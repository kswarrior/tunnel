import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { CheckIcon, ChevronDownIcon } from './Icons'

export type DropdownOption = {
  value: string
  label: string
  icon?: ReactNode
}

type DropdownProps = {
  id?: string
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  placeholder?: string
  invalid?: boolean
  label?: string
}

export function Dropdown({
  id,
  value,
  options,
  onChange,
  placeholder = 'Select an option',
  invalid = false,
  label,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  function openMenu() {
    if (options.length === 0) return
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  function choose(index: number) {
    const option = options[index]
    if (!option) return

    onChange(option.value)
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (options.length === 0) return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) {
          openMenu()
        } else {
          setActiveIndex((index) => (index + 1) % options.length)
        }
        break
      case 'ArrowUp':
        event.preventDefault()
        if (!open) {
          openMenu()
        } else {
          setActiveIndex(
            (index) => (index - 1 + options.length) % options.length,
          )
        }
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (!open) {
          openMenu()
        } else {
          choose(activeIndex)
        }
        break
      case 'Home':
        if (open) {
          event.preventDefault()
          setActiveIndex(0)
        }
        break
      case 'End':
        if (open) {
          event.preventDefault()
          setActiveIndex(options.length - 1)
        }
        break
      case 'Escape':
        if (open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div ref={rootRef} className={`dropdown${open ? ' open' : ''}`}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`dropdown-trigger${invalid ? ' invalid' : ''}`}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-label={label}
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${listId}-option-${activeIndex}`
            : undefined
        }
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span
          className={`dropdown-value${selected ? '' : ' dropdown-placeholder'}`}
        >
          {selected?.icon}
          {selected ? selected.label : placeholder}
        </span>
        <span className="dropdown-chevron">
          <ChevronDownIcon size={15} />
        </span>
      </button>

      {open ? (
        <ul id={listId} className="dropdown-menu" role="listbox" aria-label={label}>
          {options.map((option, index) => {
            const isSelected = option.value === value

            return (
              <li key={option.value} role="none">
                <button
                  type="button"
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`dropdown-option${
                    index === activeIndex ? ' active' : ''
                  }${isSelected ? ' selected' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                  tabIndex={-1}
                >
                  {option.icon}
                  <span>{option.label}</span>
                  {isSelected ? (
                    <span className="dropdown-check">
                      <CheckIcon size={14} />
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
