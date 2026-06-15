import { type ServerConnection } from "@/context/server"
import { sessionScheduleRequestHeaders } from "@/utils/session-schedule"

function responseError(method: string, path: string, status: number, text: string) {
  return Object.assign(new Error(`${method} ${path} failed: ${status} ${text}`), {
    cause: { status },
  })
}

export async function promptAtreeSession(input: {
  current: ServerConnection.Any | null | undefined
  directory: string
  sessionID: string
  messageID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  parts: unknown
}) {
  if (!input.current) return false

  const path = `/atree/session/${input.sessionID}/prompt_async`
  const url = new URL(path, input.current.http.url)
  url.searchParams.set("directory", input.directory)

  const headers = sessionScheduleRequestHeaders(input.current)
  headers.set("content-type", "application/json")
  headers.set("accept", "application/json")

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messageID: input.messageID,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      parts: input.parts,
    }),
  })
  if (!response.ok) throw responseError("POST", path, response.status, await response.text())
  return true
}
