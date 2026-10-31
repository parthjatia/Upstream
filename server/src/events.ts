/**
 * Server-sent events for `GET /events`.
 *
 * The galaxy UI (Phase 8) animates one particle per event, so events are
 * pushed as they happen rather than polled. SSE is enough here: the stream is
 * one-way, survives proxies, and reconnects by itself in the browser.
 */
import type { Response } from 'express'
import type { UpstreamEvent } from '@upstream/shared'

/** One connected browser. */
interface Client {
  id: number
  res: Response
}

let nextId = 1
const clients = new Set<Client>()

/** Recent events, so a browser that connects mid-swarm is not staring at nothing. */
const recent: UpstreamEvent[] = []
const RECENT_LIMIT = 50

export function addClient(res: Response): () => void {
  const client: Client = { id: nextId++, res }
  clients.add(client)

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Without this, a proxy can sit on the stream until it is big enough.
    'x-accel-buffering': 'no'
  })
  res.write(`retry: 2000\n\n`)

  // Replay what just happened, so the UI starts populated.
  for (const event of recent) send(client, event)

  // A comment every 25s keeps idle connections from being closed.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 25_000)

  return () => {
    clearInterval(heartbeat)
    clients.delete(client)
  }
}

function send(client: Client, event: UpstreamEvent): void {
  try {
    client.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  } catch {
    clients.delete(client)
  }
}

/** Push an event to every connected browser. */
export function emit(event: UpstreamEvent): void {
  recent.push(event)
  if (recent.length > RECENT_LIMIT) recent.shift()
  for (const client of clients) send(client, event)
}

export const clientCount = (): number => clients.size

/** Used by tests to start from a clean stream. */
export function reset(): void {
  recent.length = 0
  for (const client of clients) {
    try {
      client.res.end()
    } catch {
      /* already gone */
    }
  }
  clients.clear()
}
