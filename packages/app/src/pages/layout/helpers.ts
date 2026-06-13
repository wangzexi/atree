import { getFilename } from "@opencode-ai/core/util/path"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import type { ServerConnection } from "@/context/server"

type SessionStore = {
  session?: Session[]
  path: { directory: string }
}

export type SessionScheduleSummary = {
  nextRun?: number | string | null
  nextRunAt?: number | string | null
  runAt?: number | string | null
}

export type SessionScheduleIndex = Record<string, readonly SessionScheduleSummary[] | undefined>

function asTime(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
}

function scheduleEntry(session: Pick<Session, "id">, schedules?: SessionScheduleIndex) {
  if (!schedules) return
  if (!Object.prototype.hasOwnProperty.call(schedules, session.id)) return
  return schedules[session.id] ?? []
}

export function sessionNextScheduleRun(session: Pick<Session, "id">, schedules?: SessionScheduleIndex) {
  const items = scheduleEntry(session, schedules)
  if (!items?.length) return
  let next: number | undefined
  for (const item of items) {
    const value = asTime(item.nextRunAt ?? item.nextRun ?? item.runAt)
    if (value === undefined) continue
    if (next === undefined || value < next) next = value
  }
  return next
}

function sortSessions(now: number, schedules?: SessionScheduleIndex) {
  const oneMinuteAgo = now - 60 * 1000
  return (a: Session, b: Session) => {
    const aScheduled = sessionHasSchedule(a, schedules)
    const bScheduled = sessionHasSchedule(b, schedules)
    if (aScheduled !== bScheduled) return aScheduled ? -1 : 1
    if (aScheduled && bScheduled) {
      const aNext = sessionNextScheduleRun(a, schedules) ?? Number.MAX_SAFE_INTEGER
      const bNext = sessionNextScheduleRun(b, schedules) ?? Number.MAX_SAFE_INTEGER
      if (aNext !== bNext) return aNext - bNext
    }
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }
}

const isRootVisibleSession = (session: Session, directory: string) =>
  pathKey(session.directory) === pathKey(directory) && !session.parentID && !session.time?.archived

export const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (store: SessionStore, now: number, schedules?: SessionScheduleIndex) =>
  roots(store).sort(sortSessions(now, schedules))

export const latestRootSession = (stores: SessionStore[], now: number) =>
  stores.flatMap(roots).sort(sortSessions(now))[0]

function atreeMetadata(session: Pick<Session, "metadata">) {
  const metadata = session.metadata
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return
  const atree = metadata.atree
  if (!atree || typeof atree !== "object" || Array.isArray(atree)) return
  return atree as Record<string, unknown>
}

export const defaultSessionEmoji = "💬"

export const sessionEmojiOptions = [
  defaultSessionEmoji,
  "🐱",
  "🐶",
  "🐰",
  "🦊",
  "🐼",
  "🐧",
  "🐢",
  "🐳",
  "🦉",
  "📌",
  "🗂️",
  "📝",
  "📚",
  "🧰",
  "🔧",
  "💡",
  "🎨",
  "📷",
  "🎧",
  "🧭",
  "⏰",
  "🧪",
  "💾",
]

export function nextSessionMetadata(session: Pick<Session, "metadata">, emoji: string) {
  const metadata =
    session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? session.metadata : {}
  const currentAtree =
    metadata.atree && typeof metadata.atree === "object" && !Array.isArray(metadata.atree)
      ? (metadata.atree as Record<string, unknown>)
      : {}
  return {
    ...metadata,
    atree: {
      ...currentAtree,
      emoji,
    },
  }
}

export function randomSessionEmoji(excluded: Iterable<string>) {
  const used = new Set(excluded)
  const available = sessionEmojiOptions.filter((emoji) => !used.has(emoji))
  const source = available.length > 0 ? available : sessionEmojiOptions
  return source[Math.floor(Math.random() * source.length)] ?? defaultSessionEmoji
}

export function sessionEmoji(session: Pick<Session, "metadata">) {
  const emoji = atreeMetadata(session)?.emoji
  return typeof emoji === "string" && emoji.trim() ? emoji : defaultSessionEmoji
}

export function sessionHasSchedule(session: Pick<Session, "id" | "metadata">, schedules?: SessionScheduleIndex) {
  const items = scheduleEntry(session, schedules)
  if (items) return items.length > 0
  const atree = atreeMetadata(session)
  if (!atree) return false
  return Boolean(atree.schedule || atree.cron || atree.scheduled)
}

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined> | undefined,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request ?? {}).some((list) => list?.some(include))
}

export const childSessionOnPath = (sessions: Session[] | undefined, rootID: string, activeID?: string) => {
  if (!activeID || activeID === rootID) return
  const map = new Map((sessions ?? []).map((session) => [session.id, session]))
  let id = activeID

  while (id) {
    const session = map.get(id)
    if (!session?.parentID) return
    if (session.parentID === rootID) return session
    id = session.parentID
  }
}

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree) || project.worktree

export type HomeProjectSelection = { server: ServerConnection.Key; directory?: string }

export function toggleHomeProjectSelection(
  current: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  directory: string,
): HomeProjectSelection {
  if (current?.server === server && current.directory === directory) return { server }
  return { server, directory }
}

export function closeHomeProject(
  selected: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  projects: { close: (directory: string) => void },
  directory: string,
) {
  projects.close(directory)
  if (selected?.server === server && selected.directory === directory) return { server }
  return selected
}

export function homeProjectNavigation(active: ServerConnection.Key, server: ServerConnection.Key, href: string) {
  if (active === server) return { href }
  return { server, href }
}

export function homeProjectDirectories(result: string | string[] | null) {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

export function homeSessionServerStatus(active: boolean, status: () => { working: boolean; tint?: string }) {
  if (!active) return { working: false, tint: undefined }
  return status()
}

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

export function getProjectAvatarSource(id?: string, icon?: { color?: string; url?: string; override?: string }) {
  if (id === OPENCODE_PROJECT_ID) return "https://opencode.ai/favicon.svg"
  if (icon?.override) return icon.override
  if (icon?.color) return undefined
  return icon?.url
}

export function projectForSession<T extends { id?: string; worktree: string; sandboxes?: string[] }>(
  session: Session,
  projects: T[],
  byID: Map<string, T> = new Map(projects.flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
) {
  const direct = byID.get(session.projectID)
  if (direct) return direct
  const directory = pathKey(session.directory)
  return projects.find(
    (project) =>
      pathKey(project.worktree) === directory || project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
  )
}

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = pathKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = pathKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = pathKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
