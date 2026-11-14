export const MIN_HOST_VERSION = '2026.11.3'

const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/

export type HostSupport =
  | { readonly kind: 'supported'; readonly version: string }
  | { readonly kind: 'too_old'; readonly version: string }
  | { readonly kind: 'unknown' }

interface ReleaseVersion {
  readonly parts: readonly [number, number, number]
  readonly prerelease: boolean
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const releaseVersionOf = (text: string): ReleaseVersion | null => {
  const match = RELEASE_VERSION_PATTERN.exec(text.trim())
  if (match === null) return null
  const [, major, minor, patch, prerelease] = match
  return { parts: [Number(major), Number(minor), Number(patch)], prerelease: prerelease !== undefined }
}

const isAtLeast = (version: ReleaseVersion, floor: ReleaseVersion): boolean => {
  const differing = version.parts.findIndex((part, index) => part !== floor.parts[index])
  if (differing === -1) return !version.prerelease || floor.prerelease
  return (version.parts[differing] ?? 0) > (floor.parts[differing] ?? 0)
}

const FLOOR = releaseVersionOf(MIN_HOST_VERSION)

export const hostSupportFrom = (runtime: unknown): HostSupport => {
  const version = isRecord(runtime) && typeof runtime.version === 'string' ? runtime.version : null
  const parsed = version === null ? null : releaseVersionOf(version)
  if (version === null || parsed === null || FLOOR === null) return { kind: 'unknown' }
  return isAtLeast(parsed, FLOOR) ? { kind: 'supported', version } : { kind: 'too_old', version }
}

export const handsBackToTheHost = (support: HostSupport): boolean => support.kind === 'supported'
