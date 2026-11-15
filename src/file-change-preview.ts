import { basename } from 'node:path'
import { APPLY_PATCH_TOOL, EDIT_TOOL, patchTargetsOf, WRITE_TOOL } from './protected-writes.js'
import { redactSecrets, redactSecretsDeep } from './redaction.js'
import { withHiddenCharactersShown } from './visible-text.js'

export interface FileChangePreview {
  readonly operation: string
  readonly paths: readonly string[]
  readonly body: string
}

interface TextEdit {
  readonly oldText: string
  readonly newText: string
}

const PATH_PARAMETER = 'path'
const CONTENT_PARAMETER = 'content'
const EDITS_PARAMETER = 'edits'
const PATCH_PARAMETER = 'input'
const OLD_TEXT_PARAMETER = 'oldText'
const NEW_TEXT_PARAMETER = 'newText'
const ENV_FILE_NAME = '.env'
const ENV_ASSIGNMENT = /^([+\- ]?[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*[ \t]*=[ \t]*)\S.*$/gm
const HIDDEN_VALUE = '[value not sent]'
const REMOVED_LINE_PREFIX = '- '
const ADDED_LINE_PREFIX = '+ '

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textParameter = (params: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = params[name]
  return typeof value === 'string' ? value : undefined
}

const pathParameter = (params: Readonly<Record<string, unknown>>): string | undefined => {
  const path = textParameter(params, PATH_PARAMETER)?.trim()
  return path ? path : undefined
}

export const isEnvFile = (path: string): boolean => {
  const name = basename(path.trim()).toLowerCase()
  return name.endsWith(ENV_FILE_NAME) || name.startsWith(`${ENV_FILE_NAME}.`)
}

const withEnvValuesHidden = (text: string): string => text.replace(ENV_ASSIGNMENT, `$1${HIDDEN_VALUE}`)

const sendableText = (text: string, hidesEnvValues: boolean): string => {
  const visible = withHiddenCharactersShown(text)
  return redactSecretsDeep(hidesEnvValues ? withEnvValuesHidden(visible) : visible)
}

const sendablePath = (path: string): string => redactSecrets(withHiddenCharactersShown(path))

const lineCountOf = (text: string): number => {
  if (text.length === 0) return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

const prefixedLines = (text: string, prefix: string): string =>
  text.split('\n').map(line => `${prefix}${line}`).join('\n')

const textEditOf = (value: unknown): TextEdit | null => {
  if (!isRecord(value)) return null
  const oldText = textParameter(value, OLD_TEXT_PARAMETER)
  const newText = textParameter(value, NEW_TEXT_PARAMETER)
  return oldText === undefined || newText === undefined ? null : { oldText, newText }
}

const textEditsOf = (params: Readonly<Record<string, unknown>>): readonly TextEdit[] | null => {
  const listed = params[EDITS_PARAMETER]
  const candidates: readonly unknown[] = Array.isArray(listed) ? listed : [params]
  const edits: TextEdit[] = []
  for (const candidate of candidates) {
    const edit = textEditOf(candidate)
    if (edit === null) return null
    edits.push(edit)
  }
  return edits.length > 0 ? edits : null
}

const writePreviewOf = (params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  const path = pathParameter(params)
  const content = textParameter(params, CONTENT_PARAMETER)
  if (path === undefined || content === undefined) return null
  const shownPath = sendablePath(path)
  return {
    operation: 'write',
    paths: [shownPath],
    body: `Write ${shownPath}, ${plural(lineCountOf(content), 'line')}:\n\n${sendableText(content, isEnvFile(path))}`,
  }
}

const shownEdit = (edit: TextEdit, hidesEnvValues: boolean): string =>
  [prefixedLines(sendableText(edit.oldText, hidesEnvValues), REMOVED_LINE_PREFIX), prefixedLines(sendableText(edit.newText, hidesEnvValues), ADDED_LINE_PREFIX)].join('\n')

const editPreviewOf = (params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  const path = pathParameter(params)
  const edits = textEditsOf(params)
  if (path === undefined || edits === null) return null
  const shownPath = sendablePath(path)
  const hidesEnvValues = isEnvFile(path)
  return {
    operation: 'edit',
    paths: [shownPath],
    body: `Edit ${shownPath}, ${plural(edits.length, 'change')}:\n\n${edits.map(edit => shownEdit(edit, hidesEnvValues)).join('\n\n')}`,
  }
}

const patchPreviewOf = (params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  const patch = textParameter(params, PATCH_PARAMETER)
  if (patch === undefined) return null
  const targets = patchTargetsOf(patch)
  if (targets.length === 0) return null
  return {
    operation: 'patch',
    paths: targets.map(sendablePath),
    body: sendableText(patch, targets.some(isEnvFile)),
  }
}

export const fileChangePreviewOf = (toolId: string, params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  if (toolId === WRITE_TOOL) return writePreviewOf(params)
  if (toolId === EDIT_TOOL) return editPreviewOf(params)
  if (toolId === APPLY_PATCH_TOOL) return patchPreviewOf(params)
  return null
}
