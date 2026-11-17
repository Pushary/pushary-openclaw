import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpenClawPluginApi } from './host-api.js'
import { openClawEnvironmentOf, openClawPathsFrom, ownedPluginFolderIn } from './openclaw-paths.js'
import { nodeHasOtherNames, nodeMayBeSymbolicLink, nodeRealpath, spawnsOutsideTheWorkspace, writesIntoOpenClaw, type FileWriteCall, type OpenClawStateLocations, type ServiceFileLocation, type WriteGuardSystem } from './protected-writes.js'
import { DEFAULT_OPENCLAW_AGENT_ID } from './settings.js'

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['darwin', 'win32'])
const PATH_ALIAS_ROOTS_BY_PLATFORM: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/System/Volumes/Data', '/.vol', '/.nofollow'],
}
const EXTENSIONS_DIRECTORY_NAME = 'extensions'
const PLUGIN_ROOT_DEPTH = 2
const USER_CONFIG_DIRECTORY = '.config'
const GATEWAY_ENV_FALLBACK_DIRECTORY = 'openclaw'
const LAUNCHD_LABEL_PREFIX = 'ai.openclaw'
const SYSTEMD_UNIT_PREFIX = 'openclaw'
const USER_LAUNCH_AGENTS = ['Library', 'LaunchAgents'] as const
const USER_SYSTEMD_UNITS = ['systemd', 'user'] as const
const SYSTEM_SERVICE_FILES: readonly ServiceFileLocation[] = [
  { directory: '/Library/LaunchDaemons', namePrefix: LAUNCHD_LABEL_PREFIX },
  { directory: '/etc/systemd/system', namePrefix: SYSTEMD_UNIT_PREFIX },
]
const GATEWAY_WORKING_ENV_FILE = '.env'
const LAUNCHD_LABEL_VARIABLE = 'OPENCLAW_LAUNCHD_LABEL'
const SYSTEMD_UNIT_VARIABLE = 'OPENCLAW_SYSTEMD_UNIT'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type HostPathResolver = (...args: readonly unknown[]) => unknown

const hostFunction = (namespace: unknown, name: string): HostPathResolver | null => {
  if (!isRecord(namespace)) return null
  const candidate = namespace[name]
  return typeof candidate === 'function' ? (...args: readonly unknown[]): unknown => Reflect.apply(candidate, namespace, args) : null
}

const hostPath = (resolver: HostPathResolver | null, ...args: readonly unknown[]): string | null => {
  if (resolver === null) return null
  try {
    const value = resolver(...args)
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  } catch {
    return null
  }
}

const runtimeNamespace = (api: OpenClawPluginApi, name: string): unknown => (isRecord(api.runtime) ? api.runtime[name] : undefined)

export const stateDirectoryHoldingPlugin = (pluginFile: string): string | null => {
  let pluginRoot = pluginFile
  for (let level = 0; level < PLUGIN_ROOT_DEPTH; level += 1) pluginRoot = dirname(pluginRoot)
  const extensions = dirname(pluginRoot)
  return basename(extensions) === EXTENSIONS_DIRECTORY_NAME ? dirname(extensions) : null
}

const presentOnly = (paths: readonly (string | null)[]): readonly string[] =>
  [...new Set(paths.flatMap(path => (path === null ? [] : [path])))]

export const openClawStateLocationsFor = (
  api: OpenClawPluginApi,
  environment: Readonly<Record<string, string | undefined>>,
  osHome: string,
  pluginFile: string,
  gatewayWorkingDirectory: string,
): OpenClawStateLocations => {
  const active = openClawPathsFrom(openClawEnvironmentOf(environment), osHome)
  const persistent = openClawPathsFrom(openClawEnvironmentOf({ OPENCLAW_HOME: environment.OPENCLAW_HOME }), osHome)
  const hostState = hostPath(hostFunction(runtimeNamespace(api, 'state'), 'resolveStateDir'), environment)
  const homes = presentOnly([osHome, active.home])
  return {
    stateDirectories: presentOnly([active.stateDirectory, persistent.stateDirectory, hostState, stateDirectoryHoldingPlugin(pluginFile)]),
    configFiles: presentOnly([active.configFile, persistent.configFile, join(gatewayWorkingDirectory, GATEWAY_WORKING_ENV_FILE)]),
    protectedTrees: presentOnly([
      dirname(ownedPluginFolderIn(osHome)),
      ...homes.map(home => join(home, USER_CONFIG_DIRECTORY, GATEWAY_ENV_FALLBACK_DIRECTORY)),
    ]),
    serviceFiles: serviceFilesFor(homes, environment),
  }
}

const overriddenServiceNames = (environment: Readonly<Record<string, string | undefined>>): readonly string[] =>
  presentOnly([environment[LAUNCHD_LABEL_VARIABLE]?.trim() || null, environment[SYSTEMD_UNIT_VARIABLE]?.trim() || null])

const serviceFilesFor = (homes: readonly string[], environment: Readonly<Record<string, string | undefined>>): readonly ServiceFileLocation[] => {
  const directories = [
    ...homes.map(home => join(home, ...USER_LAUNCH_AGENTS)),
    ...homes.map(home => join(home, USER_CONFIG_DIRECTORY, ...USER_SYSTEMD_UNITS)),
    ...SYSTEM_SERVICE_FILES.map(service => service.directory),
  ]
  return [
    ...homes.flatMap(home => [
      { directory: join(home, ...USER_LAUNCH_AGENTS), namePrefix: LAUNCHD_LABEL_PREFIX },
      { directory: join(home, USER_CONFIG_DIRECTORY, ...USER_SYSTEMD_UNITS), namePrefix: SYSTEMD_UNIT_PREFIX },
    ]),
    ...SYSTEM_SERVICE_FILES,
    ...overriddenServiceNames(environment).flatMap(name => directories.map(directory => ({ directory, namePrefix: name }))),
  ]
}

const workspaceFrom = (api: OpenClawPluginApi) => (agentId: string | undefined): string | null =>
  hostPath(hostFunction(runtimeNamespace(api, 'agent'), 'resolveAgentWorkspaceDir'), api.config, agentId ?? DEFAULT_OPENCLAW_AGENT_ID)

export const openClawWriteGuardFor = (api: OpenClawPluginApi): ((call: FileWriteCall) => boolean) => {
  const osHome = homedir()
  const locations = openClawStateLocationsFor(api, process.env, osHome, fileURLToPath(import.meta.url), process.cwd())
  const system: WriteGuardSystem = {
    osHome,
    openClawHome: openClawPathsFrom(openClawEnvironmentOf(process.env), osHome).home,
    realpath: nodeRealpath,
    mayBeSymbolicLink: nodeMayBeSymbolicLink,
    hasOtherNames: nodeHasOtherNames,
    caseInsensitive: CASE_INSENSITIVE_PLATFORMS.has(process.platform),
    pathAliasRoots: PATH_ALIAS_ROOTS_BY_PLATFORM[process.platform] ?? [],
    workspaceFor: workspaceFrom(api),
    otherWorkingDirectories: [process.cwd()],
  }
  return call => writesIntoOpenClaw(locations, system, call) || spawnsOutsideTheWorkspace(locations, system, call)
}
