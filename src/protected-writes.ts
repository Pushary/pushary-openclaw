import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpenClawBeforeToolCallEvent } from './host-api.js'
import { PATCH_FILE_MARKERS, PATCH_MARKER_PREFIX, PATCH_MOVE_MARKER } from './patch-hunks.js'

export const WRITE_TOOL = 'write'
export const EDIT_TOOL = 'edit'
export const APPLY_PATCH_TOOL = 'apply_patch'
export const FILE_WRITING_TOOLS: readonly string[] = [WRITE_TOOL, EDIT_TOOL, APPLY_PATCH_TOOL]

const PATH_PARAMETER = 'path'
const PATCH_PARAMETER = 'input'
const PATCH_TARGET_MARKERS: readonly string[] = [...PATCH_FILE_MARKERS, PATCH_MOVE_MARKER]
const FILE_URL_PREFIX = 'file://'
const HOST_PATH_ARGUMENT_TAILS = /(?:<\/arg_value>>+\s*)+$/
const NOT_PLAIN_PATH_CHARACTER = /[\u0000-\u001f\u007f%?#<>|*"]/
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/
const PATH_SCHEME_SEPARATOR = ':'
const FILE_REFERENCE_PREFIX = '@'
const HOME_PREFIX = '~'
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])
const WORKSPACE_HOOKS_DIRECTORY = 'hooks'
const WORKSPACE_OPENCLAW_DIRECTORY = '.openclaw'
const WORKSPACE_FOLDERS_OPENCLAW_LOADS: readonly string[] = [WORKSPACE_HOOKS_DIRECTORY, WORKSPACE_OPENCLAW_DIRECTORY]
const RISKY_RELATIVE_STARTS: readonly string[] = ['.pushary', '.config']

export interface ServiceFileLocation {
  readonly directory: string
  readonly namePrefix: string
}

export interface OpenClawStateLocations {
  readonly stateDirectories: readonly string[]
  readonly configFiles: readonly string[]
  readonly protectedTrees: readonly string[]
  readonly serviceFiles: readonly ServiceFileLocation[]
}

export interface WriteGuardSystem {
  readonly osHome: string
  readonly openClawHome: string
  readonly realpath: (path: string) => string
  readonly mayBeSymbolicLink: (path: string) => boolean
  readonly hasOtherNames: (path: string) => boolean
  readonly caseInsensitive: boolean
  readonly workspaceFor: (agentId: string | undefined) => string | null
  readonly otherWorkingDirectories: readonly string[]
}

export interface FileWriteCall {
  readonly toolId: string
  readonly event: OpenClawBeforeToolCallEvent
  readonly agentId: string | undefined
}

type PathVerdict = 'protected' | 'clear' | 'uncertain'

interface ComparablePaths {
  readonly stateDirectories: readonly string[]
  readonly configFiles: readonly string[]
  readonly protectedTrees: readonly string[]
  readonly serviceFiles: readonly ServiceFileLocation[]
  readonly workspace: string | null
  readonly workspaceSpellings: readonly string[]
  readonly workspaceFoldersOpenClawLoads: readonly string[]
  readonly riskyRelativeStarts: ReadonlySet<string>
  readonly locationsFoldAsTheDiskDoes: boolean
}

const errorCodeOf = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null

const canonicalPathOf = (path: string, system: WriteGuardSystem): string | null => {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      const real = system.realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch (error) {
      const code = errorCodeOf(error)
      const parent = dirname(current)
      if (code === null || !MISSING_PATH_CODES.has(code) || parent === current || system.mayBeSymbolicLink(current)) return null
      missing.push(basename(current))
      current = parent
    }
  }
}

const DOTLESS_I = 'ı'

const caseFoldedCharacter = (character: string): string =>
  character === DOTLESS_I ? character : character.toLowerCase().toUpperCase().toLowerCase()

const caseFolded = (path: string): string => Array.from(path.normalize('NFD'), caseFoldedCharacter).join('').normalize('NFC')

const comparable = (path: string, system: WriteGuardSystem): string =>
  system.caseInsensitive ? caseFolded(path) : path.normalize('NFC')

const CHARACTERS_THE_RUNTIME_CANNOT_FOLD = /[\p{Cn}\p{Cs}]/u
const IOTA_SUBSCRIPTS_ON_ONE_LETTER = /ͅ\p{M}*ͅ/u

const foldsAsTheDiskDoes = (path: string): boolean =>
  !CHARACTERS_THE_RUNTIME_CANNOT_FOLD.test(path) && !IOTA_SUBSCRIPTS_ON_ONE_LETTER.test(path.normalize('NFD'))

