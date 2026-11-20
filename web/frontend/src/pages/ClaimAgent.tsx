import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getClaim, respondToClaim } from '../api'
import type { Agent } from '../types'
import { AgentIcon, AlertIcon, CheckIcon, XIcon } from '../components/Icons'

type ClaimResult = 'approved' | 'cancelled' | ''

export function ClaimAgent() {
  const { tokenParam = '' } = useParams<{ tokenParam: string }>()
  const token = tokenParam.startsWith('token=')
    ? tokenParam.slice('token='.length)
    : ''

  const [claim, setClaim] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(Boolean(token))
  const [error, setError] = useState(
    token ? '' : 'This agent link is invalid or has expired.',
  )
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ClaimResult>('')

  useEffect(() => {
    if (!token) return

    let active = true

    getClaim(token)
      .then((agent) => {
        if (!active) return
        setClaim(agent)
        setError('')
      })
      .catch((requestError) => {
        if (!active) return
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Could not load this agent request.',
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [token])

  async function handleAction(action: 'allow' | 'cancel') {
    if (!token || submitting) return

    setSubmitting(true)
    setError('')

    try {
      await respondToClaim(token, action)
      setResult(action === 'allow' ? 'approved' : 'cancelled')
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Could not update this agent request.',
      )
      setSubmitting(false)
    }
  }

  return (
    <div className="page claim-page">
      <div className="card claim-card">
        {result === 'approved' ? (
          <>
            <span className="claim-icon success">
              <CheckIcon size={24} />
            </span>
            <h1 className="claim-title">Agent approved</h1>
            <p className="claim-text">
              {claim?.name ?? 'The CLI'} was added. You can now create a tunnel
              and select it as the agent.
            </p>
            <div className="claim-actions">
              <Link className="btn btn-primary" to="/tunnels">
                Go to Tunnels
              </Link>
            </div>
          </>
        ) : result === 'cancelled' ? (
          <>
            <span className="claim-icon">
              <XIcon size={24} />
            </span>
            <h1 className="claim-title">Request cancelled</h1>
            <p className="claim-text">
              The CLI was not added as an agent. You can close this page.
            </p>
            <div className="claim-actions">
              <Link className="btn btn-ghost" to="/">
                Back to Home
              </Link>
            </div>
          </>
        ) : loading ? (
          <>
            <span className="claim-icon">
              <AgentIcon size={24} />
            </span>
            <h1 className="claim-title">Checking agent</h1>
            <p className="claim-text">Loading this connection request...</p>
          </>
        ) : error ? (
          <>
            <span className="claim-icon">
              <AlertIcon size={24} />
            </span>
            <h1 className="claim-title">Could not connect agent</h1>
            <p className="claim-text">{error}</p>
            <div className="claim-actions">
              <Link className="btn btn-ghost" to="/">
                Back to Home
              </Link>
            </div>
          </>
        ) : claim ? (
          <>
            <span className="claim-icon">
              <AgentIcon size={24} />
            </span>
            <h1 className="claim-title">Connect agent</h1>
            <p className="claim-text">
              A CLI is requesting access to KS Tunnel. Approve it to add{' '}
              <strong>{claim.name}</strong> as an agent.
            </p>
            <code className="claim-token">token={token}</code>

            {claim.authorized ? (
              <>
                <p className="claim-note">This agent is already approved.</p>
                <div className="claim-actions">
                  <Link className="btn btn-primary" to="/tunnels">
                    Go to Tunnels
                  </Link>
                </div>
              </>
            ) : (
              <>
                {!claim.connected ? (
                  <p className="claim-note">
                    The CLI is not connected right now. Start ./kstunnel and
                    reopen this link.
                  </p>
                ) : null}
                <div className="claim-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleAction('cancel')}
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleAction('allow')}
                    disabled={submitting || !claim.connected}
                  >
                    {submitting ? 'Approving...' : 'Allow'}
                  </button>
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
