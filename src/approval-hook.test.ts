import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createApprovalGateHandler, type GateEnvironment } from './approval-hook.js'
import type { ConnectionReading } from './connection.js'
import type { HandBackSurface } from './gate-result.js'
import type { OpenClawBeforeToolCallEvent, OpenClawBeforeToolCallResult, OpenClawToolContext } from './host-api.js'
import { systemClock } from './index.js'
import { createPusharyQuestions } from './pushary-client.js'
import {
  answeredWith,
  NOT_PENDING,
  PENDING_QUESTION,
  reply,
  scriptByTool,
  startPusharyStub,
  STILL_PENDING,
  WITHDRAWN,
  type PusharyStub,
  type StubScript,
} from './pushary-stub.test.support.js'
import { UNANSWERED_POLL_PAUSE_MS, WITHDRAW_ATTEMPTS, type GateClock } from './gate.js'
import type { FileWriteCall } from './protected-writes.js'
import { POLL_TIMEOUT_MAX_MS } from './pushary-client.js'
import { DEFAULT_GATED_TOOLS } from './settings.js'

const API_KEY = 'pk_0123abcd.4567ef89'
const SHORT_HOLD_MS = 1_500
const WITHDRAW_RESERVE_FOR_TESTS_MS = 10_000
const EXEC_CALL: OpenClawBeforeToolCallEvent = {
  toolName: 'exec',
  params: { command: 'rm -rf build && git push origin main', workdir: '/srv/app' },
  toolCallId: 'call-1',
}
const SECRET_EXEC_CALL: OpenClawBeforeToolCallEvent = {
  toolName: 'exec',
  params: { command: 'mysql -u root --password=hunter2 prod' },
  toolCallId: 'call-2',
}
const CONTEXT: OpenClawToolContext = { agentId: 'main', sessionKey: 'agent:main:telegram:direct:42' }

let stub: PusharyStub | null = null

afterEach(async () => {
  await stub?.close()
  stub = null
})

let requestCounter = 0

const environmentFor = (baseUrl: string, reading?: ConnectionReading, clock: GateClock = systemClock): GateEnvironment => ({
  readConnection: () => reading ?? { kind: 'ready', connection: { baseUrl, apiKey: API_KEY, machineId: 'machine-1' } },
  questionsFor: connection => createPusharyQuestions(connection),
  clock,
  newRequestId: () => `request-${++requestCounter}`,
})

const gateWith = async (
  script: StubScript,
  options: {
    readonly holdMs?: number
    readonly event?: OpenClawBeforeToolCallEvent
    readonly context?: OpenClawToolContext
    readonly handBackSurface?: HandBackSurface
    readonly reachesOpenClawState?: (call: FileWriteCall) => boolean
    readonly clock?: GateClock
  } = {},
): Promise<OpenClawBeforeToolCallResult | undefined> => {
  stub = await startPusharyStub(script)
  const handler = createApprovalGateHandler({
    settings: { gatedTools: DEFAULT_GATED_TOOLS },
    holdMs: options.holdMs ?? SHORT_HOLD_MS,
    withdrawReserveMs: WITHDRAW_RESERVE_FOR_TESTS_MS,
    handBackSurface: options.handBackSurface ?? 'openclaw_prompt',
    reachesOpenClawState: options.reachesOpenClawState ?? (() => false),
  }, environmentFor(stub.baseUrl, undefined, options.clock))
  return handler(options.event ?? EXEC_CALL, options.context ?? CONTEXT)
}

const assertBlocked = (result: OpenClawBeforeToolCallResult | undefined, reason: RegExp): void => {
  assert.equal(result?.block, true, 'the tool call must be blocked')
  assert.match(result?.blockReason ?? '', reason)
}

const cancelCount = (): number => stub?.toolCalls('cancel_question').length ?? 0

