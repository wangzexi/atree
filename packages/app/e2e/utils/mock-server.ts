import type { Page, Route } from "@playwright/test"

const emptyList = new Set([
  "/skill",
  "/command",
  "/lsp",
  "/formatter",
  "/permission",
  "/question",
  "/vcs/status",
  "/vcs/diff",
])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"])

export interface MockServerConfig {
  provider: unknown
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
  events?: () => unknown[]
  files?: (directory: string) => unknown[]
  schedules?: (sessionID: string) => unknown[]
  onPromptAsync?: (sessionID: string) => void
}

export async function mockOpenCodeServer(page: Page, config: MockServerConfig) {
  let sessions = [...config.sessions]
  const staticRoutes: Record<string, unknown> = {
    "/api/workspace": { version: 1, rootDirectory: config.directory, updatedAt: 1 },
    "/api/tree": {
      rootDirectory: config.directory,
      tree: {
        type: "directory",
        name: config.directory.split(/[\\/]/).pop() || config.directory,
        path: ".",
        absolute: config.directory,
        children: [],
      },
    },
    "/provider": config.provider,
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
  }

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    if (url.port !== targetPort) return route.fallback()

    const requestDirectory = () => {
      const query = url.searchParams.get("directory")
      if (query) return query
      const header = route.request().headers()["x-opencode-directory"]
      if (!header) return config.directory
      try {
        return decodeURIComponent(header)
      } catch {
        return header
      }
    }

    const path = url.pathname
    if (path === "/global/event" || path === "/event") return sse(route, config.events?.())
    if (path === "/global/health") return json(route, { healthy: true })
    if (path === "/path") {
      const directory = requestDirectory()
      return json(route, {
        state: config.directory,
        config: config.directory,
        worktree: config.directory,
        directory,
        home: "C:/OpenCode",
      })
    }
    if (path === "/file") return json(route, config.files?.(requestDirectory()) ?? [])
    if (path === "/session" && route.request().method() === "GET") {
      const directory = requestDirectory()
      const roots = url.searchParams.get("roots") === "true"
      const includeArchived = url.searchParams.get("archived") === "true"
      return json(
        route,
        sessions.filter((session) => {
          if (directory && session.directory !== directory) return false
          if (roots && session.parentID) return false
          if (!includeArchived && (session.time as { archived?: number } | undefined)?.archived !== undefined) return false
          return true
        }),
      )
    }
    if (path === "/session" && route.request().method() === "POST") {
      const directory = requestDirectory()
      const now = Date.now()
      const session = {
        id: `ses_e2e_${now}`,
        slug: `e2e-${now}`,
        projectID: (config.project as { id?: string }).id ?? "proj_e2e",
        directory,
        title: `New session - ${new Date(now).toISOString()}`,
        version: "test",
        time: { created: now, updated: now },
      }
      sessions = [session, ...sessions]
      return json(route, session)
    }
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])
    if (path in staticRoutes) return json(route, staticRoutes[path])

    const sessionMatch = path.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = sessions.find((s) => s.id === sessionMatch[1])
      if (session && route.request().method() === "PATCH") {
        let payload: unknown
        try {
          payload = route.request().postDataJSON()
        } catch {
          payload = undefined
        }
        if (payload && typeof payload === "object" && "metadata" in payload) {
          Object.assign(session, { metadata: (payload as { metadata?: unknown }).metadata })
        }
        return json(route, session)
      }
      return json(route, session ?? {})
    }

    const scheduleMatch = path.match(/^\/session\/([^/]+)\/schedule$/)
    if (scheduleMatch) return json(route, config.schedules?.(scheduleMatch[1]) ?? [])

    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(path)) return json(route, [])

    const promptAsyncMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/)
    if (promptAsyncMatch) {
      config.onPromptAsync?.(promptAsyncMatch[1])
      return json(route, true)
    }

    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const before = url.searchParams.get("before") ?? undefined
      const pageData = config.pageMessages(messagesMatch[1], limit, before)
      return json(route, pageData.items, pageData.cursor ? { "x-next-cursor": pageData.cursor } : undefined)
    }

    return json(route, {})
  })
}

function json(route: Route, body: unknown, headers?: Record<string, string>) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[]) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n",
  })
}
