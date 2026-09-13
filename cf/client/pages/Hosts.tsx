import { useState } from "react";
import { Modal } from "../components/Modal";
import {
  EntityCard,
  GlobeIcon,
  PencilIcon,
  TrashIcon,
} from "../components/EntityCard";
import { isHostname, newHost } from "./store";
import { useHostPresence, CONFIG_HOST_RE } from "./presence";
import type { Host } from "./types";

interface HostsPageProps {
  hosts: Host[];
  onAdd: (h: Host) => void;
  onUpdate: (id: string, patch: Partial<Host>) => void;
  onRemove: (id: string) => void;
}

function HostCard({
  host,
  onEdit,
  onDelete,
}: {
  host: Host;
  onEdit: (h: Host) => void;
  onDelete: (h: Host) => void;
}) {
  // Only CLI-style ids have live WSS presence; plain hostnames stay "Saved".
  // Token-like ids saved via Allow immediately show Connected/Offline.
  const probe = CONFIG_HOST_RE.test(host.hostname.trim()) ? host.hostname.trim() : null;
  const presence = useHostPresence(probe);

  const label = !probe ? (
    <span className="badge">Saved</span>
  ) : presence.online === true ? (
    <span className="badge badge-on">Connected</span>
  ) : presence.online === false ? (
    <span className="badge">Offline</span>
  ) : (
    <span className="badge">Checking…</span>
  );

  return (
    <EntityCard
      icon={<GlobeIcon />}
      name={host.hostname}
      label={label}
      notes={host.tunnel ? `Tunnel: ${host.tunnel}` : "No tunnel linked"}
      actions={[
        {
          key: "edit",
          label: "Edit",
          icon: <PencilIcon />,
          onClick: () => onEdit(host),
        },
        {
          key: "delete",
          label: "Delete",
          icon: <TrashIcon />,
          onClick: () => onDelete(host),
          danger: true,
        },
      ]}
    />
  );
}

export function HostsPage({ hosts, onAdd, onUpdate, onRemove }: HostsPageProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [hostname, setHostname] = useState("");
  const [tunnel, setTunnel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Host | null>(null);
  const [pendingEdit, setPendingEdit] = useState<Host | null>(null);
  const [editHostname, setEditHostname] = useState("");
  const [editTunnel, setEditTunnel] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

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

  const openEdit = (h: Host) => {
    setPendingEdit(h);
    setEditHostname(h.hostname);
    setEditTunnel(h.tunnel);
    setEditError(null);
  };

  const closeEdit = () => {
    setPendingEdit(null);
    setEditHostname("");
    setEditTunnel("");
    setEditError(null);
  };

  const handleEdit = () => {
    if (!pendingEdit) return;
    if (!isHostname(editHostname)) {
      setEditError("Enter a valid hostname, e.g. app.example.com.");
      return;
    }
    if (hosts.some((h) => h.id !== pendingEdit.id && h.hostname === editHostname.trim())) {
      setEditError("This host is already added.");
      return;
    }
    onUpdate(pendingEdit.id, { hostname: editHostname.trim(), tunnel: editTunnel.trim() });
    closeEdit();
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
            <HostCard key={h.id} host={h} onEdit={openEdit} onDelete={setPendingDelete} />
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

      <Modal open={pendingEdit !== null} title="Edit host" onClose={closeEdit}>
        <label className="label" htmlFor="host-edit-name">Hostname</label>
        <input
          id="host-edit-name"
          className="input"
          type="text"
          autoComplete="off"
          placeholder="app.example.com"
          value={editHostname}
          onChange={(e) => setEditHostname(e.target.value)}
        />
        <label className="label" htmlFor="host-edit-tunnel">Tunnel (optional)</label>
        <input
          id="host-edit-tunnel"
          className="input"
          type="text"
          autoComplete="off"
          placeholder="exampletunnel"
          value={editTunnel}
          onChange={(e) => setEditTunnel(e.target.value)}
        />
        {editError && <p className="error">{editError}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={closeEdit}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleEdit}>
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
