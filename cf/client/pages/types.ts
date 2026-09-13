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
  /** Public path slug without leading slash, e.g. "hello" for /!tunnel=hello. */
  slug: string;
  /** Tunnel type — only HTTP for now. */
  tunnelType: string;
  target: string;
  /** Selected host id (Hosts page) — CLI agent that serves this tunnel. */
  hostId: string;
  /** Selected provider id (Providers page). */
  providerId: string;
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
