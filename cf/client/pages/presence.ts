import { useEffect, useState } from "react";

export const CONFIG_HOST_RE = /^[A-Za-z0-9_-]{5,64}$/;

export type ConfigDecision = "pending" | "allowed" | "denied";

export function isConfigHostId(value: string | null | undefined): value is string {
  return !!value && CONFIG_HOST_RE.test(value.trim());
}

export function normalizeDecision(value: unknown): ConfigDecision | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "allowed" || v === "allow" || v === "approve" || v === "approved" || v === "accept") {
    return "allowed";
  }
  if (
    v === "denied" ||
    v === "deny" ||
    v === "decline" ||
    v === "declined" ||
    v === "cancel" ||
    v === "canceled" ||
    v === "cancelled" ||
    v === "reject" ||
    v === "rejected"
  ) {
    return "denied";
  }
  if (v === "pending" || v === "reset" || v === "wait" || v === "waiting") return "pending";
  return null;
}

/** Parse an inbound WS/HTTP payload into a decision, if it carries one. */
export function parseDecisionMessage(raw: string): ConfigDecision | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data === "string") return normalizeDecision(data);
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (typeof obj["type"] === "string" && obj["type"] !== "decision" && obj["type"] !== "presence") {
        const byType = normalizeDecision(obj["type"]);
        if (byType && byType !== "pending") return byType;
        if (obj["type"] === "reset") return "pending";
      }
      for (const key of ["decision", "action", "approved"]) {
        const d = normalizeDecision(obj[key]);
        if (d) return d;
      }
      if (obj["allow"] === true || obj["approved"] === true) return "allowed";
      if (obj["deny"] === true || obj["decline"] === true || obj["cancel"] === true) return "denied";
      // Presence snapshots also carry the current decision.
      if (obj["type"] === "presence") {
        const d = normalizeDecision(obj["decision"]);
        if (d) return d;
      }
    }
    return null;
  } catch {
    return normalizeDecision(raw);
  }
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

export function decisionURL(host: string): string {
  return `/api/hosts/${encodeURIComponent(host)}/decision`;
}

export function allowURL(host: string): string {
  return `/api/hosts/${encodeURIComponent(host)}/allow`;
}

export function denyURL(host: string): string {
  return `/api/hosts/${encodeURIComponent(host)}/deny`;
}

