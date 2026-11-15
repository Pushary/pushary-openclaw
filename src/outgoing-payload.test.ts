import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createApprovalGateHandler } from './approval-hook.js'
import type { OpenClawBeforeToolCallEvent, OpenClawBeforeToolCallResult } from './host-api.js'
import { systemClock } from './index.js'
import { createPusharyQuestions } from './pushary-client.js'
import { answeredWith, PENDING_QUESTION, reply, scriptByTool, startPusharyStub, STILL_PENDING, WITHDRAWN, type PusharyStub, type StubAnswer } from './pushary-stub.test.support.js'
import { DEFAULT_GATED_TOOLS } from './settings.js'

const API_KEY = 'pk_0123abcd.4567ef89'
const HOLD_MS = 1_200

interface SecretFixture {
  readonly name: string
  readonly event: OpenClawBeforeToolCallEvent
  readonly secrets: readonly string[]
}

const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'

const FIXTURES: readonly SecretFixture[] = [
  {
    name: 'an exec with a password flag and an exported token',
    event: { toolName: 'exec', params: { command: `mysql -u root --password=S3cretMysqlPw prod && export GITHUB_TOKEN=${GITHUB_TOKEN}`, workdir: '/srv/app' } },
    secrets: ['S3cretMysqlPw', GITHUB_TOKEN],
  },
  {
    name: 'an exec whose environment holds credentials',
    event: { toolName: 'exec', params: { command: 'npm publish', env: { NPM_TOKEN: 'npm token pelican', NODE_AUTH_TOKEN: `npm_${'B2c3D4e5F6'.repeat(3)}abcdef`, AWS_SECRET_ACCESS_KEY: 'walrus secret value' }, host: 'gateway' } },
    secrets: ['pelican', 'B2c3D4e5F6', 'walrus'],
  },
  {
    name: 'a write of the gateway env file',
    event: { toolName: 'write', params: { path: '~/.openclaw/.env', content: `OPENAI_API_KEY=${OPENAI_KEY}\nDISCORD_TOKEN=opal marmalade orbit\nPUSHARY_API_KEY=pk_live1234.abcd5678\n` } },
    secrets: [OPENAI_KEY, 'marmalade', 'orbit', 'pk_live1234.abcd5678'],
  },
  {
    name: 'an edit of openclaw.json, with the old and new values',
    event: { toolName: 'edit', params: { path: '~/.openclaw/openclaw.json', edits: [{ oldText: '"botToken": "123456:OLDoldOLDold"', newText: '"botToken": "654321:NEWnewNEWnew"' }] } },
    secrets: ['123456:OLDoldOLDold', '654321:NEWnewNEWnew'],
  },
  {
    name: 'an edit of an env file given as one old and new text',
    event: { toolName: 'edit', params: { path: '/home/me/.config/openclaw/gateway.env', oldText: 'SLACK_SIGNING_SECRET=first quokka', newText: 'SLACK_SIGNING_SECRET=second narwhal' } },
    secrets: ['quokka', 'narwhal'],
  },
  {
    name: 'a patch into gateway.env',
    event: { toolName: 'apply_patch', params: { input: '*** Begin Patch\n*** Add File: /home/me/.config/openclaw/gateway.env\n+ANTHROPIC_API_KEY=an unformatted platypus\n+DATABASE_URL=postgres://app:Pa55word@db.internal/app\n*** End Patch' } },
    secrets: ['platypus', 'Pa55word'],
  },
  {
    name: 'a gateway config patch with nested credentials',
    event: { toolName: 'gateway', params: { action: 'config.patch', raw: "{ models: { providers: { openai: { apiKey: 'sk-live-abcdefghijklmnop1234' } } }, channels: { telegram: { botToken: '987654:QWERTYuiop' } } }", auth: { password: 'hunter2 zebrafish' } } },
    secrets: ['sk-live-abcdefghijklmnop1234', '987654:QWERTYuiop', 'zebrafish'],
  },
  {
    name: 'keys typed into a running session',
    event: { toolName: 'process', params: { action: 'send-keys', sessionId: 'exec-1', keys: 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n' } },
    secrets: ['wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
  },
]

let stub: PusharyStub | null = null

afterEach(async () => {
  await stub?.close()
  stub = null
})

const gate = async (event: OpenClawBeforeToolCallEvent, waitAnswer: () => StubAnswer): Promise<{ readonly result: OpenClawBeforeToolCallResult | undefined; readonly stub: PusharyStub }> => {
  const started = await startPusharyStub(scriptByTool({
    ask_user: () => reply(PENDING_QUESTION),
    wait_for_answer: waitAnswer,
    cancel_question: () => reply(WITHDRAWN),
  }))
  stub = started
  const handler = createApprovalGateHandler({
    settings: { gatedTools: DEFAULT_GATED_TOOLS },
    holdMs: HOLD_MS,
    withdrawReserveMs: 5_000,
    handBackSurface: 'openclaw_prompt',
    reachesOpenClawState: () => true,
  }, {
    readConnection: () => ({ kind: 'ready', connection: { baseUrl: started.baseUrl, apiKey: API_KEY, machineId: 'machine-1' } }),
    questionsFor: connection => createPusharyQuestions(connection),
    clock: systemClock,
    newRequestId: () => 'request-1',
  })
  return { result: await handler(event, { agentId: 'main', sessionKey: 'agent:main:main' }), stub: started }
}

const assertNoSecretSent = (sent: PusharyStub, secrets: readonly string[]): void => {
  const calls = sent.calls()
  assert.ok(calls.length > 0, 'the gate must have asked')
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${API_KEY}`)
    for (const secret of secrets) assert.equal(call.body.includes(secret), false, `${call.tool} sent ${secret}: ${call.body}`)
  }
}

const assertOnlyTheQuestionIdAfterAsking = (sent: PusharyStub): void => {
  for (const call of sent.calls().filter(candidate => candidate.tool !== 'ask_user')) {
    assert.deepEqual(Object.keys(call.arguments).filter(key => key !== 'timeoutMs'), ['correlationId'], call.body)
  }
}

describe('what leaves the machine', () => {
  for (const fixture of FIXTURES) {
    it(`sends no secret from ${fixture.name}, when the answer is no`, async () => {
      const { result, stub: sent } = await gate(fixture.event, () => reply(answeredWith('no')))
      assert.equal(result?.block, true)
      assertNoSecretSent(sent, fixture.secrets)
      assertOnlyTheQuestionIdAfterAsking(sent)
    })
  }

  it('sends no secret when nobody answers and the question is withdrawn', async () => {
    const [fixture] = FIXTURES
    assert.ok(fixture)
    const { result, stub: sent } = await gate(fixture.event, () => reply(STILL_PENDING))
    assert.equal(result?.block, true)
    assert.equal(sent.toolCalls('cancel_question').length > 0, true)
    assertNoSecretSent(sent, fixture.secrets)
    assertOnlyTheQuestionIdAfterAsking(sent)
  })

  it('sends no secret when the answer is yes', async () => {
    const fixture = FIXTURES[1]
    assert.ok(fixture)
    const { result, stub: sent } = await gate(fixture.event, () => reply(answeredWith('yes')))
    assert.equal(result, undefined)
    assertNoSecretSent(sent, fixture.secrets)
  })

  it('sends nothing at all for a call too long to show in full', async () => {
    const { result, stub: sent } = await gate({ toolName: 'exec', params: { command: 'echo a; '.repeat(600) } }, () => reply(answeredWith('yes')))
    assert.equal(result?.block, true)
    assert.match(result?.blockReason ?? '', /too long to show in full: 4,800 characters, and Pushary shows at most 4,000\. It was blocked, not sent for an approval nobody could read\. Nothing ran\./)
    assert.equal(sent.calls().length, 0)
  })
})
