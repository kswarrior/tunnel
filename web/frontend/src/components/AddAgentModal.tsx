import { useState } from 'react'
import type { FormEvent } from 'react'
import { createAgent, updateAgent } from '../api'
import type { Agent } from '../types'
import { AlertIcon } from './Icons'
import { Field } from './Field'
import { Modal } from './Modal'

type AddAgentModalProps = {
  agent?: Agent
  onClose: () => void
  onSaved: (agent: Agent) => void
}

export function AddAgentModal({ agent, onClose, onSaved }: AddAgentModalProps) {
  const [name, setName] = useState(agent?.name ?? '')
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isEditing = Boolean(agent)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedName = name.trim()

    if (!trimmedName) {
      setError('Enter an agent name.')
      return
    }

    setError('')
    setFormError('')
    setSubmitting(true)

    try {
      const saved = agent
        ? await updateAgent(agent.id, trimmedName)
        : await createAgent(trimmedName)
      onSaved(saved)
      onClose()
    } catch (requestError) {
      setFormError(
        requestError instanceof Error
          ? requestError.message
          : isEditing
            ? 'Could not update agent.'
            : 'Could not add agent.',
      )
      setSubmitting(false)
    }
  }

  return (
    <Modal title={isEditing ? 'Edit agent' : 'Add agent'} onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate>
        {isEditing ? null : (
          <div className="agent-form-guide">
            <p>
              After adding, you will get a token. Run the CLI with that token on
              the machine you want to expose:
            </p>
            <code className="code-block">./kstunnel --token=&lt;token&gt;</code>
          </div>
        )}

        <Field label="Name" htmlFor="agent-name" error={error}>
          <input
            id="agent-name"
            className="input"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              if (error) setError('')
            }}
            placeholder="Agent name"
            autoComplete="off"
            autoFocus
            aria-invalid={Boolean(error)}
          />
        </Field>

        {formError ? (
          <p className="form-error">
            <AlertIcon size={14} />
            {formError}
          </p>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting
              ? isEditing
                ? 'Saving...'
                : 'Adding...'
              : isEditing
                ? 'Save changes'
                : 'Add agent'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