export function watcherWSURL(host: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/hosts/${encodeURIComponent(host)}/ws`;
}

export function hostTunnelsURL(host: string): string {
  return `/api/hosts/${encodeURIComponent(host)}/tunnels`;
}

export type RegistryEntry = {
  slug: string;
  host: string;
  target: string;
  name: string;
  tunnelType: string;
  updatedAt: string;
};

/** Worker-side slug registry (source of truth for what /<slug> resolves). */
export async function fetchRegistry(): Promise<RegistryEntry[]> {
  const res = await fetch("/api/tunnels", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { tunnels?: unknown };
  if (!Array.isArray(data.tunnels)) return [];
  return (data.tunnels as RegistryEntry[]).filter(
    (t) => t && typeof t.slug === "string" && typeof t.host === "string",
  );
}

export function useRegistry(pollMs = 10000): {
  entries: RegistryEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRegistry()
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Registry unreachable");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs]);

  return { entries, loading, error, refresh: () => setTick((t) => t + 1) };
}

export type PresenceState = {
  online: boolean | null;
  agents: number;
  decision: ConfigDecision;
  /** Slugs with a live per-tunnel wss on this host right now. */
  tunnels: string[];
};

/**
 * Send a decision to the Durable Object for `host`.
 * Uses a fast one-shot watcher WebSocket (instant relay to the CLI agent)
 * plus a durable HTTP POST fallback (persisted even if the socket drops).
 */
function sendViaWatcherWS(host: string, payload: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const ws = new WebSocket(watcherWSURL(host));
      const timer = window.setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        done();
      }, 1500);
      ws.onopen = () => {
        try {
          ws.send(payload);
        } catch {
          // ignore
        }
        window.setTimeout(() => {
          try {
            ws.close();
          } catch {
            // ignore
          }
          window.clearTimeout(timer);
          done();
        }, 400);
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        done();
      };
    } catch {
      done();
    }
  });
}

export async function sendDecision(host: string, decision: ConfigDecision): Promise<void> {
  const clean = host.trim();
  if (!isConfigHostId(clean)) return;
  const payload = JSON.stringify({ type: "decision", host: clean, decision });
  // Fast relay + durable POST in parallel: the CLI learns instantly and the
  // decision persists even if the socket drops. Allow clicks feel instant.
  const post = fetch(decision === "allowed" ? allowURL(clean) : denyURL(clean), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  }).catch(() => undefined);
  await Promise.all([sendViaWatcherWS(clean, payload).catch(() => undefined), post]);
}

export function allowHost(host: string): Promise<void> {
  return sendDecision(host, "allowed");
}

export function denyHost(host: string): Promise<void> {
  return sendDecision(host, "denied");
}

/**
 * Live presence + config decision for one host id — **deduplicated**.
 * A single WS + poll loop per host is shared across all cards that watch
 * the same host (e.g. 10 tunnels on one host = 1 socket, not 10).
 * Ref-counted: last unsubscriber tears the socket down.
 */
type Listener = (s: PresenceState) => void;

type SharedEntry = {
  state: PresenceState;
  listeners: Set<Listener>;
  ws: WebSocket | null;
  pollTimer: number | null;
  pingTimer: number | null;
  retryTimer: number | null;
  cancelled: boolean;
};

const presenceCache = new Map<string, SharedEntry>();

function createEntry(): SharedEntry {
  return {
    state: { online: null, agents: 0, decision: "pending", tunnels: [] },
    listeners: new Set(),
    ws: null,
    pollTimer: null,
    pingTimer: null,
    retryTimer: null,
    cancelled: false,
  };
}

function notify(entry: SharedEntry) {
  for (const l of entry.listeners) l(entry.state);
}

function patchState(entry: SharedEntry, patch: Partial<PresenceState> | ((s: PresenceState) => PresenceState)) {
  const next = typeof patch === "function" ? (patch as (s: PresenceState) => PresenceState)(entry.state) : { ...entry.state, ...patch };
  // shallow compare tunnels to avoid spurious renders
  const sameTunnels =
    next.tunnels === entry.state.tunnels ||
    (next.tunnels.length === entry.state.tunnels.length && next.tunnels.every((v, i) => v === entry.state.tunnels[i]));
  if (next.online === entry.state.online && next.agents === entry.state.agents && next.decision === entry.state.decision && sameTunnels) return;
  entry.state = next;
  notify(entry);
}

function startShared(host: string, entry: SharedEntry) {
  entry.cancelled = false;

  const poll = async () => {
    try {
      const res = await fetch(statusURL(host), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { online?: boolean; agents?: number; decision?: unknown; tunnels?: unknown };
      if (entry.cancelled) return;
      const d = normalizeDecision(data.decision) ?? "pending";
      const tunnels = Array.isArray(data.tunnels) ? (data.tunnels.filter((t): t is string => typeof t === "string") as string[]) : undefined;
      if (typeof data.online === "boolean") {
        patchState(entry, { online: data.online as boolean, agents: (data.agents as number) ?? 0, decision: d, tunnels: tunnels ?? entry.state.tunnels });
      } else {
        patchState(entry, (s) => ({ ...s, decision: d, tunnels: tunnels ?? s.tunnels }));
      }
    } catch {
      // keep last known state
    }
  };

  const connect = () => {
    if (entry.cancelled) return;
    try {
      entry.ws = new WebSocket(watcherWSURL(host));
    } catch {
      entry.retryTimer = window.setTimeout(connect, 5000) as unknown as number;
      return;
    }
    entry.ws.onmessage = (ev) => {
      if (entry.cancelled) return;
      const raw = String(ev.data);
      try {
        const data = JSON.parse(raw) as { type?: string; online?: boolean; agents?: number; decision?: unknown; tunnels?: unknown };
        if (data && data.type === "decision") {
          const d = normalizeDecision(data.decision) ?? parseDecisionMessage(raw);
          if (d) {
            patchState(entry, (s) => (s.decision === d ? s : { ...s, decision: d }));
            return;
          }
        }
        if (data && data.type === "presence" && typeof data.online === "boolean") {
          const d = normalizeDecision(data.decision) ?? undefined;
          const tunnels = Array.isArray(data.tunnels) ? (data.tunnels.filter((t): t is string => typeof t === "string") as string[]) : undefined;
          patchState(entry, (s) => ({
            online: data.online as boolean,
            agents: (data.agents as number) ?? 0,
            decision: d ?? s.decision,
            tunnels: tunnels ?? s.tunnels,
          }));
          return;
        }
      } catch {
        // fall through
      }
      const d = parseDecisionMessage(raw);
      if (d) patchState(entry, (s) => (s.decision === d ? s : { ...s, decision: d }));
    };
    entry.ws.onclose = () => {
      if (entry.cancelled) return;
      entry.retryTimer = window.setTimeout(connect, 5000) as unknown as number;
    };
    entry.ws.onerror = () => {
      try {
        entry.ws?.close();
      } catch {
        // ignore
      }
    };
  };

  void poll();
  connect();
  entry.pollTimer = window.setInterval(poll, 7000) as unknown as number;
  entry.pingTimer = window.setInterval(() => {
    try {
      if (entry.ws && entry.ws.readyState === WebSocket.OPEN) entry.ws.send('{"type":"ping"}');
    } catch {
      // ignore
    }
  }, 25000) as unknown as number;
}

function stopShared(host: string, entry: SharedEntry) {
  entry.cancelled = true;
  if (entry.pollTimer !== null) window.clearInterval(entry.pollTimer);
  if (entry.pingTimer !== null) window.clearInterval(entry.pingTimer);
  if (entry.retryTimer !== null) window.clearTimeout(entry.retryTimer);
  entry.pollTimer = entry.pingTimer = entry.retryTimer = null;
  try {
    entry.ws?.close();
  } catch {
    // ignore
  }
  entry.ws = null;
  presenceCache.delete(host);
}

function subscribePresence(host: string, cb: Listener): () => void {
  let entry = presenceCache.get(host);
  if (!entry) {
    entry = createEntry();
    presenceCache.set(host, entry);
    startShared(host, entry);
  }
  entry.listeners.add(cb);
  // push current state immediately (next tick to avoid sync setState during render)
  queueMicrotask(() => cb(entry!.state));
  return () => {
    const e = presenceCache.get(host);
    if (!e) return;
    e.listeners.delete(cb);
    if (e.listeners.size === 0) stopShared(host, e);
  };
}

export function useHostPresence(host: string | null): PresenceState {
  const [state, setState] = useState<PresenceState>({ online: null, agents: 0, decision: "pending", tunnels: [] });

  useEffect(() => {
    if (!host || !isConfigHostId(host)) {
      setState({ online: null, agents: 0, decision: "pending", tunnels: [] });
      return;
    }
    return subscribePresence(host, setState);
  }, [host]);

  return state;
}
