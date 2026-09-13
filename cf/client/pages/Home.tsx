import type { Host, Provider, Tunnel, WorkerStatus } from "./types";

interface HomePageProps {
  status: WorkerStatus;
  tunnels: Tunnel[];
  hosts: Host[];
  providers: Provider[];
  onRefresh: () => void;
  onGo: (key: "tunnels" | "hosts" | "providers") => void;
}

export function HomePage({ status, tunnels, hosts, providers, onRefresh, onGo }: HomePageProps) {
  const enabled = tunnels.filter((t) => t.active).length;

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>KS Tunnel</h1>
          <p className="muted">Expose local services through Cloudflare Workers.</p>
        </div>
        <button type="button" className="btn" onClick={onRefresh} disabled={status.loading}>
          {status.loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {status.error && (
        <section className="card">
          <p className="error">{status.error}</p>
        </section>
      )}

      <div className="stats">
        <button type="button" className="stat-card" onClick={() => onGo("tunnels")}>
          <span className="stat-num">{tunnels.length}</span>
          <span className="stat-label">Total Tunnels</span>
        </button>
        <button type="button" className="stat-card" onClick={() => onGo("tunnels")}>
          <span className="stat-num">{enabled}</span>
          <span className="stat-label">Enabled Tunnels</span>
        </button>
        <button type="button" className="stat-card" onClick={() => onGo("hosts")}>
          <span className="stat-num">{hosts.length}</span>
          <span className="stat-label">Hosts</span>
        </button>
        <button type="button" className="stat-card" onClick={() => onGo("providers")}>
          <span className="stat-num">{providers.length}</span>
          <span className="stat-label">Providers</span>
        </button>
      </div>

      <section className="card" aria-busy={status.loading}>
        <h2>Worker</h2>
        {status.loading ? (
          <>
            <div className="skeleton" style={{ height: 16, width: "70%" }} />
            <div className="skeleton" style={{ height: 12, width: "45%", marginTop: 8 }} />
          </>
        ) : status.message ? (
          <p className="muted">
            {status.message} · Health: {status.healthy ? "OK" : "FAIL"}
            {status.timestamp && (
              <> · <span title={status.timestamp}>checked {new Date(status.timestamp).toLocaleTimeString()}</span></>
            )}
          </p>
        ) : (
          <p className="muted">Worker unreachable.</p>
        )}
      </section>

      {(tunnels.length === 0 || hosts.length === 0) && !status.loading && !status.error && (
        <section className="card">
          <h2>Quick start</h2>
          <p className="muted" style={{ margin: "0 0 8px" }}>
            1. Run <code>kstunnel --config:host</code> on the machine to expose and Allow it (Hosts).
            2. Add a tunnel (Tunnels) pointing at that host — e.g. <code>/hello → 127.0.0.1:4757</code>.
            3. Run the shown <code>kstunnel --host … --tunnel … --target …</code> command and open the public URL.
          </p>
          <div className="row" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="btn" onClick={() => onGo("hosts")}>
              Go to Hosts
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onGo("tunnels")}>
              Go to Tunnels
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
