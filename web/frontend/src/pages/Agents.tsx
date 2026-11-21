import { useEffect, useState } from 'react'
import { deleteAgent, getAgents } from '../api'
import type { Agent, AgentStatus } from '../types'
import { AddAgentModal } from '../components/AddAgentModal'
import { CardMenu } from '../components/CardMenu'
import { ConfirmModal } from '../components/ConfirmModal'
import {
  AgentIcon,
  AlertIcon,
  CheckIcon,
  CopyIcon,
  PlusIcon,
} from '../components/Icons'
import { PageHeader } from '../components/PageHeader'

const statusLabels: Record<AgentStatus, string> = {
  online: 'Online',
  offline: 'Offline',
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}

function AgentToken({ token }: { token: string }) {
  const [copied, setCopied] = useState(false)

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can fail outside a secure context.
    }
  }

  return (
    <div className="agent-token-row">
      <code className="agent-token" title={token}>
        {token}
      </code>
      <button
        type="button"
        className="icon-button agent-token-copy"
        onClick={copyToken}
        aria-label="Copy agent token"
        title="Copy agent token"
      >
        {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
      </button>
    </div>
  )
}

export function Agents() {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [error, setError] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [deleting, setDeleting] = useState<Agent | null>(null)

  useEffect(() => {
    let active = true

    async function load() {
      try {
        const result = await getAgents()
        if (!active) return
        setAgents(result)
        setError('')
      } catch (requestError) {
        if (!active) return
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Could not load agents.',
        )
      }
    }

    load()
    const interval = window.setInterval(load, 3000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        action={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setIsAdding(true)}
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
          <h2>Could not load agents</h2>
          <p>{error}</p>
        </div>
      ) : agents === null ? (
        <div className="card-grid" aria-hidden="true">
          {[0, 1, 2].map((item) => (
            <div className="card skeleton-card" key={item}>
              <span className="skeleton skeleton-icon" />
              <span className="skeleton skeleton-line" />
            </div>
          ))}
        </div>
      ) : agents.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <AgentIcon size={22} />
          </span>
          <h2>No agents yet</h2>
          <p>Add an agent to get a token and connect the CLI.</p>
        </div>
      ) : (
        <div className="card-grid">
          {agents.map((agent) => (
            <article className="card agent-card" key={agent.id}>
              <span className="card-icon">
                <AgentIcon size={20} />
              </span>
              <div className="agent-card-body">
                <div className="agent-card-head">
                  <h2 className="card-title">{agent.name}</h2>
                  <span className={`status-badge ${agent.status}`}>
                    <span className={`status-dot ${agent.status}`} />
                    {statusLabels[agent.status]}
                  </span>
                </div>
                <p className="agent-meta">
                  {agent.connectedAt
                    ? `Last connected ${formatDate(agent.connectedAt)}`
                    : `Added ${formatDate(agent.createdAt)}`}
                </p>
                <AgentToken token={agent.token} />
                <div className="card-footer">
                  <CardMenu
                    label={`Actions for ${agent.name}`}
                    onEdit={() => setEditing(agent)}
                    onDelete={() => setDeleting(agent)}
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {isAdding || editing ? (
        <AddAgentModal
          agent={editing ?? undefined}
          onClose={() => {
            setIsAdding(false)
            setEditing(null)
          }}
          onSaved={(saved) =>
            setAgents((current) =>
              current
                ? current.map((agent) =>
                    agent.id === saved.id ? saved : agent,
                  )
                : [saved],
            )
          }
        />
      ) : null}

      {deleting ? (
        <ConfirmModal
          title="Delete agent"
          message={`Delete "${deleting.name}"? This cannot be undone.`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteAgent(deleting.id)
            setAgents(
              (current) =>
                current?.filter((agent) => agent.id !== deleting.id) ?? null,
            )
          }}
        />
      ) : null}
    </div>
  )
}
