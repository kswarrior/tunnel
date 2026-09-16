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
          <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
            Home
          </h1>
        </div>
        <button type="button" className="btn" onClick={onRefresh} disabled={status.loading} style={{ alignSelf: "center" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
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
          <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="stat-label">Total Tunnels</span>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.14)", display: "grid", placeItems: "center", color: "#0f9d58" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
            </span>
          </span>
          <span className="stat-num">{tunnels.length}</span>
          <span className="stat-sub">{tunnels.length === 0 ? "No tunnels yet" : `${enabled} enabled · tap to manage`}</span>
        </button>
        <button type="button" className="stat-card" onClick={() => onGo("tunnels")}>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="stat-label">Enabled</span>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: enabled ? "linear-gradient(135deg, rgba(16,185,129,0.14), rgba(52,211,153,0.18))" : "rgba(15,23,42,0.06)", border: enabled ? "1px solid rgba(16,185,129,0.18)" : "1px solid rgba(255,255,255,0.8)", display: "grid", placeItems: "center", color: enabled ? "#0f9d58" : "#64748b" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><polygon points="6 3 20 12 6 21 6 3" /></svg>
            </span>
          </span>
          <span className="stat-num">{enabled}</span>
          <span className="stat-sub">{enabled === 0 ? "All stopped" : "Live when CLI is online"}</span>
        </button>
        <button type="button" className="stat-card" onClick={() => onGo("hosts")}>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="stat-label">Hosts</span>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255,255,255,0.9)", border: "1px solid rgba(255,255,255,0.9)", display: "grid", placeItems: "center", color: "#0f9d58", boxShadow: "0 1px 6px rgba(15,23,42,0.06)" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
            </span>
          </span>
          <span className="stat-num">{hosts.length}</span>
          <span className="stat-sub">{hosts.length === 0 ? "Add your first host" : "Agents connected via WSS"}</span>
        </button>
        <button type="button" className="stat-card" onClick={() => onGo("providers")}>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="stat-label">Providers</span>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255,255,255,0.9)", border: "1px solid rgba(255,255,255,0.9)", display: "grid", placeItems: "center", color: "#64748b" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>
            </span>
          </span>
          <span className="stat-num">{providers.length}</span>
          <span className="stat-sub">Cloudflare Workers</span>
        </button>
      </div>

      {(tunnels.length === 0 || hosts.length === 0) && !status.loading && !status.error && (
        <section className="card">
          <h2>Quick start</h2>
          <p className="muted" style={{ margin: "0 0 8px" }}>
            1. Run <code>kstunnel --config:host</code> on the machine to expose and Allow it (Hosts).
            2. Add a tunnel (Tunnels) pointing at that host — e.g. <code>/!tunnel=hello → 127.0.0.1:4757</code>.
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