describe('an approved call', () => {
  it('runs only after an explicit yes', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => reply(answeredWith('yes')),
    }))
    assert.equal(result, undefined)
  })

  it('sends the question with the agent key, a fresh request id and OpenClaw as the agent', async () => {
    await gateWith(scriptByTool({ ask_user: () => reply(answeredWith('yes')), wait_for_answer: () => reply(STILL_PENDING) }))
    const [ask] = stub?.toolCalls('ask_user') ?? []
    assert.equal(ask?.authorization, `Bearer ${API_KEY}`)
    assert.equal(ask?.arguments.agentName, 'OpenClaw')
    assert.equal(ask?.arguments.toolUseId, undefined)
    assert.match(String(ask?.arguments.requestId), /^request-\d+$/)
    assert.equal(ask?.arguments.toolName, 'exec')
    assert.equal(ask?.arguments.wait, false)
    assert.equal(ask?.arguments.type, 'confirm')
    assert.equal(ask?.arguments.localSurfaceAvailable, false)
    assert.equal(ask?.arguments.sessionId, 'agent:main:telegram:direct:42')
    assert.equal(ask?.arguments.machineId, 'machine-1')
    assert.match(String(ask?.arguments.question), /^Allow OpenClaw to run `rm -rf build && git push origin main`\?$/)
    assert.equal(typeof ask?.arguments.waitEndsAt, 'string')
  })

  it('reads an answer delivered as an event stream', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => ({ kind: 'event_stream', value: PENDING_QUESTION }),
      wait_for_answer: () => ({ kind: 'event_stream', value: answeredWith('yes') }),
    }))
    assert.equal(result, undefined)
  })
})

