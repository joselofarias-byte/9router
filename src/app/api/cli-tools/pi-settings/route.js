"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { getModelAliases, getProviderConnections } from "@/models";
import { getCombos, getCustomModels } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

const execAsync = promisify(exec);
const PROVIDER_ID = "9router";
const DEFAULT_API_KEY = "sk_9router";
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const expandHome = (value) => {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
};

const getPiConfigDir = () => {
  const override = [
    process.env.PI_CODING_AGENT_DIR,
    process.env.PI_AGENT_DIR,
    process.env.PI_CONFIG_DIR,
  ].find((value) => value && value.trim());
  return override ? path.resolve(expandHome(override.trim())) : path.join(os.homedir(), ".pi", "agent");
};

const getModelsPath = () => path.join(getPiConfigDir(), "models.json");
const getSettingsPath = () => path.join(getPiConfigDir(), "settings.json");

const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
};

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  if (os.platform() !== "win32") await fs.chmod(filePath, 0o600);
};

const checkPiInstalled = async () => {
  try {
    await execAsync(os.platform() === "win32" ? "where pi" : "which pi", { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getPiConfigDir());
      return true;
    } catch {
      return false;
    }
  }
};

const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

const buildPiModel = ({ providerId, modelId, routedId, displayName, modelAliases }) => {
  if (!modelId || !routedId) return null;
  const fullModel = `${providerId}/${modelId}`;
  const caps = getCapabilitiesForModel(providerId, modelId);
  return {
    id: routedId,
    name: modelAliases[fullModel] || displayName || modelId,
    reasoning: Boolean(caps.reasoning),
    input: caps.vision ? ["text", "image"] : ["text"],
    contextWindow: caps.contextWindow || 128000,
    maxTokens: caps.maxOutput || 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
};

const stripKnownPrefix = (value, prefixes) => {
  let modelId = String(value || "").trim();
  for (const prefix of prefixes.filter(Boolean)) {
    if (modelId.startsWith(`${prefix}/`)) {
      modelId = modelId.slice(prefix.length + 1);
      break;
    }
  }
  return modelId;
};

const getCatalog = async () => {
  const [modelAliases, disabled, connections, combos, customModels] = await Promise.all([
    getModelAliases(),
    getDisabledModels(),
    getProviderConnections(),
    getCombos(),
    getCustomModels(),
  ]);

  const catalog = new Map();
  const isDisabled = (aliases, modelId) => aliases.some(
    (alias) => alias && Array.isArray(disabled[alias]) && disabled[alias].includes(modelId),
  );
  const put = ({ providerId, modelId, routedId, displayName }) => {
    const piModel = buildPiModel({ providerId, modelId, routedId, displayName, modelAliases });
    if (piModel) catalog.set(piModel.id, piModel);
  };

  // Combos are first-class routable model IDs in 9Router and are especially useful
  // for resilient free-tier fallback, so expose LLM combos directly to Pi.
  for (const combo of combos || []) {
    if (!combo?.name || (combo.kind && combo.kind !== "llm")) continue;
    put({
      providerId: "combo",
      modelId: combo.name,
      routedId: combo.name,
      displayName: `Combo: ${combo.name}`,
    });
  }

  const activeConnections = (connections || []).filter((connection) => connection?.isActive !== false);

  for (const connection of activeConnections) {
    const providerId = connection.provider;
    if (!providerId) continue;

    const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    const outputAlias = connection.providerSpecificData?.prefix
      || getProviderAlias(providerId)
      || staticAlias;
    const providerModels = getModelsByProviderId(providerId);
    const staticNames = new Map(providerModels.map((model) => [model.id, model.name || model.id]));
    const explicitEnabled = Array.isArray(connection.providerSpecificData?.enabledModels)
      && connection.providerSpecificData.enabledModels.length > 0;
    const candidates = new Map();

    const addCandidate = (rawId, name) => {
      const modelId = stripKnownPrefix(rawId, [outputAlias, staticAlias, providerId]);
      if (!modelId || isDisabled([outputAlias, staticAlias, providerId], modelId)) return;
      if (!candidates.has(modelId)) candidates.set(modelId, name || staticNames.get(modelId) || modelId);
    };

    if (explicitEnabled) {
      connection.providerSpecificData.enabledModels.forEach((modelId) => addCandidate(modelId));
    } else {
      providerModels.forEach((model) => addCandidate(model.id, model.name));
    }

    if (connection.defaultModel) addCandidate(connection.defaultModel);
    (connection.providerSpecificData?.customModels || []).forEach((model) => {
      if (model?.id) addCandidate(model.id, model.name);
    });

    (customModels || [])
      .filter((model) => {
        if (!model?.id || (model.type && model.type !== "llm" && model.type !== "imageToText")) return false;
        return [providerId, staticAlias, outputAlias].includes(model.providerAlias);
      })
      .forEach((model) => addCandidate(model.id, model.name));

    for (const [modelId, displayName] of candidates.entries()) {
      put({
        providerId,
        modelId,
        routedId: `${outputAlias}/${modelId}`,
        displayName,
      });
    }
  }

  // Fresh installs without provider connections keep the previous static catalog
  // behavior, while still exposing custom LLM definitions already stored in DB.
  if (activeConnections.length === 0) {
    AI_MODELS.forEach((model) => {
      const outputAlias = getProviderAlias(model.provider) || model.provider;
      if (isDisabled([outputAlias, model.provider], model.model)) return;
      put({
        providerId: model.provider,
        modelId: model.model,
        routedId: `${outputAlias}/${model.model}`,
        displayName: model.model,
      });
    });

    (customModels || []).forEach((model) => {
      if (!model?.id || !model.providerAlias || (model.type && model.type !== "llm" && model.type !== "imageToText")) return;
      const modelId = String(model.id).trim();
      if (!modelId || isDisabled([model.providerAlias], modelId)) return;
      put({
        providerId: model.providerAlias,
        modelId,
        routedId: `${model.providerAlias}/${modelId}`,
        displayName: model.name,
      });
    });
  }

  return [...catalog.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const getProviderConfig = (config) => config?.providers?.[PROVIDER_ID] || null;

const canonicalCatalog = (models = []) => models
  .filter((model) => model?.id)
  .map((model) => ({
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    input: Array.isArray(model.input) ? [...model.input] : ["text"],
    contextWindow: model.contextWindow || 128000,
    maxTokens: model.maxTokens || 16384,
    cost: {
      input: model.cost?.input || 0,
      output: model.cost?.output || 0,
      cacheRead: model.cost?.cacheRead || 0,
      cacheWrite: model.cost?.cacheWrite || 0,
    },
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

const catalogsEqual = (left = [], right = []) => (
  JSON.stringify(canonicalCatalog(left)) === JSON.stringify(canonicalCatalog(right))
);

const syncConfiguredCatalog = async (config, catalog) => {
  const provider = getProviderConfig(config);
  if (!provider) return { config, synced: false };
  if (catalogsEqual(provider.models || [], catalog)) return { config, synced: false };

  const next = {
    ...config,
    providers: {
      ...(config.providers || {}),
      [PROVIDER_ID]: {
        ...provider,
        models: catalog,
      },
    },
  };
  await writeJson(getModelsPath(), next);
  return { config: next, synced: true };
};

export async function GET() {
  try {
    const [installed, rawConfig, settings, availableModels] = await Promise.all([
      checkPiInstalled(),
      readJson(getModelsPath(), { providers: {} }),
      readJson(getSettingsPath(), {}),
      getCatalog(),
    ]);
    const { config, synced } = await syncConfiguredCatalog(rawConfig, availableModels);
    const provider = getProviderConfig(config);

    return NextResponse.json({
      installed,
      has9Router: Boolean(provider),
      config,
      settings,
      availableModels,
      configDir: getPiConfigDir(),
      configPath: getModelsPath(),
      settingsPath: getSettingsPath(),
      synced,
      pi: provider
        ? {
            baseUrl: provider.baseUrl || "",
            models: (provider.models || []).map((model) => model.id),
            defaultModel: settings.defaultProvider === PROVIDER_ID ? settings.defaultModel || "" : "",
            thinkingLevel: settings.defaultThinkingLevel || "",
            ownsDefaults: !settings.defaultProvider || settings.defaultProvider === PROVIDER_ID,
          }
        : null,
    });
  } catch (error) {
    console.error("Error reading Pi configuration:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const hasApiKey = Object.prototype.hasOwnProperty.call(body, "apiKey");
    const apiKey = hasApiKey ? String(body.apiKey ?? "").trim() : DEFAULT_API_KEY;

    if (!baseUrl) return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });
    if (!apiKey) return NextResponse.json({ error: "apiKey is required" }, { status: 400 });

    const catalog = await getCatalog();
    if (catalog.length === 0) {
      return NextResponse.json({ error: "No enabled 9Router models are available" }, { status: 400 });
    }

    const requestedIds = Array.isArray(body.modelIds)
      ? new Set(body.modelIds.filter((id) => typeof id === "string" && id.trim()))
      : null;
    const models = requestedIds?.size
      ? catalog.filter((model) => requestedIds.has(model.id))
      : catalog;

    if (models.length === 0) {
      return NextResponse.json({ error: "None of the selected models are currently available" }, { status: 400 });
    }

    const config = await readJson(getModelsPath(), { providers: {} });
    const existingProvider = getProviderConfig(config) || {};
    const nextConfig = {
      ...config,
      providers: {
        ...(config.providers || {}),
        [PROVIDER_ID]: {
          ...existingProvider,
          baseUrl,
          api: "openai-completions",
          apiKey,
          models,
        },
      },
    };
    await writeJson(getModelsPath(), nextConfig);

    const settings = await readJson(getSettingsPath(), {});
    const ownsDefaults = !settings.defaultProvider || settings.defaultProvider === PROVIDER_ID;
    let settingsUpdated = false;

    if (ownsDefaults) {
      const availableIds = new Set(models.map((model) => model.id));
      const requestedDefault = typeof body.defaultModel === "string" && availableIds.has(body.defaultModel)
        ? body.defaultModel
        : null;
      const envDefault = process.env.DEFAULT_PI_MODEL && availableIds.has(process.env.DEFAULT_PI_MODEL)
        ? process.env.DEFAULT_PI_MODEL
        : null;
      const currentDefault = availableIds.has(settings.defaultModel) ? settings.defaultModel : null;
      const defaultModel = requestedDefault || envDefault || currentDefault || models[0].id;
      const requestedThinking = typeof body.thinkingLevel === "string" && VALID_THINKING_LEVELS.has(body.thinkingLevel)
        ? body.thinkingLevel
        : null;
      const envThinking = VALID_THINKING_LEVELS.has(process.env.DEFAULT_PI_THINKING)
        ? process.env.DEFAULT_PI_THINKING
        : null;

      settings.defaultProvider = PROVIDER_ID;
      settings.defaultModel = defaultModel;
      if (!settings.defaultThinkingLevel || requestedThinking) {
        settings.defaultThinkingLevel = requestedThinking || envThinking || settings.defaultThinkingLevel || "medium";
      }
      settingsUpdated = true;
      await writeJson(getSettingsPath(), settings);
    }

    return NextResponse.json({
      success: true,
      message: `Pi configured with ${models.length} 9Router model${models.length === 1 ? "" : "s"}`,
      configPath: getModelsPath(),
      settingsPath: getSettingsPath(),
      settingsUpdated,
      modelCount: models.length,
    });
  } catch (error) {
    console.error("Error configuring Pi:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const config = await readJson(getModelsPath(), { providers: {} });
    const providers = { ...(config.providers || {}) };
    delete providers[PROVIDER_ID];
    await writeJson(getModelsPath(), { ...config, providers });

    const settings = await readJson(getSettingsPath(), {});
    if (settings.defaultProvider === PROVIDER_ID) {
      delete settings.defaultProvider;
      delete settings.defaultModel;
      await writeJson(getSettingsPath(), settings);
    }

    return NextResponse.json({ success: true, message: "9Router configuration removed from Pi" });
  } catch (error) {
    console.error("Error removing Pi configuration:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
