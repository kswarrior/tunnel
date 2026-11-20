import { useEffect, useState } from 'react'
import { getProviders, getTunnels } from '../api'
import type { Provider, Tunnel } from '../types'
import { AddTunnelModal } from '../components/AddTunnelModal'
import {
  AlertIcon,
  PlusIcon,
  TunnelIcon,
} from '../components/Icons'
import { PageHeader } from '../components/PageHeader'

export function Tunnels() {
  const [tunnels, setTunnels] = useState<Tunnel[] | null>(null)
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [error, setError] = useState('')
  const [isAdding, setIsAdding] = useState(false)

  useEffect(() => {
    let active = true

    Promise.all([getTunnels(), getProviders()])
      .then(([tunnelList, providerList]) => {
        if (!active) return
        setTunnels(tunnelList)
        setProviders(providerList)
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

  const providerNames = new Map(
    (providers ?? []).map((provider) => [provider.id, provider.name]),
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
            disabled={providers === null}
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
          <p>Add your first tunnel to get started.</p>
        </div>
      ) : (
        <div className="card-grid">
          {tunnels.map((tunnel) => (
            <article className="card tunnel-card" key={tunnel.id}>
              <div className="tunnel-head">
                <span className="card-icon">
                  <TunnelIcon size={19} />
                </span>
                <span className="badge">{tunnel.type.toUpperCase()}</span>
              </div>
              <div className="tunnel-content">
                <h2 className="card-title">{tunnel.name}</h2>
                <div className="tunnel-meta">
                  <span>
                    {providerNames.get(tunnel.providerId) ?? 'Unknown provider'}
                  </span>
                  <span className="meta-dot" aria-hidden="true" />
                  <span className="mono">
                    {tunnel.ip}:{tunnel.port}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {isAdding && providers ? (
        <AddTunnelModal
          providers={providers}
          onClose={() => setIsAdding(false)}
          onCreated={(tunnel) =>
            setTunnels((current) => [tunnel, ...(current ?? [])])
          }
        />
      ) : null}
    </div>
  )
}
