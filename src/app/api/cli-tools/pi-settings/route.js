"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { getModelAliases } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

const execAsync = promisify(exec);
const PROVIDER_ID = "9router";
const DEFAULT_API_KEY = "sk_9router";
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const getPiConfigDir = () => {
  const override = [
    process.env.PI_CODING_AGENT_DIR,
    process.env.PI_AGENT_DIR,
    process.env.PI_CONFIG_DIR,
  ].find((value) => value && value.trim());
  return override ? path.resolve(override.trim()) : path.join(os.homedir(), ".pi", "agent");
};

const getModelsPath = () => path.join(getPiConfigDir(), "models.json");
const getSettingsPath = () => path.join(getPiConfigDir(), "settings.json");

const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
};

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
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

const getCatalog = async () => {
  const [modelAliases, disabled] = await Promise.all([
    getModelAliases(),
    getDisabledModels(),
  ]);

  return AI_MODELS
    .filter((model) => {
      const providerAlias = getProviderAlias(model.provider) || model.provider;
      const disabledModels = disabled[providerAlias] || disabled[model.provider] || [];
      return !disabledModels.includes(model.model);
    })
    .map((model) => {
      const fullModel = `${model.provider}/${model.model}`;
      const providerAlias = getProviderAlias(model.provider) || model.provider;
      const routedModel = `${providerAlias}/${model.model}`;
      const caps = getCapabilitiesForModel(model.provider, model.model);
      return {
        id: routedModel,
        name: modelAliases[fullModel] || model.model,
        reasoning: Boolean(caps.reasoning),
        input: caps.vision ? ["text", "image"] : ["text"],
        contextWindow: caps.contextWindow || 128000,
        maxTokens: caps.maxOutput || 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });
};

const getProviderConfig = (config) => config?.providers?.[PROVIDER_ID] || null;

const modelIdsEqual = (left = [], right = []) => {
  if (left.length !== right.length) return false;
  const a = left.map((model) => model?.id).filter(Boolean).sort();
  const b = right.map((model) => model?.id).filter(Boolean).sort();
  return a.every((id, index) => id === b[index]);
};

// Refresh the generated model catalog whenever 9Router's enabled model list changes.
// Existing endpoint/auth settings are preserved.
const syncConfiguredCatalog = async (config) => {
  const provider = getProviderConfig(config);
  if (!provider) return { config, synced: false };

  const catalog = await getCatalog();
  if (modelIdsEqual(provider.models || [], catalog)) return { config, synced: false };

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
    const installed = await checkPiInstalled();
    const rawConfig = await readJson(getModelsPath(), { providers: {} });
    const { config, synced } = await syncConfiguredCatalog(rawConfig);
    const settings = await readJson(getSettingsPath(), {});
    const provider = getProviderConfig(config);

    return NextResponse.json({
      installed,
      has9Router: Boolean(provider),
      config,
      settings,
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
    const apiKey = String(body.apiKey || DEFAULT_API_KEY).trim();

    if (!baseUrl) {
      return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });
    }
    if (!apiKey) {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }

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
    const nextConfig = {
      ...config,
      providers: {
        ...(config.providers || {}),
        [PROVIDER_ID]: {
          baseUrl,
          api: "openai-completions",
          apiKey,
          models,
        },
      },
    };
    await writeJson(getModelsPath(), nextConfig);

    // Do not steal an existing user's default provider. Defaults are only initialized
    // when Pi has no default yet, or updated when 9Router already owns the default.
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
    const removedModelIds = new Set((getProviderConfig(config)?.models || []).map((model) => model.id));
    const providers = { ...(config.providers || {}) };
    delete providers[PROVIDER_ID];
    await writeJson(getModelsPath(), { ...config, providers });

    const settings = await readJson(getSettingsPath(), {});
    let settingsChanged = false;
    if (settings.defaultProvider === PROVIDER_ID) {
      delete settings.defaultProvider;
      settingsChanged = true;
    }
    if (removedModelIds.has(settings.defaultModel)) {
      delete settings.defaultModel;
      settingsChanged = true;
    }
    if (settingsChanged) await writeJson(getSettingsPath(), settings);

    return NextResponse.json({
      success: true,
      message: "9Router configuration removed from Pi",
    });
  } catch (error) {
    console.error("Error removing Pi configuration:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
