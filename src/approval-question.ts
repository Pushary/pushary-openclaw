import { commandPreviewOf, type CommandPreview } from './command-preview.js'
import { fileChangePreviewOf, type FileChangePreview } from './file-change-preview.js'
import type { OpenClawBeforeToolCallEvent } from './host-api.js'
import { serializedWithCredentialsRedacted } from './parameter-redaction.js'
import { redactSecrets, redactSecretsDeep } from './redaction.js'
import { SESSIONS_SPAWN_TOOL, SPAWN_FOLDER_PARAMETER, startsAnAcpSession } from './protected-writes.js'
import { AGENT_LABEL, hostToolId } from './settings.js'
import { withHiddenCharactersShown } from './visible-text.js'

export const QUESTION_SUMMARY_MAX = 160
export const CONTEXT_MAX = 500
export const ACTION_MAX = 500
export const ACTION_BODY_MAX = 4000
export const TOOL_TARGET_MAX = 80
export const TOOL_NAME_MAX = 100
export const APPROVAL_TITLE_MAX = 80
export const APPROVAL_DESCRIPTION_MAX = 512

const WORKDIR_PARAMETER = 'workdir'
const ELEVATED_PARAMETER = 'elevated'
const SPAWN_AGENT_PARAMETER = 'agentId'
const PARAMETERS_THE_CONTEXT_SHOWS: readonly string[] = [WORKDIR_PARAMETER, ELEVATED_PARAMETER]
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

export type ApprovalPreview =
  | { readonly kind: 'reviewable'; readonly question: ApprovalQuestion }
  | { readonly kind: 'too_long'; readonly toolName: string; readonly length: number }

type CallDescription =
  | { readonly kind: 'command'; readonly preview: CommandPreview }
  | { readonly kind: 'file_change'; readonly change: FileChangePreview }
  | { readonly kind: 'parameters'; readonly line: string; readonly body: string }

type ParametersCall = Extract<CallDescription, { readonly kind: 'parameters' }>

const collapsed = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ')

export const truncated = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`

export const characterCount = (length: number): string => length.toLocaleString('en-US')

const stringParameter = (params: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = params[name]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

const describedCall = (event: OpenClawBeforeToolCallEvent): CallDescription => {
  const preview = commandPreviewOf(event.params, PARAMETERS_THE_CONTEXT_SHOWS)
  if (preview !== null) return { kind: 'command', preview }
  const change = fileChangePreviewOf(hostToolId(event.toolName), event.params)
  if (change !== null) return { kind: 'file_change', change }
  const visible = withHiddenCharactersShown(serializedWithCredentialsRedacted(event.params))
  return { kind: 'parameters', line: redactSecrets(visible), body: redactSecretsDeep(visible) }
}

const READ_IT_ALL = 'Read all of it before you answer.'

const shortenedNote = (what: string, length: number): string =>
  ` Shortened here: the ${what} is ${characterCount(length)} characters. ${READ_IT_ALL}`

const summaryOf = (line: string): { readonly text: string; readonly shortened: boolean } => {
  const whole = collapsed(line)
  return { text: truncated(whole, QUESTION_SUMMARY_MAX), shortened: whole.length > QUESTION_SUMMARY_MAX }
}

const hasMoreThanTheCommand = (preview: CommandPreview): boolean =>
  preview.environmentNames.length > 0 || preview.otherParameters !== null

const commandQuestion = (preview: CommandPreview): string => {
  const summary = summaryOf(preview.command)
  const extras = hasMoreThanTheCommand(preview)
  const environment = preview.environmentNames.length > 0 ? ` with ${truncated(preview.environmentNames.join(', '), QUESTION_SUMMARY_MAX)} set` : ''
  const note = summary.shortened
    ? shortenedNote(extras ? 'full call' : 'command', preview.body.length)
    : extras ? ' Read the full call before you answer.' : ''
  return `Allow ${AGENT_LABEL} to run \`${summary.text}\`${environment}?${note}`
}

const quotedList = (paths: readonly string[]): string =>
  truncated(paths.map(path => `\`${collapsed(path)}\``).join(', '), QUESTION_SUMMARY_MAX)

