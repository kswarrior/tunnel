import { useEffect, useState } from 'react'
import { deleteTunnel, getAgents, getProviders, getTunnels } from '../api'
import type { Agent, Provider, Tunnel } from '../types'
import { AddTunnelModal } from '../components/AddTunnelModal'
import { CardMenu } from '../components/CardMenu'
import { ConfirmModal } from '../components/ConfirmModal'
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  PlusIcon,
  TunnelIcon,
} from '../components/Icons'
import { PageHeader } from '../components/PageHeader'

const statusLabels: Record<Tunnel['status'], string> = {
  active: 'Active',
  pending: 'Starting',
  error: 'Error',
}

function TunnelUrl({ tunnel }: { tunnel: Tunnel }) {
  const [copied, setCopied] = useState(false)

  if (tunnel.status === 'pending') {
    return <p className="tunnel-url-state pending">Waiting for agent...</p>
  }

  if (tunnel.status === 'error') {
    return (
      <p className="tunnel-url-state error">
        {tunnel.error || 'Could not start this tunnel.'}
      </p>
    )
  }

  if (!tunnel.publicUrl) return null

  async function copyUrl() {
    if (!tunnel.publicUrl) return

    try {
      await navigator.clipboard.writeText(tunnel.publicUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can fail outside a secure context.
    }
  }

  return (
    <div className="tunnel-url-row">
      <a
        className="tunnel-url"
        href={tunnel.publicUrl}
        target="_blank"
        rel="noreferrer"
        title={tunnel.publicUrl}
      >
        {tunnel.publicUrl}
      </a>
      <button
        type="button"
        className="icon-button tunnel-copy"
        onClick={copyUrl}
        aria-label="Copy tunnel URL"
        title="Copy tunnel URL"
      >
        {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
      </button>
    </div>
  )
}

export function Tunnels() {
  const [tunnels, setTunnels] = useState<Tunnel[] | null>(null)
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [error, setError] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [editing, setEditing] = useState<Tunnel | null>(null)
  const [deleting, setDeleting] = useState<Tunnel | null>(null)

  useEffect(() => {
    let active = true

    Promise.all([getTunnels(), getProviders(), getAgents()])
      .then(([tunnelList, providerList, agentList]) => {
        if (!active) return
        setTunnels(tunnelList)
        setProviders(providerList)
        setAgents(agentList)
      })
      .catch((requestError) => {
        if (!active) return
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Could not load tunnels.',
        )
      })

    return () => {
      active = false
    }
  }, [])

  const hasPending = tunnels?.some((tunnel) => tunnel.status === 'pending') ?? false

  useEffect(() => {
    if (!hasPending) return

    let active = true
    const interval = window.setInterval(() => {
      getTunnels()
        .then((list) => {
          if (active) setTunnels(list)
        })
        .catch(() => {
          // Keep the last known state and retry on the next tick.
        })
    }, 2000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [hasPending])

  const providerNames = new Map(
    (providers ?? []).map((provider) => [provider.id, provider.name]),
  )
  const agentNames = new Map(
    (agents ?? []).map((agent) => [agent.id, agent.name]),
  )

  return (
    <div className="page">
      <PageHeader
        title="Tunnels"
        action={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setIsAdding(true)}
            disabled={providers === null || agents === null}
          >
            <PlusIcon size={16} />
            Add
          </button>
        }
      />

      {error ? (
        <div className="empty-state">
          <span className="empty-icon">
            <AlertIcon size={22} />
          </span>
          <h2>Could not load tunnels</h2>
          <p>{error}</p>
        </div>
      ) : tunnels === null ? (
        <div className="card-grid" aria-hidden="true">
          {[0, 1, 2].map((item) => (
            <div className="card skeleton-card skeleton-tunnel" key={item}>
              <span className="skeleton skeleton-icon" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line short" />
            </div>
          ))}
        </div>
      ) : tunnels.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <TunnelIcon size={22} />
          </span>
          <h2>No tunnels yet</h2>
          <p>
            Approve an agent, then add your first tunnel to get a public URL.
          </p>
        </div>
      ) : (
        <div className="card-grid">
          {tunnels.map((tunnel) => (
            <article className="card tunnel-card" key={tunnel.id}>
              <div className="tunnel-head">
                <span className="card-icon">
                  <TunnelIcon size={19} />
                </span>
                <span className="tunnel-badges">
                  <span className="badge">{tunnel.type.toUpperCase()}</span>
                  <span className={`status-badge ${tunnel.status}`}>
                    <span className={`status-dot ${tunnel.status}`} />
                    {statusLabels[tunnel.status]}
                  </span>
                </span>
              </div>
              <div className="tunnel-content">
                <h2 className="card-title">{tunnel.name}</h2>
                <div className="tunnel-meta">
                  <span>
                    {providerNames.get(tunnel.providerId) ?? 'Unknown provider'}
                  </span>
                  <span className="meta-dot" aria-hidden="true" />
                  <span>
                    {agentNames.get(tunnel.agentId) ?? 'Unknown agent'}
                  </span>
                  <span className="meta-dot" aria-hidden="true" />
                  <span className="mono">
                    {tunnel.ip}:{tunnel.port}
                  </span>
                </div>
                <TunnelUrl tunnel={tunnel} />
              </div>
              <div className="card-footer">
                <CardMenu
                  label={`Actions for ${tunnel.name}`}
                  onEdit={() => setEditing(tunnel)}
                  onDelete={() => setDeleting(tunnel)}
                />
              </div>
            </article>
          ))}
        </div>
      )}

      {(isAdding || editing) && providers && agents ? (
        <AddTunnelModal
          providers={providers}
          agents={agents}
          tunnel={editing ?? undefined}
          onClose={() => {
            setIsAdding(false)
            setEditing(null)
          }}
          onSaved={(saved) =>
            setTunnels((current) =>
              current
                ? current.map((tunnel) =>
                    tunnel.id === saved.id ? saved : tunnel,
                  )
                : [saved],
            )
          }
        />
      ) : null}

      {deleting ? (
        <ConfirmModal
          title="Delete tunnel"
          message={`Delete "${deleting.name}"? This cannot be undone.`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteTunnel(deleting.id)
            setTunnels(
              (current) =>
                current?.filter((tunnel) => tunnel.id !== deleting.id) ?? null,
            )
          }}
        />
      ) : null}
    </div>
  )
}
