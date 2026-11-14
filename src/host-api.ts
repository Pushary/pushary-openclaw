export const BEFORE_TOOL_CALL_HOOK = 'before_tool_call'

export type OpenClawApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

export type OpenClawApprovalSeverity = 'info' | 'warning' | 'critical'

export type OpenClawToolMatcher = readonly [string, ...string[]]

export interface OpenClawBeforeToolCallEvent {
  readonly toolName: string
  readonly params: Readonly<Record<string, unknown>>
  readonly toolKind?: string
  readonly toolInputKind?: string
  readonly runId?: string
  readonly toolCallId?: string
  readonly derivedPaths?: readonly string[]
}

export interface OpenClawToolContext {
  readonly agentId?: string
  readonly sessionKey?: string
  readonly sessionId?: string
  readonly runId?: string
  readonly toolCallId?: string
  readonly channelId?: string
  readonly abortSignal?: AbortSignal
}

export interface OpenClawApprovalRequest {
  title: string
  description: string
  severity?: OpenClawApprovalSeverity
  timeoutMs?: number
  timeoutReason?: string
  allowedDecisions?: OpenClawApprovalDecision[]
}

export interface OpenClawBeforeToolCallResult {
  block?: boolean
  blockReason?: string
  requireApproval?: OpenClawApprovalRequest
}

export type OpenClawBeforeToolCallHandler = (
  event: OpenClawBeforeToolCallEvent,
  context: OpenClawToolContext,
) => Promise<OpenClawBeforeToolCallResult | undefined>

export interface OpenClawHookOptions {
  readonly matcher?: OpenClawToolMatcher
  readonly priority?: number
  readonly timeoutMs?: number
}

export interface OpenClawLogger {
  readonly info: (message: string) => void
  readonly warn: (message: string) => void
  readonly error: (message: string) => void
}

export interface OpenClawPluginApi {
  readonly id: string
  readonly config: unknown
  readonly pluginConfig?: unknown
  readonly runtime?: unknown
  readonly logger: OpenClawLogger
  readonly on: (
    hookName: typeof BEFORE_TOOL_CALL_HOOK,
    handler: OpenClawBeforeToolCallHandler,
    options?: OpenClawHookOptions,
  ) => void
}

export interface OpenClawPluginEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly register: (api: OpenClawPluginApi) => void
}
