import { type ServerConnection } from "@/context/server"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { sessionScheduleRequestHeaders } from "@/utils/session-schedule"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type NativeScheduleMeta =
  | {
      id: string
      kind: "at"
      at: string
      message: string
      created_at: string
      last_ran_at: string | null
      last_run_status: "ran" | "skipped" | null
    }
  | {
      id: string
      kind: "cron"
      expression: string
      message: string
      created_at: string
      last_ran_at: string | null
      last_run_status: "ran" | "skipped" | null
    }

type NativeSessionMeta = {
  version: number
  id: string
  title: string
  icon?: string
  metadata?: Json
  created_at: string
  updated_at: string
  archived_at: string | null
  schedule?: NativeScheduleMeta
}

type NativeSessionInfo = {
  id: string
  directory: string
  paths: {
    root: string
    meta: string
    sessionJsonl: string
    assets: string
  }
  meta: NativeSessionMeta
}

type ListAtreeSessionOptions = {
  includeArchived?: boolean
  limit?: number
}

function timestamp(value: string | null | undefined) {
  if (!value) return
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function slug(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "session"
  )
}

function sessionMetadata(meta: NativeSessionMeta): Session["metadata"] {
  if (!meta.icon) return meta.metadata as Session["metadata"]
  const metadata = meta.metadata && typeof meta.metadata === "object" && !Array.isArray(meta.metadata) ? meta.metadata : {}
  const atree = metadata.atree && typeof metadata.atree === "object" && !Array.isArray(metadata.atree) ? metadata.atree : {}
  return {
    ...metadata,
    atree: {
      ...atree,
      emoji: meta.icon,
    },
  } as Session["metadata"]
}

function toSession(item: NativeSessionInfo): Session {
  const created = timestamp(item.meta.created_at) ?? Date.now()
  const updated = timestamp(item.meta.updated_at) ?? created
  const archived = timestamp(item.meta.archived_at)
  return {
    id: item.id,
    slug: slug(item.meta.title),
    projectID: base64Encode(item.directory),
    directory: item.directory,
    path: item.paths.root.startsWith(`${item.directory}/`) ? item.paths.root.slice(item.directory.length + 1) : undefined,
    title: item.meta.title,
    version: "atree-native",
    metadata: sessionMetadata(item.meta),
    time: {
      created,
      updated,
      ...(archived !== undefined ? { archived } : {}),
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  }
}

function currentUrl(current: ServerConnection.Any | null | undefined, path: string) {
  if (!current) return
  return new URL(path, current.http.url)
}

export async function listAtreeSessions(
  current: ServerConnection.Any | null | undefined,
  directory: string,
  options: ListAtreeSessionOptions = {},
) {
  const url = currentUrl(current, "/atree/session")
  if (!url) return [] as Session[]
  url.searchParams.set("directory", directory)
  if (options.includeArchived) url.searchParams.set("includeArchived", "true")
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit))

  const response = await fetch(url, { headers: sessionScheduleRequestHeaders(current) })
  if (!response.ok) throw new Error(`Failed to list atree sessions: ${response.status}`)
  const json = (await response.json()) as NativeSessionInfo[]
  return json.map(toSession)
}

export async function getAtreeSession(
  current: ServerConnection.Any | null | undefined,
  directory: string,
  sessionID: string,
) {
  const url = currentUrl(current, `/atree/session/${sessionID}`)
  if (!url) return
  url.searchParams.set("directory", directory)

  const response = await fetch(url, { headers: sessionScheduleRequestHeaders(current) })
  if (!response.ok) throw new Error(`Failed to get atree session: ${response.status}`)
  const json = (await response.json()) as NativeSessionInfo
  return toSession(json)
}
