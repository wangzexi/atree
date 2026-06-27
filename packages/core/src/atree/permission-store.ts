import fs from "fs/promises"
import path from "path"
import type { PermissionV2 } from "../permission"
import { readSessionStoresDeep, readWorkspaceSessionStoresDeep, sessionJsonlPath, eventData, baseEventType } from "./session-store"
import { isRecord } from "../util/record"

export type PermissionStateEntry = {
  readonly request: PermissionV2.Request
  readonly directory: string
}





export async function readPermissionStateEntries(rootDirectory?: string) {
  const sessions = rootDirectory
    ? await readSessionStoresDeep(rootDirectory)
    : await readWorkspaceSessionStoresDeep()
  if (sessions.length === 0) return [] as PermissionStateEntry[]
  const permissions = new Map<string, PermissionStateEntry>()
  const ambiguous = new Set<string>()

  for (const session of sessions) {
    if (session.time.archived !== undefined) continue
    const raw = await fs.readFile(sessionJsonlPath(session.location.directory, session.id), "utf8").catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
      throw error
    })

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      const type = baseEventType(entry.type)
      const data = eventData(entry)

      if (type === "permission.v2.asked") {
        const permission = isRecord(data.permission) ? data.permission : data
        if (typeof permission.id === "string") {
          if (ambiguous.has(permission.id)) continue
          const existing = permissions.get(permission.id)
          if (existing && existing.directory !== session.location.directory) {
            permissions.delete(permission.id)
            ambiguous.add(permission.id)
            continue
          }
          permissions.set(permission.id, {
            request: permission as PermissionV2.Request,
            directory: session.location.directory,
          })
        }
        continue
      }
      if (type === "permission.v2.replied") {
        if (typeof data.requestID === "string") permissions.delete(data.requestID)
      }
    }
  }

  return [...permissions.values()]
}

export async function readPermissionState(rootDirectory?: string) {
  return (await readPermissionStateEntries(rootDirectory)).map((entry) => entry.request)
}