describe('every other outcome blocks the call', () => {
  it('blocks a no', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply(answeredWith('no')) }))
    assertBlocked(result, /did not approve this exec call/)
  })

  it('blocks a free-text answer that is not a yes', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply(answeredWith('maybe later')) }))
    assertBlocked(result, /did not approve/)
  })

  it('blocks when nobody answers before the hold ends, and withdraws the question', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => reply(STILL_PENDING),
      cancel_question: () => reply(WITHDRAWN),
    }))
    assertBlocked(result, /Nobody answered the Pushary approval within/)
    assert.equal(cancelCount(), 1)
  })

  it('honours a yes that won the race with the withdrawal', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: (_call, calls) => reply(calls.some(call => call.tool === 'cancel_question') ? answeredWith('yes') : STILL_PENDING),
      cancel_question: () => reply(NOT_PENDING),
    }))
    assert.equal(result, undefined)
  })

  it('blocks when the question expired on the server', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply({ answered: false, status: 'expired' }) }))
    assertBlocked(result, /Nobody answered/)
  })

  it('blocks when the agent was stopped from Pushary', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply({ correlationId: 'q-1', status: 'stopped', answered: false, handoffAction: 'stop' }) }))
    assertBlocked(result, /Pushary stopped this request/)
    assert.equal(stub?.toolCalls('wait_for_answer').length, 0)
  })

  it('blocks when the question is cancelled from another surface', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply({ answered: false, status: 'cancelled' }) }))
    assertBlocked(result, /Pushary stopped this request/)
  })

  it('blocks a server error on create after retrying it', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => ({ kind: 'raw', status: 500, body: '{"error":"boom"}' }) }))
    assertBlocked(result, /could not be reached/)
    assert.equal(stub?.toolCalls('ask_user').length, 3, 'a create is retried, and each retry reuses one request id')
    assert.equal(new Set(stub?.toolCalls('ask_user').map(call => call.arguments.requestId)).size, 1)
  })

  it('blocks a rejected key without retrying', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => ({ kind: 'raw', status: 401, body: '{}' }) }))
    assertBlocked(result, /rejected the API key/)
    assert.equal(stub?.toolCalls('ask_user').length, 1)
  })

  it('blocks a tool error reply', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => ({ kind: 'tool_error', message: 'question_limit' }) }))
    assertBlocked(result, /Pushary refused the approval request/)
  })

  for (const [name, value] of [
    ['an empty object', {}],
    ['an answered flag without a value', { correlationId: 'q-1', answered: true }],
    ['a non-string answer', { correlationId: 'q-1', answered: true, value: true }],
    ['an unknown status', { correlationId: 'q-1', status: 'approved' }],
    ['an array', ['yes']],
    ['a bare string', 'yes'],
  ] as const) {
    it(`blocks a malformed create reply: ${name}`, async () => {
      const result = await gateWith(scriptByTool({ ask_user: () => reply(value), cancel_question: () => reply(WITHDRAWN) }))
      assertBlocked(result, /could not be reached/)
    })
  }

  it('blocks when the body is not JSON at all', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => ({ kind: 'raw', status: 200, body: '<html>proxy</html>' }) }))
    assertBlocked(result, /could not be reached/)
  })

  it('withdraws at once and blocks on a wait reply it cannot read', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => reply({ answered: true, value: 1 }),
      cancel_question: () => reply(WITHDRAWN),
    }), { holdMs: 30_000 })
    assertBlocked(result, /could not be reached/)
    assert.equal(cancelCount(), 1)
    assert.equal(stub?.toolCalls('wait_for_answer').length, 1)
  })

  it('keeps waiting through a server error and runs the call after a later yes', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: (_call, calls) => (calls.filter(call => call.tool === 'wait_for_answer').length === 1
        ? { kind: 'raw', status: 503, body: '{}' }
        : reply(answeredWith('yes'))),
    }), { holdMs: 10_000 })
    assert.equal(result, undefined)
    assert.equal(cancelCount(), 0)
  })

  it('withdraws at once and blocks when Pushary refuses the wait', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => ({ kind: 'raw', status: 400, body: '{}' }),
      cancel_question: () => reply(WITHDRAWN),
    }), { holdMs: 30_000 })
    assertBlocked(result, /Pushary refused the approval request/)
    assert.equal(cancelCount(), 1)
  })

  it('blocks when the wait request times out', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: call => (call.arguments.timeoutMs === 1_000 ? reply(STILL_PENDING) : { kind: 'hang' }),
      cancel_question: () => reply(WITHDRAWN),
    }), { holdMs: 1_200 })
    assertBlocked(result, /could not be reached/)
  })

  it('blocks and withdraws the question when OpenClaw cancels the tool call', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => ({ kind: 'hang' }),
      cancel_question: () => reply(WITHDRAWN),
    }), { holdMs: 30_000, context: { ...CONTEXT, abortSignal: controller.signal } })
    assertBlocked(result, /was cancelled before anyone answered/)
    assert.equal(cancelCount(), 1)
  })

  it('blocks a call that was already cancelled without asking anyone', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION) }), { context: { ...CONTEXT, abortSignal: controller.signal } })
    assertBlocked(result, /was cancelled/)
    assert.equal(stub?.calls().length, 0)
  })

  it('blocks when no phone, browser or Slack is connected', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply({ ...PENDING_QUESTION, noDevices: true, handoffAction: 'cancel_then_ask_in_current_client' }),
      cancel_question: () => reply(WITHDRAWN),
    }))
    assertBlocked(result, /No phone, browser or Slack is connected/)
    assert.equal(cancelCount(), 1)
  })

  it('blocks when the API key is missing, without calling Pushary', async () => {
    stub = await startPusharyStub(() => reply(PENDING_QUESTION))
    const handler = createApprovalGateHandler({ settings: { gatedTools: DEFAULT_GATED_TOOLS }, holdMs: SHORT_HOLD_MS, withdrawReserveMs: WITHDRAW_RESERVE_FOR_TESTS_MS, handBackSurface: 'openclaw_prompt', reachesOpenClawState: () => false }, environmentFor(stub.baseUrl, { kind: 'missing_api_key' }))
    assertBlocked(await handler(EXEC_CALL, CONTEXT), /PUSHARY_API_KEY is missing/)
    assert.equal(stub.calls().length, 0)
  })

  it('says how to add a key whichever way the plugin was installed', async () => {
    stub = await startPusharyStub(() => reply(PENDING_QUESTION))
    const handler = createApprovalGateHandler({ settings: { gatedTools: DEFAULT_GATED_TOOLS }, holdMs: SHORT_HOLD_MS, withdrawReserveMs: WITHDRAW_RESERVE_FOR_TESTS_MS, handBackSurface: 'openclaw_prompt', reachesOpenClawState: () => false }, environmentFor(stub.baseUrl, { kind: 'missing_api_key' }))
    assertBlocked(await handler(EXEC_CALL, CONTEXT), /Run npx pushary@latest setup --agents openclaw, or create an API key at https:\/\/pushary\.com\/dashboard\/agent\/settings and add PUSHARY_API_KEY=<key> to ~\/\.openclaw\/\.env, then restart the OpenClaw gateway\./)
  })

  it('blocks a call too long to show in full without calling Pushary', async () => {
    const result = await gateWith(() => reply(PENDING_QUESTION), { event: { toolName: 'exec', params: { command: 'echo a; '.repeat(501) } } })
    assertBlocked(result, /^This exec call is too long to show in full: 4,008 characters/)
    assert.equal(stub?.calls().length, 0)
  })
})

