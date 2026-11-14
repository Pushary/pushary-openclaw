import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ACTION_BODY_MAX, approvalQuestionFor, CONTEXT_MAX, QUESTION_SUMMARY_MAX } from './approval-question.js'

describe('the approval question', () => {
  it('shows the command, its head and where it runs', () => {
    const question = approvalQuestionFor({ toolName: 'exec', params: { command: 'git   push --force origin main', workdir: '/srv/app', elevated: true } }, 'OpenClaw')
    assert.equal(question.question, 'Allow OpenClaw to run `git push --force origin main`?')
    assert.equal(question.toolTarget, 'git push')
    assert.equal(question.actionBody, 'git   push --force origin main')
    assert.match(question.context, /Working directory: \/srv\/app/)
    assert.match(question.context, /elevated mode/)
  })

  it('redacts credentials before anything leaves the machine', () => {
    const question = approvalQuestionFor({ toolName: 'exec', params: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuv" https://user:hunter2@example.com GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }, 'OpenClaw')
    for (const text of [question.question, question.action, question.actionBody]) {
      assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuv|hunter2|ghp_abcdefghijklmnopqrstuvwxyz0123456789/)
    }
  })

  for (const [name, command, secret] of [
    ['an exported AWS secret', 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY && aws s3 ls', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
    ['a GitHub token assignment', 'GITHUB_TOKEN=abc123secretvalue gh release create v1', 'abc123secretvalue'],
    ['a basic authorization header', "curl -H 'Authorization: Basic dXNlcjpodW50ZXIy' https://example.com", 'dXNlcjpodW50ZXIy'],
    ['a webhook signing secret', 'stripe listen --secret whsec_1234567890abcdefghijklmn', 'whsec_1234567890abcdefghijklmn'],
  ] as const) {
    it(`redacts ${name} in every outgoing field`, () => {
      const question = approvalQuestionFor({ toolName: 'exec', params: { command } }, 'OpenClaw')
      for (const text of [question.question, question.context, question.action, question.actionBody, question.toolTarget ?? '']) {
        assert.doesNotMatch(text, new RegExp(secret), `${name}: ${text}`)
      }
    })
  }

  it('redacts passwords and tokens in the JSON of a tool without a command', () => {
    const question = approvalQuestionFor({ toolName: 'browser', params: { action: 'login', password: 'hunter2hunter2', token: 'tok_live_123456' } }, 'OpenClaw')
    for (const text of [question.question, question.action, question.actionBody]) {
      assert.doesNotMatch(text, /hunter2hunter2|tok_live_123456/, text)
    }
  })

  it('describes a tool without a command by its parameters', () => {
    const question = approvalQuestionFor({ toolName: 'message', params: { action: 'send', to: '#ops', text: 'deploying' } }, 'OpenClaw - ops')
    assert.match(question.question, /^Allow OpenClaw to use message: `\{"action":"send"/)
    assert.equal(question.toolTarget, undefined)
    assert.match(question.context, /^OpenClaw - ops wants to use its message tool\./)
  })

  it('keeps every field inside the server limits', () => {
    const long = 'x'.repeat(20_000)
    const question = approvalQuestionFor({ toolName: 'exec', params: { command: long, workdir: long } }, 'OpenClaw')
    assert.ok(question.actionBody.length <= ACTION_BODY_MAX)
    assert.ok(question.context.length <= CONTEXT_MAX)
    assert.ok(question.question.length <= QUESTION_SUMMARY_MAX + 40)
  })

  it('survives parameters that cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.equal(approvalQuestionFor({ toolName: 'browser', params: circular }, 'OpenClaw').question, 'Allow OpenClaw to use browser?')
  })
})
