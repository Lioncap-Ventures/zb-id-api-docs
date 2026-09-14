// Proves the fix in commit 2da4424: the Try-it proxy's rate limiter must key on
// the LAST X-Forwarded-For entry (the peer Cloud Run's front end appended), not
// the first (caller-supplied) entry. A caller who rotates the leading entry on
// every request must land in the SAME throttle bucket, not a fresh one.
//
// Run: node --experimental-strip-types --test src/lib/client-ip.test.ts
// (Node >= 22.6; the flag is a no-op on versions where stripping is default-on.)

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clientIpFrom, isCloudflareAddress, observedPeer } from './client-ip.ts'

function headers(values: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null }
}

test('a spoofed leading X-Forwarded-For entry does not mint a fresh bucket', () => {
  const realPeer = '203.0.113.9' // the address Cloud Run's front end actually observed
  const first = clientIpFrom(headers({ 'x-forwarded-for': `1.2.3.4, ${realPeer}` }))
  const second = clientIpFrom(headers({ 'x-forwarded-for': `9.9.9.9, ${realPeer}` }))
  const third = clientIpFrom(headers({ 'x-forwarded-for': `${realPeer}, ${realPeer}` }))

  assert.equal(first, realPeer)
  assert.equal(second, realPeer)
  assert.equal(third, realPeer)
  // The whole point: three different "first hops" must produce the SAME key.
  assert.equal(first, second)
  assert.equal(second, third)
})

test('the old first-entry behaviour would have been forgeable (regression guard)', () => {
  // Documents exactly what broke: reading entries[0] gives every spoofed
  // request its own key, which is the bug this fix closes.
  const brokenFirstEntry = (xff: string) => xff.split(',')[0]!.trim()
  const a = brokenFirstEntry('1.2.3.4, 203.0.113.9')
  const b = brokenFirstEntry('9.9.9.9, 203.0.113.9')
  assert.notEqual(a, b, 'sanity check: the old approach really was forgeable')
})

test('observedPeer takes the last non-empty entry, ignoring stray whitespace/commas', () => {
  assert.equal(observedPeer(headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2 ,  3.3.3.3  ' })), '3.3.3.3')
  assert.equal(observedPeer(headers({ 'x-forwarded-for': '1.1.1.1,' })), '1.1.1.1')
  assert.equal(observedPeer(headers({})), null)
})

test('CF-Connecting-IP is honoured only when the observed peer is a real Cloudflare edge', () => {
  const cfEdge = '104.16.1.1' // inside 104.16.0.0/13
  const notCfEdge = '8.8.8.8'

  const throughCloudflare = clientIpFrom(
    headers({ 'x-forwarded-for': `evil, ${cfEdge}`, 'cf-connecting-ip': '198.51.100.7' }),
  )
  assert.equal(throughCloudflare, '198.51.100.7')

  // A caller who just sets cf-connecting-ip themselves, without coming through
  // Cloudflare, must be ignored: the observed peer is not a Cloudflare address.
  const spoofedHeaderOnly = clientIpFrom(
    headers({ 'x-forwarded-for': `evil, ${notCfEdge}`, 'cf-connecting-ip': '198.51.100.7' }),
  )
  assert.equal(spoofedHeaderOnly, notCfEdge)

  assert.equal(isCloudflareAddress(cfEdge), true)
  assert.equal(isCloudflareAddress(notCfEdge), false)
})

test('no X-Forwarded-For at all yields null (degraded shared bucket, never a crash)', () => {
  assert.equal(clientIpFrom(headers({})), null)
})
