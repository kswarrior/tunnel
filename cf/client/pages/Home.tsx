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
  const active = tunnels.filter((t) => t.active).length;

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
          <span className="stat-num">{active}</span>
          <span className="stat-label">Active Tunnels</span>
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

      <section className="card">
        <h2>Worker</h2>
        {status.loading ? (
          <div className="skeleton" style={{ height: 16 }} />
        ) : status.message ? (
          <p className="muted">
            {status.message} · Health: {status.healthy ? "OK" : "FAIL"}
          </p>
        ) : (
          <p className="muted">Worker unreachable.</p>
        )}
      </section>
    </div>
  );
}
