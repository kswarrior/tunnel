import type { ReactNode } from 'react'
import { AlertIcon } from './Icons'

type FieldProps = {
  label: string
  htmlFor?: string
  error?: string
  children: ReactNode
}

export function Field({ label, htmlFor, error, children }: FieldProps) {
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field-error">
          <AlertIcon size={12} />
          {error}
        </p>
      ) : null}
    </div>
  )
}
