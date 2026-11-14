import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerApprovalGate, type GateEnvironment } from './approval-hook.js'
import type { OpenClawBeforeToolCallHandler, OpenClawHookOptions, OpenClawPluginApi } from './host-api.js'
import pusharyPlugin, { systemClock } from './index.js'
import { MIN_HOST_VERSION } from './host-version.js'
import type { PusharyQuestions } from './pushary-client.js'
import openClawManifest from '../openclaw.plugin.json' with { type: 'json' }
import packageManifest from '../package.json' with { type: 'json' }

interface Registration {
  readonly hookName: string
  readonly handler: OpenClawBeforeToolCallHandler
  readonly options: OpenClawHookOptions | undefined
}

const unreachableQuestions: PusharyQuestions = {
  ask: async () => ({ kind: 'failed', failure: 'network' }),
  waitForAnswer: async () => ({ kind: 'failed', failure: 'network' }),
  cancel: async () => ({ kind: 'failed', failure: 'network' }),
}

const environment: GateEnvironment = {
  readConnection: () => ({ kind: 'missing_api_key' }),
  questionsFor: () => unreachableQuestions,
  clock: systemClock,
  newRequestId: () => 'request-1',
}

interface FakeApiOptions {
  readonly pluginConfig?: unknown
  readonly config?: unknown
  readonly refuseMatcher?: boolean
  readonly hostVersion?: string
}

const fakeApi = (options: FakeApiOptions = {}) => {
  const registrations: Registration[] = []
  const warnings: string[] = []
  const errors: string[] = []
  const api: OpenClawPluginApi = {
    id: 'pushary',
    config: options.config ?? {},
    pluginConfig: options.pluginConfig,
    runtime: { version: options.hostVersion ?? '2026.11.3' },
    logger: { info: () => undefined, warn: message => warnings.push(message), error: message => errors.push(message) },
    on: (hookName, handler, hookOptions) => {
      if (options.refuseMatcher && hookOptions?.matcher) throw new TypeError('tool hook matcher entries must use canonical OpenClaw tool ids')
      registrations.push({ hookName, handler, options: hookOptions })
    },
  }
  return { api, registrations, warnings, errors }
}

describe('registering the gate', () => {
  it('registers before_tool_call for exec, process and the OpenClaw self-management tools with a five minute budget', () => {
    const { api, registrations, warnings } = fakeApi()
    registerApprovalGate(api, environment)
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0]?.hookName, 'before_tool_call')
    assert.deepEqual(registrations[0]?.options, { matcher: ['exec', 'shell', 'shell_command', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal', 'write', 'edit', 'apply_patch', 'sessions_spawn'], timeoutMs: 300_000 })
    assert.deepEqual(warnings, [])
  })

  it('registers a configured alias under the name OpenClaw accepts', () => {
    const { api, registrations } = fakeApi({ pluginConfig: { gatedTools: ['bash', 'cron'] } })
    registerApprovalGate(api, environment)
    assert.deepEqual(registrations[0]?.options?.matcher, ['exec', 'shell', 'shell_command', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal', 'write', 'edit', 'apply_patch', 'sessions_spawn'])
  })

  it('falls back to checking names itself, with the same aliases, when OpenClaw refuses the tool list', async () => {
    const { api, registrations, errors } = fakeApi({ pluginConfig: { gatedTools: ['cron'] }, refuseMatcher: true })
    registerApprovalGate(api, environment)
    assert.deepEqual(registrations[0]?.options, { timeoutMs: 300_000 })
    assert.equal(errors.length, 1)
    assert.equal(await registrations[0]?.handler({ toolName: 'read', params: {} }, {}), undefined)
    assert.equal((await registrations[0]?.handler({ toolName: 'exec', params: { command: 'ls' } }, {}))?.block, true)
    assert.equal((await registrations[0]?.handler({ toolName: 'automations', params: {} }, {}))?.block, true)
  })

  it('reports an invalid list as an error and still gates the defaults', () => {
    const { api, registrations, errors } = fakeApi({ pluginConfig: { gatedTools: '*' } })
    registerApprovalGate(api, environment)
    assert.deepEqual(registrations[0]?.options?.matcher, ['exec', 'shell', 'shell_command', 'process', 'plugins', 'gateway', 'openclaw', 'automations', 'terminal', 'write', 'edit', 'apply_patch', 'sessions_spawn'])
    assert.match(errors[0] ?? '', /was ignored/)
  })

  it('names the entries that gate nothing', () => {
    const { api, errors } = fakeApi({ pluginConfig: { gatedTools: ['message', '*'] } })
    registerApprovalGate(api, environment)
    assert.match(errors[0] ?? '', /gate nothing: \*/)
  })

  it('warns on an OpenClaw older than the floor', () => {
    const { api, warnings } = fakeApi({ hostVersion: '2026.3.2' })
    registerApprovalGate(api, environment)
    assert.match(warnings[0] ?? '', /2026\.3\.2/)
  })

  it('blocks instead of throwing when something unexpected fails', async () => {
    const { api, registrations } = fakeApi()
    registerApprovalGate(api, { ...environment, readConnection: () => { throw new Error('disk gone') } })
    const result = await registrations[0]?.handler({ toolName: 'exec', params: { command: 'ls' } }, {})
    assert.equal(result?.block, true)
  })

  it('ships one plugin id and version floor across the entry, the manifest and the package', () => {
    assert.equal(pusharyPlugin.id, openClawManifest.id)
    assert.deepEqual(packageManifest.openclaw.extensions, ['./dist/index.js'])
    assert.equal(packageManifest.openclaw.install.minHostVersion, `>=${MIN_HOST_VERSION}`)
    assert.equal(packageManifest.openclaw.compat.pluginApi, `>=${MIN_HOST_VERSION}`)
    assert.equal(typeof pusharyPlugin.register, 'function')
  })
})
