'use client'

import clsx from 'clsx'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'

/**
 * <TryIt> — an interactive, server-proxied request runner for the ZB ID
 * developer docs. It holds NO shared credential: it POSTs to /api/try, which
 * targets the STAGING host only and attaches ONLY the caller's own bearer
 * token (if any). See src/app/api/try/route.ts.
 *
 * TOKEN CHAINING: when a /auth/login or /auth/register call returns an
 * `accessToken`, it is stored in sessionStorage under a shared key. Panels
 * marked `useToken` auto-attach that token as `bearer`, with a manual paste
 * override and a clear control. Nothing is ever persisted beyond the session.
 *
 * Rendering is gated on NEXT_PUBLIC_TRYIT_ENABLED === 'true' (inlined at build
 * time) so the whole console can be switched off per environment.
 */

type Method = 'GET' | 'POST'

type QueryRow = { key: string; value: string }

export interface TryItProps {
  method: Method
  path: string
  title?: string
  description?: string
  defaultBody?: Record<string, unknown> | unknown[]
  defaultQuery?: Record<string, string | number | boolean>
  pathParams?: string[]
  /**
   * When true, this panel is token-scoped: it auto-attaches the chained token
   * from the last sign-in as the bearer, and shows the token controls.
   */
  useToken?: boolean
  /**
   * When true (login / register panels), the `accessToken` in a successful
   * response is captured into the shared session token so later panels chain
   * from it.
   */
  seedsToken?: boolean
  /**
   * For endpoints that validate a token passed in the JSON BODY (introspection)
   * rather than the Authorization header. When set, the chained/pasted token is
   * written into this body field just before the request runs, so the panel can
   * introspect the token from your last sign-in without you pasting it.
   */
  tokenBodyField?: string
}

interface ProxyResult {
  ok: boolean
  status: number
  statusText?: string
  durationMs?: number
  body?: unknown
  headers?: Record<string, string>
  error?: string
}

const METHOD_BADGE: Record<Method, string> = {
  GET: 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30',
  POST: 'bg-sky-400/15 text-sky-300 ring-sky-400/30',
}

const ENABLED = process.env.NEXT_PUBLIC_TRYIT_ENABLED === 'true'

// Shared key for the chained access token (sessionStorage only).
const TOKEN_KEY = 'zbid-tryit-token'
// Cross-panel notification so a login in one panel updates the others live.
const TOKEN_EVENT = 'zbid-tryit-token-change'

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeToken(token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* sessionStorage unavailable */
  }
  try {
    window.dispatchEvent(new CustomEvent(TOKEN_EVENT))
  } catch {
    /* no window */
  }
}

function statusTone(status: number): string {
  if (status >= 200 && status < 300)
    return 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30'
  if (status >= 400 && status < 500)
    return 'bg-amber-400/15 text-amber-300 ring-amber-400/30'
  return 'bg-red-400/15 text-red-300 ring-red-400/30'
}

/** Split a path into rendered segments, highlighting {param} slots. */
function PathDisplay({ path }: { path: string }) {
  const parts = path.split(/(\{[^}]+\})/g).filter(Boolean)
  return (
    <span className="font-mono text-xs break-all text-zinc-300">
      {parts.map((part, i) =>
        part.startsWith('{') ? (
          <span
            key={i}
            className="rounded bg-emerald-400/15 px-1 text-emerald-300 ring-1 ring-emerald-400/25 ring-inset"
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  )
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z"
      />
    </svg>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => setCopied(true))
      }}
      className="rounded-md px-2 py-1 text-2xs font-medium text-zinc-400 ring-1 ring-white/10 ring-inset transition hover:bg-white/5 hover:text-zinc-200"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** Extract an accessToken from a variety of response body shapes. */
function extractAccessToken(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  const t = b.accessToken ?? b.access_token
  return typeof t === 'string' && t ? t : undefined
}

