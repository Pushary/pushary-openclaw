import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { registerApprovalGate, type GateEnvironment } from './approval-hook.js'
import { processConnectionSources, readPusharyConnection } from './connection.js'
import type { GateClock } from './gate.js'
import type { OpenClawPluginEntry } from './host-api.js'
import { createPusharyQuestions } from './pushary-client.js'
import { PLUGIN_DESCRIPTION, PLUGIN_ID, PLUGIN_NAME } from './settings.js'

const sleepUnlessAborted = async (ms: number, signal: AbortSignal | undefined): Promise<void> => {
  try {
    await delay(ms, undefined, signal === undefined ? undefined : { signal })
  } catch {
    return
  }
}

export const systemClock: GateClock = {
  monotonicMs: () => performance.now(),
  wallMs: () => Date.now(),
  sleep: sleepUnlessAborted,
}

export const processGateEnvironment = (): GateEnvironment => ({
  readConnection: () => readPusharyConnection(processConnectionSources()),
  questionsFor: connection => createPusharyQuestions(connection),
  clock: systemClock,
  newRequestId: randomUUID,
})

const pusharyPlugin: OpenClawPluginEntry = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  register: api => registerApprovalGate(api, processGateEnvironment()),
}

export default pusharyPlugin
