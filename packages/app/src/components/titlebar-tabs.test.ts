import { describe, expect, test } from "bun:test"
import type { Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { visibleDirectoryTabs } from "./titlebar-tabs"

const serverKey = ServerConnection.Key.make

const sessionTab = (input: { directory: string; id: string; server?: string }): Tab => ({
  type: "session",
  server: serverKey(input.server ?? "local"),
  dirBase64: btoa(input.directory),
  sessionId: input.id,
})

const draftTab = (input: { directory: string; id: string; server?: string }): Tab => ({
  type: "draft",
  server: serverKey(input.server ?? "local"),
  directory: input.directory,
  draftID: input.id,
})

const tabDirectory = (tab: Tab) => (tab.type === "draft" ? tab.directory : atob(tab.dirBase64))

describe("visibleDirectoryTabs", () => {
  test("returns no tabs when no directory is active", () => {
    const tabs = [sessionTab({ directory: "/repo", id: "ses_1" })]

    expect(
      visibleDirectoryTabs({
        tabs,
        currentDirectory: undefined,
        currentServer: serverKey("local"),
        directoryGroup: { server: "local", directory: "/repo" },
        tabDirectory,
      }),
    ).toEqual([])
  })

  test("shows only the active directory group tabs when the group is active", () => {
    const repo = sessionTab({ directory: "/repo", id: "ses_repo" })
    const repoDraft = draftTab({ directory: "/repo", id: "draft_repo" })
    const other = sessionTab({ directory: "/other", id: "ses_other" })

    expect(
      visibleDirectoryTabs({
        tabs: [repo, repoDraft, other],
        current: other,
        currentDirectory: "/repo",
        currentServer: serverKey("local"),
        directoryGroup: { server: "local", directory: "/repo/" },
        tabDirectory,
      }),
    ).toEqual([repo, repoDraft])
  })

  test("falls back to the current tab before the directory group is restored", () => {
    const repo = sessionTab({ directory: "/repo", id: "ses_repo" })
    const other = sessionTab({ directory: "/other", id: "ses_other" })

    expect(
      visibleDirectoryTabs({
        tabs: [repo, other],
        current: repo,
        currentDirectory: "/repo",
        currentServer: serverKey("local"),
        directoryGroup: { server: "local", directory: "/other" },
        tabDirectory,
      }),
    ).toEqual([repo])
  })

  test("does not leak stale directory group tabs while switching directories", () => {
    const repo = sessionTab({ directory: "/repo", id: "ses_repo" })
    const child = sessionTab({ directory: "/repo/child", id: "ses_child" })

    expect(
      visibleDirectoryTabs({
        tabs: [repo, child],
        current: repo,
        currentDirectory: "/repo/child",
        currentServer: serverKey("local"),
        directoryGroup: { server: "local", directory: "/repo" },
        tabDirectory,
      }),
    ).toEqual([])
  })

  test("isolates directory groups by server", () => {
    const local = sessionTab({ directory: "/repo", id: "ses_local", server: "local" })
    const remote = sessionTab({ directory: "/repo", id: "ses_remote", server: "remote" })

    expect(
      visibleDirectoryTabs({
        tabs: [local, remote],
        current: local,
        currentDirectory: "/repo",
        currentServer: serverKey("remote"),
        directoryGroup: { server: "remote", directory: "/repo/" },
        tabDirectory,
      }),
    ).toEqual([remote])
  })
})
