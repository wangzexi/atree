import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import { bootstrapDirectory, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = createStore<State>({
      status: "loading",
      agent: [],
      command: [],
      project: "",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
      session: [],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
      part_text_accum_delta: {},
    })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })

  test("warms permission sessions through native atree detail endpoint", async () => {
    const legacySessionGets: string[] = []
    const nativeReads: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const url = new URL(href)
      nativeReads.push(`${url.pathname}?${url.searchParams}`)
      expect(url.pathname).toBe("/atree/session/session-native")
      expect(url.searchParams.get("directory")).toBe("/project")
      return new Response(
        JSON.stringify({
          id: "session-native",
          directory: "/project",
          paths: {
            root: "/project/.agents/atree/sessions/session-native",
            meta: "/project/.agents/atree/sessions/session-native/meta.yaml",
            sessionJsonl: "/project/.agents/atree/sessions/session-native/session.jsonl",
            assets: "/project/.agents/atree/sessions/session-native/assets",
          },
          meta: {
            version: 1,
            id: "session-native",
            title: "Native Session",
            icon: "A",
            metadata: {},
            created_at: "2026-06-16T00:00:00.000Z",
            updated_at: "2026-06-16T00:01:00.000Z",
            archived_at: null,
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const [store, setStore] = createStore<State>({
      status: "loading",
      agent: [],
      command: [],
      project: "",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
      session: [],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
      part_text_accum_delta: {},
    })

    try {
      await bootstrapDirectory({
        directory: "/project",
        scope: ServerScope.local,
        current: { type: "http", http: { url: "http://127.0.0.1:4196" } },
        mcp: false,
        global: {
          config: {} satisfies Config,
          path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
          project: [{ id: "project", worktree: "/project" } as Project],
          provider,
        },
        sdk: {
          app: { agents: async () => ({ data: [] }) },
          config: { get: async () => ({ data: {} }) },
          session: {
            status: async () => ({ data: {} }),
            get: async ({ sessionID }: { sessionID: string }) => {
              legacySessionGets.push(sessionID)
              throw new Error("legacy session.get should not be called")
            },
          },
          vcs: { get: async () => ({ data: undefined }) },
          command: { list: async () => ({ data: [] }) },
          permission: {
            list: async () => ({ data: [{ id: "permission-1", sessionID: "session-native" }] }),
          },
          question: { list: async () => ({ data: [] }) },
          mcp: { status: async () => ({ data: {} }) },
          provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
        } as unknown as OpencodeClient,
        store,
        setStore,
        vcsCache: { setStore() {} } as unknown as VcsCache,
        loadSessions() {},
        translate: (key) => key,
        queryClient: new QueryClient(),
      })

      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(legacySessionGets).toEqual([])
      expect(nativeReads).toEqual(["/atree/session/session-native?directory=%2Fproject"])
      expect(store.session.map((item) => item.id)).toEqual(["session-native"])
      expect(store.permission["session-native"]?.map((item) => item.id)).toEqual(["permission-1"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as OpencodeClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
