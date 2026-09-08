"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Card, Button } from "@/shared/components";
import BaseUrlSelect from "./BaseUrlSelect";
import ApiKeySelect from "./ApiKeySelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import { matchKnownEndpoint } from "./cliEndpointMatch";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const ensureV1 = (url) => {
  const value = String(url || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  return value.endsWith("/v1") ? value : `${value}/v1`;
};

export default function PiToolCard({
  tool,
  isExpanded,
  onToggle,
  baseUrl,
  apiKeys = [],
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [status, setStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [endpoint, setEndpoint] = useState("");
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("medium");
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  useEffect(() => {
    if (apiKeys.length > 0 && !selectedApiKey) setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (!isExpanded) return;
    if (!status) checkStatus();
    loadModels();
  }, [isExpanded]);

  useEffect(() => {
    const currentDefault = status?.pi?.defaultModel;
    if (currentDefault) setDefaultModel(currentDefault);
    if (status?.pi?.thinkingLevel) setThinkingLevel(status.pi.thinkingLevel);
  }, [status]);

  useEffect(() => {
    if (!defaultModel && models.length > 0) setDefaultModel(models[0].routedModel);
  }, [models, defaultModel]);

  const loadModels = async () => {
    try {
      const res = await fetch("/api/models");
      const data = await res.json();
      if (res.ok) setModels(data.models || []);
    } catch (error) {
      console.log("Error loading Pi model catalog:", error);
    }
  };

  const checkStatus = async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/cli-tools/pi-settings");
      const data = await res.json();
      setStatus(data);
    } catch (error) {
      setStatus({ installed: false, error: error.message });
    } finally {
      setChecking(false);
    }
  };

  const configuredUrl = status?.pi?.baseUrl || "";
  const effectiveBaseUrl = ensureV1(endpoint || baseUrl);
  const statusLabel = useMemo(() => {
    if (!status?.installed) return null;
    if (!status?.has9Router) return "not_configured";
    return matchKnownEndpoint(configuredUrl, { tunnelPublicUrl, tailscaleUrl }) ? "configured" : "other";
  }, [status, configuredUrl, tunnelPublicUrl, tailscaleUrl]);

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = selectedApiKey?.trim() || (!cloudEnabled ? "sk_9router" : "");
      const res = await fetch("/api/cli-tools/pi-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: effectiveBaseUrl,
          apiKey: keyToUse,
          defaultModel,
          thinkingLevel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to configure Pi");
      rememberEndpoint(effectiveBaseUrl, { tunnelPublicUrl, tailscaleUrl });
      setMessage({ type: "success", text: data.message || "Pi configured successfully" });
      await checkStatus();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/pi-settings", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reset Pi");
      setMessage({ type: "success", text: data.message || "Pi reset successfully" });
      await checkStatus();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src={tool.image} alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {statusLabel === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {statusLabel === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {statusLabel === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other endpoint</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checking && <div className="flex items-center gap-2 text-text-muted"><span className="material-symbols-outlined animate-spin">progress_activity</span><span>Checking Pi CLI...</span></div>}

          {!checking && status && !status.installed && (
            <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-yellow-500">warning</span>
                <div className="flex-1">
                  <p className="font-medium text-yellow-600 dark:text-yellow-400">Pi CLI not detected locally</p>
                  <p className="text-sm text-text-muted">Install Pi on the same machine as 9Router, then refresh this page.</p>
                </div>
              </div>
              <div className="pl-9">
                <Button variant="outline" size="sm" onClick={() => setShowInstallGuide((value) => !value)}>
                  <span className="material-symbols-outlined text-[18px] mr-1">{showInstallGuide ? "expand_less" : "help"}</span>
                  {showInstallGuide ? "Hide" : "How to Install"}
                </Button>
              </div>
              {showInstallGuide && (
                <code className="block px-3 py-2 bg-black/5 dark:bg-white/5 rounded font-mono text-xs break-all">npm install -g @earendil-works/pi-coding-agent</code>
              )}
            </div>
          )}

          {!checking && status?.installed && (
            <>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Endpoint</span>
                <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                <BaseUrlSelect
                  value={endpoint || ensureV1(baseUrl)}
                  onChange={setEndpoint}
                  requiresExternalUrl={tool.requiresExternalUrl}
                  tunnelEnabled={tunnelEnabled}
                  tunnelPublicUrl={tunnelPublicUrl}
                  tailscaleEnabled={tailscaleEnabled}
                  tailscaleUrl={tailscaleUrl}
                  cloudEnabled={cloudEnabled}
                  currentUrl={configuredUrl}
                />
              </div>

              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
              </div>

              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Default model</span>
                <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                <select value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} className="w-full min-w-0 px-2 py-2 bg-surface rounded text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5">
                  {models.map((model) => <option key={model.routedModel} value={model.routedModel}>{model.alias || model.routedModel} — {model.routedModel}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Thinking</span>
                <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)} className="w-full min-w-0 px-2 py-2 bg-surface rounded text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5">
                  {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </div>

              {status?.pi?.models?.length > 0 && (
                <div className="rounded bg-surface/40 px-3 py-2 text-xs text-text-muted">
                  {status.pi.models.length} routed model{status.pi.models.length === 1 ? "" : "s"} in {status.configPath}
                  {status.synced ? " · catalog refreshed" : ""}
                </div>
              )}

              {message && <div className={`rounded px-3 py-2 text-sm ${message.type === "success" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-red-500/10 text-red-600 dark:text-red-400"}`}>{message.text}</div>}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={handleApply} disabled={applying || !effectiveBaseUrl || models.length === 0}>
                  {applying ? "Applying..." : "Apply 9Router"}
                </Button>
                {status?.has9Router && <Button variant="outline" size="sm" onClick={handleReset} disabled={restoring}>{restoring ? "Resetting..." : "Reset"}</Button>}
                <Button variant="ghost" size="sm" onClick={checkStatus} disabled={checking}>Refresh</Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
