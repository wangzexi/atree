import { type ServerConnection } from "@/context/server"
import { sessionScheduleRequestHeaders } from "@/utils/session-schedule"
import type { SnapshotFileDiff, Todo } from "@opencode-ai/sdk/v2/client"

function currentUrl(current: ServerConnection.Any | null | undefined, path: string) {
  if (!current) return
  return new URL(path, current.http.url)
}

function responseError(method: string, path: string, status: number, text: string) {
  return Object.assign(new Error(`${method} ${path} failed: ${status} ${text}`), {
    cause: { status },
  })
}

async function getJson<T>(current: ServerConnection.Any | null | undefined, directory: string, path: string) {
  const url = currentUrl(current, path)
  if (!url) return [] as T[]
  url.searchParams.set("directory", directory)

  const response = await fetch(url, { headers: sessionScheduleRequestHeaders(current) })
  if (!response.ok) throw responseError("GET", path, response.status, await response.text())
  return (await response.json()) as T[]
}

export function listAtreeSessionDiff(
  current: ServerConnection.Any | null | undefined,
  directory: string,
  sessionID: string,
) {
  return getJson<SnapshotFileDiff>(current, directory, `/atree/session/${sessionID}/diff`)
}

export function listAtreeSessionTodos(
  current: ServerConnection.Any | null | undefined,
  directory: string,
  sessionID: string,
) {
  return getJson<Todo>(current, directory, `/atree/session/${sessionID}/todo`)
}
