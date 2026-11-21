import { useEffect, useRef, useState } from 'react'
import { MoreIcon, PencilIcon, RefreshIcon, TrashIcon } from './Icons'

type CardMenuProps = {
  label: string
  onEdit: () => void
  onDelete: () => void
  onReconfigure?: () => void
}

export function CardMenu({
  label,
  onEdit,
  onDelete,
  onReconfigure,
}: CardMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    function handleMouseDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="card-menu" ref={containerRef}>
      <button
        type="button"
        className="icon-button card-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
      >
        <MoreIcon size={17} />
      </button>

      {open ? (
        <div className="card-menu-list" role="menu" aria-label={label}>
          <button
            type="button"
            className="card-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onEdit()
            }}
          >
            <PencilIcon size={14} />
            Edit
          </button>
          {onReconfigure ? (
            <button
              type="button"
              className="card-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onReconfigure()
              }}
            >
              <RefreshIcon size={14} />
              Reconfigure URL
            </button>
          ) : null}
          <button
            type="button"
            className="card-menu-item danger"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            <TrashIcon size={14} />
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}
