import { useEffect, useRef, useState } from "react";
import { allowHost, configURL, denyHost, useHostPresence } from "./presence";

interface ConfigHostPageProps {
  host: string;
  alreadySaved: boolean;
  onAllow: () => void;
  onDeny?: () => void;
  onViewHosts: () => void;
}

export function ConfigHostPage({ host, alreadySaved, onAllow, onDeny, onViewHosts }: ConfigHostPageProps) {
  const presence = useHostPresence(host);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"idle" | "allowing" | "denying">("idle");
  const [error, setError] = useState<string | null>(null);

  const decision = presence.decision;

  // Once the CLI's token is allowed we make sure it lands in Hosts
  // even if the Allow click raced with storage (App.handleAllowHost is idempotent).
  useEffect(() => {
    if (decision === "allowed") onAllow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision === "allowed"]);

  const dotClass =
    presence.online === true ? "dot dot-on" : presence.online === false ? "dot dot-off" : "dot dot-idle";
  const statusLabel =
    presence.online === true
      ? "Agent online"
      : presence.online === false
        ? "Agent offline"
        : "Checking…";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(configURL(host));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const handleAllow = async () => {
    if (busy !== "idle") return;
    setBusy("allowing");
    setError(null);
    try {
      await allowHost(host);
      onAllow();
    } catch {
      setError("Could not reach the worker. Keep this tab open and retry.");
    } finally {
      setBusy("idle");
    }
  };

  const handleCancel = async () => {
    if (busy !== "idle") return;
    setBusy("denying");
    setError(null);
    try {
      // Browser opens its own watcher WSS inside sendDecision and the worker
      // relays {"type":"decision","decision":"denied"} to the CLI agent,
      // which then stops. HTTP POST is the durable fallback.
      await denyHost(host);
      onDeny?.();
    } catch {
      setError("Could not reach the worker. Keep this tab open and retry.");
    } finally {
      setBusy("idle");
    }
  };

  return (
    <div className="container narrow">
      <div className="page-head" style={{ justifyContent: "center" }}>
        <div>
          <h1>Allow this host?</h1>
          <p className="muted">
            Your CLI asked to register a new host. Click <strong>Allow</strong> to save it in Hosts on this
            browser and keep the CLI alive — or <strong>Cancel</strong> to stop the CLI.
          </p>
        </div>
      </div>

      <section className="card config-card">
        <div className="config-host-line">
          <span className={dotClass} aria-hidden="true" title={statusLabel} />
          <code className="code config-code">{host}</code>
        </div>
        <p className={`config-status${presence.online === true ? " success" : presence.online === false ? " error" : " muted"}`}>
          {statusLabel}
          {presence.online === false && decision === "pending" && (
            <span className="muted"> — keep your CLI running: it holds the WSS connection open.</span>
          )}
        </p>

        {decision === "allowed" ? (
          <>
            <p className="success">Allowed — this host is saved in Hosts and the CLI stays connected.</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={onViewHosts}>
                View hosts
              </button>
            </div>
          </>
        ) : decision === "denied" ? (
          <>
            <p className="error">Canceled — the CLI was told to stop. This host was not saved.</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={onViewHosts}>
                View hosts
              </button>
            </div>
          </>
        ) : alreadySaved ? (
          <>
            <p className="success">This host is already saved in Hosts — Allow still notifies the waiting CLI.</p>
            <div className="row">
              <button type="button" className="btn" onClick={handleCancel} disabled={busy !== "idle"}>
                {busy === "denying" ? "Canceling…" : "Cancel"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAllow}
                disabled={busy !== "idle"}
              >
                {busy === "allowing" ? "Allowing…" : "Allow"}
              </button>
            </div>
          </>
        ) : (
          <div className="row">
            <button type="button" className="btn" onClick={handleCancel} disabled={busy !== "idle"}>
              {busy === "denying" ? "Canceling…" : "Cancel"}
            </button>
            <button type="button" className="btn btn-primary" onClick={handleAllow} disabled={busy !== "idle"}>
              {busy === "allowing" ? "Allowing…" : "Allow"}
            </button>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <div className="row">
          <button type="button" className="btn" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
        <p className="muted config-hint">
          Link shape: <code>{configURL(host)}</code>
        </p>
      </section>
    </div>
  );
}
