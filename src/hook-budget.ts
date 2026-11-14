import { BEFORE_TOOL_CALL_HOOK } from './host-api.js'

export const REQUESTED_HOOK_TIMEOUT_MS = 300_000
export const WITHDRAW_RESERVE_MS = 10_000
export const OPERATOR_HOOK_TIMEOUT_MAX_MS = 600_000

export type HookBudgetSource = 'plugin' | 'operator_hook_timeout' | 'operator_plugin_timeout'

export interface HookBudget {
  readonly timeoutMs: number
  readonly source: HookBudgetSource
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fieldOf = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined)

const operatorMilliseconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= OPERATOR_HOOK_TIMEOUT_MAX_MS ? value : null

const hookPolicyOf = (hostConfig: unknown, pluginId: string): unknown =>
  fieldOf(fieldOf(fieldOf(fieldOf(hostConfig, 'plugins'), 'entries'), pluginId), 'hooks')

export const hookBudgetFrom = (hostConfig: unknown, pluginId: string): HookBudget => {
  const policy = hookPolicyOf(hostConfig, pluginId)
  const perHook = operatorMilliseconds(fieldOf(fieldOf(policy, 'timeouts'), BEFORE_TOOL_CALL_HOOK))
  if (perHook !== null) return { timeoutMs: perHook, source: 'operator_hook_timeout' }
  const perPlugin = operatorMilliseconds(fieldOf(policy, 'timeoutMs'))
  if (perPlugin !== null) return { timeoutMs: perPlugin, source: 'operator_plugin_timeout' }
  return { timeoutMs: REQUESTED_HOOK_TIMEOUT_MS, source: 'plugin' }
}

export const holdMsWithin = (hookTimeoutMs: number): number =>
  Math.max(hookTimeoutMs - WITHDRAW_RESERVE_MS, Math.floor(hookTimeoutMs / 2))
