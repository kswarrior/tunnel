import { useEffect, useState } from "react";

export const CONFIG_HOST_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function isConfigHostId(value: string | null | undefined): value is string {
  return !!value && CONFIG_HOST_RE.test(value.trim());
}

/**
 * Read a `?host=` token from all supported shapes:
 *   /!config?host=XXX
 *   /?host=XXX
 *   /#!/config?host=XXX  (hash fallback for static hosts)
 *   /#!config?host=XXX
 */
export function getConfigHostFromLocation(
  loc: Pick<Location, "pathname" | "search" | "hash"> = window.location,
): string | null {
  try {
    const fromSearch = new URLSearchParams(loc.search).get("host");
    if (isConfigHostId(fromSearch)) return fromSearch!.trim();
  } catch {
    // ignore
  }
  if (loc.hash) {
    const qIndex = loc.hash.indexOf("?");
    if (qIndex >= 0) {
      try {
        const fromHash = new URLSearchParams(loc.hash.slice(qIndex)).get("host");
        if (isConfigHostId(fromHash)) return fromHash!.trim();
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export function configURL(host: string, base?: string): string {
  const origin = (base ?? (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
  return `${origin}/!config?host=${encodeURIComponent(host)}`;
}

export function statusURL(host: string): string {
  return `/api/hosts/${encodeURIComponent(host)}/status`;
}

export function watcherWSURL(host: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/hosts/${encodeURIComponent(host)}/ws`;
}

export type PresenceState = {
  online: boolean | null;
  agents: number;
};

/**
 * Live presence for one host id.
 * Opens a watcher WebSocket for instant updates and polls the HTTP status
 * endpoint every 7s as a fallback/reconciler.
 */
export function useHostPresence(host: string | null): PresenceState {
  const [state, setState] = useState<PresenceState>({ online: null, agents: 0 });

  useEffect(() => {
    if (!host || !isConfigHostId(host)) {
      setState({ online: null, agents: 0 });
      return;
    }
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pollTimer: number | null = null;
    let retryTimer: number | null = null;

    const poll = async () => {
      try {
        const res = await fetch(statusURL(host), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { online?: boolean; agents?: number };
        if (!cancelled && typeof data.online === "boolean") {
          setState({ online: data.online, agents: data.agents ?? 0 });
        }
      } catch {
        // keep last known state; WS may still deliver updates
      }
    };

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(watcherWSURL(host));
      } catch {
        retryTimer = window.setTimeout(connect, 5000);
        return;
      }
      ws.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(String(ev.data)) as {
            type?: string;
            online?: boolean;
            agents?: number;
            host?: string;
          };
          if (data && data.type === "presence" && typeof data.online === "boolean") {
            setState({ online: data.online, agents: data.agents ?? 0 });
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        retryTimer = window.setTimeout(connect, 5000);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          // ignore
        }
      };
    };

    void poll();
    connect();
    pollTimer = window.setInterval(poll, 7000);

    const onPing = () => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
      } catch {
        // ignore
      }
    };
    const pingTimer = window.setInterval(onPing, 25000);

    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [host]);

  return state;
}
