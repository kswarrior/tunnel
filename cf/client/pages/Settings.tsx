import { useState } from "react";
import { loadSettings, saveSettings } from "./types";

export function SettingsPage() {
  const [serverUrl, setServerUrl] = useState(() => loadSettings().serverUrl);
  const [defaultTunnel, setDefaultTunnel] = useState(() => loadSettings().defaultTunnel);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    const name = defaultTunnel.trim();
    if (!/^[a-z0-9-]{2,32}$/.test(name)) {
      setError("Tunnel name must be 2-32 chars: a-z, 0-9, hyphen.");
      setSaved(false);
      return;
    }
    if (serverUrl.trim() !== "") {
      try {
        const url = new URL(serverUrl.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("bad protocol");
        }
      } catch {
        setError("Server URL must be a valid http(s) URL or empty.");
        setSaved(false);
        return;
      }
    }
    saveSettings({ serverUrl: serverUrl.trim(), defaultTunnel: name });
    setDefaultTunnel(name);
    setError(null);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    setServerUrl("");
    setDefaultTunnel("exampletunnel");
    setError(null);
    setSaved(false);
    localStorage.removeItem("ks-tunnel-settings");
  };

  return (
    <div className="container narrow">
      <h1>Settings</h1>
      <p className="muted">Stored locally in this browser.</p>
      <section className="card">
        <label className="label" htmlFor="server-url">
          Server URL (empty = same origin)
        </label>
        <input
          id="server-url"
          className="input"
          type="url"
          inputMode="url"
          placeholder="https://ks-tunnel.workers.dev"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <label className="label" htmlFor="default-tunnel">
          Default tunnel name
        </label>
        <input
          id="default-tunnel"
          className="input"
          type="text"
          autoComplete="off"
          value={defaultTunnel}
          onChange={(e) => setDefaultTunnel(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        {saved && <p className="success">Saved.</p>}
        <div className="row">
          <button type="button" className="btn" onClick={handleReset}>
            Reset
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </section>
    </div>
  );
}
