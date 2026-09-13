export type WorkerStatus = {
  loading: boolean;
  error: string | null;
  message: string | null;
  timestamp: string | null;
  healthy: boolean | null;
};

export type TunnelSettings = {
  serverUrl: string;
  defaultTunnel: string;
};

const SETTINGS_KEY = "ks-tunnel-settings";

export function loadSettings(): TunnelSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { serverUrl: "", defaultTunnel: "exampletunnel" };
    const parsed = JSON.parse(raw) as Partial<TunnelSettings>;
    return {
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : "",
      defaultTunnel:
        typeof parsed.defaultTunnel === "string" && parsed.defaultTunnel.trim() !== ""
          ? parsed.defaultTunnel
          : "exampletunnel",
    };
  } catch {
    return { serverUrl: "", defaultTunnel: "exampletunnel" };
  }
}

export function saveSettings(value: TunnelSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
}
