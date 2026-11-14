import type { PusharyConnection } from './connection.js'

export const MCP_PATH = '/api/mcp/mcp'
export const ASK_USER_TOOL = 'ask_user'
export const WAIT_FOR_ANSWER_TOOL = 'wait_for_answer'
export const CANCEL_QUESTION_TOOL = 'cancel_question'
export const ASK_REQUEST_TIMEOUT_MS = 10_000
export const CANCEL_REQUEST_TIMEOUT_MS = 4_000
export const POLL_TIMEOUT_MIN_MS = 1_000
export const POLL_TIMEOUT_MAX_MS = 30_000
export const POLL_RESPONSE_GRACE_MS = 2_000

const JSON_RPC_VERSION = '2.0'
const TOOLS_CALL_METHOD = 'tools/call'
const EVENT_STREAM_TYPE = 'text/event-stream'
const EVENT_DATA_PREFIX = 'data:'
const UNAUTHORIZED_STATUSES: ReadonlySet<number> = new Set([401, 403])
const TOO_MANY_REQUESTS_STATUS = 429
const SERVER_ERROR_STATUS_FLOOR = 500

export type CallFailure = 'aborted' | 'timed_out' | 'network' | 'unauthorized' | 'refused' | 'server_error' | 'unreadable' | 'tool_error'

export type CallResult =
  | { readonly kind: 'reply'; readonly value: unknown }
  | { readonly kind: 'failed'; readonly failure: CallFailure }

export interface AskUserArguments {
  readonly question: string
  readonly type: 'confirm'
  readonly wait: false
  readonly context: string
  readonly agentName: string
  readonly toolName: string
  readonly action: string
  readonly actionBody: string
  readonly waitEndsAt: string
  readonly localSurfaceAvailable: false
  readonly toolTarget?: string
  readonly sessionId?: string
  readonly machineId?: string
  readonly requestId: string
}

export interface PusharyQuestions {
  readonly ask: (args: AskUserArguments) => Promise<CallResult>
  readonly waitForAnswer: (correlationId: string, timeoutMs: number, signal: AbortSignal | undefined) => Promise<CallResult>
  readonly cancel: (correlationId: string) => Promise<CallResult>
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>

type ReplyRecord = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is ReplyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsedJson = (text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

const lastEventData = (stream: string): string | null => {
  const events = stream.split(/\r?\n\r?\n/).map(event =>
    event.split(/\r?\n/).filter(line => line.startsWith(EVENT_DATA_PREFIX)).map(line => line.slice(EVENT_DATA_PREFIX.length).trimStart()).join('\n').trim())
  return events.filter(data => data.length > 0).at(-1) ?? null
}

const envelopeOf = (body: string, contentType: string): unknown => {
  const text = contentType.includes(EVENT_STREAM_TYPE) ? lastEventData(body) : body
  if (text === null || text.trim().length === 0) return null
  const parsed = parsedJson(text)
  return parsed.ok ? parsed.value : null
}

const firstTextContent = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null
  const first: unknown = content[0]
  return isRecord(first) && typeof first.text === 'string' ? first.text : null
}

const toolReplyOf = (envelope: unknown): CallResult => {
  if (!isRecord(envelope)) return { kind: 'failed', failure: 'unreadable' }
  if (envelope.error !== undefined) return { kind: 'failed', failure: 'tool_error' }
  const result = envelope.result
  if (!isRecord(result)) return { kind: 'failed', failure: 'unreadable' }
  if (result.isError === true) return { kind: 'failed', failure: 'tool_error' }
  if (isRecord(result.structuredContent)) return { kind: 'reply', value: result.structuredContent }
  const text = firstTextContent(result.content)
  const parsed = text === null ? null : parsedJson(text)
  return parsed?.ok ? { kind: 'reply', value: parsed.value } : { kind: 'failed', failure: 'unreadable' }
}

const requestSignal = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

const httpFailureOf = (status: number): CallFailure => {
  if (UNAUTHORIZED_STATUSES.has(status)) return 'unauthorized'
  return status === TOO_MANY_REQUESTS_STATUS || status >= SERVER_ERROR_STATUS_FLOOR ? 'server_error' : 'refused'
}

export const clampedPollMs = (timeoutMs: number): number =>
  Math.min(Math.max(Math.floor(timeoutMs), POLL_TIMEOUT_MIN_MS), POLL_TIMEOUT_MAX_MS)

export const createPusharyQuestions = (connection: PusharyConnection, fetcher: Fetcher = fetch): PusharyQuestions => {
  const endpoint = `${connection.baseUrl}${MCP_PATH}`

  const callTool = async (
    name: string,
    args: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<CallResult> => {
    const combined = requestSignal(signal, timeoutMs)
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: `application/json, ${EVENT_STREAM_TYPE}`,
          Authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: 1, method: TOOLS_CALL_METHOD, params: { name, arguments: args } }),
        signal: combined,
      })
      if (!response.ok) return { kind: 'failed', failure: httpFailureOf(response.status) }
      const body = await response.text()
      return toolReplyOf(envelopeOf(body, response.headers.get('content-type') ?? ''))
    } catch {
      if (signal?.aborted) return { kind: 'failed', failure: 'aborted' }
      return { kind: 'failed', failure: combined.aborted ? 'timed_out' : 'network' }
    }
  }

  return {
    ask: args => callTool(ASK_USER_TOOL, { ...args }, ASK_REQUEST_TIMEOUT_MS, undefined),
    waitForAnswer: (correlationId, timeoutMs, signal) => {
      const pollMs = clampedPollMs(timeoutMs)
      return callTool(WAIT_FOR_ANSWER_TOOL, { correlationId, timeoutMs: pollMs }, pollMs + POLL_RESPONSE_GRACE_MS, signal)
    },
    cancel: correlationId => callTool(CANCEL_QUESTION_TOOL, { correlationId }, CANCEL_REQUEST_TIMEOUT_MS, undefined),
  }
}
