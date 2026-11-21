import type { Agent, NewTunnel, Provider, Tunnel } from './types'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let message = 'Something went wrong.'

    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // Keep the generic message when the body is not JSON.
    }

    throw new Error(message)
  }

  return (await response.json()) as T
}

export function getProviders(): Promise<Provider[]> {
  return request<Provider[]>('/api/providers')
}

export function createProvider(name: string): Promise<Provider> {
  return request<Provider>('/api/providers', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function updateProvider(id: string, name: string): Promise<Provider> {
  return request<Provider>(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export function deleteProvider(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(
    `/api/providers/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

export function getAgents(): Promise<Agent[]> {
  return request<Agent[]>('/api/agents')
}

export function createAgent(name: string): Promise<Agent> {
  return request<Agent>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function updateAgent(id: string, name: string): Promise<Agent> {
  return request<Agent>(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export function deleteAgent(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function getTunnels(): Promise<Tunnel[]> {
  return request<Tunnel[]>('/api/tunnels')
}

export function createTunnel(tunnel: NewTunnel): Promise<Tunnel> {
  return request<Tunnel>('/api/tunnels', {
    method: 'POST',
    body: JSON.stringify(tunnel),
  })
}

export function updateTunnel(id: string, tunnel: NewTunnel): Promise<Tunnel> {
  return request<Tunnel>(`/api/tunnels/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(tunnel),
  })
}

export function deleteTunnel(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(
    `/api/tunnels/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}