const spellingsOfLocation = (path: string, system: WriteGuardSystem): readonly string[] => {
  const canonical = canonicalPathOf(path, system)
  const resolved = comparable(resolve(path), system)
  return canonical === null ? [resolved] : [...new Set([comparable(canonical, system), resolved])]
}

const spellingsOfAll = (paths: readonly string[], system: WriteGuardSystem): readonly string[] =>
  [...new Set(paths.flatMap(path => spellingsOfLocation(path, system)))]

const isSameOrInside = (path: string, directory: string): boolean =>
  path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`)

const isStrictlyInside = (path: string, directory: string): boolean => path !== directory && isSameOrInside(path, directory)

const firstComponentUnder = (path: string, directory: string): string | null => {
  if (!isStrictlyInside(path, directory)) return null
  return relative(directory, path).split(sep)[0] ?? null
}

const locationSpellingsOf = (locations: OpenClawStateLocations, system: WriteGuardSystem, workspace: string | null): readonly string[] => {
  const places = [...locations.stateDirectories, ...locations.configFiles, ...locations.protectedTrees, ...locations.serviceFiles.map(location => location.directory), ...system.otherWorkingDirectories]
  if (workspace !== null) places.push(workspace)
  return [...places.flatMap(place => [place, canonicalPathOf(place, system) ?? '']), ...locations.serviceFiles.map(location => location.namePrefix)]
}

const comparablePathsFor = (locations: OpenClawStateLocations, system: WriteGuardSystem, agentId: string | undefined): ComparablePaths => {
  const stateDirectories = spellingsOfAll(locations.stateDirectories, system)
  const workspace = system.workspaceFor(agentId)
  const workspaceCanonical = workspace === null ? null : canonicalPathOf(workspace, system)
  const comparableWorkspace = workspaceCanonical === null ? null : comparable(workspaceCanonical, system)
  return {
    locationsFoldAsTheDiskDoes: !system.caseInsensitive || locationSpellingsOf(locations, system, workspace).every(foldsAsTheDiskDoes),
    stateDirectories,
    configFiles: spellingsOfAll(locations.configFiles, system),
    protectedTrees: spellingsOfAll(locations.protectedTrees, system),
    serviceFiles: locations.serviceFiles.flatMap(location =>
      spellingsOfLocation(location.directory, system).map(directory => ({ directory, namePrefix: comparable(location.namePrefix, system) }))),
    workspace: comparableWorkspace,
    workspaceSpellings: workspace === null || comparableWorkspace === null ? [] : [...new Set([comparableWorkspace, resolve(workspace)])],
    workspaceFoldersOpenClawLoads: WORKSPACE_FOLDERS_OPENCLAW_LOADS.map(folder => comparable(folder, system)),
    riskyRelativeStarts: new Set([
      ...locations.stateDirectories.map(state => comparable(basename(state), system)),
      ...locations.configFiles.map(file => comparable(basename(file), system)),
      ...RISKY_RELATIVE_STARTS.map(start => comparable(start, system)),
    ]),
  }
}

const isServiceFile = (path: string, services: readonly ServiceFileLocation[]): boolean =>
  services.some(service => firstComponentUnder(path, service.directory)?.startsWith(service.namePrefix) === true)

const isInAWorkspaceFolderOpenClawLoads = (path: string, paths: ComparablePaths): boolean => {
  if (paths.workspace === null) return false
  const component = firstComponentUnder(path, paths.workspace)
  return component !== null && paths.workspaceFoldersOpenClawLoads.includes(component)
}

const isInWorkspaceUnderState = (path: string, paths: ComparablePaths): boolean => {
  const { workspace } = paths
  if (workspace === null || !isSameOrInside(path, workspace)) return false
  return paths.stateDirectories.some(state => isStrictlyInside(workspace, state))
}

const isProtectedLocation = (path: string, paths: ComparablePaths): boolean => {
  if (paths.configFiles.includes(path)) return true
  if (paths.protectedTrees.some(tree => isSameOrInside(path, tree))) return true
  if (isServiceFile(path, paths.serviceFiles)) return true
  if (isInAWorkspaceFolderOpenClawLoads(path, paths)) return true
  if (!paths.stateDirectories.some(state => isSameOrInside(path, state))) return false
  return !isInWorkspaceUnderState(path, paths)
}

const foldCanBeTrustedFor = (path: string, paths: ComparablePaths, system: WriteGuardSystem): boolean =>
  !system.caseInsensitive || (paths.locationsFoldAsTheDiskDoes && foldsAsTheDiskDoes(path))

const verdictForAbsolute = (path: string, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  const canonical = canonicalPathOf(path, system)
  if (canonical === null || system.hasOtherNames(canonical) || !foldCanBeTrustedFor(canonical, paths, system)) return 'uncertain'
  return isProtectedLocation(comparable(canonical, system), paths) ? 'protected' : 'clear'
}

const firstComponentOf = (relativePath: string): string => normalize(relativePath).split(/[\\/]/).find(part => part.length > 0) ?? ''

const expandedHome = (path: string, osHome: string): string =>
  path === HOME_PREFIX || path.startsWith(`${HOME_PREFIX}/`) || (process.platform === 'win32' && path.startsWith(`${HOME_PREFIX}\\`))
    ? join(osHome, path.slice(HOME_PREFIX.length))
    : path

const spellingsOf = (raw: string): readonly string[] => {
  if (!raw.startsWith(FILE_REFERENCE_PREFIX)) return [raw]
  const referenced = raw.slice(FILE_REFERENCE_PREFIX.length)
  return [referenced.startsWith(FILE_REFERENCE_PREFIX) ? `./${referenced}` : referenced, `./${raw}`]
}

const isFileUrlSpelling = (spelling: string): boolean => spelling.slice(0, FILE_URL_PREFIX.length).toLowerCase() === FILE_URL_PREFIX

const decodedFileUrlOf = (spelling: string): string | null => {
  try {
    return fileURLToPath(spelling)
  } catch {
    return null
  }
}

const absoluteOrRelative = (spelling: string, osHome: string): string | null =>
  isFileUrlSpelling(spelling) ? decodedFileUrlOf(spelling) : expandedHome(spelling, osHome)

const worstOf = (verdicts: readonly PathVerdict[]): PathVerdict => {
  if (verdicts.includes('protected')) return 'protected'
  if (verdicts.length === 0 || verdicts.includes('uncertain')) return 'uncertain'
  return 'clear'
}

const PARENT_SEGMENT = '..'

const leadingClimbsOf = (relativePath: string): number => {
  const parts = normalize(relativePath).split(/[\\/]/)
  const firstOther = parts.findIndex(part => part !== PARENT_SEGMENT)
  return firstOther === -1 ? parts.length : firstOther
}

const ancestorsUpTo = (directory: string, levels: number): readonly string[] => {
  const ancestors = [directory]
  for (let level = 0; level < levels; level += 1) ancestors.push(dirname(ancestors[ancestors.length - 1] ?? directory))
  return ancestors
}

const landingPlacesOf = (relativePath: string, workspaces: readonly string[], others: readonly string[]): readonly string[] => {
  const climbs = leadingClimbsOf(relativePath)
  const rest = normalize(relativePath).split(/[\\/]/).slice(climbs).join(sep)
  const fromInsideTheWorkspace = workspaces.flatMap(workspace => ancestorsUpTo(workspace, climbs).map(base => join(base, rest)))
  return [...fromInsideTheWorkspace, ...[...workspaces, ...others].map(directory => resolve(directory, relativePath))]
}

const verdictForPath = (path: string, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  if (isAbsolute(path)) return verdictForAbsolute(path, paths, system)
  if (paths.riskyRelativeStarts.has(comparable(firstComponentOf(path), system))) return 'protected'
  if (paths.workspace === null) return 'uncertain'
  return worstOf(landingPlacesOf(path, paths.workspaceSpellings, system.otherWorkingDirectories).map(place => verdictForAbsolute(place, paths, system)))
}

export const withoutHostArgumentTails = (path: string): string => path.replace(HOST_PATH_ARGUMENT_TAILS, '').trim()

export const isPlainPath = (path: string): boolean => {
  if (path !== path.trim()) return false
  const rest = path.replace(WINDOWS_DRIVE_PREFIX, '')
  return !NOT_PLAIN_PATH_CHARACTER.test(rest) && !rest.includes(PATH_SCHEME_SEPARATOR)
}

const verdictForSpelling = (spelling: string, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  const path = expandedHome(spelling, system.osHome)
  return path.trim().length === 0 ? 'uncertain' : verdictForPath(path, paths, system)
}

const verdictForRawPath = (raw: unknown, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  if (typeof raw !== 'string' || raw.trim().length === 0 || !isPlainPath(raw)) return 'uncertain'
  return worstOf(spellingsOf(raw).map(spelling => verdictForSpelling(spelling, paths, system)))
}

const patchTargetOf = (line: string): string | null => {
  const header = line.trimStart()
  if (!header.startsWith(PATCH_MARKER_PREFIX)) return null
  const trimmed = header.trimEnd()
  const marker = PATCH_TARGET_MARKERS.find(candidate => trimmed.startsWith(candidate))
  return marker === undefined ? null : trimmed.slice(marker.length)
}

export const patchTargetsOf = (patch: unknown): readonly string[] =>
  typeof patch === 'string' ? patch.split(/\r?\n/).flatMap(line => {
    const target = patchTargetOf(line)
    return target === null ? [] : [target]
  }) : []

const hostResolvedPathsOf = (event: OpenClawBeforeToolCallEvent): readonly unknown[] =>
  Array.isArray(event.derivedPaths) ? event.derivedPaths : []

const rawTargetsOf = (toolId: string, event: OpenClawBeforeToolCallEvent): readonly unknown[] | null => {
  if (toolId === APPLY_PATCH_TOOL) {
    const targets = [...patchTargetsOf(event.params[PATCH_PARAMETER]), ...hostResolvedPathsOf(event)]
    return targets.length === 0 ? null : targets
  }
  return [event.params[PATH_PARAMETER]]
}

export const writesIntoOpenClaw = (locations: OpenClawStateLocations, system: WriteGuardSystem, call: FileWriteCall): boolean => {
  if (!FILE_WRITING_TOOLS.includes(call.toolId)) return false
  const targets = rawTargetsOf(call.toolId, call.event)
  if (targets === null) return true
  const paths = comparablePathsFor(locations, system, call.agentId)
  return targets.some(target => verdictForRawPath(target, paths, system) !== 'clear')
}

export const SESSIONS_SPAWN_TOOL = 'sessions_spawn'
export const SPAWN_FOLDER_PARAMETER = 'cwd'
const SPAWN_SOURCES_IT_CANNOT_SEE: readonly string[] = ['projectId', 'projectGitUrl', 'worktree']

const SPAWN_RUNTIME_PARAMETER = 'runtime'
const ACP_RUNTIME = 'acp'

export const startsAnAcpSession = (params: Readonly<Record<string, unknown>>): boolean => {
  const runtime = params[SPAWN_RUNTIME_PARAMETER]
  return typeof runtime === 'string' && runtime.trim().toLowerCase() === ACP_RUNTIME
}

const namesAFolderItCannotSee = (params: Readonly<Record<string, unknown>>): boolean =>
  SPAWN_SOURCES_IT_CANNOT_SEE.some(name => params[name] !== undefined && params[name] !== false)

const spawnFolderReadingsOf = (raw: string, system: WriteGuardSystem): readonly string[] | null => {
  const readings: string[] = []
  for (const home of [system.osHome, system.openClawHome]) {
    const decoded = absoluteOrRelative(raw, home)
    if (decoded === null) return null
    readings.push(decoded, expandedHome(raw, home))
  }
  return [...new Set(readings)]
}

const spawnFolderPlacesOf = (readings: readonly string[], paths: ComparablePaths, system: WriteGuardSystem): readonly string[] =>
  readings.flatMap(reading => [...paths.workspaceSpellings, ...system.otherWorkingDirectories].map(directory => resolve(directory, reading)))

const spawnPlaceVerdict = (place: string, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  const canonical = canonicalPathOf(place, system)
  if (canonical === null || !foldCanBeTrustedFor(canonical, paths, system)) return 'uncertain'
  const folder = comparable(canonical, system)
  if (paths.workspace === null || !isSameOrInside(folder, paths.workspace)) return 'protected'
  return isInAWorkspaceFolderOpenClawLoads(folder, paths) ? 'protected' : 'clear'
}

const spawnFolderVerdict = (raw: unknown, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  if (typeof raw !== 'string' || raw.trim().length === 0 || paths.workspace === null) return 'uncertain'
  const readings = spawnFolderReadingsOf(raw.trim(), system)
  if (readings === null) return 'uncertain'
  return worstOf(spawnFolderPlacesOf(readings, paths, system).map(place => spawnPlaceVerdict(place, paths, system)))
}

export const spawnsOutsideTheWorkspace = (locations: OpenClawStateLocations, system: WriteGuardSystem, call: FileWriteCall): boolean => {
  if (call.toolId !== SESSIONS_SPAWN_TOOL) return false
  const { params } = call.event
  if (startsAnAcpSession(params) || namesAFolderItCannotSee(params)) return true
  if (params[SPAWN_FOLDER_PARAMETER] === undefined) return false
  return spawnFolderVerdict(params[SPAWN_FOLDER_PARAMETER], comparablePathsFor(locations, system, call.agentId), system) !== 'clear'
}

export const nodeRealpath = (path: string): string => realpathSync(path)

export const nodeMayBeSymbolicLink = (path: string): boolean => {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true
  } catch {
    return true
  }
}

export const nodeHasOtherNames = (path: string): boolean => {
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false })
    return entry !== undefined && !entry.isDirectory() && entry.nlink > 1
  } catch {
    return true
  }
}
