import { useState } from "react";
import { Modal } from "../components/Modal";
import { isTarget, isTunnelName, newTunnel } from "./store";
import type { Tunnel } from "./types";

interface TunnelsPageProps {
  tunnels: Tunnel[];
  onAdd: (t: Tunnel) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

export function TunnelsPage({ tunnels, onAdd, onToggle, onRemove }: TunnelsPageProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null);

  const closeModal = () => {
    setModalOpen(false);
    setName("");
    setTarget("");
    setFormError(null);
  };

  const handleAdd = () => {
    if (!isTunnelName(name)) {
      setFormError("Name must be 2-32 chars: a-z, 0-9, hyphen.");
      return;
    }
    if (!isTarget(target)) {
      setFormError("Target must look like host:port, e.g. 127.0.0.1:3000.");
      return;
    }
    if (tunnels.some((t) => t.name === name.trim())) {
      setFormError("A tunnel with this name already exists.");
      return;
    }
    onAdd(newTunnel(name, target));
    closeModal();
  };

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>Tunnels</h1>
          <p className="muted">{tunnels.length === 0 ? "No tunnels yet." : `${tunnels.length} tunnel(s).`}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
          Add tunnel
        </button>
      </div>

      {tunnels.length === 0 ? (
        <section className="card">
          <p className="muted">Nothing here. Add your first tunnel to get started.</p>
          <code className="code">./release/kstunnel/kstunnel --tunnel exampletunnel --target 127.0.0.1:3000</code>
        </section>
      ) : (
        <div className="cards">
          {tunnels.map((t) => (
            <article key={t.id} className="item-card">
              <div className="item-top">
                <strong>{t.name}</strong>
                <span className={`badge${t.active ? " badge-on" : ""}`}>
                  {t.active ? "Active" : "Offline"}
                </span>
              </div>
              <code className="code">{t.target}</code>
              <div className="item-actions">
                <button type="button" className="btn" onClick={() => onToggle(t.id)}>
                  {t.active ? "Stop" : "Start"}
                </button>
                <button type="button" className="btn" onClick={() => setPendingDelete(t)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal open={modalOpen} title="Add tunnel" onClose={closeModal}>
        <label className="label" htmlFor="tunnel-name">Name</label>
        <input
          id="tunnel-name"
          className="input"
          type="text"
          autoComplete="off"
          placeholder="exampletunnel"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="label" htmlFor="tunnel-target">Target host:port</label>
        <input
          id="tunnel-target"
          className="input"
          type="text"
          autoComplete="off"
          inputMode="numeric"
          placeholder="127.0.0.1:3000"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
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

      <Modal open={pendingDelete !== null} title="Delete tunnel" onClose={() => setPendingDelete(null)}>
        <p>
          Delete <strong>{pendingDelete?.name}</strong>? This cannot be undone.
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
