import { useState } from "react";
import { Modal } from "../components/Modal";

const LOCAL_KEYS = ["ks-tunnels", "ks-hosts", "ks-providers"] as const;

function clearLocalData() {
  for (const k of LOCAL_KEYS) {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
  // also clear any pending batched writes in memory by forcing reload
  window.location.reload();
}

export function SettingsPage() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="container narrow">
      <h1>Settings</h1>
      <p className="muted">App preferences will live here.</p>

      <section className="card">
        <h2>Danger zone</h2>
        <p className="muted" style={{ margin: "0 0 12px" }}>
          Delete all local data stored in this browser (tunnels, hosts and providers). This only clears
          data on this device — it does not affect the worker registry. The page will reload when done.
        </p>
        <button type="button" className="btn" style={{ color: "var(--danger)", borderColor: "var(--danger-border)", background: "var(--danger-bg)" }} onClick={() => setConfirmOpen(true)}>
          Delete local data
        </button>
      </section>

      <Modal open={confirmOpen} title="Delete local data" onClose={() => setConfirmOpen(false)}>
        <p>
          This will permanently delete <strong>tunnels, hosts and providers</strong> saved in <code>localStorage</code> on this browser
          (<code>{LOCAL_KEYS.join(", ")}</code>). This cannot be undone.
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          Tip: export what you need before deleting. The worker registry ( <code>/!tunnel=...</code> ) is not cleared by this button.
        </p>
        <div className="row">
          <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>
            Cancel
          </button>
          <button type="button" className="btn" style={{ background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }} onClick={clearLocalData}>
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
