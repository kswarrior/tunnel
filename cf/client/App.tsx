import { useCallback, useEffect, useState } from "react";
import { Header } from "./components/Header";
import { Sidebar, type NavKey } from "./components/Sidebar";

type HelloResponse = {
  message: string;
  timestamp: string;
};

type HealthResponse = {
  ok: boolean;
};

function useHello() {
  const [data, setData] = useState<HelloResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/hello")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HelloResponse;
      })
      .then((json) => {
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to fetch backend");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error, loading };
}

function useHealth(active: boolean) {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    fetch("/api/health")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HealthResponse;
      })
      .then((json) => {
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Health check failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return { data, error, loading };
}

export default function App(): JSX.Element {
  const [nav, setNav] = useState<NavKey>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const hello = useHello();
  const health = useHealth(nav === "health");

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!sidebarOpen) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [sidebarOpen, closeSidebar]);

  const handleNavigate = useCallback(
    (key: NavKey) => {
      setNav(key);
      closeSidebar();
    },
    [closeSidebar],
  );

  const statusText = hello.loading ? "Connecting…" : hello.error ? "Backend offline" : "Backend online";

  return (
    <div className="shell">
      <Header
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        statusText={statusText}
      />
      <div className="body">
        <Sidebar active={nav} open={sidebarOpen} onNavigate={handleNavigate} />
        <main className="content" aria-hidden={sidebarOpen ? true : undefined}>
          {nav === "home" && (
            <div className="container narrow">
              <h1>Hello World (Frontend TS + React)</h1>
              <p>Cloudflare frontend served from the Worker.</p>
              <section className="card" aria-busy={hello.loading}>
                <h2>Backend response</h2>
                {hello.loading ? (
                  <>
                    <div className="skeleton" style={{ height: 16, margin: "8px 0" }} />
                    <div className="skeleton" style={{ height: 12, width: "60%", margin: "0 auto" }} />
                  </>
                ) : hello.data ? (
                  <>
                    <p>
                      <strong>{hello.data.message}</strong>
                    </p>
                    <small>{hello.data.timestamp}</small>
                  </>
                ) : (
                  <p className="error">Backend error: {hello.error}</p>
                )}
              </section>
            </div>
          )}

          {nav === "backend" && (
            <div className="container narrow">
              <h1>Backend</h1>
              <p>Live data from GET /api/hello.</p>
              <section className="card" aria-busy={hello.loading}>
                {hello.loading ? (
                  <div className="skeleton" style={{ height: 16 }} />
                ) : hello.data ? (
                  <>
                    <p>
                      <strong>{hello.data.message}</strong>
                    </p>
                    <small>{hello.data.timestamp}</small>
                  </>
                ) : (
                  <p className="error">Backend error: {hello.error}</p>
                )}
              </section>
            </div>
          )}

          {nav === "health" && (
            <div className="container narrow">
              <h1>Health</h1>
              <p>Live data from GET /api/health.</p>
              <section className="card" aria-busy={health.loading}>
                {health.loading ? (
                  <div className="skeleton" style={{ height: 16 }} />
                ) : health.data ? (
                  <p>
                    Status: <strong>{health.data.ok ? "OK" : "FAIL"}</strong>
                  </p>
                ) : (
                  <p className="error">Health error: {health.error}</p>
                )}
              </section>
            </div>
          )}
        </main>
      </div>
      <div
        className={`overlay${sidebarOpen ? " open" : ""}`}
        onClick={closeSidebar}
        aria-hidden="true"
      />
    </div>
  );
}
