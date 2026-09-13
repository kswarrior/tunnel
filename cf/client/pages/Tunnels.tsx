import { useState } from "react";
import type { WorkerStatus } from "./types";
import { loadSettings } from "./types";

interface TunnelsPageProps {
  status: WorkerStatus;
  onRefresh: () => void;
}

export function TunnelsPage({ status, onRefresh }: TunnelsPageProps) {
  const [copied, setCopied] = useState(false);
  const settings = loadSettings();
  const cmd = `./release/kstunnel/kstunnel --tunnel ${settings.defaultTunnel} --target 127.0.0.1:3000`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="container narrow">
      <h1>Tunnels</h1>
      <p className="muted">No tunnels connected yet. Start the Go agent to open one.</p>
      <section className="card">
        <h2>Agent command</h2>
        <code className="code">{cmd}</code>
        <div className="row">
          <button type="button" className="btn" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn btn-primary" onClick={onRefresh} disabled={status.loading}>
            {status.loading ? "Checking…" : "Check worker"}
          </button>
        </div>
        {status.error ? (
          <p className="error">{status.error}</p>
        ) : status.message ? (
          <p className="muted">
            Worker: {status.message} · Health: {status.healthy ? "OK" : "FAIL"}
          </p>
        ) : null}
      </section>
    </div>
  );
}
