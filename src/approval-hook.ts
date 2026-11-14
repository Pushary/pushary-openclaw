import { createHash } from 'node:crypto'
import { approvalQuestionFor } from './approval-question.js'
import type { ConnectionReading, PusharyConnection } from './connection.js'
import { runApprovalGate, type GateClock } from './gate.js'
import { notConnectedResultFor, openClawResultFor, type HandBackSurface } from './gate-result.js'
import { holdMsWithin, hookBudgetFrom, REQUESTED_HOOK_TIMEOUT_MS } from './hook-budget.js'
import {
  BEFORE_TOOL_CALL_HOOK,
  type OpenClawBeforeToolCallHandler,
  type OpenClawBeforeToolCallResult,
  type OpenClawPluginApi,
  type OpenClawToolContext,
} from './host-api.js'
import { handsBackToTheHost, hostSupportFrom, MIN_HOST_VERSION, type HostSupport } from './host-version.js'
import { openClawWriteGuardFor } from './openclaw-write-guard.js'
import type { FileWriteCall } from './protected-writes.js'
import type { PusharyQuestions } from './pushary-client.js'
import { askingAgentName, hookMatcherFor, hostToolId, needsApproval, readGateSettings, type GateSettings, type SettingsReading } from './settings.js'

export const SESSION_ID_MAX = 128

const MILLISECONDS_PER_SECOND = 1_000

export interface GateEnvironment {
  readonly readConnection: () => ConnectionReading
  readonly questionsFor: (connection: PusharyConnection) => PusharyQuestions
  readonly clock: GateClock
  readonly newRequestId: () => string
}

export interface GateHandlerOptions {
  readonly settings: GateSettings
  readonly holdMs: number
  readonly withdrawReserveMs: number
  readonly handBackSurface: HandBackSurface
  readonly reachesOpenClawState: (call: FileWriteCall) => boolean
}

const UNEXPECTED_FAILURE_REASON = 'The Pushary approval gate failed unexpectedly, so this tool call was blocked. Nothing ran.'

const boundedSessionId = (value: string): string =>
  value.length <= SESSION_ID_MAX ? value : createHash('sha256').update(value, 'utf8').digest('hex')

const sessionIdOf = (context: OpenClawToolContext): string | undefined => {
  const session = (context.sessionId ?? context.sessionKey)?.trim()
  return session ? boundedSessionId(session) : undefined
}

export const createApprovalGateHandler = (
  options: GateHandlerOptions,
  environment: GateEnvironment,
): OpenClawBeforeToolCallHandler => async (event, context): Promise<OpenClawBeforeToolCallResult | undefined> => {
  const reachesOpenClawState = options.reachesOpenClawState({ toolId: hostToolId(event.toolName), event, agentId: context.agentId })
  if (!needsApproval(options.settings, event) && !reachesOpenClawState) return undefined
  const agentName = askingAgentName(context.agentId)
  const question = approvalQuestionFor(event, agentName)
  const reading = environment.readConnection()
  if (reading.kind !== 'ready') return notConnectedResultFor(reading.kind, question.toolName)
  const sessionId = sessionIdOf(context)
  const outcome = await runApprovalGate({
    question,
    agentName,
    requestId: environment.newRequestId(),
    holdMs: options.holdMs,
    withdrawReserveMs: options.withdrawReserveMs,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(reading.connection.machineId === null ? {} : { machineId: reading.connection.machineId }),
    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
  }, { questions: environment.questionsFor(reading.connection), clock: environment.clock })
  return openClawResultFor(outcome, question, options.handBackSurface)
}

const failingClosed = (handler: OpenClawBeforeToolCallHandler, api: OpenClawPluginApi): OpenClawBeforeToolCallHandler =>
  async (event, context) => {
    try {
      return await handler(event, context)
    } catch (error) {
      api.logger.error(`pushary: approval gate failed for ${event.toolName}: ${String(error)}`)
      return { block: true, blockReason: UNEXPECTED_FAILURE_REASON }
    }
  }

const gatedToolsLine = (settings: GateSettings): string => settings.gatedTools.join(', ')

const reportSettings = (api: OpenClawPluginApi, reading: SettingsReading): void => {
  if (reading.kind === 'invalid') {
    api.logger.error(`pushary: plugins.entries.pushary.config.gatedTools must be a list of OpenClaw tool ids; it was ignored, and only ${gatedToolsLine(reading.settings)} ask`)
  }
  if (reading.kind === 'configured' && reading.rejected.length > 0) {
    api.logger.error(`pushary: these gatedTools entries are not OpenClaw tool ids and gate nothing: ${reading.rejected.join(', ')}`)
  }
}

const reportHostSupport = (api: OpenClawPluginApi, support: HostSupport): void => {
  if (support.kind === 'supported') return
  const found = support.kind === 'too_old' ? `OpenClaw ${support.version}` : 'an OpenClaw that does not report its version'
  api.logger.warn(`pushary: this plugin is built for OpenClaw ${MIN_HOST_VERSION} or later and found ${found}; approvals that would go to OpenClaw's own prompt are blocked instead`)
}

const handBackSurfaceFor = (support: HostSupport): HandBackSurface => (handsBackToTheHost(support) ? 'openclaw_prompt' : 'none')

export const registerApprovalGate = (api: OpenClawPluginApi, environment: GateEnvironment): void => {
  const reading = readGateSettings(api.pluginConfig)
  reportSettings(api, reading)
  const support = hostSupportFrom(api.runtime)
  reportHostSupport(api, support)
  const hookTimeoutMs = hookBudgetFrom(api.config, api.id).timeoutMs
  const holdMs = holdMsWithin(hookTimeoutMs)
  const handlerOptions: GateHandlerOptions = {
    settings: reading.settings,
    holdMs,
    withdrawReserveMs: hookTimeoutMs - holdMs,
    handBackSurface: handBackSurfaceFor(support),
    reachesOpenClawState: openClawWriteGuardFor(api),
  }
  const handler = failingClosed(createApprovalGateHandler(handlerOptions, environment), api)
  try {
    api.on(BEFORE_TOOL_CALL_HOOK, handler, { matcher: hookMatcherFor(reading.settings), timeoutMs: REQUESTED_HOOK_TIMEOUT_MS })
  } catch (error) {
    api.logger.error(`pushary: OpenClaw refused the tool list (${String(error)}), so every tool call is checked against it by name instead`)
    api.on(BEFORE_TOOL_CALL_HOOK, handler, { timeoutMs: REQUESTED_HOOK_TIMEOUT_MS })
  }
  api.logger.info(`pushary: asking before ${gatedToolsLine(reading.settings)}, waiting up to ${Math.round(holdMs / MILLISECONDS_PER_SECOND)} s for an answer`)
}
