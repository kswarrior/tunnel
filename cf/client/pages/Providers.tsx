import { useState } from "react";
import { Modal } from "../components/Modal";
import { newProvider } from "./store";
import type { Provider } from "./types";

const KINDS = ["Cloudflare Workers", "Custom", "Local"] as const;

interface ProvidersPageProps {
  providers: Provider[];
  onAdd: (p: Provider) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

export function ProvidersPage({ providers, onAdd, onToggle, onRemove }: ProvidersPageProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>(KINDS[0]);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Provider | null>(null);

  const closeModal = () => {
    setModalOpen(false);
    setName("");
    setKind(KINDS[0]);
    setFormError(null);
  };

  const handleAdd = () => {
    if (name.trim().length < 2) {
      setFormError("Name must be at least 2 characters.");
      return;
    }
    if (providers.some((p) => p.name === name.trim())) {
      setFormError("A provider with this name already exists.");
      return;
    }
    onAdd(newProvider(name, kind));
    closeModal();
  };

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>Providers</h1>
          <p className="muted">{providers.length === 0 ? "No providers yet." : `${providers.length} provider(s).`}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
          Add provider
        </button>
      </div>

      {providers.length === 0 ? (
        <section className="card">
          <p className="muted">Nothing here. Add where your tunnels run.</p>
        </section>
      ) : (
        <div className="cards">
          {providers.map((p) => (
            <article key={p.id} className="item-card">
              <div className="item-top">
                <strong>{p.name}</strong>
                <span className={`badge${p.active ? " badge-on" : ""}`}>
                  {p.active ? "Active" : "Off"}
                </span>
              </div>
              <p className="muted">{p.kind}</p>
              <div className="item-actions">
                <button type="button" className="btn" onClick={() => onToggle(p.id)}>
                  {p.active ? "Disable" : "Enable"}
                </button>
                <button type="button" className="btn" onClick={() => setPendingDelete(p)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal open={modalOpen} title="Add provider" onClose={closeModal}>
        <label className="label" htmlFor="provider-name">Name</label>
        <input
          id="provider-name"
          className="input"
          type="text"
          autoComplete="off"
          placeholder="My Workers account"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="label" htmlFor="provider-kind">Type</label>
        <select
          id="provider-kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
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

      <Modal open={pendingDelete !== null} title="Delete provider" onClose={() => setPendingDelete(null)}>
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
