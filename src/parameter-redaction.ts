import { redactSecrets } from './redaction.js'

export const REDACTED_VALUE = '[redacted]'

const REDACTION_PROBE = 'x'

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isCredentialName = (key: string): boolean => redactSecrets(`${key}=${REDACTION_PROBE}`) !== `${key}=${REDACTION_PROBE}`

const withCredentialValuesRedacted = (value: unknown, ancestors: ReadonlySet<object>): unknown => {
  if (typeof value !== 'object' || value === null) return value
  if (ancestors.has(value)) throw new TypeError('circular parameters')
  const inside = new Set([...ancestors, value])
  if (Array.isArray(value)) return value.map(item => withCredentialValuesRedacted(item, inside))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    isCredentialName(key) ? REDACTED_VALUE : withCredentialValuesRedacted(entry, inside),
  ]))
}

export const serializedWithCredentialsRedacted = (value: unknown): string => {
  try {
    return JSON.stringify(withCredentialValuesRedacted(value, new Set())) ?? ''
  } catch {
    return ''
  }
}
