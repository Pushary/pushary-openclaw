export interface PatchHunk {
  readonly headers: readonly string[]
  readonly targets: readonly string[]
  readonly body: readonly string[]
}

const BEGIN_PATCH = '*** Begin Patch'
const END_PATCH = '*** End Patch'
const HEREDOC_OPENINGS: readonly string[] = ['<<EOF', "<<'EOF'", '<<"EOF"']
const HEREDOC_CLOSING = 'EOF'
const HEREDOC_MINIMUM_LINES = 4
const ADD_FILE = '*** Add File: '
const DELETE_FILE = '*** Delete File: '
const UPDATE_FILE = '*** Update File: '
export const PATCH_MOVE_MARKER = '*** Move to: '
export const PATCH_FILE_MARKERS: readonly string[] = [ADD_FILE, DELETE_FILE, UPDATE_FILE]
export const PATCH_MARKER_PREFIX = '***'
const END_OF_FILE = '*** End of File'
const ADDED_LINE = '+'
const CHANGE_CONTEXT = '@@'
const CHANGE_CONTEXT_PREFIX = '@@ '
const CHANGE_LINE_MARKERS: readonly string[] = [' ', '+', '-']
const PATCH_LINES = /\r?\n/
const PATCH_LINE_BREAK = '\n'

const withoutHeredoc = (lines: readonly string[]): readonly string[] => {
  const first = lines[0]
  const last = lines.at(-1)
  const wrapped = lines.length >= HEREDOC_MINIMUM_LINES && first !== undefined && last !== undefined
    && HEREDOC_OPENINGS.includes(first) && last.endsWith(HEREDOC_CLOSING)
  return wrapped ? lines.slice(1, -1) : lines
}

const hunkLinesOf = (patch: string): readonly string[] | null => {
  const lines = withoutHeredoc(patch.trim().split(PATCH_LINES))
  return lines[0]?.trim() === BEGIN_PATCH && lines.at(-1)?.trim() === END_PATCH ? lines.slice(1, -1) : null
}

const hunkMarkerOf = (header: string): string | undefined => PATCH_FILE_MARKERS.find(marker => header.startsWith(marker))

const moveHeaderOf = (line: string | undefined): string | null => {
  const header = line?.trim()
  return header?.startsWith(PATCH_MOVE_MARKER) ? header : null
}

const isChangeLine = (line: string): boolean => line === '' || CHANGE_LINE_MARKERS.includes(line.charAt(0))

const opensWithContext = (line: string | undefined): boolean => line === CHANGE_CONTEXT || line?.startsWith(CHANGE_CONTEXT_PREFIX) === true

const chunkEndOf = (lines: readonly string[], start: number, isFirstChunk: boolean): number | null => {
  const hasContext = opensWithContext(lines[start])
  if (!hasContext && !isFirstChunk) return null
  const changesStart = start + (hasContext ? 1 : 0)
  if (changesStart >= lines.length || lines[changesStart] === END_OF_FILE) return null
  for (let end = changesStart; end < lines.length; end += 1) {
    const line = lines[end] ?? ''
    if (line === END_OF_FILE) return end + 1
    if (!isChangeLine(line)) return end === changesStart ? null : end
  }
  return lines.length
}

const updateBodyEndOf = (lines: readonly string[], start: number): number | null => {
  let offset = start
  let chunks = 0
  while (offset < lines.length) {
    const line = lines[offset] ?? ''
    if (line.trim() === '') {
      offset += 1
      continue
    }
    if (line.startsWith(PATCH_MARKER_PREFIX)) break
    const end = chunkEndOf(lines, offset, chunks === 0)
    if (end === null) return null
    offset = end
    chunks += 1
  }
  return chunks === 0 ? null : offset
}

const addBodyEndOf = (lines: readonly string[], start: number): number => {
  const end = lines.findIndex((line, index) => index >= start && !line.startsWith(ADDED_LINE))
  return end === -1 ? lines.length : end
}

const bodyEndOf = (marker: string, lines: readonly string[], start: number): number | null => {
  if (marker === DELETE_FILE) return start
  return marker === ADD_FILE ? addBodyEndOf(lines, start) : updateBodyEndOf(lines, start)
}

export const patchHunksOf = (patch: string): readonly PatchHunk[] | null => {
  const lines = hunkLinesOf(patch)
  if (lines === null) return null
  const hunks: PatchHunk[] = []
  let offset = 0
  while (offset < lines.length) {
    const header = lines[offset]?.trim() ?? ''
    const marker = hunkMarkerOf(header)
    if (marker === undefined) return null
    const moveHeader = marker === UPDATE_FILE ? moveHeaderOf(lines[offset + 1]) : null
    const headers = moveHeader === null ? [header] : [header, moveHeader]
    const bodyStart = offset + headers.length
    const bodyEnd = bodyEndOf(marker, lines, bodyStart)
    if (bodyEnd === null) return null
    const targets = [header.slice(marker.length), ...(moveHeader === null ? [] : [moveHeader.slice(PATCH_MOVE_MARKER.length)])]
    hunks.push({ headers, targets, body: lines.slice(bodyStart, bodyEnd) })
    offset = bodyEnd
  }
  return hunks
}

export const patchTextOf = (hunkLines: readonly string[]): string => [BEGIN_PATCH, ...hunkLines, END_PATCH].join(PATCH_LINE_BREAK)

const COLUMN_ZERO_TARGET_MARKERS: readonly string[] = [...PATCH_FILE_MARKERS, PATCH_MOVE_MARKER]

const columnZeroTargetOf = (line: string): readonly string[] => {
  const marker = COLUMN_ZERO_TARGET_MARKERS.find(candidate => line.startsWith(candidate))
  return marker === undefined ? [] : [line.trim().slice(marker.length)]
}

export const columnZeroTargetsOf = (patch: string): readonly string[] => patch.split(PATCH_LINES).flatMap(columnZeroTargetOf)
