/**
 * Rate-limit + token helpers — ported from ks-ssh-v2/cf/worker/limit.ts
 * so CLI<->CF pairing behaves identically (token routing, per-IP budgets,
 * fragment-only E2E `k` guard). Pure helpers (no DO types) so
 * `node scripts/relay-check.mjs` style unit tests still work.
 *
 * Tokens route; `k` seals. Same shape as ks-ssh-v2 so the two repos can
 * share tokens / tooling: 5-char legacy still routes, fresh tunnels mint 9.
 */

/** 5-char legacy or 9-char fresh — exactly those lengths, [A-Z0-9]. */
export const TOKEN_RE = /^(?:[A-Z0-9]{5}|[A-Z0-9]{9})$/

/** Tunnel slugs are lower-case a-z0-9 hyphen, 2-32 chars. */
export const SLUG_RE = /^[a-z0-9-]{2,32}$/

/** Host IDs: tunnel's [A-Za-z0-9_-]{5,64} OR the shorter TOKEN form above. */
export const HOST_RE = /^[A-Za-z0-9_-]{5,64}$/

/** Fixed-window limits (per isolate; HostPresence DO adds per-socket limits). */
export const RATE_IP_LIMIT = 120
export const RATE_IP_WINDOW_MS = 60_000
export const RATE_MISS_LIMIT = 20
export const RATE_MISS_WINDOW_MS = 60_000

export type LimitBucket = { n: number; reset: number }
export type LimitState = Map<string, { n: number; reset: number }>

/**
 * Fixed-window check. Mutates `state`. Returns `allowed` + `retryAfter`
 * seconds (0 when allowed). Pure time via `now` param for tests.
 */
export function checkLimit(
  state: LimitState,
  key: string,
  now: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfter: number } {
  const cur = state.get(key)
  if (!cur || now >= cur.reset) {
    state.set(key, { n: 1, reset: now + windowMs })
    return { allowed: true, retryAfter: 0 }
  }
  if (cur.n < limit) {
    cur.n += 1
    return { allowed: true, retryAfter: 0 }
  }
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((cur.reset - now) / 1000)) }
}

/** Normalize + validate a token/host query param (uppercases token form). */
export function validToken(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.trim().toUpperCase()
  return TOKEN_RE.test(t) ? t : null
}

/** Validate a host id (legacy 5-64 [A-Za-z0-9_-] or TOKEN form). Accepts both. */
export function validHost(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.trim()
  if (HOST_RE.test(t)) return t
  const tok = validToken(t)
  return tok
}

/** Best-effort client IP for per-IP limits (never logged with secrets). */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")
  if (cf && cf.trim()) return cf.trim().slice(0, 64)
  const xff = req.headers.get("x-forwarded-for")
  if (xff && xff.trim()) return xff.split(",")[0]!.trim().slice(0, 64)
  return "unknown"
}

/** 429 JSON with `Retry-After` (token scans + floods back off here). */
export function rateLimited(retryAfter: number): Response {
  return Response.json(
    { ok: false, error: "rate limited — slow down and retry" },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfter),
        "cache-control": "no-store",
      },
    },
  )
}
