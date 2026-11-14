import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { isValidApiKey } from './api-key-shape.js'
import { isPusharyHost } from './pushary-hosts.js'

export const API_KEY_VARIABLE = 'PUSHARY_API_KEY'
export const BASE_URL_VARIABLE = 'PUSHARY_BASE_URL'
export const CONFIG_FILE_VARIABLE = 'PUSHARY_CONFIG_FILE'
export const DEFAULT_BASE_URL = 'https://pushary.com'

const PUSHARY_DIRECTORY = '.pushary'
const PUSHARY_CONFIG_FILE = 'config.json'
const SHARED_MACHINE_ID_FILE = 'machine-id'
const SHARED_MACHINE_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/
const HOSTNAME_MACHINE_ID_LENGTH = 8
const PUSHARY_PROTOCOL = 'https:'

export type Environment = Readonly<Record<string, string | undefined>>

export interface PusharyConnection {
  readonly baseUrl: string
  readonly apiKey: string
  readonly machineId: string | null
}

export type ConnectionReading =
  | { readonly kind: 'ready'; readonly connection: PusharyConnection }
  | { readonly kind: 'missing_api_key' }
  | { readonly kind: 'invalid_base_url' }

export interface ConnectionSources {
  readonly environment: Environment
  readonly homeDirectory: string
  readonly readText: (path: string) => string | null
  readonly hostName: () => string | null
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsedJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const usableApiKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const key = value.trim()
  return isValidApiKey(key) ? key : null
}

const pusharyPath = (sources: ConnectionSources, file: string): string =>
  join(sources.homeDirectory, PUSHARY_DIRECTORY, file)

const configFilePath = (sources: ConnectionSources): string => {
  const configured = sources.environment[CONFIG_FILE_VARIABLE]?.trim()
  return configured ? configured : pusharyPath(sources, PUSHARY_CONFIG_FILE)
}

const apiKeyFrom = (sources: ConnectionSources): string | null => {
  const fromEnvironment = usableApiKey(sources.environment[API_KEY_VARIABLE])
  if (fromEnvironment !== null) return fromEnvironment
  const config = parsedJson(sources.readText(configFilePath(sources)))
  return isRecord(config) ? usableApiKey(config.apiKey) : null
}

const isPusharyOrigin = (url: URL): boolean =>
  url.protocol === PUSHARY_PROTOCOL
  && url.port === ''
  && url.username === ''
  && url.password === ''
  && isPusharyHost(url.hostname)

const baseUrlFrom = (environment: Environment): string | null => {
  const configured = environment[BASE_URL_VARIABLE]?.trim()
  if (!configured) return DEFAULT_BASE_URL
  try {
    const url = new URL(configured)
    return isPusharyOrigin(url) ? url.origin : null
  } catch {
    return null
  }
}

const hostnameMachineId = (sources: ConnectionSources): string | null => {
  const host = sources.hostName()
  return host ? createHash('sha256').update(host, 'utf8').digest('hex').slice(0, HOSTNAME_MACHINE_ID_LENGTH) : null
}

const machineIdFrom = (sources: ConnectionSources): string | null => {
  const shared = sources.readText(pusharyPath(sources, SHARED_MACHINE_ID_FILE))?.trim() ?? ''
  return SHARED_MACHINE_ID_PATTERN.test(shared) ? shared : hostnameMachineId(sources)
}

export const readPusharyConnection = (sources: ConnectionSources): ConnectionReading => {
  const baseUrl = baseUrlFrom(sources.environment)
  if (baseUrl === null) return { kind: 'invalid_base_url' }
  const apiKey = apiKeyFrom(sources)
  if (apiKey === null) return { kind: 'missing_api_key' }
  return { kind: 'ready', connection: { baseUrl, apiKey, machineId: machineIdFrom(sources) } }
}

const readTextFile = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const currentHostName = (): string | null => {
  try {
    return hostname() || null
  } catch {
    return null
  }
}

export const processConnectionSources = (): ConnectionSources => ({
  environment: process.env,
  homeDirectory: homedir(),
  readText: readTextFile,
  hostName: currentHostName,
})
