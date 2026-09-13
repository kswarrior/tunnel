import { useState } from "react";
import { Modal } from "../components/Modal";
import {
  CopyIcon,
  EntityCard,
  GlobeIcon,
  PencilIcon,
  TrashIcon,
} from "../components/EntityCard";
import { isHostname, newHost } from "./store";
import { useHostPresence, CONFIG_HOST_RE, isConfigHostId } from "./presence";
import type { Host, Tunnel } from "./types";

interface HostsPageProps {
  hosts: Host[];
  tunnels: Tunnel[];
  onAdd: (h: Host) => void;
  onUpdate: (id: string, patch: Partial<Host>) => void;
  onRemove: (id: string) => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function HostCard({
  host,
  tunnels,
  onEdit,
  onDelete,
}: {
  host: Host;
  tunnels: Tunnel[];
  onEdit: (h: Host) => void;
  onDelete: (h: Host) => void;
}) {
  // Only CLI-style ids have live WSS presence; plain hostnames stay "Saved".
  // Token-like ids saved via Allow immediately show Connected/Offline + tunnels.
  const token = host.hostname.trim();
  const probe = CONFIG_HOST_RE.test(token) ? token : null;
  const presence = useHostPresence(probe);
  const [copied, setCopied] = useState(false);

  const linked = tunnels.filter((t) => t.hostId === host.id);

  const label = !probe ? (
    <span className="badge">Saved</span>
  ) : presence.online === true ? (
    <span className="badge badge-on">Connected</span>
  ) : presence.online === false ? (
    <span className="badge">Offline</span>
  ) : (
    <span className="badge">Checking…</span>
  );

  const handleCopy = async () => {
    if (await copyText(token)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <EntityCard
      icon={<GlobeIcon />}
      name={host.hostname}
      label={label}
      notes={
        <span>
          <span className="muted">
            {linked.length === 0
              ? "No tunnels linked"
              : `Tunnels: ${linked.map((t) => `/${t.slug}`).join(", ")}`}
          </span>
          {probe && presence.tunnels.length > 0 && (
            <span className="muted" style={{ display: "block" }}>
              Live wss: {presence.tunnels.map((s) => `/${s}`).join(", ")}
            </span>
          )}
          {probe && (
            <span className="muted" style={{ display: "block", marginTop: 4 }}>
              <code>kstunnel --host {token} --tunnel &lt;slug&gt; --target 127.0.0.1:PORT</code>
              {copied && " — id copied!"}
            </span>
          )}
        </span>
      }
      actions={[
        ...(probe
          ? [
              {
                key: "copy",
                label: "Copy host id",
                icon: <CopyIcon />,
                onClick: () => void handleCopy(),
              } as const,
            ]
          : []),
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

export function HostsPage({ hosts, tunnels, onAdd, onUpdate, onRemove }: HostsPageProps) {
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
    const clean = hostname.trim();
    if (!isHostname(clean)) {
      setFormError("Enter a valid hostname or CLI host id (e.g. app.example.com or abcde).");
      return;
    }
    if (hosts.some((h) => h.hostname.trim().toLowerCase() === clean.toLowerCase())) {
      setFormError("This host is already added.");
      return;
    }
    onAdd(newHost(clean, tunnel));
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
    const clean = editHostname.trim();
    if (!isHostname(clean)) {
      setEditError("Enter a valid hostname or CLI host id (e.g. app.example.com or abcde).");
      return;
    }
    if (hosts.some((h) => h.id !== pendingEdit.id && h.hostname.trim().toLowerCase() === clean.toLowerCase())) {
      setEditError("This host is already added.");
      return;
    }
    onUpdate(pendingEdit.id, { hostname: clean, tunnel: editTunnel.trim() });
    closeEdit();
  };

  const pendingLinked = pendingDelete ? tunnels.filter((t) => t.hostId === pendingDelete.id) : [];

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
          <p className="muted">
            Nothing here. Run <code>kstunnel --config:host</code> on the machine you want to expose, open the
            printed Allow link, and it lands here automatically.
          </p>
        </section>
      ) : (
        <div className="cards">
          {hosts.map((h) => (
            <HostCard key={h.id} host={h} tunnels={tunnels} onEdit={openEdit} onDelete={setPendingDelete} />
          ))}
        </div>
      )}

      <Modal open={modalOpen} title="Add host" onClose={closeModal}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <label className="label" htmlFor="host-name">Hostname or CLI host id</label>
          <input
            id="host-name"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="app.example.com or abcde"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
          />
          <p className="muted" style={{ fontSize: 12 }}>
            Tip: CLI machines register via the Allow link — you rarely need to type the id by hand.
            {isConfigHostId(hostname.trim()) && " Looks like a CLI host id — live status will appear."}
          </p>
          <label className="label" htmlFor="host-tunnel">Tunnel (optional)</label>
          <input
            id="host-tunnel"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="exampletunnel"
            value={tunnel}
            onChange={(e) => setTunnel(e.target.value)}
          />
          {formError && <p className="error">{formError}</p>}
          <div className="row">
            <button type="button" className="btn" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Save
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={pendingEdit !== null} title="Edit host" onClose={closeEdit}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleEdit();
          }}
        >
          <label className="label" htmlFor="host-edit-name">Hostname or CLI host id</label>
          <input
            id="host-edit-name"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="app.example.com or abcde"
            value={editHostname}
            onChange={(e) => setEditHostname(e.target.value)}
          />
          <label className="label" htmlFor="host-edit-tunnel">Tunnel (optional)</label>
          <input
            id="host-edit-tunnel"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="exampletunnel"
            value={editTunnel}
            onChange={(e) => setEditTunnel(e.target.value)}
          />
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

      <Modal open={pendingDelete !== null} title="Delete host" onClose={() => setPendingDelete(null)}>
        <p>
          Delete <strong>{pendingDelete?.hostname}</strong>? This cannot be undone.
        </p>
        {pendingLinked.length > 0 && (
          <p className="error">
            {pendingLinked.length} tunnel(s) use this host ({pendingLinked.map((t) => `/${t.slug}`).join(", ")}).
            Deleting unlinks them — their public URLs will go offline until you pick a new host.
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
