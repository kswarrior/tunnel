import { useState } from 'react'
import type { FormEvent } from 'react'
import { updateTunnelSlug } from '../api'
import type { Tunnel } from '../types'
import { AlertIcon } from './Icons'
import { Field } from './Field'
import { Modal } from './Modal'

type SlugModalProps = {
  tunnel: Tunnel
  onClose: () => void
  onSaved: (tunnel: Tunnel) => void
}

const slugPattern = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/

export function SlugModal({ tunnel, onClose, onSaved }: SlugModalProps) {
  const [slug, setSlug] = useState(tunnel.slug ?? '')
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const nextSlug = slug.trim().toLowerCase()
    if (nextSlug && !slugPattern.test(nextSlug)) {
      setError('Use 2-40 lowercase letters, numbers, or hyphens.')
      return
    }

    setError('')
    setFormError('')
    setSubmitting(true)

    try {
      const saved = await updateTunnelSlug(tunnel.id, nextSlug)
      onSaved(saved)
      onClose()
    } catch (requestError) {
      setFormError(
        requestError instanceof Error
          ? requestError.message
          : 'Could not update slug.',
      )
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Set slug" onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate>
        <Field label="Slug" htmlFor="tunnel-slug" error={error}>
          <input
            id="tunnel-slug"
            className="input"
            type="text"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value)
              if (error) setError('')
            }}
            placeholder="hi"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            aria-invalid={Boolean(error)}
          />
        </Field>

        <p className="field-hint">
          Opening /s/&lt;slug&gt; redirects to this tunnel. Leave empty to use
          the default URL.
        </p>

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
            {submitting ? 'Saving...' : 'Save slug'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
