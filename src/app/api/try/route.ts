/**
 * Server-side "Try it" forwarder for the ZB ID developer docs.
 *
 * SECURITY MODEL (do not weaken):
 *  - Runs on the Node.js runtime only.
 *  - NO SHARED SECRET. ZB ID is an auth service; the safe playground endpoints
 *    are either PUBLIC (discovery, register, login, introspect) or use the
 *    USER'S OWN bearer token from an interactive login on the page. This proxy
 *    injects NO server-side key and holds NO credential. If the client passes a
 *    `bearer`, it is attached as `Authorization: Bearer <it>` and otherwise no
 *    auth header is sent. Tokens are NEVER logged and NEVER echoed back.
 *  - The upstream base URL is fixed to the STAGING host id-staging.zb.co.zw.
 *    A caller cannot override the host: only a whitelisted method + relative
 *    path is accepted, and the URL is always built as `${STAGING_BASE}${path}`.
 *    Absolute URLs, schemes, hosts, protocol-relative paths and traversal in
 *    `path` are rejected. Never prod.
 *  - Every request is matched against an explicit method+path whitelist
 *    (regex). Anything else -> 400. No admin, KYC, password-reset, token,
 *    deactivate, logout, delete, grant/revoke, PATCH or role route is
 *    reachable, by design (see EXCLUDED note at the bottom).
 *  - Per-IP in-memory sliding-window rate limit (~30/min) -> 429.
 *  - 15s upstream timeout. Only a safe subset of upstream response headers is
 *    echoed back to the browser.
 */

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// STAGING ONLY. Never prod. `path` is always appended to this fixed base, so
// the effective host can never be anything other than what this resolves to.
const STAGING_BASE = process.env.ZBID_STAGING_BASE ?? 'https://id-staging.zb.co.zw'

type Method = 'GET' | 'POST'

/**
 * The complete server-enforced whitelist. Verified against the LIVE staging
 * OpenAPI (https://id-staging.zb.co.zw/v3/api-docs) and this repo's MDX pages
 * on 2026-08-11. Only these exact method + path shapes ever reach the upstream.
 *
 * SAFE set only:
 *  - public discovery: JWKS, OpenID config, service info, the OpenAPI doc
 *  - public auth flows: register (creates a throwaway), login (anti-enum),
 *    introspect (returns active:false for bad tokens)
 *  - token-scoped reads that only ever read the CALLER'S OWN data with the
 *    caller's own bearer: current user, active sessions, and memberships for
 *    the calling identity. None mutate anything.
 *
 * Patterns are anchored and mutually exclusive per method, so at most one
 * matches. NO admin / KYC / password / token / deactivate / logout / delete /
 * grant / revoke / PATCH / role endpoint appears here.
 */
const WHITELIST: ReadonlyArray<{ method: Method; pattern: RegExp }> = [
  // --- public discovery (no auth needed) ---
  { method: 'GET', pattern: /^\/\.well-known\/jwks\.json$/ },
  { method: 'GET', pattern: /^\/\.well-known\/openid-configuration$/ },
  { method: 'GET', pattern: /^\/$/ },
  { method: 'GET', pattern: /^\/v3\/api-docs$/ },

  // --- public auth flows (safe; register a throwaway, never real creds) ---
  { method: 'POST', pattern: /^\/auth\/register$/ },
  { method: 'POST', pattern: /^\/auth\/login$/ },

  // --- token validation (public; returns active:false for unknown tokens) ---
  { method: 'POST', pattern: /^\/oauth\/introspect$/ },

  // --- caller-scoped reads (require the caller's own bearer; read-only) ---
  { method: 'GET', pattern: /^\/users\/me$/ },
  { method: 'GET', pattern: /^\/sessions$/ },
  { method: 'GET', pattern: /^\/v1\/memberships$/ },
]

function isWhitelisted(method: string, path: string): boolean {
  return WHITELIST.some((w) => w.method === method && w.pattern.test(path))
}

// ---- rate limiting (in-memory sliding window, per client IP) ----
const RATE_LIMIT = 30 // requests
const RATE_WINDOW_MS = 60_000 // per 60s
const hits = new Map<string, number[]>()

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim() // first hop is the client
  return req.headers.get('x-real-ip')?.trim() || 'unknown'
}

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const cutoff = now - RATE_WINDOW_MS
  const recent = (hits.get(ip) ?? []).filter((t) => t > cutoff)
  recent.push(now)
  hits.set(ip, recent)

  // opportunistic cleanup so the map cannot grow unbounded
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      const kept = v.filter((t) => t > cutoff)
      if (kept.length === 0) hits.delete(k)
      else hits.set(k, kept)
    }
  }

  return recent.length > RATE_LIMIT
}

// Only these upstream response headers are ever echoed back to the browser.
// Authorization / Set-Cookie and everything else are dropped.
const SAFE_HEADER_ALLOW = (name: string): boolean => {
  const n = name.toLowerCase()
  return n === 'content-type' || n.startsWith('x-ratelimit-')
}

