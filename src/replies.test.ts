import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { askReplyOf, isExplicitApproval, questionStateOf, withdrawalOf } from './replies.js'

describe('Pushary replies', () => {
  it('reads an answer only when answered is true and the value is a string', () => {
    assert.deepEqual(questionStateOf({ answered: true, value: 'yes' }), { kind: 'answered', value: 'yes' })
    assert.deepEqual(questionStateOf({ answered: true }), { kind: 'unreadable' })
    assert.deepEqual(questionStateOf({ answered: true, value: { yes: true } }), { kind: 'unreadable' })
    assert.deepEqual(questionStateOf({ answered: 'true', value: 'yes', status: 'pending' }), { kind: 'pending' })
  })

  it('treats stop, cancelled, unavailable and missing as a stop', () => {
    for (const reply of [{ handoffAction: 'stop' }, { status: 'cancelled' }, { status: 'unavailable' }, { status: 'stopped' }, { status: 'missing' }]) {
      assert.deepEqual(questionStateOf(reply), { kind: 'stopped' })
    }
  })

  it('lets a stop win over an answer that arrived with it, as the CLI hook does', () => {
    assert.deepEqual(questionStateOf({ answered: true, value: 'yes', handoffAction: 'stop' }), { kind: 'stopped' })
    assert.deepEqual(questionStateOf({ answered: true, value: 'yes', status: 'cancelled' }), { kind: 'stopped' })
    assert.deepEqual(askReplyOf({ correlationId: 'q', answered: true, value: 'yes', handoffAction: 'stop' }), { kind: 'stopped' })
  })

  it('hands back with the reason the server gave', () => {
    assert.deepEqual(questionStateOf({ handoffAction: 'cancel_then_ask_in_current_client', noDevices: true }), { kind: 'hand_back', reason: 'no_devices' })
    assert.deepEqual(questionStateOf({ handoffAction: 'cancel_then_ask_in_current_client', status: 'terminal' }), { kind: 'hand_back', reason: 'current_client' })
  })

  it('needs a correlation id before it waits', () => {
    assert.deepEqual(askReplyOf({ status: 'pending' }), { kind: 'unreadable' })
    assert.deepEqual(askReplyOf({ correlationId: ' ', status: 'pending' }), { kind: 'unreadable' })
    assert.deepEqual(askReplyOf(null), { kind: 'unreadable' })
  })

  it('applies a push_first window only when the requester may answer', () => {
    const pushFirst = { correlationId: 'q', status: 'pending', deliveryMode: 'push_first', policyTimeoutMs: 60_000 }
    assert.deepEqual(askReplyOf(pushFirst), { kind: 'question', correlationId: 'q', state: { kind: 'pending' }, handBackAfterMs: 60_000 })
    const routed = askReplyOf({ ...pushFirst, requesterMayAnswer: false })
    assert.equal(routed.kind === 'question' ? routed.handBackAfterMs : 'unreadable', null)
    const pushOnly = askReplyOf({ ...pushFirst, deliveryMode: 'push_only' })
    assert.equal(pushOnly.kind === 'question' ? pushOnly.handBackAfterMs : 'unreadable', null)
  })

  it('classifies a withdrawal', () => {
    assert.equal(withdrawalOf({ cancelled: true, cancelledByThisCall: true }), 'withdrawn')
    assert.equal(withdrawalOf({ cancelled: false }), 'not_pending')
    assert.equal(withdrawalOf({ cancelled: false, status: 'unavailable', handoffAction: 'stop' }), 'stop')
    assert.equal(withdrawalOf({ cancelled: 'yes' }), 'unreachable')
    assert.equal(withdrawalOf({ cancelled: false, cancelledByThisCall: true }), 'unreachable')
    assert.equal(withdrawalOf(undefined), 'unreachable')
  })

  it('approves only the exact answer yes, as the CLI hook does', () => {
    assert.equal(isExplicitApproval('yes'), true)
    for (const answer of ['no', '', ' yes', 'Yes', 'YES', 'y', 'true', 'approve', 'approved', 'allow', 'ok', 'yes please', 'deny']) {
      assert.equal(isExplicitApproval(answer), false, answer)
    }
  })
})
