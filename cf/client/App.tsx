import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "./components/Header";
import { Sidebar, type NavKey } from "./components/Sidebar";
import { getConfigHostFromLocation } from "./pages/presence";
import { useHosts, useProviders, useTunnels, newHost } from "./pages/store";
import type { WorkerStatus } from "./pages/types";

const HomePage = lazy(() => import("./pages/Home").then((m) => ({ default: m.HomePage })));
const TunnelsPage = lazy(() => import("./pages/Tunnels").then((m) => ({ default: m.TunnelsPage })));
const HostsPage = lazy(() => import("./pages/Hosts").then((m) => ({ default: m.HostsPage })));
const ProvidersPage = lazy(() => import("./pages/Providers").then((m) => ({ default: m.ProvidersPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const ConfigHostPage = lazy(() => import("./pages/ConfigHost").then((m) => ({ default: m.ConfigHostPage })));

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
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));

    Promise.all([
      fetch("/api/hello", { signal: ac.signal, cache: "no-store" }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HelloResponse;
      }),
      fetch("/api/health", { signal: ac.signal, cache: "no-store" }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HealthResponse;
      }),
    ])
      .then(([hello, health]) => {
        if (ac.signal.aborted) return;
        setState({
          loading: false,
          error: null,
          message: hello.message,
          timestamp: hello.timestamp,
          healthy: health.ok,
        });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : "Worker unreachable",
        }));
      });

    return () => ac.abort();
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
  // `https://<worker>/!config?host=<random>` (also `/?host=` + hash fallback).
  // When present we show the Allow screen instead of the normal page.
  const [configHost, setConfigHost] = useState<string | null>(() => {
    try {
      return getConfigHostFromLocation();
    } catch {
      return null;
    }
  });

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // memoize configHost presence check to avoid re-scanning on every render
  const configAlreadySaved = useMemo(
    () => (configHost ? hosts.items.some((h) => h.hostname.trim().toLowerCase() === configHost.trim().toLowerCase()) : false),
    [configHost, hosts.items],
  );

  useEffect(() => {
    const onPopState = () => {
      try {
        setConfigHost(getConfigHostFromLocation());
      } catch {
        // ignore
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
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

  const handleRemoveHost = useCallback(
    (id: string) => {
      // Unlink tunnels pointing at this host so cards don't dangle.
      for (const t of tunnels.items) {
        if (t.hostId === id) tunnels.update(t.id, { hostId: "" });
      }
      hosts.remove(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tunnels.items],
  );

  const handleRemoveProvider = useCallback(
    (id: string) => {
      for (const t of tunnels.items) {
        if (t.providerId === id) tunnels.update(t.id, { providerId: "" });
      }
      providers.remove(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tunnels.items],
  );

  const clearConfigHost = useCallback(() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("host");
      // Drop hash-carried host too, keep plain navigation.
      if (url.hash.includes("host=")) url.hash = "";
      // If we are on /!config with no host left, go back to /.
      if (url.pathname === "/!config" && !url.searchParams.get("host")) url.pathname = "/";
      window.history.replaceState(null, "", url.toString());
    } catch {
      // ignore
    }
    setConfigHost(null);
  }, []);

  const handleAllowHost = useCallback(() => {
    if (!configHost) return;
    const clean = configHost.trim();
    const exists = hosts.items.some((h) => h.hostname.trim().toLowerCase() === clean.toLowerCase());
    if (!exists) hosts.add(newHost(configHost, ""));
    // Keep the ?host= URL mounted: ConfigHostPage flips to the
    // "Allowed — CLI stays connected" state via the live decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configHost, hosts.items]);

  const handleDenyHost = useCallback(() => {
    // Keep the ?host= URL mounted too: the page flips to the
    // "Canceled — CLI stopped" state via the live decision.
    // The host is deliberately NOT added to Hosts here.
  }, []);

  return (
    <div className="shell">
      <Header
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />
      <div className="body">
        <Sidebar active={nav} open={sidebarOpen} onNavigate={handleNavigate} />
        <main className="content" aria-hidden={sidebarOpen ? true : undefined}>
          <Suspense fallback={<div className="container"><span className="skeleton" style={{ height: 120, display: "block" }} /></div>}>
            {configHost ? (
              <ConfigHostPage
                host={configHost}
                alreadySaved={configAlreadySaved}
                onAllow={handleAllowHost}
                onDeny={handleDenyHost}
                onViewHosts={() => {
                  clearConfigHost();
                  setNav("hosts");
                }}
              />
            ) : (
              <>
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
                    hosts={hosts.items}
                    providers={providers.items}
                    onAdd={tunnels.add}
                    onToggle={(id) => {
                      const found = tunnels.items.find((t) => t.id === id);
                      if (found) tunnels.update(id, { active: !found.active });
                    }}
                    onUpdate={tunnels.update}
                    onRemove={tunnels.remove}
                  />
                )}
                {nav === "hosts" && (
                  <HostsPage
                    hosts={hosts.items}
                    tunnels={tunnels.items}
                    onAdd={hosts.add}
                    onUpdate={hosts.update}
                    onRemove={handleRemoveHost}
                  />
                )}
                {nav === "providers" && (
                  <ProvidersPage
                    providers={providers.items}
                    tunnels={tunnels.items}
                    onAdd={providers.add}
                    onToggle={(id) => {
                      const found = providers.items.find((p) => p.id === id);
                      if (found) providers.update(id, { active: !found.active });
                    }}
                    onUpdate={providers.update}
                    onRemove={handleRemoveProvider}
                  />
                )}
                {nav === "settings" && <SettingsPage />}
              </>
            )}
          </Suspense>
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
