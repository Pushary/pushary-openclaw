import { isApprovingAnswer, isDecisionStoppedReply, STOP_HANDOFF_ACTION } from './decision-reply.js'

export const CANCEL_THEN_ASK_IN_CURRENT_CLIENT = 'cancel_then_ask_in_current_client'
export const PUSH_FIRST_DELIVERY = 'push_first'

const PENDING_STATUS = 'pending'
const UNAVAILABLE_STATUS = 'unavailable'
const ENDED_STATUSES: ReadonlySet<string> = new Set(['expired'])

export type HandBackReason = 'no_devices' | 'current_client'

export type QuestionState =
  | { readonly kind: 'answered'; readonly value: string }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'ended' }
  | { readonly kind: 'hand_back'; readonly reason: HandBackReason }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unreadable' }

export type AskReply =
  | {
    readonly kind: 'question'
    readonly correlationId: string
    readonly state: QuestionState
    readonly handBackAfterMs: number | null
  }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'unreadable' }

export type Withdrawal = 'withdrawn' | 'not_pending' | 'stop' | 'unreachable'

type ReplyRecord = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is ReplyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const answeredValueOf = (reply: ReplyRecord): string | null =>
  reply.answered === true && typeof reply.value === 'string' ? reply.value : null

const statusOf = (reply: ReplyRecord): string | null => (typeof reply.status === 'string' ? reply.status : null)

const hasEnded = (reply: ReplyRecord): boolean => {
  const status = statusOf(reply)
  return status !== null && ENDED_STATUSES.has(status)
}

const handBackReasonOf = (reply: ReplyRecord): HandBackReason =>
  reply.noDevices === true ? 'no_devices' : 'current_client'

export const questionStateOf = (reply: unknown): QuestionState => {
  if (!isRecord(reply)) return { kind: 'unreadable' }
  if (isDecisionStoppedReply(reply)) return { kind: 'stopped' }
  const answered = answeredValueOf(reply)
  if (answered !== null) return { kind: 'answered', value: answered }
  if (reply.answered === true) return { kind: 'unreadable' }
  if (hasEnded(reply)) return { kind: 'ended' }
  if (reply.handoffAction === CANCEL_THEN_ASK_IN_CURRENT_CLIENT) return { kind: 'hand_back', reason: handBackReasonOf(reply) }
  if (statusOf(reply) === PENDING_STATUS) return { kind: 'pending' }
  return { kind: 'unreadable' }
}

const correlationIdOf = (reply: ReplyRecord): string | null =>
  typeof reply.correlationId === 'string' && reply.correlationId.trim().length > 0 ? reply.correlationId : null

const handBackAfterMsOf = (reply: ReplyRecord): number | null => {
  if (reply.requesterMayAnswer === false || reply.deliveryMode !== PUSH_FIRST_DELIVERY) return null
  const window = reply.policyTimeoutMs
  return typeof window === 'number' && Number.isFinite(window) && window >= 0 ? window : null
}

export const askReplyOf = (reply: unknown): AskReply => {
  if (!isRecord(reply)) return { kind: 'unreadable' }
  const state = questionStateOf(reply)
  if (state.kind === 'stopped') return { kind: 'stopped' }
  const correlationId = correlationIdOf(reply)
  if (correlationId === null) return { kind: 'unreadable' }
  return { kind: 'question', correlationId, state, handBackAfterMs: handBackAfterMsOf(reply) }
}

export const withdrawalOf = (reply: unknown): Withdrawal => {
  if (!isRecord(reply)) return 'unreachable'
  if (statusOf(reply) === UNAVAILABLE_STATUS || reply.handoffAction === STOP_HANDOFF_ACTION) return 'stop'
  if (typeof reply.cancelled !== 'boolean') return 'unreachable'
  const byThisCall = reply.cancelledByThisCall
  if (byThisCall !== undefined && typeof byThisCall !== 'boolean') return 'unreachable'
  if (byThisCall === true && !reply.cancelled) return 'unreachable'
  return reply.cancelled ? 'withdrawn' : 'not_pending'
}

export const isExplicitApproval = (answer: string): boolean => isApprovingAnswer(answer)
