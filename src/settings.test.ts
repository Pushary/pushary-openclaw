import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OpenClawBeforeToolCallEvent } from './host-api.js'
import { askingAgentName, DEFAULT_GATED_TOOLS, hookMatcherFor, hostToolId, needsApproval, readGateSettings } from './settings.js'

const call = (toolName: string, params: Readonly<Record<string, unknown>> = {}): OpenClawBeforeToolCallEvent => ({ toolName, params })

describe('gate settings', () => {
  it('gates exec, process and the tools that can change OpenClaw itself when nothing is configured', () => {
    assert.deepEqual(readGateSettings(undefined), { kind: 'defaulted', settings: { gatedTools: DEFAULT_GATED_TOOLS } })
    assert.deepEqual(readGateSettings({}), { kind: 'defaulted', settings: { gatedTools: ['exec', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal'] } })
  })

  it('adds configured tools to the defaults instead of replacing them', () => {
    assert.deepEqual(readGateSettings({ gatedTools: ['message'] }), { kind: 'configured', settings: { gatedTools: ['exec', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal', 'message'] }, rejected: [] })
  })

  it('reads configured ids the way OpenClaw names its tools', () => {
    const reading = readGateSettings({ gatedTools: [' Bash ', 'cron', 'tool_call', 'apply-patch', 'exec_command', 'agent'] })
    assert.deepEqual(reading.settings.gatedTools, ['exec', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal', 'dispatch_action', 'apply_patch', 'spawn_agent'])
  })

  it('reports entries that are not tool ids and still gates the defaults', () => {
    const reading = readGateSettings({ gatedTools: ['message', '*', 3, ' '] })
    assert.deepEqual(reading, { kind: 'configured', settings: { gatedTools: ['exec', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal', 'message'] }, rejected: ['*', '3', ' '] })
  })

  for (const [name, value] of [
    ['a string instead of a list', { gatedTools: 'exec' }],
    ['a list instead of an object', ['exec']],
  ] as const) {
    it(`ignores ${name} and gates the defaults`, () => {
      assert.deepEqual(readGateSettings(value), { kind: 'invalid', settings: { gatedTools: ['exec', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal'] } })
    })
  }

  it('registers every spelling the host may send for exec, and never a name OpenClaw refuses', () => {
    const matcher = hookMatcherFor(readGateSettings({ gatedTools: ['bash', 'cron'] }).settings)
    assert.deepEqual(matcher, ['exec', 'shell', 'shell_command', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal', 'write', 'edit', 'apply_patch', 'sessions_spawn'])
    for (const refused of ['bash', 'exec_command', 'apply-patch', 'agent', 'cron', 'tool_call']) assert.equal(matcher.includes(refused), false, refused)
  })
})

describe('which calls need approval', () => {
  const defaults = readGateSettings(undefined).settings

  it('gates exec under every spelling the host sends', () => {
    for (const name of ['exec', 'EXEC', 'shell', 'shell_command', 'bash']) assert.equal(needsApproval(defaults, call(name, { command: 'ls' })), true, name)
  })

  it('gates the process actions that type into a session', () => {
    for (const action of ['send-keys', 'write', 'submit', 'paste', 'Send-Keys']) assert.equal(needsApproval(defaults, call('process', { action, sessionId: 's' })), true, action)
  })

  it('gates a process call whose action it cannot read', () => {
    assert.equal(needsApproval(defaults, call('process', {})), true)
    assert.equal(needsApproval(defaults, call('process', { action: 'something_new' })), true)
  })

  it('leaves the process read and housekeeping actions alone', () => {
    for (const action of ['list', 'poll', 'log', 'kill', 'clear', 'remove']) assert.equal(needsApproval(defaults, call('process', { action })), false, action)
  })

  it('gates every plugins action that installs, enables, disables, uninstalls or reloads a plugin', () => {
    for (const action of ['install', 'enable', 'disable', 'uninstall', 'reload', 'reloadAndResume', 'something_new']) {
      assert.equal(needsApproval(defaults, call('plugins', { action, pluginId: 'pushary' })), true, action)
    }
    assert.equal(needsApproval(defaults, call('plugins', { pluginId: 'pushary' })), true)
  })

  it('lets the plugins tool list, inspect and search without asking', () => {
    for (const action of ['list', 'inspect', 'search']) assert.equal(needsApproval(defaults, call('plugins', { action })), false, action)
  })

  it('gates a gateway update and lets config reads through', () => {
    assert.equal(needsApproval(defaults, call('gateway', { action: 'update.run' })), true)
    for (const action of ['config.get', 'config.schema.lookup']) assert.equal(needsApproval(defaults, call('gateway', { action })), false, action)
  })

  it('gates every openclaw system action that changes config, plugins, agents or the gateway', () => {
    for (const action of ['config_set', 'config_unset', 'config_set_ref', 'plugin_install', 'plugin_uninstall', 'plugin_activate_artifact', 'gateway_restart', 'gateway_stop', 'gateway_start', 'setup', 'set_default_model', 'create_agent', 'configure_gateway', 'connect_channel']) {
      assert.equal(needsApproval(defaults, call('openclaw', { action, path: 'plugins.entries.pushary.enabled', value: 'false' })), true, action)
    }
  })

  it('lets openclaw system reads and navigation through', () => {
    for (const action of ['status', 'models', 'agents', 'channels', 'channel_info', 'audit', 'validate_config', 'doctor', 'config_get', 'config_schema', 'gateway_status', 'plugin_list', 'plugin_search', 'open_agent', 'open_setup']) {
      assert.equal(needsApproval(defaults, call('openclaw', { action })), false, action)
    }
  })

  it('gates every automations action that adds, changes, removes, runs or wakes a job, under either name', () => {
    for (const name of ['automations', 'cron']) {
      for (const action of ['add', 'update', 'remove', 'run', 'wake', 'something_new']) assert.equal(needsApproval(defaults, call(name, { action })), true, `${name} ${action}`)
      for (const action of ['status', 'list', 'get', 'runs', 'next_check']) assert.equal(needsApproval(defaults, call(name, { action })), false, `${name} ${action}`)
    }
    assert.equal(needsApproval(defaults, call('automations', { action: 'add', job: { schedule: { kind: 'stream', command: ['sh', '-c', 'id'] } } })), true)
  })

  it('gates terminal input and every terminal action except read and list', () => {
    for (const action of ['input', 'resize', 'close', 'something_new']) assert.equal(needsApproval(defaults, call('terminal', { action, data: 'rm -rf ~\n' })), true, action)
    for (const action of ['read', 'list']) assert.equal(needsApproval(defaults, call('terminal', { action })), false, action)
  })

  it('matches a configured alias against the name the host sends', () => {
    const settings = readGateSettings({ gatedTools: ['cron'] }).settings
    assert.equal(needsApproval(settings, call('automations')), true)
    assert.equal(hostToolId('cron'), 'automations')
  })

  it('leaves tools that are not gated alone', () => {
    assert.equal(needsApproval(defaults, call('read', { path: 'README.md' })), false)
    assert.equal(needsApproval(defaults, call('message', { action: 'send' })), false)
  })

  it('keeps OpenClaw first in the agent name so the server files it as OpenClaw', () => {
    assert.equal(askingAgentName(undefined), 'OpenClaw')
    assert.equal(askingAgentName('main'), 'OpenClaw')
    assert.equal(askingAgentName('ops'), 'OpenClaw - ops')
  })
})
