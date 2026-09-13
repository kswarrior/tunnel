import { useState } from "react";
import { Modal } from "../components/Modal";
import { isHostname, newHost } from "./store";
import type { Host } from "./types";

interface HostsPageProps {
  hosts: Host[];
  onAdd: (h: Host) => void;
  onRemove: (id: string) => void;
}

export function HostsPage({ hosts, onAdd, onRemove }: HostsPageProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [hostname, setHostname] = useState("");
  const [tunnel, setTunnel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Host | null>(null);

  const closeModal = () => {
    setModalOpen(false);
    setHostname("");
    setTunnel("");
    setFormError(null);
  };

  const handleAdd = () => {
    if (!isHostname(hostname)) {
      setFormError("Enter a valid hostname, e.g. app.example.com.");
      return;
    }
    if (hosts.some((h) => h.hostname === hostname.trim())) {
      setFormError("This host is already added.");
      return;
    }
    onAdd(newHost(hostname, tunnel));
    closeModal();
  };

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>Hosts</h1>
          <p className="muted">{hosts.length === 0 ? "No hosts yet." : `${hosts.length} host(s).`}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
          Add host
        </button>
      </div>

      {hosts.length === 0 ? (
        <section className="card">
          <p className="muted">Nothing here. Add the first hostname to route through a tunnel.</p>
        </section>
      ) : (
        <div className="cards">
          {hosts.map((h) => (
            <article key={h.id} className="item-card">
              <div className="item-top">
                <strong>{h.hostname}</strong>
                <span className="badge badge-on">Saved</span>
              </div>
              <p className="muted">{h.tunnel ? `Tunnel: ${h.tunnel}` : "No tunnel linked"}</p>
              <div className="item-actions">
                <button type="button" className="btn" onClick={() => setPendingDelete(h)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal open={modalOpen} title="Add host" onClose={closeModal}>
        <label className="label" htmlFor="host-name">Hostname</label>
        <input
          id="host-name"
          className="input"
          type="text"
          autoComplete="off"
          placeholder="app.example.com"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
        />
        <label className="label" htmlFor="host-tunnel">Tunnel (optional)</label>
        <input
          id="host-tunnel"
          className="input"
          type="text"
          autoComplete="off"
          placeholder="exampletunnel"
          value={tunnel}
          onChange={(e) => setTunnel(e.target.value)}
        />
        {formError && <p className="error">{formError}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleAdd}>
            Save
          </button>
        </div>
      </Modal>

      <Modal open={pendingDelete !== null} title="Delete host" onClose={() => setPendingDelete(null)}>
        <p>
          Delete <strong>{pendingDelete?.hostname}</strong>? This cannot be undone.
        </p>
        <div className="row">
          <button type="button" className="btn" onClick={() => setPendingDelete(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (pendingDelete) onRemove(pendingDelete.id);
              setPendingDelete(null);
            }}
          >
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
