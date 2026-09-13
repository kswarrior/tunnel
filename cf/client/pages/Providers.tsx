import { useState } from "react";

export function ProvidersPage() {
  const [copied, setCopied] = useState(false);
  const origin = window.location.origin;
  const deployCmd = "npx wrangler deploy";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(deployCmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="container narrow">
      <h1>Providers</h1>
      <p className="muted">Where KS Tunnel runs right now.</p>
      <section className="card">
        <h2>Cloudflare Workers</h2>
        <p>
          Status: <strong>Active</strong>
        </p>
        <p className="muted">Origin: {origin}</p>
        <p className="muted">Endpoints: /api/hello · /api/health</p>
        <code className="code">{deployCmd}</code>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={handleCopy}>
            {copied ? "Copied" : "Copy deploy command"}
          </button>
        </div>
      </section>
    </div>
  );
}
