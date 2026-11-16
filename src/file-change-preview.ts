import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRecord } from './parameter-redaction.js'
import { APPLY_PATCH_TOOL, EDIT_TOOL, patchTargetsOf, WRITE_TOOL } from './protected-writes.js'
import { redactSecrets, redactSecretsDeep } from './redaction.js'
import { withHiddenCharactersShown } from './visible-text.js'

export const WRITE_OPERATION = 'write'
export const EDIT_OPERATION = 'edit'
export const PATCH_OPERATION = 'patch'
export type FileChangeOperation = typeof WRITE_OPERATION | typeof EDIT_OPERATION | typeof PATCH_OPERATION

export interface FileChangePreview {
  readonly operation: FileChangeOperation
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
const PATCH_PARAMETERS: readonly string[] = ['input', 'command']
const OLD_TEXT_PARAMETER = 'oldText'
const NEW_TEXT_PARAMETER = 'newText'
const ENV_FILE_NAME = '.env'
const ENV_BLANK_OR_COMMENT_LINE = /^[ \t]*(?:#.*)?$/
const ENV_ASSIGNMENT_LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(?:(?:"[^"]*"|'[^']*'|`[^`]*`)[ \t]*(?:#.*)?|[^"'`\s].*)?$/
const WINDOWS_STREAM_SEPARATOR = ':'
const ENV_VALUE_HIDDEN = '[value not sent]'
const ENV_EDIT_HIDDEN = '[dotenv change contents not sent]'
const PATCH_FILE_START = /(?=^[ \t]*\*\*\* (?:Add|Delete|Update) File: )/m
const PATCH_END = '*** End Patch'
const REMOVED_LINE_PREFIX = '- '
const ADDED_LINE_PREFIX = '+ '

const textParameter = (params: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = params[name]
  return typeof value === 'string' ? value : undefined
}

const pathParameter = (params: Readonly<Record<string, unknown>>): string | undefined => {
  const path = textParameter(params, PATH_PARAMETER)?.trim()
  return path ? path : undefined
}

const fileUrlPathOf = (url: string): string => {
  try {
    return fileURLToPath(url)
  } catch {
    return url
  }
}

const isEnvFileName = (name: string): boolean => name.endsWith(ENV_FILE_NAME) || name.startsWith(`${ENV_FILE_NAME}.`)

export const isEnvFile = (path: string): boolean => {
  const referenced = path.trim().replace(/^@/, '')
  const resolved = referenced.startsWith('file://') ? fileUrlPathOf(referenced) : referenced
  const name = win32.basename(resolved).toLowerCase()
  const [nameBeforeStream = name] = name.split(WINDOWS_STREAM_SEPARATOR)
  return isEnvFileName(name) || isEnvFileName(nameBeforeStream)
}

const sendableText = (text: string): string => redactSecretsDeep(withHiddenCharactersShown(text))

const isEnvBlankOrComment = (line: string): boolean => ENV_BLANK_OR_COMMENT_LINE.test(line)

const assignedEnvNameOf = (line: string): string | null => ENV_ASSIGNMENT_LINE.exec(line)?.[1] ?? null

const isEnvName = (name: string | null): name is string => name !== null

const envNamesOnly = (content: string): string => {
  const lines = content.split(/\r?\n/).filter(line => !isEnvBlankOrComment(line))
  const names = lines.map(assignedEnvNameOf).filter(isEnvName)
  if (names.length === 0 || names.length !== lines.length) return ENV_EDIT_HIDDEN
  return [...new Set(names)].sort().map(name => `${name}=${ENV_VALUE_HIDDEN}`).join('\n')
}

const isPatchPathHeader = (line: string): boolean => patchTargetsOf(line).length > 0

const withoutEnvPatchContents = (patch: string): string =>
  patch.split(PATCH_FILE_START).map(section => {
    if (!patchTargetsOf(section).some(isEnvFile)) return section
    const headers = section.split(/\r?\n/).filter(isPatchPathHeader)
    const end = section.trimEnd().endsWith(PATCH_END) ? [PATCH_END] : []
    return [...headers, ENV_EDIT_HIDDEN, ...end, ''].join('\n')
  }).join('')

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
    operation: WRITE_OPERATION,
    paths: [shownPath],
    body: `Write ${shownPath}, ${plural(lineCountOf(content), 'line')}:\n\n${sendableText(isEnvFile(path) ? envNamesOnly(content) : content)}`,
  }
}

const shownEdit = (edit: TextEdit): string =>
  [prefixedLines(sendableText(edit.oldText), REMOVED_LINE_PREFIX), prefixedLines(sendableText(edit.newText), ADDED_LINE_PREFIX)].join('\n')

const editPreviewOf = (params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  const path = pathParameter(params)
  const edits = textEditsOf(params)
  if (path === undefined || edits === null) return null
  const shownPath = sendablePath(path)
  const changes = isEnvFile(path) ? ENV_EDIT_HIDDEN : edits.map(shownEdit).join('\n\n')
  return {
    operation: EDIT_OPERATION,
    paths: [shownPath],
    body: `Edit ${shownPath}, ${plural(edits.length, 'change')}:\n\n${changes}`,
  }
}

const hasPatchTargets = (text: string | undefined): text is string => text !== undefined && patchTargetsOf(text).length > 0

const patchPreviewOf = (params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  const patch = PATCH_PARAMETERS.map(name => textParameter(params, name)).find(hasPatchTargets)
  if (patch === undefined) return null
  const targets = patchTargetsOf(patch)
  return {
    operation: PATCH_OPERATION,
    paths: targets.map(sendablePath),
    body: sendableText(targets.some(isEnvFile) ? withoutEnvPatchContents(patch) : patch),
  }
}

const readablePreviewOf = (toolId: string, params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  if (toolId === WRITE_TOOL) return writePreviewOf(params)
  if (toolId === EDIT_TOOL) return editPreviewOf(params)
  if (toolId === APPLY_PATCH_TOOL) return patchPreviewOf(params)
  return null
}

const PATH_CHANGE_OPERATIONS: ReadonlyMap<string, FileChangeOperation> = new Map<string, FileChangeOperation>([
  [WRITE_TOOL, WRITE_OPERATION],
  [EDIT_TOOL, EDIT_OPERATION],
])

const withheldEnvChangeOf = (toolId: string, params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  const operation = PATH_CHANGE_OPERATIONS.get(toolId)
  const path = pathParameter(params)
  return operation === undefined || path === undefined || !isEnvFile(path) ? null : { operation, paths: [sendablePath(path)], body: ENV_EDIT_HIDDEN }
}

export const fileChangePreviewOf = (toolId: string, params: Readonly<Record<string, unknown>>): FileChangePreview | null =>
  readablePreviewOf(toolId, params) ?? withheldEnvChangeOf(toolId, params)
