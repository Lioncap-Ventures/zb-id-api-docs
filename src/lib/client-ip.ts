/*
 * THE ONE CLIENT-IP READER IN THIS REPOSITORY (standing delta 5).
 *
 * On Cloud Run the Google front end APPENDS the peer it connected to, so
 * `X-Forwarded-For` reads `<whatever the caller wrote>, <the real peer>`. Only
 * the LAST entry is beyond the caller's reach. Reading the first entry hands
 * every forged request its own throttle bucket (proven twice in the estate).
 *
 * CF-Connecting-IP is honoured ONLY when that appended peer is inside
 * Cloudflare's published ranges, i.e. the request really came through the
 * Cloudflare proxy. Any other peer means the header is caller-written and is
 * ignored. zbid-docs.lioncapventures.com IS proxied by Cloudflare, so without
 * the range gate every visitor behind one Cloudflare edge would share a bucket.
 * Same rule and ranges as zb-developer-portal src/server/client-ip.ts.
 *
 * Pure: no `server-only`, no configuration at import time, so tests load it.
 */

type HeaderBag = { get(name: string): string | null }

/** cloudflare.com/ips, identical to zb-re-core ClientIp.kt CLOUDFLARE_RANGES. */
export const CLOUDFLARE_RANGES: ReadonlyArray<string> = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = BigInt(0)
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << BigInt(8)) + BigInt(n)
  }
  return value
}

function parseIpv6(ip: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(ip) || !ip.includes(':')) return null
  let head: string[]
  let tail: string[]
  const doubleColon = ip.split('::')
  if (doubleColon.length > 2) return null
  if (doubleColon.length === 2) {
    head = doubleColon[0] ? doubleColon[0].split(':') : []
    tail = doubleColon[1] ? doubleColon[1].split(':') : []
  } else {
    head = ip.split(':')
    tail = []
  }
  const expandV4 = (groups: string[]): string[] | null => {
    const last = groups.at(-1)
    if (last && last.includes('.')) {
      const v4 = parseIpv4(last)
      if (v4 === null) return null
      const hi = Number((v4 >> BigInt(16)) & BigInt(0xffff)).toString(16)
      const lo = Number(v4 & BigInt(0xffff)).toString(16)
      return [...groups.slice(0, -1), hi, lo]
    }
    return groups
  }
  const h = expandV4(head)
  const t = expandV4(tail)
  if (!h || !t) return null
  const missing = 8 - h.length - t.length
  if (doubleColon.length === 2 ? missing < 1 : missing !== 0) return null
  const groups = [...h, ...Array(Math.max(missing, 0)).fill('0'), ...t]
  let value = BigInt(0)
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    value = (value << BigInt(16)) + BigInt(parseInt(g, 16))
  }
  return value
}

interface ParsedIp {
  version: 4 | 6
  value: bigint
}

export function parseIp(raw: string): ParsedIp | null {
  const ip = raw.trim()
  const v4 = parseIpv4(ip)
  if (v4 !== null) return { version: 4, value: v4 }
  const v6 = parseIpv6(ip)
  if (v6 !== null) return { version: 6, value: v6 }
  return null
}

function inCidr(ip: ParsedIp, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/')
  const parsed = parseIp(base)
  if (!parsed || parsed.version !== ip.version) return false
  const width = ip.version === 4 ? 32 : 128
  const bits = Number(bitsRaw)
  const shift = BigInt(width - bits)
  return ip.value >> shift === parsed.value >> shift
}

export function isCloudflareAddress(raw: string): boolean {
  const ip = parseIp(raw)
  if (!ip) return false
  return CLOUDFLARE_RANGES.some((cidr) => inCidr(ip, cidr))
}

/** The address the platform front end observed: the LAST non-empty XFF entry. */
export function observedPeer(headers: HeaderBag): string | null {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const entries = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    const peer = entries[entries.length - 1]
    if (peer) return peer
  }
  return null
}

/**
 * The caller's address for throttle keys and forwarding.
 *
 * NULL when no proxy header is present (a local fetch); callers then share one
 * bucket, which is degraded and honest rather than forgeable.
 */
export function clientIpFrom(headers: HeaderBag): string | null {
  const peer = observedPeer(headers)
  if (peer && isCloudflareAddress(peer)) {
    const cf = headers.get('cf-connecting-ip')?.trim()
    if (cf && parseIp(cf)) return cf
  }
  return peer
}
