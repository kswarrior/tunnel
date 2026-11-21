import { useState } from 'react'
import { AlertIcon } from './Icons'
import { Modal } from './Modal'

type ConfirmModalProps = {
  title: string
  message: string
  confirmLabel?: string
  onClose: () => void
  onConfirm: () => Promise<void>
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  onClose,
  onConfirm,
}: ConfirmModalProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleConfirm() {
    setSubmitting(true)
    setError('')

    try {
      await onConfirm()
      onClose()
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Something went wrong.',
      )
      setSubmitting(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="confirm-text">{message}</p>

      {error ? (
        <p className="form-error">
          <AlertIcon size={14} />
          {error}
        </p>
      ) : null}

      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={handleConfirm}
          disabled={submitting}
        >
          {submitting ? 'Deleting...' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
