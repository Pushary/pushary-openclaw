import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { OpenClawPluginApi } from './host-api.js'
import { openClawStateLocationsFor, stateDirectoryHoldingPlugin } from './openclaw-write-guard.js'

const HOME = '/home/claw'

const apiWith = (runtime: unknown): OpenClawPluginApi => ({
  id: 'pushary',
  config: {},
  runtime,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on: () => {},
})

describe('the OpenClaw state a file write must not change', () => {
  it('finds the state directory that loads this plugin from its own install path', () => {
    assert.equal(stateDirectoryHoldingPlugin('/srv/claw/.openclaw/extensions/pushary/dist/openclaw-write-guard.js'), '/srv/claw/.openclaw')
    assert.equal(stateDirectoryHoldingPlugin('/repo/packages/openclaw-plugin/src/openclaw-write-guard.ts'), null)
  })

  it('protects the run state, the default state and the state that installed the plugin, together', () => {
    const runState = '/tmp/openclaw-run-1'
    const locations = openClawStateLocationsFor(apiWith({ state: { resolveStateDir: () => runState } }), { OPENCLAW_STATE_DIR: runState }, HOME, '/srv/claw/.openclaw/extensions/pushary/dist/index.js', '/srv/gateway')
    assert.deepEqual([...locations.stateDirectories].sort(), [runState, '/home/claw/.openclaw', '/srv/claw/.openclaw'].sort())
    assert.deepEqual([...locations.configFiles].sort(), [join(runState, 'openclaw.json'), '/home/claw/.openclaw/openclaw.json', '/srv/gateway/.env'].sort())
    assert.deepEqual(locations.protectedTrees, ['/home/claw/.pushary', '/home/claw/.config/openclaw'])
    assert.ok(locations.serviceFiles.some(service => service.directory === '/home/claw/Library/LaunchAgents' && service.namePrefix === 'ai.openclaw'))
    assert.ok(locations.serviceFiles.some(service => service.directory === '/home/claw/.config/systemd/user' && service.namePrefix === 'openclaw'))
  })

  it('still protects its own rules when the host offers no resolver', () => {
    const locations = openClawStateLocationsFor(apiWith(undefined), {}, HOME, '/elsewhere/index.js', '/srv/gateway')
    assert.deepEqual(locations.stateDirectories, ['/home/claw/.openclaw'])
  })

  it('protects a gateway service whose name the operator overrode', () => {
    const locations = openClawStateLocationsFor(apiWith(undefined), { OPENCLAW_SYSTEMD_UNIT: 'claw-gw' }, HOME, '/elsewhere/index.js', '/srv/gateway')
    assert.ok(locations.serviceFiles.some(service => service.directory === '/home/claw/.config/systemd/user' && service.namePrefix === 'claw-gw'))
  })
})
