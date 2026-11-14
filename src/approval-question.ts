import type { OpenClawBeforeToolCallEvent } from './host-api.js'
import { redactSecrets, redactSecretsDeep } from './redaction.js'
import { SESSIONS_SPAWN_TOOL, SPAWN_FOLDER_PARAMETER } from './protected-writes.js'
import { AGENT_LABEL } from './settings.js'

export const QUESTION_SUMMARY_MAX = 160
export const CONTEXT_MAX = 500
export const ACTION_MAX = 500
export const ACTION_BODY_MAX = 4000
export const TOOL_TARGET_MAX = 80
export const TOOL_NAME_MAX = 100
export const APPROVAL_TITLE_MAX = 80
export const APPROVAL_DESCRIPTION_MAX = 512

const COMMAND_PARAMETERS = ['command', 'code'] as const
const WORKDIR_PARAMETER = 'workdir'
const TARGET_WORDS = 2
const ELLIPSIS = '…'

export interface ApprovalQuestion {
  readonly question: string
  readonly context: string
  readonly toolName: string
  readonly toolTarget: string | undefined
  readonly action: string
  readonly actionBody: string
}

const collapsed = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ')

export const truncated = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`

const stringParameter = (params: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = params[name]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

const commandOf = (event: OpenClawBeforeToolCallEvent): string | undefined =>
  COMMAND_PARAMETERS.map(name => stringParameter(event.params, name)).find(value => value !== undefined)

const serializedParams = (params: Readonly<Record<string, unknown>>): string => {
  try {
    return JSON.stringify(params) ?? ''
  } catch {
    return ''
  }
}

const questionFor = (toolName: string, summary: string, command: string | undefined, folder: string | undefined): string => {
  if (command !== undefined) return `Allow ${AGENT_LABEL} to run \`${summary}\`?`
  if (folder !== undefined) return `Allow ${AGENT_LABEL} to start a session in \`${truncated(collapsed(folder), QUESTION_SUMMARY_MAX)}\`?`
  return `Allow ${AGENT_LABEL} to use ${toolName}${summary ? `: \`${summary}\`` : ''}?`
}

const contextLines = (event: OpenClawBeforeToolCallEvent, agentName: string): readonly string[] => {
  const workdir = stringParameter(event.params, WORKDIR_PARAMETER) ?? stringParameter(event.params, SPAWN_FOLDER_PARAMETER)
  return [
    `${agentName} wants to use its ${event.toolName} tool.`,
    ...(workdir ? [`Working directory: ${workdir}`] : []),
    ...(event.params.elevated === true ? ['It asked for elevated mode, outside the sandbox.'] : []),
  ]
}

const targetOf = (command: string | undefined): string | undefined => {
  if (command === undefined) return undefined
  const head = collapsed(command).split(' ').slice(0, TARGET_WORDS).join(' ')
  return head ? truncated(head, TOOL_TARGET_MAX) : undefined
}

export const approvalQuestionFor = (event: OpenClawBeforeToolCallEvent, agentName: string): ApprovalQuestion => {
  const toolName = truncated(event.toolName.trim(), TOOL_NAME_MAX)
  const command = commandOf(event)
  const raw = command ?? serializedParams(event.params)
  const body = redactSecrets(raw)
  const summary = truncated(collapsed(body), QUESTION_SUMMARY_MAX)
  return {
    question: questionFor(toolName, summary, command, event.toolName === SESSIONS_SPAWN_TOOL ? stringParameter(event.params, SPAWN_FOLDER_PARAMETER) : undefined),
    context: truncated(redactSecrets(contextLines(event, agentName).join(' ')), CONTEXT_MAX),
    toolName,
    toolTarget: targetOf(command === undefined ? undefined : body),
    action: truncated(collapsed(body), ACTION_MAX),
    actionBody: truncated(redactSecretsDeep(raw), ACTION_BODY_MAX),
  }
}
