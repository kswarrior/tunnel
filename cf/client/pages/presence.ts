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

export type PresenceState = {
  online: boolean | null;
  agents: number;
  decision: ConfigDecision;
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
  // Fast relay first (CLI learns instantly), then durable POST.
  await sendViaWatcherWS(clean, payload).catch(() => undefined);
  try {
    await fetch(decision === "allowed" ? allowURL(clean) : denyURL(clean), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
  } catch {
    // WS relay already attempted; offline POST just means the next poll/WS wins.
  }
}

export function allowHost(host: string): Promise<void> {
  return sendDecision(host, "allowed");
}

export function denyHost(host: string): Promise<void> {
  return sendDecision(host, "denied");
}

/**
 * Live presence + config decision for one host id.
 * Opens a watcher WebSocket for instant updates and polls the HTTP status
 * endpoint every 7s as a fallback/reconciler.
 * Missing/404 decision counts as "pending" (not decided yet = OK, keep waiting).
 */
export function useHostPresence(host: string | null): PresenceState {
  const [state, setState] = useState<PresenceState>({ online: null, agents: 0, decision: "pending" });

  useEffect(() => {
    if (!host || !isConfigHostId(host)) {
      setState({ online: null, agents: 0, decision: "pending" });
      return;
    }
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pollTimer: number | null = null;
    let retryTimer: number | null = null;

    const applyDecision = (raw: string) => {
      const d = parseDecisionMessage(raw);
      if (d && !cancelled) {
        setState((s) => (s.decision === d ? s : { ...s, decision: d }));
      }
    };

    const poll = async () => {
      try {
        const res = await fetch(statusURL(host), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { online?: boolean; agents?: number; decision?: unknown };
        if (cancelled) return;
        const d = normalizeDecision(data.decision) ?? "pending";
        if (typeof data.online === "boolean") {
          setState((s) => ({ online: data.online as boolean, agents: data.agents ?? 0, decision: d }));
        } else {
          setState((s) => ({ ...s, decision: d }));
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
        const raw = String(ev.data);
        try {
          const data = JSON.parse(raw) as {
            type?: string;
            online?: boolean;
            agents?: number;
            host?: string;
            decision?: unknown;
          };
          if (data && data.type === "decision") {
            const d = normalizeDecision(data.decision) ?? parseDecisionMessage(raw);
            if (d) {
              setState((s) => ({ ...s, decision: d }));
              return;
            }
          }
          if (data && data.type === "presence" && typeof data.online === "boolean") {
            const d = normalizeDecision(data.decision) ?? undefined;
            setState((s) => ({
              online: data.online as boolean,
              agents: data.agents ?? 0,
              decision: d ?? s.decision,
            }));
            return;
          }
        } catch {
          // fall through to raw decision parse
        }
        applyDecision(raw);
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
