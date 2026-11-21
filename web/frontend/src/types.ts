export type Provider = {
  id: string
  name: string
  createdAt: string
}

export type AgentStatus = 'online' | 'offline'

export type Agent = {
  id: string
  name: string
  token: string
  status: AgentStatus
  connected: boolean
  createdAt: string
  connectedAt?: string
}

export type TunnelType = 'https' | 'http' | 'tcp' | 'udp'

export type TunnelStatus = 'pending' | 'active' | 'error' | 'stopped'

export type Tunnel = {
  id: string
  name: string
  providerId: string
  agentId: string
  ip: string
  port: number
  type: TunnelType
  publicUrl: string
  status: TunnelStatus
  error?: string
  createdAt: string
}

export type NewTunnel = {
  name: string
  providerId: string
  agentId: string
  ip: string
  port: number
  type: TunnelType
}
