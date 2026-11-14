import type { ApprovalQuestion } from './approval-question.js'
import {
  CANCEL_REQUEST_TIMEOUT_MS,
  POLL_RESPONSE_GRACE_MS,
  type AskUserArguments,
  type CallFailure,
  type CallResult,
  type PusharyQuestions,
} from './pushary-client.js'
import { askReplyOf, isExplicitApproval, questionStateOf, withdrawalOf, type HandBackReason, type QuestionState, type Withdrawal } from './replies.js'

export const ASK_ATTEMPTS = 3
export const ASK_RETRY_PAUSE_MS = 1_000
export const POLL_RETRY_PAUSES_MS: readonly [number, ...number[]] = [2_000, 4_000, 8_000, 15_000]
export const UNANSWERED_POLL_PAUSE_MS = 2_000
export const LATE_ANSWER_POLL_MS = 1_000
export const WITHDRAW_ATTEMPTS = 3
export const WITHDRAW_RETRY_PAUSE_MS = 500

export type GateFailure = CallFailure | 'unreadable_reply'

const RETRYABLE_FAILURES: ReadonlySet<GateFailure> = new Set(['network', 'timed_out', 'server_error'])

export type GateOutcome =
  | { readonly kind: 'approved' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unanswered'; readonly heldMs: number }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'undeliverable' }
  | { readonly kind: 'handed_back' }
  | { readonly kind: 'unavailable'; readonly failure: GateFailure }

export interface GateClock {
  readonly monotonicMs: () => number
  readonly wallMs: () => number
  readonly sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>
}

export interface GateRequest {
  readonly question: ApprovalQuestion
  readonly agentName: string
  readonly requestId: string
  readonly holdMs: number
  readonly withdrawReserveMs: number
  readonly sessionId?: string
  readonly machineId?: string
  readonly signal?: AbortSignal
}

export interface GateDependencies {
  readonly questions: PusharyQuestions
  readonly clock: GateClock
}

type Withdrawn =
  | { readonly kind: 'withdrawn' }
  | { readonly kind: 'answered'; readonly value: string }
  | { readonly kind: 'gone' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'unreachable' }

type SettledState = Exclude<QuestionState, { readonly kind: 'pending' | 'unreadable' }>

const LATE_ANSWER_REQUEST_MS = LATE_ANSWER_POLL_MS + POLL_RESPONSE_GRACE_MS

const decisionFor = (answer: string): GateOutcome =>
  isExplicitApproval(answer) ? { kind: 'approved' } : { kind: 'denied' }

const askArgumentsFor = (request: GateRequest, waitEndsAt: string): AskUserArguments => ({
  question: request.question.question,
  type: 'confirm',
  wait: false,
  context: request.question.context,
  agentName: request.agentName,
  toolName: request.question.toolName,
  action: request.question.action,
  actionBody: request.question.actionBody,
  waitEndsAt,
  localSurfaceAvailable: false,
  requestId: request.requestId,
  ...(request.question.toolTarget === undefined ? {} : { toolTarget: request.question.toolTarget }),
  ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  ...(request.machineId === undefined ? {} : { machineId: request.machineId }),
})

const isRetryable = (failure: GateFailure): boolean => RETRYABLE_FAILURES.has(failure)

const pollFailureOf = (polled: CallResult, state: QuestionState | null): GateFailure | null => {
  if (polled.kind === 'failed') return polled.failure
  return state?.kind === 'unreadable' ? 'unreadable_reply' : null
}

const retryPauseMs = (consecutiveFailures: number): number =>
  POLL_RETRY_PAUSES_MS[Math.min(consecutiveFailures, POLL_RETRY_PAUSES_MS.length) - 1] ?? POLL_RETRY_PAUSES_MS[0]

const pauseAfterPoll = (consecutiveFailures: number): number =>
  consecutiveFailures > 0 ? retryPauseMs(consecutiveFailures) : UNANSWERED_POLL_PAUSE_MS

const isAbortFailure = (result: CallResult): boolean => result.kind === 'failed' && result.failure === 'aborted'

const isSettled = (state: QuestionState | null): state is SettledState =>
  state !== null && state.kind !== 'pending' && state.kind !== 'unreadable'

const withdrawalOfResult = (result: CallResult): Withdrawal => (result.kind === 'reply' ? withdrawalOf(result.value) : 'unreachable')

const WITHDRAW_RETRY_NEEDS_MS = WITHDRAW_RETRY_PAUSE_MS + CANCEL_REQUEST_TIMEOUT_MS

const mayRetryWithdrawal = (result: CallResult, attempt: number, remainingMs: number): boolean =>
  result.kind === 'failed' && isRetryable(result.failure) && attempt < WITHDRAW_ATTEMPTS && remainingMs >= WITHDRAW_RETRY_NEEDS_MS

export const runApprovalGate = async (request: GateRequest, dependencies: GateDependencies): Promise<GateOutcome> => {
  const { questions, clock } = dependencies
  const startedAt = clock.monotonicMs()
  const deadline = startedAt + request.holdMs
  const hookDeadline = deadline + request.withdrawReserveMs
  const aborted = (): boolean => request.signal?.aborted === true
  const remainingMs = (until: number): number => until - clock.monotonicMs()
  const heldMs = (): number => Math.max(0, clock.monotonicMs() - startedAt)

  const cancelWithRetry = async (correlationId: string, endsAt: number): Promise<Withdrawal> => {
    for (let attempt = 1; ; attempt += 1) {
      const result = await questions.cancel(correlationId)
      const withdrawal = withdrawalOfResult(result)
      if (withdrawal !== 'unreachable' || !mayRetryWithdrawal(result, attempt, remainingMs(endsAt))) return withdrawal
      await clock.sleep(WITHDRAW_RETRY_PAUSE_MS, undefined)
    }
  }

  const lateAnswerOf = async (correlationId: string, endsAt: number): Promise<Withdrawn> => {
    if (remainingMs(endsAt) < LATE_ANSWER_REQUEST_MS) return { kind: 'gone' }
    const late = await questions.waitForAnswer(correlationId, LATE_ANSWER_POLL_MS, undefined)
    const state = late.kind === 'reply' ? questionStateOf(late.value) : null
    if (state?.kind === 'stopped') return { kind: 'stop' }
    return state?.kind === 'answered' ? { kind: 'answered', value: state.value } : { kind: 'gone' }
  }

  const withdraw = async (correlationId: string): Promise<Withdrawn> => {
    const endsAt = Math.min(hookDeadline, clock.monotonicMs() + request.withdrawReserveMs)
    const withdrawal = await cancelWithRetry(correlationId, endsAt)
    if (withdrawal === 'not_pending') return lateAnswerOf(correlationId, endsAt)
    return { kind: withdrawal }
  }

  const cancelledAfterWithdrawing = async (correlationId: string): Promise<GateOutcome> => {
    await withdraw(correlationId)
    return { kind: 'cancelled' }
  }

  const unavailableAfterWithdrawing = async (correlationId: string, failure: GateFailure): Promise<GateOutcome> => {
    await withdraw(correlationId)
    return { kind: 'unavailable', failure }
  }

  const handBack = async (correlationId: string, reason: HandBackReason): Promise<GateOutcome> => {
    const withdrawn = await withdraw(correlationId)
    if (withdrawn.kind === 'answered') return decisionFor(withdrawn.value)
    if (withdrawn.kind === 'stop') return { kind: 'stopped' }
    if (withdrawn.kind === 'unreachable') return { kind: 'unavailable', failure: 'network' }
    return reason === 'no_devices' ? { kind: 'undeliverable' } : { kind: 'handed_back' }
  }

  const createQuestion = async (): Promise<CallResult> => {
    const args = askArgumentsFor(request, new Date(clock.wallMs() + request.holdMs).toISOString())
    let last: CallResult = { kind: 'failed', failure: 'network' }
    for (let attempt = 0; attempt < ASK_ATTEMPTS && remainingMs(deadline) > 0; attempt += 1) {
      if (attempt > 0) {
        if (aborted()) return last
        await clock.sleep(Math.min(ASK_RETRY_PAUSE_MS, remainingMs(deadline)), request.signal)
      }
      last = await questions.ask(args)
      if (last.kind === 'reply' || !isRetryable(last.failure)) return last
    }
    return last
  }

  const settleAfterHold = async (correlationId: string, handBackAt: number | null, lastFailure: GateFailure | null): Promise<GateOutcome> => {
    const handBackDue = handBackAt !== null && handBackAt < deadline && clock.monotonicMs() >= handBackAt
    const withdrawn = await withdraw(correlationId)
    if (withdrawn.kind === 'answered') return decisionFor(withdrawn.value)
    if (withdrawn.kind === 'stop') return { kind: 'stopped' }
    if (withdrawn.kind === 'unreachable') return { kind: 'unavailable', failure: lastFailure ?? 'network' }
    if (handBackDue) return { kind: 'handed_back' }
    if (lastFailure !== null) return { kind: 'unavailable', failure: lastFailure }
    return { kind: 'unanswered', heldMs: heldMs() }
  }

  const settleState = async (correlationId: string, state: SettledState): Promise<GateOutcome> => {
    if (state.kind === 'answered') return decisionFor(state.value)
    if (state.kind === 'stopped') return { kind: 'stopped' }
    if (state.kind === 'ended') return { kind: 'unanswered', heldMs: heldMs() }
    return handBack(correlationId, state.reason)
  }

  const waitForDecision = async (correlationId: string, handBackAfterMs: number | null): Promise<GateOutcome> => {
    const handBackAt = handBackAfterMs === null ? null : startedAt + handBackAfterMs
    const until = handBackAt === null ? deadline : Math.min(deadline, handBackAt)
    let lastFailure: GateFailure | null = null
    let consecutiveFailures = 0
    while (remainingMs(until) > 0) {
      if (aborted()) return cancelledAfterWithdrawing(correlationId)
      const polled = await questions.waitForAnswer(correlationId, remainingMs(until), request.signal)
      if (aborted() || isAbortFailure(polled)) return cancelledAfterWithdrawing(correlationId)
      const state = polled.kind === 'reply' ? questionStateOf(polled.value) : null
      if (isSettled(state)) return settleState(correlationId, state)
      lastFailure = pollFailureOf(polled, state)
      if (lastFailure !== null && !isRetryable(lastFailure)) return unavailableAfterWithdrawing(correlationId, lastFailure)
      consecutiveFailures = lastFailure === null ? 0 : consecutiveFailures + 1
      await clock.sleep(Math.min(pauseAfterPoll(consecutiveFailures), Math.max(0, remainingMs(until))), request.signal)
    }
    if (aborted()) return cancelledAfterWithdrawing(correlationId)
    return settleAfterHold(correlationId, handBackAt, lastFailure)
  }

  if (aborted()) return { kind: 'cancelled' }
  const created = await createQuestion()
  const reply = created.kind === 'reply' ? askReplyOf(created.value) : null
  if (aborted()) return reply?.kind === 'question' ? cancelledAfterWithdrawing(reply.correlationId) : { kind: 'cancelled' }
  if (created.kind === 'failed') return { kind: 'unavailable', failure: created.failure }
  if (reply === null || reply.kind === 'unreadable') return { kind: 'unavailable', failure: 'unreadable_reply' }
  if (reply.kind === 'stopped') return { kind: 'stopped' }
  if (reply.state.kind === 'pending') return waitForDecision(reply.correlationId, reply.handBackAfterMs)
  if (reply.state.kind === 'unreadable') return unavailableAfterWithdrawing(reply.correlationId, 'unreadable_reply')
  return settleState(reply.correlationId, reply.state)
}
