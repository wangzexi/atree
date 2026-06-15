import { eventID } from "./ids"

export type RuntimeEvent = {
  directory?: string
  payload: {
    id?: string
    type: string
    properties?: Record<string, unknown>
  }
}

type Listener = (event: RuntimeEvent) => void

export class EventHub {
  private listeners = new Set<Listener>()

  publish(event: RuntimeEvent) {
    const payload = {
      id: event.payload.id ?? eventID(),
      type: event.payload.type,
      properties: event.payload.properties ?? {},
    }
    const next = { ...event, payload }
    for (const listener of this.listeners) listener(next)
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stream() {
    const encoder = new TextEncoder()
    const write = (controller: ReadableStreamDefaultController<Uint8Array>, event: RuntimeEvent) => {
      if (closed) return
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    }
    let closed = false
    let unsubscribe: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        write(controller, {
          payload: {
            id: eventID(),
            type: "server.connected",
            properties: {},
          },
        })
        unsubscribe = this.subscribe((event) => write(controller, event))
        heartbeat = setInterval(() => {
          write(controller, {
            payload: {
              id: eventID(),
              type: "server.heartbeat",
              properties: {},
            },
          })
        }, 10_000)
      },
      cancel: () => {
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe?.()
      },
    })
  }
}
