export type Provider = {
  id: string
  name: string
  createdAt: string
}

export type TunnelType = 'https' | 'http' | 'tcp' | 'udp'

export type Tunnel = {
  id: string
  name: string
  providerId: string
  ip: string
  port: number
  type: TunnelType
  createdAt: string
}

export type NewTunnel = {
  name: string
  providerId: string
  ip: string
  port: number
  type: TunnelType
}
