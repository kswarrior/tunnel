import { useCallback, useState } from "react";
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

export function isTarget(value: string): boolean {
  return /^[A-Za-z0-9_.-]+:\d{1,5}$/.test(value.trim());
}

export function isHostname(value: string): boolean {
  return /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value.trim());
}

function useCollection<T extends { id: string }>(key: string) {
  const [items, setItems] = useState<T[]>(() => read<T>(key));

  const add = useCallback(
    (item: T) => {
      setItems((prev) => {
        const next = [...prev, item];
        write(key, next);
        return next;
      });
    },
    [key],
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

export function newTunnel(name: string, target: string): Tunnel {
  return { id: makeId(), name: name.trim(), target: target.trim(), active: false, createdAt: Date.now() };
}

export function newHost(hostname: string, tunnel: string): Host {
  return { id: makeId(), hostname: hostname.trim(), tunnel: tunnel.trim(), createdAt: Date.now() };
}

export function newProvider(name: string, kind: string): Provider {
  return { id: makeId(), name: name.trim(), kind, active: true, createdAt: Date.now() };
}

export function useTunnels() {
  return useCollection<Tunnel>("ks-tunnels");
}

export function useHosts() {
  return useCollection<Host>("ks-hosts");
}

export function useProviders() {
  return useCollection<Provider>("ks-providers");
}
