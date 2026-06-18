import { authTokenFromCredentials } from "@/utils/server"
import type { ServerConnection } from "@/context/server"

export type AtreeWorkspaceState = {
  version: 1
  rootDirectory: string | null
  updatedAt: number | null
}

function requestHeaders(current?: ServerConnection.Any | null) {
  const headers = new Headers()
  headers.set("Content-Type", "application/json")
  if (current?.http.password) {
    headers.set(
      "Authorization",
      `Basic ${authTokenFromCredentials({ username: current.http.username, password: current.http.password })}`,
    )
  }
  return headers
}

export async function getAtreeWorkspace(current: ServerConnection.Any | null | undefined) {
  if (!current) return { version: 1, rootDirectory: null, updatedAt: null } satisfies AtreeWorkspaceState
  const response = await fetch(new URL("/api/workspace", current.http.url), {
    headers: requestHeaders(current),
  })
  if (!response.ok) throw new Error(`Failed to load atree workspace: ${response.status}`)
  return (await response.json()) as AtreeWorkspaceState
}

export async function setAtreeWorkspaceRoot(current: ServerConnection.Any | null | undefined, rootDirectory: string) {
  if (!current) throw new Error("No server connection")
  const response = await fetch(new URL("/api/workspace/root", current.http.url), {
    method: "PUT",
    headers: requestHeaders(current),
    body: JSON.stringify({ rootDirectory }),
  })
  if (!response.ok) throw new Error(`Failed to update atree workspace root: ${response.status}`)
  return (await response.json()) as AtreeWorkspaceState
}
