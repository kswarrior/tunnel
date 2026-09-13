import { useState } from "react";
import { configURL, useHostPresence } from "./presence";

interface ConfigHostPageProps {
  host: string;
  alreadySaved: boolean;
  onAllow: () => void;
  onViewHosts: () => void;
}

export function ConfigHostPage({ host, alreadySaved, onAllow, onViewHosts }: ConfigHostPageProps) {
  const presence = useHostPresence(host);
  const [copied, setCopied] = useState(false);

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

  return (
    <div className="container narrow">
      <div className="page-head" style={{ justifyContent: "center" }}>
        <div>
          <h1>Allow this host?</h1>
          <p className="muted">
            Your CLI asked to register a new host. Click <strong>Allow</strong> to save it in Hosts on this
            browser.
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
          {presence.online === false && (
            <span className="muted"> — keep your CLI running: it holds the WSS connection open.</span>
          )}
        </p>

        {alreadySaved ? (
          <>
            <p className="success">This host is already saved in Hosts.</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={onViewHosts}>
                View hosts
              </button>
            </div>
          </>
        ) : (
          <div className="row">
            <button type="button" className="btn" onClick={onViewHosts}>
              Decline
            </button>
            <button type="button" className="btn btn-primary" onClick={onAllow}>
              Allow
            </button>
          </div>
        )}

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
