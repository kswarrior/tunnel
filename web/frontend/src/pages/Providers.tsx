import { useEffect, useState } from 'react'
import { deleteProvider, getProviders } from '../api'
import type { Provider } from '../types'
import { AddProviderModal } from '../components/AddProviderModal'
import { CardMenu } from '../components/CardMenu'
import { ConfirmModal } from '../components/ConfirmModal'
import { AlertIcon, CloudIcon, PlusIcon } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'

export function Providers() {
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [error, setError] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [deleting, setDeleting] = useState<Provider | null>(null)

  useEffect(() => {
    let active = true

    getProviders()
      .then((result) => {
        if (active) setProviders(result)
      })
      .catch((requestError) => {
        if (!active) return
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Could not load providers.',
        )
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <div className="page">
      <PageHeader
        title="Providers"
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
          <h2>Could not load providers</h2>
          <p>{error}</p>
        </div>
      ) : providers === null ? (
        <div className="card-grid" aria-hidden="true">
          {[0, 1, 2].map((item) => (
            <div className="card skeleton-card" key={item}>
              <span className="skeleton skeleton-icon" />
              <span className="skeleton skeleton-line" />
            </div>
          ))}
        </div>
      ) : providers.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <CloudIcon size={22} />
          </span>
          <h2>No providers yet</h2>
          <p>Add a provider to get started.</p>
        </div>
      ) : (
        <div className="card-grid">
          {providers.map((provider) => (
            <article className="card provider-card" key={provider.id}>
              <div className="provider-head">
                <span className="card-icon">
                  <CloudIcon size={20} />
                </span>
                <h2 className="card-title">{provider.name}</h2>
              </div>
              <div className="card-footer">
                <CardMenu
                  label={`Actions for ${provider.name}`}
                  onEdit={() => setEditing(provider)}
                  onDelete={() => setDeleting(provider)}
                />
              </div>
            </article>
          ))}
        </div>
      )}

      {isAdding || editing ? (
        <AddProviderModal
          provider={editing ?? undefined}
          onClose={() => {
            setIsAdding(false)
            setEditing(null)
          }}
          onSaved={(saved) =>
            setProviders((current) =>
              current
                ? current.map((provider) =>
                    provider.id === saved.id ? saved : provider,
                  )
                : [saved],
            )
          }
        />
      ) : null}

      {deleting ? (
        <ConfirmModal
          title="Delete provider"
          message={`Delete "${deleting.name}"? This cannot be undone.`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteProvider(deleting.id)
            setProviders(
              (current) =>
                current?.filter((provider) => provider.id !== deleting.id) ??
                null,
            )
          }}
        />
      ) : null}
    </div>
  )
}