describe('a decision Pushary hands back to OpenClaw', () => {
  it('asks in OpenClaw itself when the delivery mode keeps the phone out, without the secret', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply({ correlationId: 'q-1', status: 'terminal', answered: false, mode: 'terminal_only', handoffAction: 'cancel_then_ask_in_current_client' }),
      cancel_question: () => reply(WITHDRAWN),
    }), { event: SECRET_EXEC_CALL })
    assert.equal(result?.block, undefined)
    assert.deepEqual(result?.requireApproval?.allowedDecisions, ['allow-once', 'deny'])
    assert.doesNotMatch(`${result?.requireApproval?.title} ${result?.requireApproval?.description}`, /hunter2/)
    assert.ok((result?.requireApproval?.title.length ?? 0) <= 80)
    assert.equal(cancelCount(), 1)
  })

  it('says so when OpenClaw\'s own prompt cannot hold the whole call', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply({ correlationId: 'q-1', status: 'terminal', answered: false, mode: 'terminal_only', handoffAction: 'cancel_then_ask_in_current_client' }),
      cancel_question: () => reply(WITHDRAWN),
    }), { event: { toolName: 'exec', params: { command: 'echo a; '.repeat(100) } } })
    const description = result?.requireApproval?.description ?? ''
    assert.ok(description.length <= 512, description)
    assert.match(description, /\(shortened from \d[\d,]* characters: read the whole call in OpenClaw before you allow it\)$/)
  })

  it('asks in OpenClaw once a push_first window passes without an answer', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply({ ...PENDING_QUESTION, deliveryMode: 'push_first', policyTimeoutMs: 400 }),
      wait_for_answer: () => reply(STILL_PENDING),
      cancel_question: () => reply(WITHDRAWN),
    }), { holdMs: 10_000 })
    assert.ok(result?.requireApproval, 'the decision is handed to OpenClaw approvals')
  })

  it('blocks instead when the withdrawal could not be confirmed, after a bounded number of retries', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply({ correlationId: 'q-1', status: 'terminal', handoffAction: 'cancel_then_ask_in_current_client' }),
      cancel_question: () => ({ kind: 'raw', status: 502, body: '' }),
    }))
    assertBlocked(result, /could not be reached/)
    assert.equal(cancelCount(), WITHDRAW_ATTEMPTS)
  })
})

describe('a stop that arrives during the withdrawal', () => {
  it('blocks instead of handing the call back to OpenClaw', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply({ correlationId: 'q-1', status: 'terminal', handoffAction: 'cancel_then_ask_in_current_client' }),
      cancel_question: () => reply(NOT_PENDING),
      wait_for_answer: () => reply({ answered: true, value: 'yes', handoffAction: 'stop' }),
    }))
    assertBlocked(result, /Pushary stopped this request/)
  })
})

