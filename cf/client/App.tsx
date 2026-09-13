import { useCallback, useEffect, useState } from "react";
import { Header } from "./components/Header";
import { Sidebar, type NavKey } from "./components/Sidebar";
import { HomePage } from "./pages/Home";
import { TunnelsPage } from "./pages/Tunnels";
import { HostsPage } from "./pages/Hosts";
import { ProvidersPage } from "./pages/Providers";
import { SettingsPage } from "./pages/Settings";
import { useHosts, useProviders, useTunnels } from "./pages/store";
import type { WorkerStatus } from "./pages/types";

type HelloResponse = {
  message: string;
  timestamp: string;
};

type HealthResponse = {
  ok: boolean;
};

function useWorkerStatus() {
  const [state, setState] = useState<WorkerStatus>({
    loading: true,
    error: null,
    message: null,
    timestamp: null,
    healthy: null,
  });

  const refresh = useCallback(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    Promise.all([
      fetch("/api/hello").then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HelloResponse;
      }),
      fetch("/api/health").then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HealthResponse;
      }),
    ])
      .then(([hello, health]) => {
        if (!cancelled) {
          setState({
            loading: false,
            error: null,
            message: hello.message,
            timestamp: hello.timestamp,
            healthy: health.ok,
          });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            loading: false,
            error: err instanceof Error ? err.message : "Worker unreachable",
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = refresh();
    return cleanup;
  }, [refresh]);

  return { status: state, refresh };
}

export default function App(): JSX.Element {
  const [nav, setNav] = useState<NavKey>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { status, refresh } = useWorkerStatus();
  const tunnels = useTunnels();
  const hosts = useHosts();
  const providers = useProviders();

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

  const statusText = status.loading
    ? "Connecting…"
    : status.error
      ? "Worker offline"
      : "Worker online";

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
            <HomePage
              status={status}
              tunnels={tunnels.items}
              hosts={hosts.items}
              providers={providers.items}
              onRefresh={refresh}
              onGo={(key) => setNav(key)}
            />
          )}
          {nav === "tunnels" && (
            <TunnelsPage
              tunnels={tunnels.items}
              onAdd={tunnels.add}
              onToggle={(id) => {
                const found = tunnels.items.find((t) => t.id === id);
                if (found) tunnels.update(id, { active: !found.active });
              }}
              onRemove={tunnels.remove}
            />
          )}
          {nav === "hosts" && (
            <HostsPage hosts={hosts.items} onAdd={hosts.add} onRemove={hosts.remove} />
          )}
          {nav === "providers" && (
            <ProvidersPage
              providers={providers.items}
              onAdd={providers.add}
              onToggle={(id) => {
                const found = providers.items.find((p) => p.id === id);
                if (found) providers.update(id, { active: !found.active });
              }}
              onRemove={providers.remove}
            />
          )}
          {nav === "settings" && <SettingsPage />}
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
