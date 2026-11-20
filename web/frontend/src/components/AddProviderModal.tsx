import { useState } from 'react'
import type { FormEvent } from 'react'
import { createProvider } from '../api'
import type { Provider } from '../types'
import { AlertIcon } from './Icons'
import { Field } from './Field'
import { Modal } from './Modal'

type AddProviderModalProps = {
  onClose: () => void
  onCreated: (provider: Provider) => void
}

export function AddProviderModal({
  onClose,
  onCreated,
}: AddProviderModalProps) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedName = name.trim()

    if (!trimmedName) {
      setError('Enter a provider name.')
      return
    }

    setError('')
    setFormError('')
    setSubmitting(true)

    try {
      const provider = await createProvider(trimmedName)
      onCreated(provider)
      onClose()
    } catch (requestError) {
      setFormError(
        requestError instanceof Error
          ? requestError.message
          : 'Could not add provider.',
      )
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Add provider" onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate>
        <Field label="Name" htmlFor="provider-name" error={error}>
          <input
            id="provider-name"
            className="input"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              if (error) setError('')
            }}
            placeholder="Provider name"
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
            {submitting ? 'Adding...' : 'Add provider'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