describe('a request id is never shared between two tool calls', () => {
  it('mints a new one even when OpenClaw repeats a tool call id', async () => {
    stub = await startPusharyStub(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply(answeredWith('no')) }))
    const handler = createApprovalGateHandler({ settings: { gatedTools: DEFAULT_GATED_TOOLS }, holdMs: SHORT_HOLD_MS, withdrawReserveMs: WITHDRAW_RESERVE_FOR_TESTS_MS, handBackSurface: 'openclaw_prompt', reachesOpenClawState: () => false }, environmentFor(stub.baseUrl))
    await handler(EXEC_CALL, CONTEXT)
    await handler(EXEC_CALL, CONTEXT)
    const ids = stub.toolCalls('ask_user').map(call => call.arguments.requestId)
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
  })
})

describe('the process tool', () => {
  it('asks before send-keys types into a session', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply(answeredWith('no')) }), {
      event: { toolName: 'process', params: { action: 'send-keys', sessionId: 'abc', literal: 'rm -rf ~\n' } },
    })
    assertBlocked(result, /did not approve this process call/)
    assert.match(String(stub?.toolCalls('ask_user')[0]?.arguments.actionBody), /send-keys/)
  })

  it('lets a poll through without asking', async () => {
    const result = await gateWith(() => reply(PENDING_QUESTION), { event: { toolName: 'process', params: { action: 'poll', sessionId: 'abc' } } })
    assert.equal(result, undefined)
    assert.equal(stub?.calls().length, 0)
  })
})

describe('the gate cannot be switched off by the agent it gates', () => {
  it('asks before the plugins tool disables Pushary, and blocks on a no', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply(answeredWith('no')) }), {
      event: { toolName: 'plugins', params: { action: 'disable', pluginId: 'pushary' } },
    })
    assertBlocked(result, /did not approve this plugins call/)
    assert.equal(stub?.toolCalls('ask_user')[0]?.arguments.toolName, 'plugins')
  })

  it('asks before the openclaw tool rewrites the Pushary entry', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply(answeredWith('no')) }), {
      event: { toolName: 'openclaw', params: { action: 'config_set', path: 'plugins.entries.pushary.enabled', value: 'false', approved: true } },
    })
    assertBlocked(result, /did not approve this openclaw call/)
  })
})

describe('a file tool that writes into OpenClaw itself', () => {
  it('asks before an edit of openclaw.json, and blocks on a no', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply(answeredWith('no')) }), {
      event: { toolName: 'edit', params: { path: '~/.openclaw/openclaw.json', edits: [{ oldText: '"enabled": true', newText: '"enabled": false' }] } },
      reachesOpenClawState: call => call.toolId === 'edit' && String(call.event.params.path).includes('.openclaw'),
    })
    assertBlocked(result, /did not approve this edit call/)
    assert.equal(stub?.toolCalls('ask_user')[0]?.arguments.toolName, 'edit')
  })

  it('lets a workspace write through without calling Pushary', async () => {
    const result = await gateWith(() => reply(PENDING_QUESTION), {
      event: { toolName: 'write', params: { path: 'src/app.ts', content: 'x' } },
      reachesOpenClawState: () => false,
    })
    assert.equal(result, undefined)
    assert.equal(stub?.calls().length, 0)
  })
})

describe('a session spawned into another folder', () => {
  it('asks with the folder in the question, and blocks on a no', async () => {
    const result = await gateWith(scriptByTool({ ask_user: () => reply(PENDING_QUESTION), wait_for_answer: () => reply(answeredWith('no')) }), {
      event: { toolName: 'sessions_spawn', params: { task: 'tidy up', cwd: '~/.openclaw' } },
      reachesOpenClawState: call => call.toolId === 'sessions_spawn',
    })
    assertBlocked(result, /did not approve this sessions_spawn call/)
    assert.match(String(stub?.toolCalls('ask_user')[0]?.arguments.question), /~\/\.openclaw/)
  })
})

describe('an OpenClaw that cannot ask in its own prompt', () => {
  it('blocks a decision Pushary hands back instead of asking OpenClaw', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply({ correlationId: 'q-1', status: 'terminal', answered: false, mode: 'terminal_only', handoffAction: 'cancel_then_ask_in_current_client' }),
      cancel_question: () => reply(WITHDRAWN),
    }), { handBackSurface: 'none' })
    assertBlocked(result, /older than 2026\.11\.3/)
    assert.equal(result?.requireApproval, undefined)
  })
})

