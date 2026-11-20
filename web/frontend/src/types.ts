export type Provider = {
  id: string
  name: string
  createdAt: string
}

export type AgentStatus = 'pending' | 'online' | 'offline' | 'rejected'

export type Agent = {
  id: string
  name: string
  status: AgentStatus
  authorized: boolean
  connected: boolean
  createdAt: string
  connectedAt?: string
}

export type TunnelType = 'https' | 'http' | 'tcp' | 'udp'

export type TunnelStatus = 'pending' | 'active' | 'error'

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

export type ClaimAction = 'allow' | 'cancel'