const fileChangeQuestion = (change: FileChangePreview): string => {
  const targets = quotedList(change.paths)
  const asked = change.operation === 'patch' ? `apply a patch to ${targets}` : `${change.operation} ${targets}`
  return `Allow ${AGENT_LABEL} to ${asked}? Read the change before you answer.`
}

const quotedForQuestion = (text: string): string => `\`${truncated(collapsed(redactSecrets(withHiddenCharactersShown(text))), QUESTION_SUMMARY_MAX)}\``

const spawnQuestion = (event: OpenClawBeforeToolCallEvent, note: string): string | null => {
  if (event.toolName !== SESSIONS_SPAWN_TOOL) return null
  const folder = stringParameter(event.params, SPAWN_FOLDER_PARAMETER)
  const where = folder === undefined ? '' : ` in ${quotedForQuestion(folder)}`
  if (startsAnAcpSession(event.params)) {
    const agent = stringParameter(event.params, SPAWN_AGENT_PARAMETER)
    const harness = agent === undefined ? '' : ` with ${quotedForQuestion(agent)}`
    return `Allow ${AGENT_LABEL} to start an outside agent session (ACP)${harness}${where}? Pushary does not see the tool calls that session makes.${note}`
  }
  return folder === undefined ? null : `Allow ${AGENT_LABEL} to start a session${where}?${note}`
}

const parametersQuestion = (toolName: string, description: ParametersCall, event: OpenClawBeforeToolCallEvent): string => {
  const summary = summaryOf(description.line)
  const note = summary.shortened ? shortenedNote('request', description.body.length) : ''
  return spawnQuestion(event, note) ?? `Allow ${AGENT_LABEL} to use ${toolName}${summary.text ? `: \`${summary.text}\`` : ''}?${note}`
}

const questionFor = (toolName: string, description: CallDescription, event: OpenClawBeforeToolCallEvent): string => {
  if (description.kind === 'command') return commandQuestion(description.preview)
  if (description.kind === 'file_change') return fileChangeQuestion(description.change)
  return parametersQuestion(toolName, description, event)
}

const contextLines = (event: OpenClawBeforeToolCallEvent, agentName: string, description: CallDescription): readonly string[] => {
  const workdir = stringParameter(event.params, WORKDIR_PARAMETER) ?? stringParameter(event.params, SPAWN_FOLDER_PARAMETER)
  const otherParameters = description.kind === 'command' ? description.preview.otherParameters : null
  return [
    `${agentName} wants to use its ${event.toolName} tool.`,
    ...(workdir ? [`Working directory: ${workdir}`] : []),
    ...(event.params[ELEVATED_PARAMETER] === true ? ['It asked for elevated mode, outside the sandbox.'] : []),
    ...(otherParameters === null ? [] : [`Other parameters: ${otherParameters}`]),
  ]
}

const targetOf = (description: CallDescription): string | undefined => {
  if (description.kind !== 'command') return undefined
  const head = collapsed(description.preview.command).split(' ').slice(0, TARGET_WORDS).join(' ')
  return head ? truncated(head, TOOL_TARGET_MAX) : undefined
}

const actionLineOf = (description: CallDescription): string => {
  if (description.kind === 'command') return description.preview.line
  if (description.kind === 'file_change') return `${description.change.operation} ${description.change.paths.join(', ')}`
  return description.line
}

const actionBodyOf = (description: CallDescription): string => {
  if (description.kind === 'command') return description.preview.body
  if (description.kind === 'file_change') return description.change.body
  return description.body
}

export const approvalPreviewFor = (event: OpenClawBeforeToolCallEvent, agentName: string): ApprovalPreview => {
  const toolName = truncated(withHiddenCharactersShown(event.toolName.trim()), TOOL_NAME_MAX)
  const description = describedCall(event)
  const actionBody = actionBodyOf(description)
  if (actionBody.length > ACTION_BODY_MAX) return { kind: 'too_long', toolName, length: actionBody.length }
  return {
    kind: 'reviewable',
    question: {
      question: questionFor(toolName, description, event),
      context: truncated(redactSecrets(withHiddenCharactersShown(contextLines(event, agentName, description).join(' '))), CONTEXT_MAX),
      toolName,
      toolTarget: targetOf(description),
      action: truncated(collapsed(actionLineOf(description)), ACTION_MAX),
      actionBody,
    },
  }
}