export function TryIt({
  method,
  path,
  title,
  description,
  defaultBody,
  defaultQuery,
  pathParams = [],
  useToken = false,
  seedsToken = false,
  tokenBodyField,
}: TryItProps) {
  const uid = useId()

  // ---- editable state ----
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(pathParams.map((p) => [p, ''])),
  )
  const [queryRows, setQueryRows] = useState<QueryRow[]>(() =>
    defaultQuery
      ? Object.entries(defaultQuery).map(([key, value]) => ({
          key,
          value: String(value),
        }))
      : [{ key: '', value: '' }],
  )
  const [bodyText, setBodyText] = useState<string>(() =>
    defaultBody ? JSON.stringify(defaultBody, null, 2) : '',
  )
  const [bodyError, setBodyError] = useState<string | null>(null)

  // ---- token chaining ----
  const [chainedToken, setChainedToken] = useState('')
  const [manualToken, setManualToken] = useState('')
  const [tokenOpen, setTokenOpen] = useState(false)

  // ---- request state ----
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ProxyResult | null>(null)
  const [headersOpen, setHeadersOpen] = useState(false)

  const hasBody = method === 'POST'

  // Keep the chained token in sync across panels (login here updates users/me).
  useEffect(() => {
    if (!useToken && !seedsToken) return
    const sync = () => setChainedToken(readToken())
    sync()
    window.addEventListener(TOKEN_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(TOKEN_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [useToken, seedsToken])

  // The concrete path with {param} slots filled in for display + request.
  const resolvedPath = useMemo(() => {
    let p = path
    for (const name of pathParams) {
      const val = params[name]?.trim()
      p = p.replace(`{${name}}`, val ? encodeURIComponent(val) : `{${name}}`)
    }
    return p
  }, [path, pathParams, params])

  const formatBody = useCallback(() => {
    if (!bodyText.trim()) return
    try {
      const parsed = JSON.parse(bodyText)
      setBodyText(JSON.stringify(parsed, null, 2))
      setBodyError(null)
    } catch (e) {
      setBodyError(e instanceof Error ? e.message : 'Invalid JSON')
    }
  }, [bodyText])

  const updateQueryRow = (i: number, patch: Partial<QueryRow>) => {
    setQueryRows((rows) =>
      rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    )
  }
  const addQueryRow = () =>
    setQueryRows((rows) => [...rows, { key: '', value: '' }])
  const removeQueryRow = (i: number) =>
    setQueryRows((rows) => rows.filter((_, idx) => idx !== i))

  // The bearer this panel will send: manual paste wins, else the chained token.
  const effectiveBearer = manualToken.trim() || chainedToken

  const run = useCallback(async () => {
    setBodyError(null)

    // Guard: unfilled path params.
    const missing = pathParams.filter((p) => !params[p]?.trim())
    if (missing.length > 0) {
      setResult({
        ok: false,
        status: 400,
        error: `Fill in the path parameter${
          missing.length > 1 ? 's' : ''
        }: ${missing.join(', ')}.`,
      })
      return
    }

    // Parse body up front so the user sees a clean inline error.
    let parsedBody: unknown = undefined
    if (hasBody && bodyText.trim()) {
      try {
        parsedBody = JSON.parse(bodyText)
      } catch (e) {
        setBodyError(e instanceof Error ? e.message : 'Invalid JSON')
        return
      }
    }

    // For body-token endpoints (introspection): drop the chained/pasted token
    // into the named body field unless the user already typed one there.
    if (tokenBodyField && effectiveBearer) {
      const base =
        parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
          ? (parsedBody as Record<string, unknown>)
          : {}
      const existing = base[tokenBodyField]
      if (!existing || existing === 'paste-a-token-here') {
        parsedBody = { ...base, [tokenBodyField]: effectiveBearer }
      }
    }

    const query: Record<string, string> = {}
    for (const { key, value } of queryRows) {
      if (key.trim()) query[key.trim()] = value
    }

    setLoading(true)
    setResult(null)
    setHeadersOpen(false)
    try {
      const res = await fetch('/api/try', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          path: resolvedPath,
          query,
          body: parsedBody,
          bearer: useToken ? effectiveBearer || undefined : undefined,
        }),
      })
      const data = (await res.json()) as ProxyResult
      setResult(data)

      // Seed the shared token from a successful login / register.
      if (seedsToken && data.ok) {
        const token = extractAccessToken(data.body)
        if (token) writeToken(token)
      }
    } catch {
      setResult({
        ok: false,
        status: 0,
        error:
          'Network error. Could not reach the docs server. Check your connection and try again.',
      })
    } finally {
      setLoading(false)
    }
  }, [
    hasBody,
    bodyText,
    queryRows,
    params,
    pathParams,
    method,
    resolvedPath,
    useToken,
    effectiveBearer,
    seedsToken,
    tokenBodyField,
  ])

  if (!ENABLED) {
    return (
      <div className="not-prose my-6 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/2.5 dark:text-zinc-400">
        Interactive console disabled in this environment.
      </div>
    )
  }

  const prettyBody =
    result?.body !== undefined
      ? typeof result.body === 'string'
        ? result.body
        : JSON.stringify(result.body, null, 2)
      : ''

  const usingChained = useToken && !manualToken.trim() && !!chainedToken

  return (
    <div className="not-prose my-8 overflow-hidden rounded-2xl bg-zinc-900 shadow-md ring-1 ring-white/10">
      {/* header */}
      <div className="flex flex-col gap-1 border-b border-white/5 bg-white/[0.02] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span
            className={clsx(
              'inline-flex items-center rounded-md px-2 py-0.5 text-2xs font-semibold ring-1 ring-inset',
              METHOD_BADGE[method],
            )}
          >
            {method}
          </span>
          <PathDisplay path={path} />
          <span className="ml-auto text-2xs font-medium tracking-wide text-zinc-500 uppercase">
            Try it
          </span>
        </div>
        {title && <p className="text-sm font-medium text-zinc-200">{title}</p>}
        {description && <p className="text-xs text-zinc-400">{description}</p>}
      </div>

      {/* staging banner */}
      <div className="flex items-start gap-2 border-b border-white/5 bg-amber-400/[0.06] px-4 py-2.5">
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="mt-0.5 h-3.5 w-3.5 flex-none fill-amber-400"
        >
          <circle cx="8" cy="8" r="8" />
          <path fill="#18181b" d="M7.25 4.5h1.5v4.5h-1.5zM7.25 10h1.5v1.5h-1.5z" />
        </svg>
        <p className="text-2xs leading-relaxed text-amber-200/90">
          Runs against the ZB ID STAGING sandbox (id-staging.zb.co.zw). Register
          a throwaway test account; never use real credentials.
        </p>
      </div>

      <div className="space-y-4 px-4 py-4">
        {/* token indicator (token-scoped panels only) */}
        {useToken && (
          <div className="rounded-lg bg-white/[0.02] ring-1 ring-white/5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              {usingChained ? (
                <span className="inline-flex items-center gap-1.5 text-2xs text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Using the token from your last sign-in
                </span>
              ) : manualToken.trim() ? (
                <span className="inline-flex items-center gap-1.5 text-2xs text-sky-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                  Using the token you pasted below
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-2xs text-zinc-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
                  No token yet. Sign in above, or paste one below.
                </span>
              )}
              <div className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setTokenOpen((o) => !o)}
                  aria-expanded={tokenOpen}
                  className="text-2xs font-medium text-emerald-400 transition hover:text-emerald-300"
                >
                  {tokenOpen ? 'Hide token' : 'Paste a token'}
                </button>
                {chainedToken && (
                  <button
                    type="button"
                    onClick={() => {
                      writeToken('')
                      setManualToken('')
                    }}
                    className="text-2xs font-medium text-zinc-500 transition hover:text-zinc-300"
                  >
                    Clear token
                  </button>
                )}
              </div>
            </div>
            {tokenOpen && (
              <div className="space-y-1.5 px-3 pb-3">
                <input
                  type="password"
                  autoComplete="off"
                  aria-label="Bearer token override"
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="Paste an access token to override"
                  className="w-full rounded-md border-0 bg-white/5 px-2.5 py-1.5 font-mono text-xs text-zinc-100 ring-1 ring-white/10 ring-inset placeholder:text-zinc-600 focus:ring-2 focus:ring-emerald-400/60 focus:outline-none"
                />
                <p className="text-2xs text-zinc-500">
                  A pasted token takes priority over the chained one. It is sent
                  only to this site&apos;s server proxy and is never stored in
                  the page.
                </p>
              </div>
            )}
          </div>
        )}

        {/* path params */}
        {pathParams.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-2xs font-semibold tracking-wide text-zinc-400 uppercase">
              Path parameters
            </legend>
            {pathParams.map((name) => (
              <div key={name} className="flex items-center gap-2">
                <label
                  htmlFor={`${uid}-param-${name}`}
                  className="w-28 flex-none font-mono text-xs text-emerald-300"
                >
                  {name}
                </label>
                <input
                  id={`${uid}-param-${name}`}
                  value={params[name] ?? ''}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, [name]: e.target.value }))
                  }
                  placeholder={`e.g. value`}
                  className="min-w-0 flex-auto rounded-md border-0 bg-white/5 px-2.5 py-1.5 font-mono text-xs text-zinc-100 ring-1 ring-white/10 ring-inset placeholder:text-zinc-600 focus:ring-2 focus:ring-emerald-400/60 focus:outline-none"
                />
              </div>
            ))}
          </fieldset>
        )}

        {/* query editor */}
        {(method === 'GET' || queryRows.length > 0) && (
          <fieldset className="space-y-2">
            <legend className="text-2xs font-semibold tracking-wide text-zinc-400 uppercase">
              Query parameters
            </legend>
            {queryRows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  aria-label={`Query key ${i + 1}`}
                  value={row.key}
                  onChange={(e) => updateQueryRow(i, { key: e.target.value })}
                  placeholder="key"
                  className="w-1/3 min-w-0 rounded-md border-0 bg-white/5 px-2.5 py-1.5 font-mono text-xs text-zinc-100 ring-1 ring-white/10 ring-inset placeholder:text-zinc-600 focus:ring-2 focus:ring-emerald-400/60 focus:outline-none"
                />
                <input
                  aria-label={`Query value ${i + 1}`}
                  value={row.value}
                  onChange={(e) => updateQueryRow(i, { value: e.target.value })}
                  placeholder="value"
                  className="min-w-0 flex-auto rounded-md border-0 bg-white/5 px-2.5 py-1.5 font-mono text-xs text-zinc-100 ring-1 ring-white/10 ring-inset placeholder:text-zinc-600 focus:ring-2 focus:ring-emerald-400/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeQueryRow(i)}
                  aria-label={`Remove query parameter ${i + 1}`}
                  className="flex-none rounded-md px-2 py-1.5 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addQueryRow}
              className="text-2xs font-medium text-emerald-400 transition hover:text-emerald-300"
            >
              + Add parameter
            </button>
          </fieldset>
        )}

        {/* JSON body */}
        {hasBody && (
          <fieldset className="space-y-1.5">
            <div className="flex items-center justify-between">
              <legend className="text-2xs font-semibold tracking-wide text-zinc-400 uppercase">
                Request body (JSON)
              </legend>
              <button
                type="button"
                onClick={formatBody}
                className="text-2xs font-medium text-emerald-400 transition hover:text-emerald-300"
              >
                Format JSON
              </button>
            </div>
            <textarea
              aria-label="Request body JSON"
              value={bodyText}
              spellCheck={false}
              onChange={(e) => {
                setBodyText(e.target.value)
                if (bodyError) setBodyError(null)
              }}
              rows={Math.min(16, Math.max(6, bodyText.split('\n').length + 1))}
              className="w-full resize-y rounded-md border-0 bg-white/5 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 ring-1 ring-white/10 ring-inset placeholder:text-zinc-600 focus:ring-2 focus:ring-emerald-400/60 focus:outline-none"
            />
            {bodyError && (
              <p className="text-2xs text-red-400">Invalid JSON: {bodyError}</p>
            )}
          </fieldset>
        )}

        {/* run */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={loading}
            className={clsx(
              'inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold transition',
              'bg-emerald-500 text-white hover:bg-emerald-400',
              'focus:ring-2 focus:ring-emerald-400/60 focus:outline-none',
              loading && 'cursor-not-allowed opacity-70',
            )}
          >
            {loading && <Spinner />}
            {loading ? 'Running' : 'Run'}
          </button>
          {result && (
            <div className="flex items-center gap-2 text-2xs text-zinc-500">
              <span
                className={clsx(
                  'inline-flex items-center rounded-md px-2 py-0.5 font-semibold ring-1 ring-inset',
                  statusTone(result.status),
                )}
              >
                {result.status || 'ERR'}
                {result.statusText ? ` ${result.statusText}` : ''}
              </span>
              {typeof result.durationMs === 'number' && (
                <span>{result.durationMs} ms</span>
              )}
            </div>
          )}
        </div>

        {/* token captured hint */}
        {seedsToken && result?.ok && extractAccessToken(result.body) && (
          <p className="text-2xs text-emerald-300">
            Access token captured. Token-scoped panels below will use it
            automatically.
          </p>
        )}

        {/* response */}
        {result && (
          <div className="space-y-2">
            {result.error && (
              <div
                className={clsx(
                  'rounded-lg px-3 py-2 text-xs ring-1 ring-inset',
                  result.status === 429
                    ? 'bg-amber-400/10 text-amber-300 ring-amber-400/25'
                    : 'bg-red-400/10 text-red-300 ring-red-400/25',
                )}
              >
                {result.error}
              </div>
            )}

            {prettyBody && (
              <div className="overflow-hidden rounded-lg ring-1 ring-white/10">
                <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-3 py-1.5">
                  <span className="text-2xs font-medium tracking-wide text-zinc-500 uppercase">
                    Response body
                  </span>
                  <CopyButton text={prettyBody} />
                </div>
                <pre className="max-h-96 overflow-auto p-3 font-mono text-xs leading-relaxed text-zinc-200">
                  {prettyBody}
                </pre>
              </div>
            )}

            {result.headers && Object.keys(result.headers).length > 0 && (
              <div className="rounded-lg bg-white/[0.02] ring-1 ring-white/5">
                <button
                  type="button"
                  onClick={() => setHeadersOpen((o) => !o)}
                  aria-expanded={headersOpen}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-2xs font-medium text-zinc-400 transition hover:text-zinc-200"
                >
                  <span>Response headers</span>
                  <span
                    className={clsx(
                      'transition-transform',
                      headersOpen && 'rotate-90',
                    )}
                    aria-hidden="true"
                  >
                    &rsaquo;
                  </span>
                </button>
                {headersOpen && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-2.5 font-mono text-2xs">
                    {Object.entries(result.headers).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-zinc-500">{k}</dt>
                        <dd className="break-all text-zinc-300">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default TryIt