function buildQueryString(query: unknown): string {
  if (!query || typeof query !== 'object') return ''
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue
    params.append(k, String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

export async function POST(req: Request) {
  const ip = clientIp(req)

  if (rateLimited(ip)) {
    return NextResponse.json(
      {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        error:
          'You are running requests too quickly. The playground allows about 30 requests per minute. Wait a moment and try again.',
      },
      { status: 429 },
    )
  }

  let payload: {
    method?: string
    path?: string
    query?: Record<string, unknown>
    body?: unknown
    bearer?: string
  }
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, status: 400, error: 'Request body must be valid JSON.' },
      { status: 400 },
    )
  }

  const method = String(payload.method ?? '').toUpperCase()
  const path = String(payload.path ?? '')

  // HOST LOCK: reject anything that is not a clean, relative path. This is what
  // keeps the target host pinned to staging: no absolute URLs, no host, no
  // scheme, no protocol-relative path, no traversal, no whitespace.
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('://') ||
    path.includes('..') ||
    path.includes('\\') ||
    /\s/.test(path)
  ) {
    return NextResponse.json(
      { ok: false, status: 400, error: 'Path is not an allowed relative endpoint.' },
      { status: 400 },
    )
  }

  if (!['GET', 'POST'].includes(method)) {
    return NextResponse.json(
      {
        ok: false,
        status: 400,
        error: `Method ${method || '(none)'} is not allowed.`,
      },
      { status: 400 },
    )
  }

  if (!isWhitelisted(method, path)) {
    return NextResponse.json(
      {
        ok: false,
        status: 400,
        error: `${method} ${path} is not on the interactive whitelist.`,
      },
      { status: 400 },
    )
  }

  // Build the upstream URL from the FIXED staging base + the (whitelisted,
  // relative-only) path. The host can never be caller-controlled.
  const url = `${STAGING_BASE}${path}${buildQueryString(payload.query)}`

  const headers: Record<string, string> = { Accept: 'application/json' }

  // The ONLY credential ever attached is the caller's own bearer token, taken
  // from the request body (never from server state). Never logged, never
  // returned. If absent, the request goes out unauthenticated.
  const bearer = typeof payload.bearer === 'string' ? payload.bearer.trim() : ''
  if (bearer) headers.Authorization = `Bearer ${bearer}`

  const requestInit: RequestInit = { method, headers }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    requestInit.body =
      typeof payload.body === 'string'
        ? payload.body
        : JSON.stringify(payload.body ?? {})
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  const started = Date.now()

  try {
    const upstream = await fetch(url, {
      ...requestInit,
      signal: controller.signal,
      cache: 'no-store',
    })
    const durationMs = Date.now() - started

    // Parse the body as JSON, fall back to text.
    const raw = await upstream.text()
    let body: unknown = raw
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }

    // Echo only a safe subset of upstream headers.
    const safeHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      if (SAFE_HEADER_ALLOW(key)) safeHeaders[key] = value
    })

    return NextResponse.json({
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
      durationMs,
      body,
      headers: safeHeaders,
    })
  } catch (err) {
    const durationMs = Date.now() - started
    const aborted = err instanceof Error && err.name === 'AbortError'
    // We deliberately do not log the error object (it can carry the request URL
    // and, in some runtimes, headers). Return a generic message only.
    return NextResponse.json(
      {
        ok: false,
        status: aborted ? 504 : 502,
        statusText: aborted ? 'Gateway Timeout' : 'Bad Gateway',
        durationMs,
        error: aborted
          ? 'The staging sandbox did not respond within 15 seconds. Try again.'
          : 'Could not reach the staging sandbox. It may be briefly unavailable.',
      },
      { status: 200 }, // 200 envelope; the real status is in the body for the UI
    )
  } finally {
    clearTimeout(timeout)
  }
}

export function GET() {
  return NextResponse.json({ ok: false, error: 'Use POST.' }, { status: 405 })
}

/**
 * DELIBERATELY EXCLUDED as unsafe (never reachable through this proxy):
 *  - all /admin/* (OAuth client CRUD + secret rotation)
 *  - all /v1/kyc/* (real FCB credit-check, World-Check screening, eGov ID)
 *  - /auth/password/forgot, /auth/password/reset (email real reset links),
 *    /auth/password/change
 *  - /auth/deactivate, /auth/logout, /auth/logout/all (destroy sessions)
 *  - /auth/token/refresh, /oauth/token (client-credentials, needs a secret)
 *  - PATCH /users/me, PATCH /users/{id}/status, GET /users/{id},
 *    GET /users/phone/{phone}, all /users/{id}/roles routes (admin / other
 *    users' data)
 *  - POST /v1/memberships, DELETE /v1/memberships/{id} (grant / revoke)
 *  - DELETE /sessions, DELETE /sessions/{id} (revoke)
 *  - /docs (redirect)
 * When in doubt whether an endpoint is safe and non-destructive, it is LEFT OUT.
 */
