import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from './Icons'

type ModalProps = {
  title: string
  onClose: () => void
  children: ReactNode
}

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({ title, onClose, children }: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
        return
      }

      if (event.key !== 'Tab' || !panelRef.current) return

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(focusableSelector),
      )

      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="modal-header">
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon size={17} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
