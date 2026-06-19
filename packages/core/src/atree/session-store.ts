import { DateTime } from "effect"
import fs from "fs/promises"
import path from "path"
import { AgentV2 } from "../agent"
import { Global } from "../global"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { ProviderV2 } from "../provider"
import { AbsolutePath, RelativePath } from "../schema"
import { SessionSchema } from "../session/schema"
import { WorkspaceV2 } from "../workspace"

const FindMaxDepth = 8
const FindMaxNodes = 2_000
const IgnoredDirectories = new Set([
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

function stateFile() {
  return path.join(Global.Path.data, "atree", "state.json")
}

function parseValue(value: string) {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function parseMeta(raw: string, fallbackDirectory: string): SessionSchema.Info | undefined {
  const data: Record<string, unknown> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/)
    if (!match) continue
    data[match[1]] = parseValue(match[2] ?? "")
  }

  if (typeof data.id !== "string") return
  const created = typeof data.createdAt === "number" ? data.createdAt : 0
  const updated = typeof data.updatedAt === "number" ? data.updatedAt : created
  const archived = typeof data.archivedAt === "number" ? data.archivedAt : undefined
  const model =
    data.model && typeof data.model === "object"
      ? (data.model as { id?: unknown; providerID?: unknown; variant?: unknown })
      : undefined

  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(data.id),
    parentID: typeof data.parentID === "string" ? SessionSchema.ID.make(data.parentID) : undefined,
    projectID: ProjectV2.ID.make(typeof data.projectID === "string" ? data.projectID : "global"),
    title: typeof data.title === "string" ? data.title : data.id,
    agent: typeof data.agent === "string" ? AgentV2.ID.make(data.agent) : undefined,
    model:
      typeof model?.id === "string" && typeof model.providerID === "string"
        ? {
            id: ModelV2.ID.make(model.id),
            providerID: ProviderV2.ID.make(model.providerID),
            variant: ModelV2.VariantID.make(typeof model.variant === "string" ? model.variant : "default"),
          }
        : undefined,
    cost: typeof data.cost === "number" ? data.cost : 0,
    tokens:
      data.tokens && typeof data.tokens === "object"
        ? (data.tokens as SessionSchema.Info["tokens"])
        : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: Location.Ref.make({
      directory: AbsolutePath.make(fallbackDirectory),
      workspaceID: typeof data.workspaceID === "string" ? WorkspaceV2.ID.make(data.workspaceID) : undefined,
    }),
    subpath: typeof data.path === "string" ? RelativePath.make(data.path) : undefined,
    time: {
      created: DateTime.makeUnsafe(created),
      updated: DateTime.makeUnsafe(updated),
      archived: archived === undefined ? undefined : DateTime.makeUnsafe(archived),
    },
  })
}

export async function readWorkspaceRoot() {
  try {
    const raw = await fs.readFile(stateFile(), "utf8")
    const parsed = JSON.parse(raw) as { rootDirectory?: unknown }
    return typeof parsed.rootDirectory === "string" ? parsed.rootDirectory : undefined
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function readSessionStore(directory: string, sessionID: SessionSchema.ID) {
  const target = path.join(directory, ".agents", "atree", "sessions", sessionID, "meta.yaml")
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!raw) return
  return parseMeta(raw, directory)
}

export async function readSessionStores(directory: string) {
  const root = path.join(directory, ".agents", "atree", "sessions")
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  })
  const sessions: SessionSchema.Info[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const session = await readSessionStore(directory, SessionSchema.ID.make(entry.name))
    if (session) sessions.push(session)
  }
  return sessions
}

export async function findSessionStore(rootDirectory: string, sessionID: SessionSchema.ID) {
  const root = await fs.realpath(rootDirectory)
  const budget = { count: 0 }

  async function walk(directory: string, depth: number): Promise<SessionSchema.Info | undefined> {
    if (budget.count++ >= FindMaxNodes) return
    const found = await readSessionStore(directory, sessionID)
    if (found) return found
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
      const result = await walk(path.join(directory, entry.name), depth + 1)
      if (result) return result
    }
  }

  return walk(root, 0)
}
