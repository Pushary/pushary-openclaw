import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readPusharyConnection, type ConnectionSources } from './connection.js'

const KEY = 'pk_0123abcd.4567ef89'

const sources = (overrides: Partial<ConnectionSources> & { readonly files?: Readonly<Record<string, string>> } = {}): ConnectionSources => ({
  environment: overrides.environment ?? {},
  homeDirectory: '/home/claw',
  readText: path => overrides.files?.[path] ?? null,
  hostName: overrides.hostName ?? (() => 'vps-1'),
})

describe('the Pushary connection', () => {
  it('prefers PUSHARY_API_KEY from the environment', () => {
    const reading = readPusharyConnection(sources({ environment: { PUSHARY_API_KEY: ` ${KEY} ` }, files: { '/home/claw/.pushary/config.json': JSON.stringify({ apiKey: 'pk_ffff.ffff' }) } }))
    assert.equal(reading.kind === 'ready' && reading.connection.apiKey, KEY)
  })

  it('falls back to the key pushary setup saved', () => {
    const reading = readPusharyConnection(sources({ files: { '/home/claw/.pushary/config.json': JSON.stringify({ apiKey: KEY }) } }))
    assert.deepEqual(reading, { kind: 'ready', connection: { baseUrl: 'https://pushary.com', apiKey: KEY, machineId: reading.kind === 'ready' ? reading.connection.machineId : null } })
  })

  it('reports a missing key for an absent, malformed or wrong-shaped config', () => {
    for (const config of [undefined, '{not json', JSON.stringify({ apiKey: 42 }), JSON.stringify({ apiKey: 'Bearer something' }), JSON.stringify(['pk_1.2'])]) {
      const files = config === undefined ? {} : { '/home/claw/.pushary/config.json': config }
      assert.deepEqual(readPusharyConnection(sources({ files })), { kind: 'missing_api_key' }, String(config))
    }
  })

  it('accepts only the key shape Pushary issues, the same rule the server and CLI use', () => {
    for (const key of ['pk_ABCDEF.0123', 'pk_xyz.abc', 'pk_0123.ghij', 'pk_.abcd']) {
      assert.deepEqual(readPusharyConnection(sources({ environment: { PUSHARY_API_KEY: key } })), { kind: 'missing_api_key' }, key)
    }
  })

  it('honours PUSHARY_CONFIG_FILE', () => {
    const reading = readPusharyConnection(sources({ environment: { PUSHARY_CONFIG_FILE: '/etc/pushary.json' }, files: { '/etc/pushary.json': JSON.stringify({ apiKey: KEY }) } }))
    assert.equal(reading.kind, 'ready')
  })

  it('refuses any base URL that is not a Pushary https origin, so a config write cannot point the gate at a server that always says yes', () => {
    for (const url of ['file:///etc/passwd', 'not a url', 'http://127.0.0.1:8787', 'http://pushary.com', 'https://evil.example', 'https://pushary.com.evil.example', 'https://evilpushary.com', 'https://pushary.com:8443', 'https://user@evil.example/pushary.com', 'https://pushary.com@evil.example', 'https://acme.pushary.com', 'https://staging.pushary.com']) {
      assert.deepEqual(readPusharyConnection(sources({ environment: { PUSHARY_API_KEY: KEY, PUSHARY_BASE_URL: url } })), { kind: 'invalid_base_url' }, url)
    }
  })

  it('accepts only the hosts the CLI talks to, over https, and keeps only the origin', () => {
    for (const [url, origin] of [['https://pushary.com', 'https://pushary.com'], ['https://www.pushary.com/api/mcp', 'https://www.pushary.com'], ['HTTPS://PUSHARY.COM/', 'https://pushary.com']] as const) {
      const reading = readPusharyConnection(sources({ environment: { PUSHARY_API_KEY: KEY, PUSHARY_BASE_URL: url } }))
      assert.equal(reading.kind === 'ready' && reading.connection.baseUrl, origin, url)
    }
  })

  it('uses the shared machine id when it is well formed, and a hostname hash otherwise', () => {
    const shared = readPusharyConnection(sources({ environment: { PUSHARY_API_KEY: KEY }, files: { '/home/claw/.pushary/machine-id': 'abc-123\n' } }))
    assert.equal(shared.kind === 'ready' && shared.connection.machineId, 'abc-123')
    const hashed = readPusharyConnection(sources({ environment: { PUSHARY_API_KEY: KEY }, files: { '/home/claw/.pushary/machine-id': '../../x' } }))
    assert.match(hashed.kind === 'ready' ? String(hashed.connection.machineId) : '', /^[0-9a-f]{8}$/)
    const unknown = readPusharyConnection(sources({ environment: { PUSHARY_API_KEY: KEY }, hostName: () => null }))
    assert.equal(unknown.kind === 'ready' && unknown.connection.machineId, null)
  })
})
