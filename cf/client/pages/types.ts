export type WorkerStatus = {
  loading: boolean;
  error: string | null;
  message: string | null;
  timestamp: string | null;
  healthy: boolean | null;
};

export type Tunnel = {
  id: string;
  name: string;
  target: string;
  active: boolean;
  createdAt: number;
};

export type Host = {
  id: string;
  hostname: string;
  tunnel: string;
  createdAt: number;
};

export type Provider = {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  createdAt: number;
};
