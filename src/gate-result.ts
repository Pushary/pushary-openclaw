import { APPROVAL_DESCRIPTION_MAX, APPROVAL_TITLE_MAX, truncated, type ApprovalQuestion } from './approval-question.js'
import { API_KEY_VARIABLE, BASE_URL_VARIABLE, type ConnectionReading } from './connection.js'
import { MIN_HOST_VERSION } from './host-version.js'
import type { GateOutcome } from './gate.js'
import type { OpenClawApprovalDecision, OpenClawBeforeToolCallResult } from './host-api.js'

export const SETUP_COMMAND = 'npx pushary@latest setup'
export const DEVICES_URL = 'https://pushary.com/dashboard/agent/settings'
export const HAND_BACK_DECISIONS: readonly OpenClawApprovalDecision[] = ['allow-once', 'deny']

const SECONDS_PER_MINUTE = 60
const MILLISECONDS_PER_SECOND = 1_000

export type ConnectionProblem = Exclude<ConnectionReading, { readonly kind: 'ready' }>['kind']

export type HandBackSurface = 'openclaw_prompt' | 'none'

const blocked = (blockReason: string): OpenClawBeforeToolCallResult => ({ block: true, blockReason })

const waitedFor = (heldMs: number): string => {
  const seconds = Math.round(heldMs / MILLISECONDS_PER_SECOND)
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} seconds`
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

const unavailableReason = (toolName: string, outcome: Extract<GateOutcome, { readonly kind: 'unavailable' }>): string => {
  if (outcome.failure === 'unauthorized') {
    return `Pushary rejected the API key, so this ${toolName} call was blocked. Nothing ran. Run ${SETUP_COMMAND} again to get a new key, then restart the OpenClaw gateway.`
  }
  if (outcome.failure === 'tool_error' || outcome.failure === 'refused') {
    return `Pushary refused the approval request, so this ${toolName} call was blocked. Nothing ran. Answer or cancel your open questions in Pushary, then try again.`
  }
  return `Pushary could not be reached, so nobody could approve this ${toolName} call and it was blocked. Nothing ran. Try again in a moment.`
}

const handedBack = (question: ApprovalQuestion): OpenClawBeforeToolCallResult => ({
  requireApproval: {
    title: truncated(question.question, APPROVAL_TITLE_MAX),
    description: truncated(`${question.context} ${question.action}`, APPROVAL_DESCRIPTION_MAX),
    severity: 'warning',
    allowedDecisions: [...HAND_BACK_DECISIONS],
  },
})

const noPromptToHandBackTo = (toolName: string): OpenClawBeforeToolCallResult =>
  blocked(`Your Pushary delivery mode keeps this approval off your phone, and this OpenClaw is older than ${MIN_HOST_VERSION}, so it cannot ask in its own prompt. This ${toolName} call was blocked. Update OpenClaw, or change the delivery mode in Pushary.`)

export const openClawResultFor = (outcome: GateOutcome, question: ApprovalQuestion, handBackSurface: HandBackSurface): OpenClawBeforeToolCallResult | undefined => {
  const tool = question.toolName
  switch (outcome.kind) {
    case 'approved':
      return undefined
    case 'denied':
      return blocked(`The person you asked in Pushary did not approve this ${tool} call, so it was blocked. Do not retry it. Ask them what to do instead.`)
    case 'unanswered':
      return blocked(`Nobody answered the Pushary approval within ${waitedFor(outcome.heldMs)}, so this ${tool} call was blocked. Nothing ran.`)
    case 'stopped':
      return blocked(`Pushary stopped this request, so this ${tool} call was blocked. Stop and wait for instructions.`)
    case 'cancelled':
      return blocked(`This ${tool} call was cancelled before anyone answered the Pushary approval. Nothing ran.`)
    case 'undeliverable':
      return blocked(`No phone, browser or Slack is connected to Pushary, so nobody could approve this ${tool} call and it was blocked. Connect one at ${DEVICES_URL}.`)
    case 'handed_back':
      return handBackSurface === 'openclaw_prompt' ? handedBack(question) : noPromptToHandBackTo(tool)
    case 'unavailable':
      return blocked(unavailableReason(tool, outcome))
  }
}

export const notConnectedResultFor = (problem: ConnectionProblem, toolName: string): OpenClawBeforeToolCallResult =>
  problem === 'missing_api_key'
    ? blocked(`Pushary is not set up for OpenClaw on this machine: ${API_KEY_VARIABLE} is missing, so this ${toolName} call was blocked. Run ${SETUP_COMMAND}, or add ${API_KEY_VARIABLE} to ~/.openclaw/.env, then restart the OpenClaw gateway.`)
    : blocked(`${BASE_URL_VARIABLE} is not https://pushary.com or https://www.pushary.com, so this ${toolName} call was blocked. Remove it, then restart the OpenClaw gateway.`)
