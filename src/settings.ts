import type { OpenClawBeforeToolCallEvent, OpenClawToolMatcher } from './host-api.js'
import { FILE_WRITING_TOOLS, SESSIONS_SPAWN_TOOL } from './protected-writes.js'

export const PLUGIN_ID = 'pushary'
export const PLUGIN_NAME = 'Pushary'
export const PLUGIN_DESCRIPTION = 'Asks you on your phone before OpenClaw runs a gated tool call, and blocks the call unless you approve it.'
export const AGENT_LABEL = 'OpenClaw'
export const DEFAULT_OPENCLAW_AGENT_ID = 'main'
export const EXEC_TOOL = 'exec'
export const PROCESS_TOOL = 'process'
export const PLUGINS_TOOL = 'plugins'
export const GATEWAY_TOOL = 'gateway'
export const OPENCLAW_SYSTEM_TOOL = 'openclaw'
export const AUTOMATIONS_TOOL = 'automations'
export const TERMINAL_TOOL = 'terminal'
export const TOOL_ACTION_PARAMETER = 'action'

const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,99}$/
const AGENT_NAME_SEPARATOR = ' - '
const AGENT_ID_MAX_LENGTH = 40

const HOST_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['bash', EXEC_TOOL],
  ['exec_command', EXEC_TOOL],
  ['shell', EXEC_TOOL],
  ['shell_command', EXEC_TOOL],
  ['apply-patch', 'apply_patch'],
  ['tool_call', 'dispatch_action'],
  ['cron', AUTOMATIONS_TOOL],
  ['agent', 'spawn_agent'],
])

const HOST_SPELLINGS_OF_EXEC: readonly string[] = [EXEC_TOOL, 'shell', 'shell_command']

const PROCESS_ACTIONS_WITHOUT_APPROVAL: ReadonlySet<string> = new Set(['list', 'poll', 'log', 'kill', 'clear', 'remove'])
const PLUGINS_ACTIONS_WITHOUT_APPROVAL: ReadonlySet<string> = new Set(['list', 'inspect', 'search'])
const GATEWAY_ACTIONS_WITHOUT_APPROVAL: ReadonlySet<string> = new Set(['config.get', 'config.schema.lookup'])
const OPENCLAW_SYSTEM_ACTIONS_WITHOUT_APPROVAL: ReadonlySet<string> = new Set([
  'status', 'models', 'agents', 'channels', 'channel_info', 'audit', 'validate_config', 'doctor',
  'config_get', 'config_schema', 'gateway_status', 'plugin_list', 'plugin_search', 'open_agent', 'open_setup',
])

const AUTOMATIONS_ACTIONS_WITHOUT_APPROVAL: ReadonlySet<string> = new Set(['status', 'list', 'get', 'runs', 'next_check'])
const TERMINAL_ACTIONS_WITHOUT_APPROVAL: ReadonlySet<string> = new Set(['read', 'list'])

const ACTIONS_WITHOUT_APPROVAL_BY_TOOL: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [PROCESS_TOOL, PROCESS_ACTIONS_WITHOUT_APPROVAL],
  [PLUGINS_TOOL, PLUGINS_ACTIONS_WITHOUT_APPROVAL],
  [GATEWAY_TOOL, GATEWAY_ACTIONS_WITHOUT_APPROVAL],
  [OPENCLAW_SYSTEM_TOOL, OPENCLAW_SYSTEM_ACTIONS_WITHOUT_APPROVAL],
  [AUTOMATIONS_TOOL, AUTOMATIONS_ACTIONS_WITHOUT_APPROVAL],
  [TERMINAL_TOOL, TERMINAL_ACTIONS_WITHOUT_APPROVAL],
])

export const DEFAULT_GATED_TOOLS: readonly string[] = [EXEC_TOOL, PROCESS_TOOL, PLUGINS_TOOL, GATEWAY_TOOL, OPENCLAW_SYSTEM_TOOL, AUTOMATIONS_TOOL, TERMINAL_TOOL]

export interface GateSettings {
  readonly gatedTools: readonly string[]
}

export type SettingsReading =
  | { readonly kind: 'defaulted'; readonly settings: GateSettings }
  | { readonly kind: 'configured'; readonly settings: GateSettings; readonly rejected: readonly string[] }
  | { readonly kind: 'invalid'; readonly settings: GateSettings }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const hostToolId = (name: string): string => {
  const lowered = name.trim().toLowerCase()
  return HOST_TOOL_ALIASES.get(lowered) ?? lowered
}

const configuredToolId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const id = hostToolId(value)
  return TOOL_ID_PATTERN.test(id) ? id : null
}

const withDefaults = (extra: readonly string[]): readonly string[] => [...new Set([...DEFAULT_GATED_TOOLS, ...extra])]

const DEFAULT_SETTINGS: GateSettings = { gatedTools: DEFAULT_GATED_TOOLS }

const rejectedEntry = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value))

export const readGateSettings = (pluginConfig: unknown): SettingsReading => {
  if (pluginConfig === undefined) return { kind: 'defaulted', settings: DEFAULT_SETTINGS }
  if (!isRecord(pluginConfig)) return { kind: 'invalid', settings: DEFAULT_SETTINGS }
  const configured = pluginConfig.gatedTools
  if (configured === undefined) return { kind: 'defaulted', settings: DEFAULT_SETTINGS }
  if (!Array.isArray(configured)) return { kind: 'invalid', settings: DEFAULT_SETTINGS }
  const accepted = configured.flatMap(entry => {
    const id = configuredToolId(entry)
    return id === null ? [] : [id]
  })
  const rejected = configured.filter(entry => configuredToolId(entry) === null).map(rejectedEntry)
  return { kind: 'configured', settings: { gatedTools: withDefaults(accepted) }, rejected }
}

const hostSpellingsOf = (toolId: string): readonly string[] => (toolId === EXEC_TOOL ? HOST_SPELLINGS_OF_EXEC : [toolId])

export const hookMatcherFor = (settings: GateSettings): OpenClawToolMatcher => {
  const [first, ...rest] = [...new Set([...settings.gatedTools.flatMap(hostSpellingsOf), ...FILE_WRITING_TOOLS, SESSIONS_SPAWN_TOOL])]
  return [first ?? EXEC_TOOL, ...rest]
}

const toolActionOf = (event: OpenClawBeforeToolCallEvent): string | null => {
  const action = event.params[TOOL_ACTION_PARAMETER]
  return typeof action === 'string' ? action.trim() : null
}

const actionNeedsApproval = (actionsWithoutApproval: ReadonlySet<string>, event: OpenClawBeforeToolCallEvent): boolean => {
  const action = toolActionOf(event)
  return action === null || !actionsWithoutApproval.has(action)
}

export const needsApproval = (settings: GateSettings, event: OpenClawBeforeToolCallEvent): boolean => {
  const toolId = hostToolId(event.toolName)
  if (!settings.gatedTools.includes(toolId)) return false
  const actionsWithoutApproval = ACTIONS_WITHOUT_APPROVAL_BY_TOOL.get(toolId)
  return actionsWithoutApproval === undefined || actionNeedsApproval(actionsWithoutApproval, event)
}

export const askingAgentName = (openClawAgentId: string | undefined): string => {
  const agentId = openClawAgentId?.trim().slice(0, AGENT_ID_MAX_LENGTH)
  return agentId && agentId !== DEFAULT_OPENCLAW_AGENT_ID
    ? `${AGENT_LABEL}${AGENT_NAME_SEPARATOR}${agentId}`
    : AGENT_LABEL
}
