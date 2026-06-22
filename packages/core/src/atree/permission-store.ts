import fs from "fs/promises"
import path from "path"
import type { PermissionV2 } from "../permission"
import { readSessionStores, readWorkspaceRoot } from "./session-store"

type RecordValue = Record<string, unknown>

const FindMaxDepth = 8
const FindMaxNodes = 2_000
const IgnoredDirectories = new Set([
  ".agents",
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
])

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function eventType(value: unknown) {
  return typeof value === "string" ? value.replace(/\.\d+$/, "") : undefined
}

function eventData(entry: RecordValue) {
  return isRecord(entry.data) ? entry.data : entry
}

function sessionJsonlPath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl")
}

async function readDirectoryPermissions(directory: string, permissions: Map<string, PermissionV2.Request>) {
  const sessions = await readSessionStores(directory)
  for (const session of sessions) {
    const raw = await fs.readFile(sessionJsonlPath(session.location.directory, session.id), "utf8").catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
      throw error
    })

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let entry: RecordValue
      try {
        entry = JSON.parse(line) as RecordValue
      } catch {
        continue
      }

      const type = eventType(entry.type)
      const data = eventData(entry)

      if (type === "permission.v2.asked") {
        const permission = isRecord(data.permission) ? data.permission : data
        if (typeof permission.id === "string") permissions.set(permission.id, permission as PermissionV2.Request)
        continue
      }
      if (type === "permission.v2.replied") {
        if (typeof data.requestID === "string") permissions.delete(data.requestID)
      }
    }
  }
}

export async function readPermissionState(rootDirectory?: string) {
  const rootInput = rootDirectory ?? (await readWorkspaceRoot())
  if (!rootInput) return [] as PermissionV2.Request[]

  const root = await fs.realpath(rootInput)
  const budget = { count: 0 }
  const permissions = new Map<string, PermissionV2.Request>()

  async function walk(directory: string, depth: number): Promise<void> {
    if (budget.count++ >= FindMaxNodes) return
    await readDirectoryPermissions(directory, permissions)
    if (depth >= FindMaxDepth) return

    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EACCES")
      ) {
        return []
      }
      throw error
    })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (IgnoredDirectories.has(entry.name)) continue
      await walk(path.join(directory, entry.name), depth + 1)
    }
  }

  await walk(root, 0)
  return [...permissions.values()]
}
