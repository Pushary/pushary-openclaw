import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpenClawBeforeToolCallEvent } from './host-api.js'

export const WRITE_TOOL = 'write'
export const EDIT_TOOL = 'edit'
export const APPLY_PATCH_TOOL = 'apply_patch'
export const FILE_WRITING_TOOLS: readonly string[] = [WRITE_TOOL, EDIT_TOOL, APPLY_PATCH_TOOL]

const PATH_PARAMETER = 'path'
const PATCH_PARAMETER = 'input'
const PATCH_TARGET_MARKERS: readonly string[] = ['*** Add File: ', '*** Delete File: ', '*** Update File: ', '*** Move to: ']
const PATCH_MARKER_PREFIX = '***'
const FILE_URL_PREFIX = 'file://'
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
  readonly realpath: (path: string) => string
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
  readonly workspaceFoldersOpenClawLoads: readonly string[]
  readonly riskyRelativeStarts: ReadonlySet<string>
}

const errorCodeOf = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null

const canonicalPathOf = (path: string, system: WriteGuardSystem): string | null => {
  const missing: string[] = []
  let current = normalize(path)
  for (;;) {
    try {
      const real = system.realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch (error) {
      const code = errorCodeOf(error)
      const parent = dirname(current)
      if (code === null || !MISSING_PATH_CODES.has(code) || parent === current) return null
      missing.push(basename(current))
      current = parent
    }
  }
}

const comparable = (path: string, system: WriteGuardSystem): string => {
  const composed = path.normalize('NFC')
  return system.caseInsensitive ? composed.toLowerCase() : composed
}

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

const comparablePathsFor = (locations: OpenClawStateLocations, system: WriteGuardSystem, agentId: string | undefined): ComparablePaths => {
  const stateDirectories = spellingsOfAll(locations.stateDirectories, system)
  const workspace = system.workspaceFor(agentId)
  const workspaceCanonical = workspace === null ? null : canonicalPathOf(workspace, system)
  return {
    stateDirectories,
    configFiles: spellingsOfAll(locations.configFiles, system),
    protectedTrees: spellingsOfAll(locations.protectedTrees, system),
    serviceFiles: locations.serviceFiles.flatMap(location =>
      spellingsOfLocation(location.directory, system).map(directory => ({ directory, namePrefix: comparable(location.namePrefix, system) }))),
    workspace: workspaceCanonical === null ? null : comparable(workspaceCanonical, system),
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

const verdictForAbsolute = (path: string, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  const canonical = canonicalPathOf(path, system)
  if (canonical === null) return 'uncertain'
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

const absoluteOrRelative = (spelling: string, osHome: string): string | null => {
  if (!spelling.startsWith(FILE_URL_PREFIX)) return expandedHome(spelling, osHome)
  try {
    return fileURLToPath(spelling)
  } catch {
    return null
  }
}

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

const landingPlacesOf = (relativePath: string, workspace: string, others: readonly string[]): readonly string[] => {
  const climbs = leadingClimbsOf(relativePath)
  const rest = normalize(relativePath).split(/[\\/]/).slice(climbs).join(sep)
  const fromInsideTheWorkspace = ancestorsUpTo(workspace, climbs).map(base => join(base, rest))
  return [...fromInsideTheWorkspace, resolve(workspace, relativePath), ...others.map(directory => resolve(directory, relativePath))]
}

const verdictForSpelling = (spelling: string, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  const path = absoluteOrRelative(spelling, system.osHome)
  if (path === null || path.trim().length === 0) return 'uncertain'
  if (isAbsolute(path)) return verdictForAbsolute(path, paths, system)
  if (paths.riskyRelativeStarts.has(comparable(firstComponentOf(path), system))) return 'protected'
  if (paths.workspace === null) return 'uncertain'
  return worstOf(landingPlacesOf(path, paths.workspace, system.otherWorkingDirectories).map(place => verdictForAbsolute(place, paths, system)))
}

const verdictForRawPath = (raw: unknown, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'uncertain'
  return worstOf(spellingsOf(raw.trim()).map(spelling => verdictForSpelling(spelling, paths, system)))
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

const spawnFolderVerdict = (raw: unknown, paths: ComparablePaths, system: WriteGuardSystem): PathVerdict => {
  if (typeof raw !== 'string' || raw.trim().length === 0 || paths.workspace === null) return 'uncertain'
  const expanded = absoluteOrRelative(raw.trim(), system.osHome)
  if (expanded === null) return 'uncertain'
  const canonical = canonicalPathOf(resolve(paths.workspace, expanded), system)
  if (canonical === null) return 'uncertain'
  const folder = comparable(canonical, system)
  if (!isSameOrInside(folder, paths.workspace)) return 'protected'
  return isInAWorkspaceFolderOpenClawLoads(folder, paths) ? 'protected' : 'clear'
}

export const spawnsOutsideTheWorkspace = (locations: OpenClawStateLocations, system: WriteGuardSystem, call: FileWriteCall): boolean => {
  if (call.toolId !== SESSIONS_SPAWN_TOOL) return false
  const { params } = call.event
  if (startsAnAcpSession(params) || namesAFolderItCannotSee(params)) return true
  if (params[SPAWN_FOLDER_PARAMETER] === undefined) return false
  return spawnFolderVerdict(params[SPAWN_FOLDER_PARAMETER], comparablePathsFor(locations, system, call.agentId), system) !== 'clear'
}

export const nodeRealpath = (path: string): string => realpathSync(path)
