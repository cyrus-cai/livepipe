"use client";

import { useEffect, useMemo, useState } from "react";

type ConfigUpdate = {
  type: "hot-reloaded" | "restart-required" | "validation-error";
  at: string;
  message: string;
  changedFields: string[];
  hotReloaded: string[];
  restartRequired: string[];
  issues?: string[];
};

type StatusResponse = {
  running: boolean;
  message: string;
  effectiveConfig: {
    reviewEnabled: boolean;
    provider: string;
    model: string;
    outputLanguage: string;
  };
  configUpdate: ConfigUpdate | null;
};

const EMPTY_STATUS: StatusResponse = {
  running: false,
  message: "Loading status...",
  effectiveConfig: {
    reviewEnabled: false,
    provider: "",
    model: "",
    outputLanguage: "zh-CN",
  },
  configUpdate: null,
};

function formatFieldValue(value: string): string {
  return value.trim() ? value : "(unset)";
}

function formatTimestamp(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

export default function Home() {
  const [status, setStatus] = useState<StatusResponse>(EMPTY_STATUS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const response = await fetch("/api/start", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const payload = (await response.json()) as StatusResponse;
        if (!cancelled) {
          setStatus(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      }
    };

    loadStatus();
    const timer = window.setInterval(loadStatus, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const statusColor = status.running ? "#4ade80" : "#f87171";
  const statusText = status.running ? "Pipeline Running" : "Pipeline Stopped";

  const configUpdateColor = useMemo(() => {
    const updateType = status.configUpdate?.type;
    if (updateType === "hot-reloaded") return "#4ade80";
    if (updateType === "restart-required") return "#f59e0b";
    if (updateType === "validation-error") return "#f87171";
    return "#888";
  }, [status.configUpdate?.type]);

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
        LivePipe
      </h1>
      <p style={{ color: "#888", marginBottom: "1.5rem" }}>
        Real-time screen content analysis powered by Screenpipe + local AI.
      </p>

      <div
        style={{
          padding: "1.5rem",
          border: "1px solid #333",
          borderRadius: "8px",
          marginBottom: "1.5rem",
          background: "#111",
        }}
      >
        <p style={{ color: statusColor, fontSize: "1.125rem", marginBottom: "0.5rem" }}>
          {statusText}
        </p>
        <p style={{ color: "#888", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
          {status.message}
        </p>
        {error && (
          <p style={{ color: "#f87171", fontSize: "0.875rem" }}>
            Failed to refresh status: {error}
          </p>
        )}
      </div>

      <div
        style={{
          padding: "1.5rem",
          border: "1px solid #333",
          borderRadius: "8px",
          marginBottom: "1.5rem",
          background: "#111",
        }}
      >
        <h3 style={{ color: "#ddd", marginBottom: "0.75rem" }}>
          Effective Config
        </h3>
        <div style={{ color: "#bbb", fontSize: "0.9rem", lineHeight: 1.8 }}>
          <div>review.enabled: {String(status.effectiveConfig.reviewEnabled)}</div>
          <div>review.provider: {formatFieldValue(status.effectiveConfig.provider)}</div>
          <div>review.model: {formatFieldValue(status.effectiveConfig.model)}</div>
          <div>outputLanguage: {formatFieldValue(status.effectiveConfig.outputLanguage)}</div>
        </div>
        <div style={{ color: configUpdateColor, fontSize: "0.875rem", marginTop: "0.9rem" }}>
          {status.configUpdate
            ? `最近配置变更（${formatTimestamp(status.configUpdate.at)}）：${status.configUpdate.message}`
            : "最近配置变更：暂无"}
        </div>
      </div>

      <div style={{ color: "#666", fontSize: "0.875rem" }}>
        <h3 style={{ color: "#888", marginBottom: "0.5rem" }}>
          Manage Services
        </h3>
        <pre
          style={{
            background: "#0a0a0a",
            padding: "1rem",
            borderRadius: "6px",
            overflow: "auto",
          }}
        >
          <code style={{ color: "#888" }}>{`live status    # Check service status
live logs      # View real-time logs
live stop      # Stop all services
live restart   # Restart services`}</code>
        </pre>
      </div>
    </div>
  );
}
