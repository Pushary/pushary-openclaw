import { isCredentialName, isRecord, REDACTED_VALUE, serializedWithCredentialsRedacted } from './parameter-redaction.js'
import { redactSecrets, redactSecretsDeep } from './redaction.js'
import { withHiddenCharactersShown } from './visible-text.js'

export interface CommandPreview {
  readonly command: string
  readonly line: string
  readonly body: string
  readonly environmentNames: readonly string[]
  readonly otherParameters: string | null
}

interface EnvironmentEntry {
  readonly name: string
  readonly assignment: string
}

const COMMAND_PARAMETERS = ['command', 'code'] as const
const ENV_PARAMETER = 'env'
const ASSIGNMENT_SEPARATOR = '='

const commandParameterOf = (params: Readonly<Record<string, unknown>>): { readonly name: string; readonly command: string } | null => {
  for (const name of COMMAND_PARAMETERS) {
    const value = params[name]
    if (typeof value === 'string' && value.trim().length > 0) return { name, command: value }
  }
  return null
}

const environmentValueText = (value: unknown): string =>
  typeof value === 'string' ? value : serializedWithCredentialsRedacted(value)

const environmentEntryOf = (name: string, value: unknown): EnvironmentEntry => ({
  name,
  assignment: `${name}${ASSIGNMENT_SEPARATOR}${isCredentialName(name) ? REDACTED_VALUE : environmentValueText(value)}`,
})

const environmentEntryOfAssignment = (assignment: string): EnvironmentEntry => {
  const separator = assignment.indexOf(ASSIGNMENT_SEPARATOR)
  return separator === -1
    ? { name: assignment, assignment }
    : environmentEntryOf(assignment.slice(0, separator), assignment.slice(separator + ASSIGNMENT_SEPARATOR.length))
}

const isListOfText = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const environmentOf = (value: unknown): readonly EnvironmentEntry[] | null => {
  if (isRecord(value)) return Object.entries(value).map(([name, entry]) => environmentEntryOf(name, entry))
  if (isListOfText(value)) return value.map(environmentEntryOfAssignment)
  return null
}

const otherParametersOf = (params: Readonly<Record<string, unknown>>, skipped: ReadonlySet<string>): string | null => {
  const others = Object.entries(params).filter(([name]) => !skipped.has(name))
  return others.length === 0 ? null : serializedWithCredentialsRedacted(Object.fromEntries(others))
}

const sectionsOf = (environment: readonly EnvironmentEntry[], otherParameters: string | null, command: string): string => {
  if (environment.length === 0 && otherParameters === null) return command
  return [
    ...(environment.length > 0 ? ['Environment:', ...environment.map(entry => entry.assignment), ''] : []),
    ...(otherParameters === null ? [] : [`Other parameters: ${otherParameters}`, '']),
    'Command:',
    command,
  ].join('\n')
}

const oneLineOf = (environment: readonly EnvironmentEntry[], otherParameters: string | null, command: string): string =>
  [...environment.map(entry => entry.assignment), command, ...(otherParameters === null ? [] : [`(${otherParameters})`])].join(' ')

const displayed = (text: string): string => redactSecrets(withHiddenCharactersShown(text))

export const commandPreviewOf = (params: Readonly<Record<string, unknown>>, shownElsewhere: readonly string[]): CommandPreview | null => {
  const found = commandParameterOf(params)
  if (found === null) return null
  const environment = environmentOf(params[ENV_PARAMETER])
  const skipped = new Set([found.name, ...shownElsewhere, ...(environment === null ? [] : [ENV_PARAMETER])])
  const entries = environment ?? []
  const otherParameters = otherParametersOf(params, skipped)
  return {
    command: displayed(found.command),
    line: displayed(oneLineOf(entries, otherParameters, found.command)),
    body: redactSecretsDeep(withHiddenCharactersShown(sectionsOf(entries, otherParameters, found.command))),
    environmentNames: entries.map(entry => displayed(entry.name)),
    otherParameters: otherParameters === null ? null : displayed(otherParameters),
  }
}
