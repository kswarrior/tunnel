import { useState } from 'react'
import type { FormEvent } from 'react'
import { createProvider, updateProvider } from '../api'
import type { Provider } from '../types'
import { AlertIcon } from './Icons'
import { Field } from './Field'
import { Modal } from './Modal'

type AddProviderModalProps = {
  provider?: Provider
  onClose: () => void
  onSaved: (provider: Provider) => void
}

export function AddProviderModal({
  provider,
  onClose,
  onSaved,
}: AddProviderModalProps) {
  const [name, setName] = useState(provider?.name ?? '')
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isEditing = Boolean(provider)

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
      const saved = provider
        ? await updateProvider(provider.id, trimmedName)
        : await createProvider(trimmedName)
      onSaved(saved)
      onClose()
    } catch (requestError) {
      setFormError(
        requestError instanceof Error
          ? requestError.message
          : isEditing
            ? 'Could not update provider.'
            : 'Could not add provider.',
      )
      setSubmitting(false)
    }
  }

  return (
    <Modal title={isEditing ? 'Edit provider' : 'Add provider'} onClose={onClose}>
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
            {submitting
              ? isEditing
                ? 'Saving...'
                : 'Adding...'
              : isEditing
                ? 'Save changes'
                : 'Add provider'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