describe('questions are never left open on the phone', () => {
  it('withdraws the question an ask created while OpenClaw cancelled the call', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await gateWith(scriptByTool({
      ask_user: () => ({ kind: 'delayed', ms: 400, answer: reply(PENDING_QUESTION) }),
      cancel_question: () => reply(WITHDRAWN),
    }), { holdMs: 30_000, context: { ...CONTEXT, abortSignal: controller.signal } })
    assertBlocked(result, /was cancelled before anyone answered/)
    assert.deepEqual(stub?.toolCalls('cancel_question').map(call => call.arguments.correlationId), ['q-1'])
  })

  it('retries a withdrawal that did not get through', async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => reply(STILL_PENDING),
      cancel_question: (_call, calls) => (calls.filter(call => call.tool === 'cancel_question').length === 1 ? { kind: 'raw', status: 502, body: '' } : reply(WITHDRAWN)),
    }))
    assertBlocked(result, /Nobody answered/)
    assert.equal(cancelCount(), 2)
  })
})

describe('a withdrawal stays inside the reserve the hook keeps for it', () => {
  it('gives up a failing withdrawal quickly after OpenClaw cancels the call', { timeout: 15_000 }, async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => ({ kind: 'hang' }),
      cancel_question: () => ({ kind: 'raw', status: 500, body: '' }),
    }), { holdMs: 60_000, context: { ...CONTEXT, abortSignal: controller.signal } })
    assertBlocked(result, /was cancelled before anyone answered/)
    assert.equal(cancelCount(), WITHDRAW_ATTEMPTS)
  })

  it('withdraws once and blocks at once when the key is rejected mid-wait', { timeout: 15_000 }, async () => {
    const result = await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => ({ kind: 'raw', status: 401, body: '{}' }),
      cancel_question: () => ({ kind: 'raw', status: 401, body: '{}' }),
    }), { holdMs: 30_000 })
    assertBlocked(result, /rejected/)
    assert.equal(cancelCount(), 1)
    assert.equal(stub?.toolCalls('wait_for_answer').length, 1)
  })
})

const clockThatMovesOnlyWhenTheGateSleeps = (): { readonly clock: GateClock; readonly pauses: number[] } => {
  let now = 0
  const pauses: number[] = []
  return {
    pauses,
    clock: {
      monotonicMs: () => now,
      wallMs: () => Date.UTC(2026, 10, 15) + now,
      sleep: async ms => {
        pauses.push(ms)
        now += ms
      },
    },
  }
}

describe('polling paces itself like the CLI hook', () => {
  it('pauses two seconds after every poll that comes back unanswered', async () => {
    const { clock, pauses } = clockThatMovesOnlyWhenTheGateSleeps()
    await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => reply(STILL_PENDING),
      cancel_question: () => reply(WITHDRAWN),
    }), { holdMs: 4_500, clock })
    assert.equal(stub?.toolCalls('wait_for_answer').length, 3)
    assert.deepEqual(pauses, [UNANSWERED_POLL_PAUSE_MS, UNANSWERED_POLL_PAUSE_MS, 500])
  })

  it('asks the server to hold one poll for at most 30 seconds', async () => {
    await gateWith(scriptByTool({
      ask_user: () => reply(PENDING_QUESTION),
      wait_for_answer: () => reply(answeredWith('yes')),
    }), { holdMs: 120_000 })
    assert.equal(POLL_TIMEOUT_MAX_MS, 30_000)
    assert.equal(stub?.toolCalls('wait_for_answer')[0]?.arguments.timeoutMs, POLL_TIMEOUT_MAX_MS)
  })
})

describe('calls that are not gated', () => {
  it('leaves an ungated tool alone without calling Pushary', async () => {
    const result = await gateWith(() => reply(PENDING_QUESTION), { event: { toolName: 'read', params: { path: 'README.md' } } })
    assert.equal(result, undefined)
    assert.equal(stub?.calls().length, 0)
  })
})
