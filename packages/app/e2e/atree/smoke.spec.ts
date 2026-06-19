import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"

const root = "/tmp/atree-e2e-root"
const child = `${root}/inbox`

const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: { "mock-model": { id: "mock-model", name: "Mock Model", limit: { context: 200_000 } } },
    },
  ],
  connected: ["opencode"],
  default: { providerID: "opencode", modelID: "mock-model" },
}

const project = {
  id: "proj_atree_smoke",
  worktree: root,
  vcs: "git",
  name: "atree-smoke",
  time: { created: 1700000000000, updated: 1700000000000 },
  sandboxes: [],
}

test.describe("atree smoke", () => {
  test.setTimeout(70_000)

  test("opens a directory session and clears a one-time automation", async ({ page }) => {
    const errors = trackPageErrors(page)
    let automation:
      | {
          sessionID: string
          scheduleID: string
          runAt: number
          message: string
        }
      | undefined

    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    })

    await mockOpenCodeServer(page, {
      directory: root,
      project,
      provider,
      sessions: [
        {
          id: "ses_root_existing",
          slug: "root-existing",
          projectID: project.id,
          directory: root,
          title: "Root existing session",
          version: "test",
          time: { created: 1700000000000, updated: 1700000000000 },
        },
        {
          id: "ses_child_existing",
          slug: "child-existing",
          projectID: project.id,
          directory: child,
          title: "Child existing session",
          version: "test",
          time: { created: 1700000001000, updated: 1700000001000 },
        },
      ],
      pageMessages: () => ({ items: [] }),
      files: (directory) =>
        directory !== child
          ? [{ type: "directory", name: "inbox", path: "inbox", absolute: child }]
          : [],
      schedules: (sessionID) =>
        automation?.sessionID === sessionID && Date.now() < automation.runAt
          ? [
              {
                id: automation.scheduleID,
                sessionID,
                kind: "once",
                expression: "",
                runAt: automation.runAt,
                message: automation.message,
                createdAt: automation.runAt - 60_000,
                lastRanAt: null,
                lastRunStatus: null,
                nextRun: automation.runAt,
              },
            ]
          : [],
      onPromptAsync: (sessionID) => {
        automation = {
          sessionID,
          scheduleID: "sch_atree_smoke_once",
          runAt: Date.now() + 1_000,
          message: "一分钟后提醒我检查 atree 冒烟测试",
        }
      },
    })

    await page.goto(`/${base64Encode(child)}/session`)
    await expect(page.getByText("aTree", { exact: true })).toBeVisible()
    await expect(page.locator(`[data-atree-directory="${root}"]`)).toBeVisible()
    await expect(page).toHaveURL(/\/(new-session\?draftId=|session)$/)

    const editor = page.locator('[contenteditable="true"]').first()
    await expect(editor).toBeVisible()
    await editor.click()
    await editor.fill("1 分钟后提醒我检查 atree 冒烟测试")
    await page.locator('[data-action="prompt-submit"]').first().click()

    await expect(page).toHaveURL(new RegExp(`/${base64Encode(child)}/session/ses_e2e_`))
    await page.reload()

    const dock = page.locator('[data-component="session-schedule-dock"]')
    await expect(dock).toBeVisible()
    await expect(dock).toContainText("自动化消息")
    await expect(dock).toContainText("一分钟后提醒我检查 atree 冒烟测试")

    await expect(dock).toBeHidden({ timeout: 45_000 })
    expect(errors).toEqual([])
  })
})
