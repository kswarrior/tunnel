import { useMemo, useState } from "react";
import { Modal } from "../components/Modal";
import {
  EntityCard,
  PencilIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
  TunnelIcon,
} from "../components/EntityCard";
import {
  TUNNEL_TYPES,
  isSlug,
  isTarget,
  isTunnelName,
  newTunnel,
  normalizeSlug,
} from "./store";
import type { Host, Provider, Tunnel } from "./types";

interface TunnelsPageProps {
  tunnels: Tunnel[];
  hosts: Host[];
  providers: Provider[];
  onAdd: (t: Tunnel) => void;
  onToggle: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Tunnel>) => void;
  onRemove: (id: string) => void;
}

function hostToken(hosts: Host[], hostId: string): string {
  const h = hosts.find((x) => x.id === hostId);
  return h ? h.hostname.trim() : "";
}

function hostName(hosts: Host[], hostId: string): string {
  const h = hosts.find((x) => x.id === hostId);
  return h ? h.hostname : "—";
}

function providerName(providers: Provider[], providerId: string): string {
  const p = providers.find((x) => x.id === providerId);
  return p ? p.name : "—";
}

/** Publish slug -> host mapping so visitors hitting /<slug> can be proxied. */
async function publishTunnel(t: Tunnel, hosts: Host[]): Promise<void> {
  try {
    const host = hostToken(hosts, t.hostId);
    await fetch("/api/tunnels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: t.slug,
        host,
        target: t.target,
        name: t.name,
        tunnelType: t.tunnelType,
      }),
    });
  } catch {
    // offline registry just means the public route 404s until the next save
  }
}

async function unpublishTunnel(slug: string): Promise<void> {
  try {
    await fetch(`/api/tunnels/${encodeURIComponent(slug)}`, { method: "DELETE" });
  } catch {
    // ignore
  }
}

function tunnelWSS(t: Tunnel, hosts: Host[]): string {
  const host = hostToken(hosts, t.hostId);
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/tunnels/ws?host=${encodeURIComponent(host)}&slug=${encodeURIComponent(t.slug)}`;
}

function mainWSS(hosts: Host[], hostId: string): string {
  const host = hostToken(hosts, hostId);
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/agent/ws?host=${encodeURIComponent(host)}`;
}

