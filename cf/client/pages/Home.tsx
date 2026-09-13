import type { WorkerStatus } from "./types";

interface HomePageProps {
  status: WorkerStatus;
  onRefresh: () => void;
  onGoTunnels: () => void;
}

export function HomePage({ status, onRefresh, onGoTunnels }: HomePageProps) {
  return (
    <div className="container narrow">
      <h1>KS Tunnel</h1>
      <p className="muted">Expose local services through Cloudflare Workers.</p>
      <section className="card" aria-busy={status.loading}>
        <h2>Worker status</h2>
        {status.loading ? (
          <>
            <div className="skeleton" style={{ height: 16, margin: "8px 0" }} />
            <div className="skeleton" style={{ height: 12, width: "60%", margin: "0 auto" }} />
          </>
        ) : status.error ? (
          <p className="error">{status.error}</p>
        ) : (
          <>
            <p>
              <strong>{status.message}</strong>
            </p>
            {status.timestamp && <small className="muted">{status.timestamp}</small>}
            <p className="muted">Health: {status.healthy ? "OK" : "FAIL"}</p>
          </>
        )}
        <div className="row">
          <button type="button" className="btn" onClick={onRefresh} disabled={status.loading}>
            Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={onGoTunnels}>
            View tunnels
          </button>
        </div>
      </section>
    </div>
  );
}
