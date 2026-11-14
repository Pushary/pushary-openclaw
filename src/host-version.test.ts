import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handsBackToTheHost, hostSupportFrom } from './host-version.js'

describe('the host version floor', () => {
  it('hands back to OpenClaw only on 2026.11.3 or later', () => {
    for (const version of ['2026.11.3', '2026.11.4', '2026.12.0', '2027.1.1']) assert.equal(handsBackToTheHost(hostSupportFrom({ version })), true, version)
    for (const version of ['2026.3.2', '2026.11.2', '2026.10.10', '2026.11.3-beta.2']) assert.equal(handsBackToTheHost(hostSupportFrom({ version })), false, version)
  })

  it('treats a host that does not report a readable version as unsupported', () => {
    for (const runtime of [undefined, null, {}, { version: 3 }, { version: 'dev' }]) {
      assert.deepEqual(hostSupportFrom(runtime), { kind: 'unknown' })
    }
  })

  it('accepts a prerelease after the floor', () => {
    assert.deepEqual(hostSupportFrom({ version: '2026.11.5-beta.1' }), { kind: 'supported', version: '2026.11.5-beta.1' })
  })
})