export function TunnelsPage({ tunnels, hosts, providers, onAdd, onToggle, onUpdate, onRemove }: TunnelsPageProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [tunnelType, setTunnelType] = useState<string>(TUNNEL_TYPES[0]);
  const [target, setTarget] = useState("");
  const [hostId, setHostId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null);
  const [pendingEdit, setPendingEdit] = useState<Tunnel | null>(null);
  const [editName, setEditName] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editType, setEditType] = useState<string>(TUNNEL_TYPES[0]);
  const [editTarget, setEditTarget] = useState("");
  const [editHostId, setEditHostId] = useState("");
  const [editProviderId, setEditProviderId] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  // Default the dropdowns to the first host + "KS Tunnel" provider when opened.
  const defaultHostId = useMemo(() => hosts[0]?.id ?? "", [hosts]);
  const defaultProviderId = useMemo(() => {
    const ks = providers.find((p) => p.name.trim().toLowerCase() === "ks tunnel");
    return (ks ?? providers[0])?.id ?? "";
  }, [providers]);

  const openModal = () => {
    setModalOpen(true);
    setFormError(null);
    if (!hostId && defaultHostId) setHostId(defaultHostId);
    if (!providerId && defaultProviderId) setProviderId(defaultProviderId);
  };

  const closeModal = () => {
    setModalOpen(false);
    setName("");
    setSlug("");
    setTunnelType(TUNNEL_TYPES[0]);
    setTarget("");
    setHostId("");
    setProviderId("");
    setFormError(null);
  };

  const openEdit = (t: Tunnel) => {
    setPendingEdit(t);
    setEditName(t.name);
    setEditSlug(t.slug);
    setEditType(t.tunnelType || TUNNEL_TYPES[0]);
    setEditTarget(t.target);
    setEditHostId(t.hostId);
    setEditProviderId(t.providerId);
    setEditError(null);
  };

  const closeEdit = () => {
    setPendingEdit(null);
    setEditName("");
    setEditSlug("");
    setEditType(TUNNEL_TYPES[0]);
    setEditTarget("");
    setEditHostId("");
    setEditProviderId("");
    setEditError(null);
  };

  const validate = (
    v: { name: string; slug: string; target: string; hostId: string; providerId: string },
    ignoreId?: string,
  ): string | null => {
    if (!isTunnelName(v.name)) return "Name must be 2-32 chars: a-z, 0-9, hyphen.";
    if (!isSlug(v.slug)) return "Slug must look like /hello (2-32 chars: a-z, 0-9, hyphen).";
    const cleanSlug = normalizeSlug(v.slug);
    if (tunnels.some((t) => t.id !== ignoreId && normalizeSlug(t.slug) === cleanSlug)) {
      return `Slug /${cleanSlug} is already used by another tunnel.`;
    }
    if (tunnels.some((t) => t.id !== ignoreId && t.name === v.name.trim())) {
      return "A tunnel with this name already exists.";
    }
    if (!isTarget(v.target)) return "URL must look like host:port, e.g. 127.0.0.1:4757.";
    if (hosts.length > 0 && !v.hostId) return "Pick a host — this is where the CLI serves the URL from.";
    if (v.hostId && !hosts.some((h) => h.id === v.hostId)) return "Selected host no longer exists.";
    if (providers.length > 0 && !v.providerId) return "Pick a provider.";
    if (v.providerId && !providers.some((p) => p.id === v.providerId)) {
      return "Selected provider no longer exists.";
    }
    return null;
  };

  const handleAdd = () => {
    const err = validate({ name, slug: slug || name, target, hostId, providerId });
    if (err) {
      setFormError(err);
      return;
    }
    const t = newTunnel(name, target, {
      slug: normalizeSlug(slug || name),
      tunnelType,
      hostId,
      providerId,
    });
    onAdd(t);
    void publishTunnel(t, hosts);
    closeModal();
  };

  const handleEdit = () => {
    if (!pendingEdit) return;
    const err = validate(
      { name: editName, slug: editSlug, target: editTarget, hostId: editHostId, providerId: editProviderId },
      pendingEdit.id,
    );
    if (err) {
      setEditError(err);
      return;
    }
    const patch: Partial<Tunnel> = {
      name: editName.trim(),
      slug: normalizeSlug(editSlug),
      tunnelType: editType,
      target: editTarget.trim(),
      hostId: editHostId,
      providerId: editProviderId,
    };
    onUpdate(pendingEdit.id, patch);
    void publishTunnel({ ...pendingEdit, ...patch } as Tunnel, hosts);
    closeEdit();
  };

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>Tunnels</h1>
          <p className="muted">{tunnels.length === 0 ? "No tunnels yet." : `${tunnels.length} tunnel(s).`}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openModal}>
          Add tunnel
        </button>
      </div>

      {tunnels.length === 0 ? (
        <section className="card">
          <p className="muted">Nothing here. Add your first tunnel to get started.</p>
          <code className="code">visit /hello to see 127.0.0.1:4757 via wss (cli → workers → you, fullscreen)</code>
        </section>
      ) : (
        <div className="cards">
          {tunnels.map((t) => {
            const token = hostToken(hosts, t.hostId);
            return (
              <EntityCard
                key={t.id}
                icon={<TunnelIcon />}
                name={t.name}
                label={
                  <span className={`badge${t.active ? " badge-on" : ""}`}>
                    {t.active ? "Running" : "Stopped"}
                  </span>
                }
                notes={
                  <span>
                    <code className="code">/{t.slug} → {t.target}</code>
                    <span className="muted">
                      {t.tunnelType} · host {hostName(hosts, t.hostId)} · {providerName(providers, t.providerId)}
                    </span>
                    {token && (
                      <span className="muted" style={{ display: "block", marginTop: 4 }}>
                        per-tunnel wss: <code>/api/tunnels/ws?host={token}&amp;slug={t.slug}</code>
                        <br />
                        main wss (cf ↔ cli): <code>/api/agent/ws?host={token}</code>
                        <br />
                        cli: <code>kstunnel --host {token} --tunnel {t.slug} --target {t.target}</code>
                      </span>
                    )}
                  </span>
                }
                actions={[
                  {
                    key: "toggle",
                    label: t.active ? "Stop" : "Start",
                    icon: t.active ? <StopIcon /> : <PlayIcon />,
                    onClick: () => onToggle(t.id),
                  },
                  {
                    key: "edit",
                    label: "Edit",
                    icon: <PencilIcon />,
                    onClick: () => openEdit(t),
                  },
                  {
                    key: "delete",
                    label: "Delete",
                    icon: <TrashIcon />,
                    onClick: () => setPendingDelete(t),
                    danger: true,
                  },
                ]}
              />
            );
          })}
        </div>
      )}

      <Modal open={modalOpen} title="Add tunnel" onClose={closeModal} wide>
        <div className="form-grid">
          <div>
            <label className="label" htmlFor="tunnel-name">Name</label>
            <input
              id="tunnel-name"
              className="input"
              type="text"
              autoComplete="off"
              placeholder="hello"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tunnel-slug">Slug (like /hello)</label>
            <input
              id="tunnel-slug"
              className="input"
              type="text"
              autoComplete="off"
              placeholder="/hello"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tunnel-type">Type (HTTP only yet)</label>
            <select
              id="tunnel-type"
              className="input"
              value={tunnelType}
              onChange={(e) => setTunnelType(e.target.value)}
            >
              {TUNNEL_TYPES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tunnel-target">URL (like 127.0.0.1:4757)</label>
            <input
              id="tunnel-target"
              className="input"
              type="text"
              autoComplete="off"
              inputMode="numeric"
              placeholder="127.0.0.1:4757"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tunnel-host">Host (selection drop down)</label>
            <select
              id="tunnel-host"
              className="input"
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
            >
              <option value="">{hosts.length === 0 ? "No hosts yet — allow one first" : "Select host…"}</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.hostname}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tunnel-provider">Providers Drop down</label>
            <select
              id="tunnel-provider"
              className="input"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              <option value="">{providers.length === 0 ? "No providers yet" : "Select provider…"}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {formError && <p className="error">{formError}</p>}
        <p className="muted" style={{ fontSize: 12 }}>
          Visiting <code>/{normalizeSlug(slug || name) || "hello"}</code> shows <code>{target || "127.0.0.1:4757"}</code> of
          that host — proxied fullscreen via wss (cli → workers → you). One wss per tunnel + one main wss
          (cf ↔ cli) for control.
        </p>
        <div className="row">
          <button type="button" className="btn" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleAdd}>
            Save
          </button>
        </div>
      </Modal>

      <Modal open={pendingEdit !== null} title="Edit tunnel" onClose={closeEdit} wide>
        <div className="form-grid">
          <div>
            <label className="label" htmlFor="tunnel-edit-name">Name</label>
            <input
              id="tunnel-edit-name"
              className="input"
              type="text"
              autoComplete="off"
              placeholder="hello"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tunnel-edit-slug">Slug (like /hello)</label>
            <input
              id="tunnel-edit-slug"
              className="input"
              type="text"
              autoComplete="off"
              placeholder="/hello"
              value={editSlug}
              onChange={(e) => setEditSlug(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tunnel-edit-type">Type (HTTP only yet)</label>
            <select
              id="tunnel-edit-type"
              className="input"
              value={editType}
              onChange={(e) => setEditType(e.target.value)}
            >
              {TUNNEL_TYPES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tunnel-edit-target">URL (like 127.0.0.1:4757)</label>
            <input
              id="tunnel-edit-target"
              className="input"
              type="text"
              autoComplete="off"
              inputMode="numeric"
              placeholder="127.0.0.1:4757"
              value={editTarget}
              onChange={(e) => setEditTarget(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tunnel-edit-host">Host (selection drop down)</label>
            <select
              id="tunnel-edit-host"
              className="input"
              value={editHostId}
              onChange={(e) => setEditHostId(e.target.value)}
            >
              <option value="">{hosts.length === 0 ? "No hosts yet — allow one first" : "Select host…"}</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.hostname}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tunnel-edit-provider">Providers Drop down</label>
            <select
              id="tunnel-edit-provider"
              className="input"
              value={editProviderId}
              onChange={(e) => setEditProviderId(e.target.value)}
            >
              <option value="">{providers.length === 0 ? "No providers yet" : "Select provider…"}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
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
              if (pendingDelete) {
                void unpublishTunnel(pendingDelete.slug);
                onRemove(pendingDelete.id);
              }
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

// Re-exported for cards that want the live endpoint shapes.
export { tunnelWSS, mainWSS };
