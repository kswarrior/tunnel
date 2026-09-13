import { useState } from "react";
import { Modal } from "../components/Modal";
import {
  CloudIcon,
  EntityCard,
  PencilIcon,
  PowerIcon,
  TrashIcon,
} from "../components/EntityCard";
import { DEFAULT_PROVIDER_NAME, newProvider } from "./store";
import type { Provider, Tunnel } from "./types";

const KINDS = ["Cloudflare Workers", "Custom", "Local"] as const;

interface ProvidersPageProps {
  providers: Provider[];
  tunnels: Tunnel[];
  onAdd: (p: Provider) => void;
  onToggle: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Provider>) => void;
  onRemove: (id: string) => void;
}

function isDefaultProvider(p: Provider): boolean {
  return p.name.trim().toLowerCase() === DEFAULT_PROVIDER_NAME.toLowerCase();
}

export function ProvidersPage({ providers, tunnels, onAdd, onToggle, onUpdate, onRemove }: ProvidersPageProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>(KINDS[0]);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Provider | null>(null);
  const [pendingEdit, setPendingEdit] = useState<Provider | null>(null);
  const [editName, setEditName] = useState("");
  const [editKind, setEditKind] = useState<string>(KINDS[0]);
  const [editError, setEditError] = useState<string | null>(null);

  const openAdd = () => {
    setAdding(true);
    setFormError(null);
  };

  const closeAdd = () => {
    setAdding(false);
    setName("");
    setKind(KINDS[0]);
    setFormError(null);
  };

  const openEdit = (p: Provider) => {
    setPendingEdit(p);
    setEditName(p.name);
    setEditKind(p.kind);
    setEditError(null);
  };

  const closeEdit = () => {
    setPendingEdit(null);
    setEditName("");
    setEditKind(KINDS[0]);
    setEditError(null);
  };

  const handleEdit = () => {
    if (!pendingEdit) return;
    if (editName.trim().length < 2) {
      setEditError("Name must be at least 2 characters.");
      return;
    }
    if (providers.some((p) => p.id !== pendingEdit.id && p.name.trim().toLowerCase() === editName.trim().toLowerCase())) {
      setEditError("A provider with this name already exists.");
      return;
    }
    onUpdate(pendingEdit.id, { name: editName.trim(), kind: editKind });
    closeEdit();
  };

  const handleAdd = () => {
    if (name.trim().length < 2) {
      setFormError("Name must be at least 2 characters.");
      return;
    }
    if (providers.some((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      setFormError("A provider with this name already exists.");
      return;
    }
    onAdd(newProvider(name, kind));
    closeAdd();
  };

  const pendingInUse = pendingDelete ? tunnels.filter((t) => t.providerId === pendingDelete.id) : [];

  if (adding) {
    return (
      <div className="container">
        <div className="page-head">
          <div>
            <h1>Add provider</h1>
          </div>
          <button type="button" className="btn" onClick={closeAdd}>
            Back
          </button>
        </div>

        <section className="card">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAdd();
            }}
          >
            <label className="label" htmlFor="provider-name">Name</label>
            <input
              id="provider-name"
              className="input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="My Workers account"
              autoFocus
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
              <button type="button" className="btn" onClick={closeAdd}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save
              </button>
            </div>
          </form>
        </section>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1 className="page-title">Providers <span className="badge">{providers.length}</span></h1>
        </div>
        <button type="button" className="btn btn-primary" onClick={openAdd}>
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
            <EntityCard
              key={p.id}
              icon={<CloudIcon />}
              name={p.name}
              label={
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  {isDefaultProvider(p) && <span className="badge">Default</span>}
                  <span className={`badge${p.active ? " badge-on" : ""}`}>
                    {p.active ? "Active" : "Off"}
                  </span>
                </span>
              }
              notes={p.kind}
              actions={[
                {
                  key: "toggle",
                  label: p.active ? "Disable" : "Enable",
                  icon: <PowerIcon />,
                  onClick: () => onToggle(p.id),
                  danger: p.active,
                  positive: !p.active,
                },
                {
                  key: "edit",
                  label: "Edit",
                  icon: <PencilIcon />,
                  onClick: () => openEdit(p),
                },
                {
                  key: "delete",
                  label: "Delete",
                  icon: <TrashIcon />,
                  onClick: () => setPendingDelete(p),
                  danger: true,
                },
              ]}
            />
          ))}
        </div>
      )}

      <Modal open={pendingEdit !== null} title="Edit provider" onClose={closeEdit}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleEdit();
          }}
        >
          <label className="label" htmlFor="provider-edit-name">Name</label>
          <input
            id="provider-edit-name"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="My Workers account"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <label className="label" htmlFor="provider-edit-kind">Type</label>
          <select
            id="provider-edit-kind"
            className="input"
            value={editKind}
            onChange={(e) => setEditKind(e.target.value)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {editError && <p className="error">{editError}</p>}
          <div className="row">
            <button type="button" className="btn" onClick={closeEdit}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Save
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={pendingDelete !== null} title="Delete provider" onClose={() => setPendingDelete(null)}>
        <p>
          Delete <strong>{pendingDelete?.name}</strong>? This cannot be undone.
        </p>
        {pendingDelete && isDefaultProvider(pendingDelete) && (
          <p className="muted">
            This is the default provider — new tunnels won't have one pre-selected after it's gone.
          </p>
        )}
        {pendingInUse.length > 0 && (
          <p className="error">
            {pendingInUse.length} tunnel(s) use this provider ({pendingInUse.map((t) => t.name).join(", ")}).
            Deleting unlinks them.
          </p>
        )}
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
