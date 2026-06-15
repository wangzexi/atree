import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { listAtreeSessions, updateAtreeSession } from "./atree-session"
import { listAtreeSessionDiff, listAtreeSessionTodos } from "./atree-session-state"

const originalFetch = globalThis.fetch

const current = {
  type: "http",
  http: {
    url: "http://127.0.0.1:4196",
  },
} as unknown as ServerConnection.Any

const nativeSession = (input: {
  id: string
  directory: string
  title: string
  archivedAt?: string | null
  icon?: string
}) => {
  const now = "2026-06-15T00:00:00.000Z"
  return {
    id: input.id,
    directory: input.directory,
    paths: {
      root: `${input.directory}/.agents/atree/sessions/${input.id}`,
      meta: `${input.directory}/.agents/atree/sessions/${input.id}/meta.yaml`,
      sessionJsonl: `${input.directory}/.agents/atree/sessions/${input.id}/session.jsonl`,
      assets: `${input.directory}/.agents/atree/sessions/${input.id}/assets`,
    },
    meta: {
      version: 1,
      id: input.id,
      title: input.title,
      icon: input.icon,
      metadata: input.icon ? { atree: { emoji: input.icon } } : {},
      created_at: now,
      updated_at: now,
      archived_at: input.archivedAt ?? null,
    },
  }
}

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("atree session adapter", () => {
  test("lists sessions from the native atree endpoint", async () => {
    const requests: URL[] = []
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      requests.push(url)
      return Response.json([nativeSession({ id: "ses_1", directory: "/repo/root", title: "Root", icon: "🌲" })])
    }, originalFetch)

    const sessions = await listAtreeSessions(current, "/repo/root", { includeArchived: true, limit: 20 })

    expect(requests).toHaveLength(1)
    expect(requests[0].pathname).toBe("/atree/session")
    expect(requests[0].searchParams.get("directory")).toBe("/repo/root")
    expect(requests[0].searchParams.get("includeArchived")).toBe("true")
    expect(requests[0].searchParams.get("limit")).toBe("20")
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe("ses_1")
    expect(sessions[0].directory).toBe("/repo/root")
    expect(sessions[0].title).toBe("Root")
    expect(sessions[0].metadata).toEqual({ atree: { emoji: "🌲" } })
  })

  test("updates archive metadata through the native atree endpoint", async () => {
    const archived = Date.parse("2026-06-15T01:00:00.000Z")
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      requests.push({ url, init })
      return Response.json(
        nativeSession({
          id: "ses_2",
          directory: "/repo/root",
          title: "Archived",
          archivedAt: new Date(archived).toISOString(),
        }),
      )
    }, originalFetch)

    const session = await updateAtreeSession(current, "/repo/root", "ses_2", { time: { archived } })

    expect(requests).toHaveLength(1)
    expect(requests[0].url.pathname).toBe("/atree/session/ses_2")
    expect(requests[0].url.searchParams.get("directory")).toBe("/repo/root")
    expect(requests[0].init?.method).toBe("PATCH")
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ time: { archived } })
    expect(session?.id).toBe("ses_2")
    expect(session?.time.archived).toBe(archived)
  })

  test("reads diff and todo state from native atree endpoints", async () => {
    const requests: URL[] = []
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (url.pathname.endsWith("/diff")) return Response.json([{ file: "note.md", additions: 1, deletions: 0 }])
      if (url.pathname.endsWith("/todo"))
        return Response.json([{ content: "Review migration", status: "pending", priority: "medium" }])
      return Response.json([])
    }, originalFetch)

    const diff = await listAtreeSessionDiff(current, "/repo/root", "ses_3")
    const todo = await listAtreeSessionTodos(current, "/repo/root", "ses_3")

    expect(requests.map((url) => `${url.pathname}?${url.searchParams}`)).toEqual([
      "/atree/session/ses_3/diff?directory=%2Frepo%2Froot",
      "/atree/session/ses_3/todo?directory=%2Frepo%2Froot",
    ])
    expect(diff).toEqual([{ file: "note.md", additions: 1, deletions: 0 }])
    expect(todo).toEqual([{ content: "Review migration", status: "pending", priority: "medium" }])
  })
})
