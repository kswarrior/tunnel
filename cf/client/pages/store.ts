import { useCallback, useEffect, useState } from "react";
import type { Host, Provider, Tunnel } from "./types";

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — keep in-memory state only
  }
}

export function isTunnelName(value: string): boolean {
  return /^[a-z0-9-]{2,32}$/.test(value.trim());
}

/** Slug like /hello — stored without the leading slash. */
export function normalizeSlug(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

export function isSlug(value: string): boolean {
  return /^[a-z0-9-]{2,32}$/.test(normalizeSlug(value));
}

export const TUNNEL_TYPES = ["HTTP"] as const;

export function isTarget(value: string): boolean {
  return /^[A-Za-z0-9_.-]+:\d{1,5}$/.test(value.trim());
}

export function isHostname(value: string): boolean {
  return /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value.trim());
}

function useCollection<T extends { id: string }>(
  key: string,
  isDuplicate?: (prev: T, next: T) => boolean,
) {
  const [items, setItems] = useState<T[]>(() => {
    const initial = read<T>(key);
    // Heal legacy duplicates already sitting in localStorage
    // (e.g. two cards for the same hostname after Allow).
    if (!isDuplicate || initial.length < 2) return initial;
    const healed: T[] = [];
    for (const item of initial) {
      if (!healed.some((h) => h.id === item.id || isDuplicate(h, item))) healed.push(item);
    }
    if (healed.length !== initial.length) write(key, healed);
    return healed;
  });

  const add = useCallback(
    (item: T) => {
      setItems((prev) => {
        // Functional update = always fresh: back-to-back adds
        // (Allow click + allowed-watcher effect) can't both slip through.
        if (prev.some((p) => p.id === item.id || (isDuplicate && isDuplicate(p, item)))) {
          return prev;
        }
        const next = [...prev, item];
        write(key, next);
        return next;
      });
    },
    [key, isDuplicate],
  );

  const remove = useCallback(
    (id: string) => {
      setItems((prev) => {
        const next = prev.filter((i) => i.id !== id);
        write(key, next);
        return next;
      });
    },
    [key],
  );

  const update = useCallback(
    (id: string, patch: Partial<T>) => {
      setItems((prev) => {
        const next = prev.map((i) => (i.id === id ? { ...i, ...patch } : i));
        write(key, next);
        return next;
      });
    },
    [key],
  );

  return { items, add, remove, update };
}

export function newTunnel(
  name: string,
  target: string,
  opts?: { slug?: string; tunnelType?: string; hostId?: string; providerId?: string },
): Tunnel {
  const cleanName = name.trim();
  const slug = normalizeSlug(opts?.slug ?? cleanName);
  return {
    id: makeId(),
    name: cleanName,
    slug,
    tunnelType: opts?.tunnelType ?? "HTTP",
    target: target.trim(),
    hostId: (opts?.hostId ?? "").trim(),
    providerId: (opts?.providerId ?? "").trim(),
    active: false,
    createdAt: Date.now(),
  };
}

export function newHost(hostname: string, tunnel: string): Host {
  return { id: makeId(), hostname: hostname.trim(), tunnel: tunnel.trim(), createdAt: Date.now() };
}

function healTunnel(raw: Tunnel): Tunnel {
  const r = raw as Partial<Tunnel> & { target?: string };
  const name = typeof r.name === "string" ? r.name : "";
  const slug = typeof r.slug === "string" && r.slug
    ? normalizeSlug(r.slug)
    : normalizeSlug(name);
  return {
    id: r.id ?? makeId(),
    name,
    slug,
    tunnelType: typeof r.tunnelType === "string" && r.tunnelType ? r.tunnelType : "HTTP",
    target: typeof r.target === "string" ? r.target : "",
    hostId: typeof r.hostId === "string" ? r.hostId : "",
    providerId: typeof r.providerId === "string" ? r.providerId : "",
    active: !!r.active,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
  };
}

export function newProvider(name: string, kind: string): Provider {
  return { id: makeId(), name: name.trim(), kind, active: true, createdAt: Date.now() };
}

export const DEFAULT_PROVIDER_NAME = "KS Tunnel";

export function useTunnels() {
  const col = useCollection<Tunnel>("ks-tunnels");
  // Heal legacy tunnels saved before slug/type/host/provider existed.
  // Runs once per items change; writes back only when healing changed something.
  const healed = col.items.map(healTunnel);
  const needsHeal = healed.some((h, i) => {
    const o = col.items[i] as Partial<Tunnel>;
    return o.slug !== h.slug || o.tunnelType !== h.tunnelType || o.hostId !== h.hostId || o.providerId !== h.providerId;
  });
  if (needsHeal) {
    // Defer write to avoid setState-in-render loops; persist healed shape.
    try {
      localStorage.setItem("ks-tunnels", JSON.stringify(healed));
    } catch {
      // ignore
    }
    // Return healed view immediately so the form/dropdowns work.
    return { ...col, items: healed };
  }
  return col;
}

export function useHosts() {
  // Same hostname (case-insensitive) = same host, even with different ids.
  return useCollection<Host>("ks-hosts", sameHostname);
}

function sameHostname(a: Host, b: Host): boolean {
  return a.hostname.trim().toLowerCase() === b.hostname.trim().toLowerCase();
}

export function useProviders() {
  const col = useCollection<Provider>("ks-providers");
  // Seed one provider already called "KS Tunnel" so the tunnel form
  // always has a provider to pick.
  const hasDefault = col.items.some(
    (p) => p.name.trim().toLowerCase() === DEFAULT_PROVIDER_NAME.toLowerCase(),
  );
  if (!hasDefault && typeof window !== "undefined") {
    try {
      const seeded: Provider = {
        id: makeId(),
        name: DEFAULT_PROVIDER_NAME,
        kind: "Cloudflare Workers",
        active: true,
        createdAt: Date.now(),
      };
      const next = [...col.items, seeded];
      localStorage.setItem("ks-providers", JSON.stringify(next));
      return { ...col, items: next };
    } catch {
      // storage unavailable — fall through with in-memory items
    }
  }
  return col;
}
