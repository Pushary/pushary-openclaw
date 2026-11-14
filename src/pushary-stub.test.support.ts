import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type StubAnswer =
  | { readonly kind: 'reply'; readonly value: unknown }
  | { readonly kind: 'event_stream'; readonly value: unknown }
  | { readonly kind: 'raw'; readonly status: number; readonly body: string }
  | { readonly kind: 'tool_error'; readonly message: string }
  | { readonly kind: 'hang' }
  | { readonly kind: 'delayed'; readonly ms: number; readonly answer: StubAnswer }

export interface StubCall {
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly authorization: string | undefined
}

export type StubScript = (call: StubCall, calls: readonly StubCall[]) => StubAnswer

export interface PusharyStub {
  readonly baseUrl: string
  readonly calls: () => readonly StubCall[]
  readonly toolCalls: (tool: string) => readonly StubCall[]
  readonly setScript: (script: StubScript) => void
  readonly close: () => Promise<void>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

const callOf = (body: string, authorization: string | undefined): StubCall | null => {
  const envelope: unknown = JSON.parse(body)
  if (!isRecord(envelope) || !isRecord(envelope.params)) return null
  const { name, arguments: args } = envelope.params
  return typeof name === 'string' && isRecord(args) ? { tool: name, arguments: args, authorization } : null
}

const toolResult = (value: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })

const respond = (response: ServerResponse, answer: StubAnswer): void => {
  if (answer.kind === 'hang') return
  if (answer.kind === 'delayed') {
    setTimeout(() => respond(response, answer.answer), answer.ms)
    return
  }
  if (answer.kind === 'raw') {
    response.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body)
    return
  }
  if (answer.kind === 'tool_error') {
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: answer.message }] } }))
    return
  }
  if (answer.kind === 'event_stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${toolResult(answer.value)}\n\n`)
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(toolResult(answer.value))
}

export const startPusharyStub = async (initial: StubScript): Promise<PusharyStub> => {
  const calls: StubCall[] = []
  let script = initial
  const hanging = new Set<ServerResponse>()
  const server: Server = createServer((request, response) => {
    void readBody(request).then(body => {
      const call = callOf(body, request.headers.authorization)
      if (call === null) {
        response.writeHead(400).end()
        return
      }
      calls.push(call)
      const answer = script(call, calls)
      if (answer.kind === 'hang') hanging.add(response)
      respond(response, answer)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the Pushary stub has no TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls: () => [...calls],
    toolCalls: tool => calls.filter(call => call.tool === tool),
    setScript: next => { script = next },
    close: async () => {
      for (const response of hanging) response.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

export const PENDING_QUESTION = { correlationId: 'q-1', status: 'pending', nextAction: 'wait_for_answer', deliveryMode: 'push_only', policyTimeoutMs: 600_000 }
export const STILL_PENDING = { answered: false, status: 'pending', nextAction: 'wait_for_answer' }
export const WITHDRAWN = { cancelled: true, cancelledByThisCall: true, correlationId: 'q-1' }
export const NOT_PENDING = { cancelled: false, cancelledByThisCall: false, correlationId: 'q-1' }
export const answeredWith = (value: string): Readonly<Record<string, unknown>> => ({ answered: true, status: 'answered', value })

export const scriptByTool = (answers: Readonly<Record<string, (call: StubCall, calls: readonly StubCall[]) => StubAnswer>>): StubScript =>
  (call, calls) => answers[call.tool]?.(call, calls) ?? { kind: 'raw', status: 404, body: '{}' }

export const reply = (value: unknown): StubAnswer => ({ kind: 'reply', value })
