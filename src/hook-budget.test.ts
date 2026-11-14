import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { holdMsWithin, hookBudgetFrom, REQUESTED_HOOK_TIMEOUT_MS } from './hook-budget.js'

const configWith = (hooks: unknown): unknown => ({ plugins: { entries: { pushary: { enabled: true, hooks } } } })

describe('the before_tool_call budget', () => {
  it('uses the plugin request when the operator set nothing', () => {
    assert.deepEqual(hookBudgetFrom({}, 'pushary'), { timeoutMs: REQUESTED_HOOK_TIMEOUT_MS, source: 'plugin' })
    assert.deepEqual(hookBudgetFrom(null, 'pushary'), { timeoutMs: REQUESTED_HOOK_TIMEOUT_MS, source: 'plugin' })
  })

  it('lets a per-hook operator timeout win over the plugin-wide one', () => {
    assert.deepEqual(hookBudgetFrom(configWith({ timeoutMs: 30_000, timeouts: { before_tool_call: 20_000 } }), 'pushary'), { timeoutMs: 20_000, source: 'operator_hook_timeout' })
    assert.deepEqual(hookBudgetFrom(configWith({ timeoutMs: 30_000 }), 'pushary'), { timeoutMs: 30_000, source: 'operator_plugin_timeout' })
  })

  it('ignores operator values OpenClaw itself would drop', () => {
    for (const value of [0, -5, 1.5, 600_001, '30000', Number.NaN]) {
      assert.equal(hookBudgetFrom(configWith({ timeoutMs: value }), 'pushary').source, 'plugin', String(value))
    }
  })

  it('reads only its own plugin entry', () => {
    assert.equal(hookBudgetFrom(configWith({ timeoutMs: 30_000 }), 'other').source, 'plugin')
  })

  it('ends the wait ten seconds before the budget, or halfway through a short one', () => {
    assert.equal(holdMsWithin(300_000), 290_000)
    assert.equal(holdMsWithin(15_000), 7_500)
    assert.equal(holdMsWithin(60_000), 50_000)
  })
})
