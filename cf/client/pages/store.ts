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
  const clean = value.trim().replace(/^https?:\/\//i, "").split("/")[0];
  const m = clean.match(/^([A-Za-z0-9_.-]+):(\d{1,5})$/);
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535;
}

export function isHostname(value: string): boolean {
  return /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value.trim());
}

function useCollection<T extends { id: string }>(
  key: string,
  opts?: {
    isDuplicate?: (prev: T, next: T) => boolean;
    /** Normalize legacy rows on first load so state is healed (not just the view). */
    heal?: (raw: T) => T;
    /** True when a healed row differs and must be persisted. */
    needsHeal?: (before: T, after: T) => boolean;
  },
) {
  const isDuplicate = opts?.isDuplicate;
  const [items, setItems] = useState<T[]>(() => {
    let initial = read<T>(key);
    if (opts?.heal) {
      const healed = initial.map((r) => opts.heal!(r));
      if (opts.needsHeal && healed.some((h, i) => opts.needsHeal!(initial[i], h))) {
        write(key, healed);
        initial = healed;
      } else if (!opts.needsHeal) {
        // Persist shape upgrades best-effort (compare by JSON).
        try {
          if (JSON.stringify(initial) !== JSON.stringify(healed)) {
            write(key, healed);
            initial = healed;
          }
        } catch {
          initial = healed;
        }
      }
    }
    // Heal legacy duplicates already sitting in localStorage
    // (e.g. two cards for the same hostname after Allow).
    if (!isDuplicate || initial.length < 2) return initial;
    const deduped: T[] = [];
    for (const item of initial) {
      if (!deduped.some((h) => h.id === item.id || isDuplicate(h, item))) deduped.push(item);
    }
    if (deduped.length !== initial.length) write(key, deduped);
    return deduped;
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
  return useCollection<Tunnel>("ks-tunnels", {
    isDuplicate: sameTunnelSlug,
    heal: healTunnel,
    needsHeal: (before, after) =>
      (before as Partial<Tunnel>).slug !== after.slug ||
      (before as Partial<Tunnel>).tunnelType !== after.tunnelType ||
      (before as Partial<Tunnel>).hostId !== after.hostId ||
      (before as Partial<Tunnel>).providerId !== after.providerId,
  });
}

function sameTunnelSlug(a: Tunnel, b: Tunnel): boolean {
  const sa = normalizeSlug(a.slug || "");
  const sb = normalizeSlug(b.slug || "");
  return !!sa && sa === sb;
}

export function useHosts() {
  // Same hostname (case-insensitive) = same host, even with different ids.
  return useCollection<Host>("ks-hosts", { isDuplicate: sameHostname });
}

function sameHostname(a: Host, b: Host): boolean {
  return a.hostname.trim().toLowerCase() === b.hostname.trim().toLowerCase();
}

export function useProviders() {
  const col = useCollection<Provider>("ks-providers", { isDuplicate: sameProviderName });
  // Seed "KS Tunnel" exactly once: only when the key never existed.
  // (If the user deletes it, it stays deleted — no resurrection loop.)
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded) return;
    let missingKey = false;
    try {
      missingKey = localStorage.getItem("ks-providers") === null;
    } catch {
      missingKey = col.items.length === 0;
    }
    if (missingKey && !col.items.some((p) => sameProviderName(p, { id: "", name: DEFAULT_PROVIDER_NAME } as Provider))) {
      col.add({
        id: makeId(),
        name: DEFAULT_PROVIDER_NAME,
        kind: "Cloudflare Workers",
        active: true,
        createdAt: Date.now(),
      });
    }
    setSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded]);
  return col;
}

function sameProviderName(a: Provider, b: Provider): boolean {
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}
