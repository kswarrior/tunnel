import { useState } from 'react'
import type { FormEvent } from 'react'
import { createTunnel } from '../api'
import type { Provider, Tunnel, TunnelType } from '../types'
import { AlertIcon, CloudIcon } from './Icons'
import { Dropdown } from './Dropdown'
import type { DropdownOption } from './Dropdown'
import { Field } from './Field'
import { Modal } from './Modal'

type AddTunnelModalProps = {
  providers: Provider[]
  onClose: () => void
  onCreated: (tunnel: Tunnel) => void
}

type FieldErrors = Partial<
  Record<'name' | 'providerId' | 'ip' | 'port', string>
>

const typeOptions: DropdownOption[] = [
  { value: 'https', label: 'HTTPS' },
  { value: 'http', label: 'HTTP' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
]

export function AddTunnelModal({
  providers,
  onClose,
  onCreated,
}: AddTunnelModalProps) {
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const [ip, setIp] = useState('localhost')
  const [port, setPort] = useState('')
  const [type, setType] = useState<TunnelType>('https')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const providerOptions: DropdownOption[] = providers.map((provider) => ({
    value: provider.id,
    label: provider.name,
    icon: <CloudIcon size={15} />,
  }))

  function clearError(key: keyof FieldErrors) {
    setErrors((current) => {
      if (!current[key]) return current

      const next = { ...current }
      delete next[key]
      return next
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (providers.length === 0) {
      setFormError('Add a provider before creating a tunnel.')
      return
    }

    const nextErrors: FieldErrors = {}
    const trimmedName = name.trim()
    const trimmedIp = ip.trim()
    const portNumber = Number(port)

    if (!trimmedName) {
      nextErrors.name = 'Enter a tunnel name.'
    }

    if (!providerId) {
      nextErrors.providerId = 'Select a provider.'
    }

    if (!trimmedIp) {
      nextErrors.ip = 'Enter an IP address.'
    }

    if (
      !port ||
      !Number.isInteger(portNumber) ||
      portNumber < 1 ||
      portNumber > 65535
    ) {
      nextErrors.port = 'Enter a valid port.'
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }

    setErrors({})
    setFormError('')
    setSubmitting(true)

    try {
      const tunnel = await createTunnel({
        name: trimmedName,
        providerId,
        ip: trimmedIp,
        port: portNumber,
        type,
      })
      onCreated(tunnel)
      onClose()
    } catch (requestError) {
      setFormError(
        requestError instanceof Error
          ? requestError.message
          : 'Could not add tunnel.',
      )
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Add tunnel" onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate>
        <Field label="Name" htmlFor="tunnel-name" error={errors.name}>
          <input
            id="tunnel-name"
            className="input"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              clearError('name')
            }}
            placeholder="Tunnel name"
            autoComplete="off"
            autoFocus
            aria-invalid={Boolean(errors.name)}
          />
        </Field>

        <Field
          label="Provider"
          htmlFor="tunnel-provider"
          error={errors.providerId}
        >
          <Dropdown
            id="tunnel-provider"
            value={providerId}
            options={providerOptions}
            onChange={(value) => {
              setProviderId(value)
              clearError('providerId')
            }}
            placeholder="Select a provider"
            invalid={Boolean(errors.providerId)}
            label="Provider"
          />
        </Field>

        <Field label="IP" htmlFor="tunnel-ip" error={errors.ip}>
          <input
            id="tunnel-ip"
            className="input"
            type="text"
            value={ip}
            onChange={(event) => {
              setIp(event.target.value)
              clearError('ip')
            }}
            placeholder="localhost"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors.ip)}
          />
        </Field>

        <div className="form-row">
          <Field label="Port" htmlFor="tunnel-port" error={errors.port}>
            <input
              id="tunnel-port"
              className="input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={5}
              value={port}
              onChange={(event) => {
                setPort(event.target.value.replace(/\D/g, ''))
                clearError('port')
              }}
              placeholder="3000"
              autoComplete="off"
              aria-invalid={Boolean(errors.port)}
            />
          </Field>

          <Field label="Type" htmlFor="tunnel-type">
            <Dropdown
              id="tunnel-type"
              value={type}
              options={typeOptions}
              onChange={(value) => setType(value as TunnelType)}
              label="Type"
            />
          </Field>
        </div>

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
            {submitting ? 'Adding...' : 'Add tunnel'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
