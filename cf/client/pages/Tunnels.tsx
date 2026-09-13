import { useEffect, useMemo, useState } from "react";
import { Modal } from "../components/Modal";
import { CheckingPills, Skeleton } from "../components/Skeleton";
import {
  CopyIcon,
  EntityCard,
  OpenIcon,
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
import { isConfigHostId, useHostPresence, useRegistry, type RegistryEntry } from "./presence";
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

/** Publish slug -> host mapping so visitors hitting /<slug> can be proxied. */
async function publishTunnel(t: Tunnel, hosts: Host[]): Promise<void> {
  const host = hostToken(hosts, t.hostId);
  if (!isConfigHostId(host)) {
    throw new Error("pick the CLI host from Hosts first — without a host, /" + t.slug + " can never resolve");
  }
  const res = await fetch("/api/tunnels", {
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
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
}

async function unpublishTunnel(slug: string): Promise<void> {
  try {
    await fetch(`/api/tunnels/${encodeURIComponent(slug)}`, { method: "DELETE" });
  } catch {
    // ignore — orphaned slug simply 404s for visitors
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function TunnelCard({
  tunnel,
  hosts,
  providers,
  registryEntry,
  registryLoading,
  onToggle,
  onEdit,
  onDelete,
}: {
  tunnel: Tunnel;
  hosts: Host[];
  providers: Provider[];
  registryEntry: RegistryEntry | undefined;
  registryLoading: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const token = hostToken(hosts, tunnel.hostId);
  const probe = isConfigHostId(token) ? token : null;
  const presence = useHostPresence(probe);

  const agentKnown = probe !== null;
  const agentOnline = presence.online === true;
  const tunnelLive = presence.tunnels.includes(tunnel.slug);
  const published = !!registryEntry && registryEntry.host === token;
  const targetDrifted = !!registryEntry && registryEntry.target !== tunnel.target;
  // Presence starts unknown (WS + first poll pending) — shimmer instead of
  // flashing "offline" text that flips a moment later. No-host tunnels never
  // check, so they render their final state immediately.
  const checking = agentKnown && presence.online === null;

  const statusBadge = checking ? (
    <Skeleton width={76} height={22} pill label="Checking live status…" />
  ) : tunnelLive ? (
    <span className="badge badge-on">Live</span>
  ) : tunnel.active ? (
    <span className="badge">Enabled (local only — not serving)</span>
  ) : (
    <span className="badge">Stopped</span>
  );

  const publicURL = `/${tunnel.slug}`;
  const cliCmd = token
    ? `kstunnel --host ${token} --tunnel ${tunnel.slug} --target ${tunnel.target}`
    : `kstunnel --host <id> --tunnel ${tunnel.slug} --target ${tunnel.target}`;

  const handleCopy = async () => {
    await copyText(cliCmd);
  };

  const agentDot = !agentKnown || presence.online === null
    ? "dot-idle"
    : agentOnline
      ? "dot-on"
      : "dot-off";
  const tunnelDot = tunnelLive ? "dot-on" : "dot-off";

  const agentText = !agentKnown
    ? "Agent: no host"
    : presence.online === null
      ? "Agent: checking…"
      : agentOnline
        ? "Agent: online"
        : "Agent: offline";
  const tunnelText = tunnelLive ? "Tunnel: connected" : "Tunnel: offline";

  return (
    <EntityCard
      icon={<TunnelIcon />}
      name={
        <>
          {tunnel.name} <span className="badge">/{tunnel.slug}</span>
        </>
      }
      sub={tunnel.target}
      label={statusBadge}
      notes={
        <span>
          {checking ? (
            <CheckingPills />
          ) : (
            <span className="presence-row">
              <span className="presence">
                <span className={`dot ${agentDot}`} aria-hidden="true" />
                {agentText}
              </span>
              <span className="presence">
                <span className={`dot ${tunnelDot}`} aria-hidden="true" />
                {tunnelText}
              </span>
            </span>
          )}
          {tunnel.active && !tunnelLive && (
            <span className="error" style={{ display: "block", marginTop: 4 }}>
              Enabled locally, but the CLI tunnel wss is not connected — /{tunnel.slug} will not show {tunnel.target}.
              Run the CLI on the host machine and keep it running
              {" (or run the host in host mode to auto-serve every published tunnel)"}.
            </span>
          )}
          {tunnelLive && !registryLoading && !published && (
            <span className="error" style={{ display: "block", marginTop: 4 }}>
              Tunnel wss is connected, but /{tunnel.slug} is not published for this host — re-save to publish.
            </span>
          )}
          {tunnelLive && published && targetDrifted && (
            <span className="error" style={{ display: "block", marginTop: 4 }}>
              Published target differs — re-save to update /{tunnel.slug}.
            </span>
          )}
        </span>
      }
      actions={[
        {
          key: "toggle",
          label: tunnel.active ? "Stop" : "Start",
          icon: tunnel.active ? <StopIcon /> : <PlayIcon />,
          onClick: onToggle,
        },
        {
          key: "open",
          label: `Open /${tunnel.slug} in a new tab`,
          icon: <OpenIcon />,
          onClick: () => window.open(publicURL, "_blank", "noopener"),
        },
        {
          key: "copy",
          label: "Copy CLI command",
          icon: <CopyIcon />,
          onClick: () => void handleCopy(),
        },
        {
          key: "edit",
          label: "Edit",
          icon: <PencilIcon />,
          onClick: onEdit,
        },
        {
          key: "delete",
          label: "Delete",
          icon: <TrashIcon />,
          onClick: onDelete,
          danger: true,
        },
      ]}
    />
  );
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
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null);
  const [pendingEdit, setPendingEdit] = useState<Tunnel | null>(null);
  const [editName, setEditName] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editType, setEditType] = useState<string>(TUNNEL_TYPES[0]);
  const [editTarget, setEditTarget] = useState("");
  const [editHostId, setEditHostId] = useState("");
  const [editProviderId, setEditProviderId] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const registry = useRegistry(10000);
  const registryBySlug = useMemo(() => {
    const map = new Map<string, RegistryEntry>();
    for (const e of registry.entries) map.set(normalizeSlug(e.slug), e);
    return map;
  }, [registry.entries]);

  const defaultHostId = useMemo(() => hosts[0]?.id ?? "", [hosts]);
  const defaultProviderId = useMemo(() => {
    const ks = providers.find((p) => p.name.trim().toLowerCase() === "ks tunnel");
    return (ks ?? providers[0])?.id ?? "";
  }, [providers]);

  // Apply dropdown defaults whenever the add dialog opens (hosts may load late).
  useEffect(() => {
    if (!modalOpen) return;
    if (!hostId && defaultHostId) setHostId(defaultHostId);
    if (!providerId && defaultProviderId) setProviderId(defaultProviderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, defaultHostId, defaultProviderId]);

  const openModal = () => {
    setModalOpen(true);
    setFormError(null);
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
    if (tunnels.some((t) => t.id !== ignoreId && t.name.trim().toLowerCase() === v.name.trim().toLowerCase())) {
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
    setFormError(null);
    closeModal();
    setPageNotice(`Saved ${t.name} — publishing /${t.slug}…`);
    publishTunnel(t, hosts)
      .then(() => {
        setPageNotice(`Published — visit /${t.slug} to see ${t.target}.`);
        registry.refresh();
      })
      .catch((e: unknown) => {
        setPageNotice(`Saved locally, but publishing failed (${e instanceof Error ? e.message : "worker unreachable"}) — /${t.slug} won't resolve until you re-save with the worker online.`);
      });
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
    const oldSlug = normalizeSlug(pendingEdit.slug);
    const patch: Partial<Tunnel> = {
      name: editName.trim(),
      slug: normalizeSlug(editSlug),
      tunnelType: editType,
      target: editTarget.trim(),
      hostId: editHostId,
      providerId: editProviderId,
    };
    const updated = { ...pendingEdit, ...patch } as Tunnel;
    onUpdate(pendingEdit.id, patch);
    setEditError(null);
    // If the slug moved, remove the orphaned registry entry.
    const cleanup = normalizeSlug(updated.slug) !== oldSlug ? unpublishTunnel(oldSlug) : Promise.resolve();
    cleanup
      .catch(() => undefined)
      .then(() => publishTunnel(updated, hosts))
      .then(() => {
        setPageNotice(`Saved — /${updated.slug} is published.`);
        registry.refresh();
      })
      .catch((e: unknown) => {
        setPageNotice(`Saved locally, but publishing failed (${e instanceof Error ? e.message : "worker unreachable"}).`);
      });
    closeEdit();
  };

  // Enabling is local-only — it never starts serving by itself. Re-publish on
  // enable so a previously failed publish (worker offline, host picked later)
  // heals: /<slug> then gives a clear 502 "tunnel offline, run CLI…" instead
  // of falling back to the web UI itself. Disabling unpublishes so a host-mode
  // CLI (`kstunnel --host <id>`) closes the tunnel socket by itself.
  const handleToggle = (t: Tunnel) => {
    const turningOn = !t.active;
    onToggle(t.id);
    if (!turningOn) {
      void unpublishTunnel(t.slug).then(() => {
        setPageNotice(`Stopped — /${t.slug} unpublished. A host-mode CLI closes it automatically.`);
        registry.refresh();
      });
      return;
    }
    const updated = { ...t, active: true };
    publishTunnel(updated, hosts)
      .then(() => {
        setPageNotice(`Enabled and published — /${t.slug} resolves. Keep the CLI running: kstunnel --host <id> --tunnel ${t.slug} --target ${t.target}.`);
        registry.refresh();
      })
      .catch((e: unknown) => {
        setPageNotice(`Enabled locally, but publishing failed (${e instanceof Error ? e.message : "worker unreachable"}) — /${t.slug} won't resolve until you re-save with the worker online.`);
      });
  };

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1 className="page-title">Tunnels <span className="badge">{tunnels.length}</span></h1>
        </div>
        <button type="button" className="btn btn-primary" onClick={openModal}>
          Add tunnel
        </button>
      </div>

      {pageNotice && (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>{pageNotice}</p>
        </section>
      )}
      {registry.error && (
        <section className="card">
          <p className="error" style={{ margin: 0 }}>Worker registry: {registry.error} — live status may be stale.</p>
        </section>
      )}
      <section className="card">
        <p className="muted" style={{ margin: 0 }}>
          Host mode: run <code>kstunnel --host &lt;id&gt;</code> once on the machine and every published tunnel is
          served automatically — the worker tells the CLI to open each tunnel wss, no per-tunnel command needed.
        </p>
      </section>

      {tunnels.length === 0 ? (
        <section className="card">
          <p className="muted">Nothing here. Add your first tunnel to get started.</p>
          <code className="code">visit /hello to see 127.0.0.1:4757 via wss (cli → workers → you, fullscreen)</code>
        </section>
      ) : (
        <div className="cards">
          {tunnels.map((t) => (
            <TunnelCard
              key={t.id}
              tunnel={t}
              hosts={hosts}
              providers={providers}
              registryEntry={registryBySlug.get(normalizeSlug(t.slug))}
              registryLoading={registry.loading}
              onToggle={() => handleToggle(t)}
              onEdit={() => openEdit(t)}
              onDelete={() => setPendingDelete(t)}
            />
          ))}
        </div>
      )}

      <Modal open={modalOpen} title="Add tunnel" onClose={closeModal} wide>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <div className="form-grid">
            <div>
              <label className="label" htmlFor="tunnel-name">Name</label>
              <input
                id="tunnel-name"
                className="input"
                type="text"
                autoComplete="off"
                spellCheck={false}
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
                spellCheck={false}
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
                spellCheck={false}
                inputMode="url"
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
            <button type="submit" className="btn btn-primary">
              Save
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={pendingEdit !== null} title="Edit tunnel" onClose={closeEdit} wide>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleEdit();
          }}
        >
          <div className="form-grid">
            <div>
              <label className="label" htmlFor="tunnel-edit-name">Name</label>
              <input
                id="tunnel-edit-name"
                className="input"
                type="text"
                autoComplete="off"
                spellCheck={false}
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
                spellCheck={false}
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
                spellCheck={false}
                inputMode="url"
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
            <button type="submit" className="btn btn-primary">
              Save
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={pendingDelete !== null} title="Delete tunnel" onClose={() => setPendingDelete(null)}>
        <p>
          Delete <strong>{pendingDelete?.name}</strong> (<code>/{pendingDelete?.slug}</code>)? Visitors will stop
          resolving it. This cannot be undone.
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
                setPageNotice(`Deleted /${pendingDelete.slug}.`);
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
