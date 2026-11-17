import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRecord } from './parameter-redaction.js'
import { columnZeroTargetsOf, patchHunksOf, patchTextOf, type PatchHunk } from './patch-hunks.js'
import { APPLY_PATCH_TOOL, EDIT_TOOL, isPlainPath, patchTargetsOf, withoutHostArgumentTails, WRITE_TOOL } from './protected-writes.js'
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
const ENV_ASSIGNMENT_LINE = /^[ \t]*(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(?:(?:"[^"\\]*"|'[^'\\]*'|`[^`\\]*`)[ \t]*(?:#.*)?|[^"'`\\\s][^"'`\\]*)?$/
const WINDOWS_STREAM_SEPARATOR = ':'
const WINDOWS_TRAILING_DOTS_AND_SPACES = /[. ]+$/
const FILE_URL_PREFIX = 'file://'
const ENV_VALUE_HIDDEN = '[value not sent]'
const ENV_EDIT_HIDDEN = '[dotenv change contents not sent]'
const ENV_FILE_NAME_HIDDEN = '[dotenv file name not sent]'
const DOTENV_MENTION = /\.env/i
const REMOVED_LINE_PREFIX = '- '
const ADDED_LINE_PREFIX = '+ '

const textParameter = (params: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = params[name]
  return typeof value === 'string' ? value : undefined
}

const pathAsWrittenOf = (params: Readonly<Record<string, unknown>>): string | undefined => textParameter(params, PATH_PARAMETER)

const pathParameter = (params: Readonly<Record<string, unknown>>): string | undefined => {
  const path = textParameter(params, PATH_PARAMETER)?.trim()
  return path ? path : undefined
}

const mayWriteEnvFile = (params: Readonly<Record<string, unknown>>): boolean => {
  const path = pathAsWrittenOf(params)
  return path !== undefined && mayBeEnvFile(path)
}

const fileUrlPathOf = (url: string): string => {
  try {
    return fileURLToPath(url)
  } catch {
    return url
  }
}

const isEnvFileName = (name: string): boolean => {
  const windowsName = name.replace(WINDOWS_TRAILING_DOTS_AND_SPACES, '')
  return windowsName.endsWith(ENV_FILE_NAME) || windowsName.startsWith(`${ENV_FILE_NAME}.`)
}

const isEnvFileOrStreamName = (name: string): boolean => {
  const [nameBeforeStream = name] = name.split(WINDOWS_STREAM_SEPARATOR)
  return isEnvFileName(name) || isEnvFileName(nameBeforeStream)
}

const resolvedFileNamesOf = (path: string): readonly string[] =>
  [win32.basename(win32.normalize(path)), posix.basename(posix.normalize(path))].map(name => name.toLowerCase())

const isFileUrl = (path: string): boolean => path.slice(0, FILE_URL_PREFIX.length).toLowerCase() === FILE_URL_PREFIX

const spellingsOf = (path: string): readonly string[] => {
  const referenced = withoutHostArgumentTails(path.trim().replace(/^@/, ''))
  return isFileUrl(referenced) ? [referenced, fileUrlPathOf(referenced)] : [referenced]
}

export const isEnvFile = (path: string): boolean => spellingsOf(path).flatMap(resolvedFileNamesOf).some(isEnvFileOrStreamName)

const mayBeEnvFile = (path: string): boolean => !isPlainPath(path) || isEnvFile(path)

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

interface ShownPatch {
  readonly paths: readonly string[]
  readonly body: string
}

const mentionsEnvFile = (text: string): boolean => patchTargetsOf(text).some(mayBeEnvFile)

const mentionsDotenv = (text: string): boolean => DOTENV_MENTION.test(text) || mentionsEnvFile(text)

const isEnvHunk = (hunk: PatchHunk): boolean => hunk.targets.some(mayBeEnvFile) || hunk.body.some(mentionsEnvFile)

const movesAnEnvFile = (hunk: PatchHunk): boolean => hunk.targets.length > 1 && hunk.targets.some(mayBeEnvFile)

const withheldHunkLinesOf = (hunk: PatchHunk): readonly string[] =>
  hunk.body.length === 0 ? hunk.headers : [...hunk.headers, ENV_EDIT_HIDDEN]

const shownHunkLinesOf = (hunk: PatchHunk): readonly string[] =>
  isEnvHunk(hunk) ? withheldHunkLinesOf(hunk) : [...hunk.headers, ...hunk.body]

const shownPatchBodyOf = (patch: string, hunks: readonly PatchHunk[]): string => {
  if (hunks.some(movesAnEnvFile)) return patchTextOf(hunks.flatMap(withheldHunkLinesOf))
  return hunks.some(isEnvHunk) ? patchTextOf(hunks.flatMap(shownHunkLinesOf)) : patch
}

const uniqueTargets = (targets: readonly string[]): readonly string[] => [...new Set(targets)]

const namedOrHidden = (targets: readonly string[]): readonly string[] =>
  targets.length === 0 ? [ENV_FILE_NAME_HIDDEN] : uniqueTargets(targets)

const unparsedPatchOf = (patch: string): ShownPatch =>
  mentionsDotenv(patch)
    ? { paths: namedOrHidden(columnZeroTargetsOf(patch)), body: ENV_EDIT_HIDDEN }
    : { paths: uniqueTargets(patchTargetsOf(patch)), body: patch }

const shownPatchOf = (patch: string): ShownPatch => {
  const hunks = patchHunksOf(patch)
  if (hunks === null) return unparsedPatchOf(patch)
  const paths = uniqueTargets(hunks.flatMap(hunk => hunk.targets))
  return { paths, body: shownPatchBodyOf(patch, hunks) }
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
    operation: WRITE_OPERATION,
    paths: [shownPath],
    body: `Write ${shownPath}, ${plural(lineCountOf(content), 'line')}:\n\n${sendableText(mayWriteEnvFile(params) ? envNamesOnly(content) : content)}`,
  }
}

const shownEdit = (edit: TextEdit): string =>
  [prefixedLines(sendableText(edit.oldText), REMOVED_LINE_PREFIX), prefixedLines(sendableText(edit.newText), ADDED_LINE_PREFIX)].join('\n')

const editPreviewOf = (params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  const path = pathParameter(params)
  const edits = textEditsOf(params)
  if (path === undefined || edits === null) return null
  const shownPath = sendablePath(path)
  const changes = mayWriteEnvFile(params) ? ENV_EDIT_HIDDEN : edits.map(shownEdit).join('\n\n')
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
  const shown = shownPatchOf(patch)
  return { operation: PATCH_OPERATION, paths: shown.paths.map(sendablePath), body: sendableText(shown.body) }
}

const readablePreviewOf = (toolId: string, params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  if (toolId === WRITE_TOOL) return writePreviewOf(params)
  if (toolId === EDIT_TOOL) return editPreviewOf(params)
  if (toolId === APPLY_PATCH_TOOL) return patchPreviewOf(params)
  return null
}

const FILE_CHANGE_OPERATIONS: ReadonlyMap<string, FileChangeOperation> = new Map<string, FileChangeOperation>([
  [WRITE_TOOL, WRITE_OPERATION],
  [EDIT_TOOL, EDIT_OPERATION],
  [APPLY_PATCH_TOOL, PATCH_OPERATION],
])

const stringsIn = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  return isRecord(value) ? Object.entries(value).flatMap(([key, entry]) => [key, ...stringsIn(entry)]) : []
}

const declaredTargetsOf = (toolId: string, params: Readonly<Record<string, unknown>>): readonly string[] => {
  if (toolId === APPLY_PATCH_TOOL) return stringsIn(params).flatMap(columnZeroTargetsOf)
  const path = pathParameter(params)
  return path === undefined ? [] : [path]
}

const declaresEnvChange = (toolId: string, params: Readonly<Record<string, unknown>>): boolean => {
  const path = toolId === APPLY_PATCH_TOOL ? undefined : pathParameter(params)
  return path === undefined ? stringsIn(params).some(mentionsDotenv) : mayWriteEnvFile(params)
}

const withheldEnvChangeOf = (toolId: string, params: Readonly<Record<string, unknown>>): FileChangePreview | null => {
  const operation = FILE_CHANGE_OPERATIONS.get(toolId)
  if (operation === undefined || !declaresEnvChange(toolId, params)) return null
  return { operation, paths: namedOrHidden(declaredTargetsOf(toolId, params)).map(sendablePath), body: ENV_EDIT_HIDDEN }
}

export const fileChangePreviewOf = (toolId: string, params: Readonly<Record<string, unknown>>): FileChangePreview | null =>
  readablePreviewOf(toolId, params) ?? withheldEnvChangeOf(toolId, params)
