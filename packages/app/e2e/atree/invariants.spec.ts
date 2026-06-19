import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"

const root = "/tmp/atree-e2e-root"
const child = `${root}/inbox`
const other = `${root}/archive`

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
  id: "proj_atree_invariants",
  worktree: root,
  vcs: "git",
  name: "atree-invariants",
  time: { created: 1700000000000, updated: 1700000000000 },
  sandboxes: [],
}

test.describe("atree invariants", () => {
  test("shows the empty root state and no session tabs when no root is selected", async ({ page }) => {
    const errors = trackPageErrors(page)

    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    })

    await mockOpenCodeServer(page, {
      directory: root,
      project,
      provider,
      // No root selected on the server side.
      workspace: { rootDirectory: null },
      sessions: [],
      pageMessages: () => ({ items: [] }),
      files: () => [],
    })

    await page.goto("/")
    await expect(page.getByText("选择一个根目录开始", { exact: true })).toBeVisible()
    await expect(page.locator('[data-atree-session-tab]')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test("restores the server root after a page reload", async ({ page }) => {
    const errors = trackPageErrors(page)

    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    })

    await mockOpenCodeServer(page, {
      directory: root,
      project,
      provider,
      sessions: [],
      pageMessages: () => ({ items: [] }),
      files: (directory) =>
        directory === root
          ? [
              { type: "directory", name: "inbox", path: "inbox", absolute: child },
              { type: "directory", name: "archive", path: "archive", absolute: other },
            ]
          : [],
    })

    await page.goto("/")
    await expect(page.getByText("aTree", { exact: true })).toBeVisible()
    // The root directory node is rendered from the server workspace state.
    const childNode = page.locator(`[data-atree-directory="${child}"]`)
    await expect(childNode).toBeVisible()

    // Reload: the root must come back from the server, not localStorage-only state.
    await page.reload()
    await expect(page.getByText("aTree", { exact: true })).toBeVisible()
    await expect(childNode).toBeVisible()
    expect(errors).toEqual([])
  })

  test("archiving a session tab removes it and it does not revive after switching directories", async ({ page }) => {
    const errors = trackPageErrors(page)

    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    })

    await mockOpenCodeServer(page, {
      directory: root,
      project,
      provider,
      sessions: [],
      pageMessages: () => ({ items: [] }),
      files: (directory) =>
        directory === root
          ? [
              { type: "directory", name: "inbox", path: "inbox", absolute: child },
              { type: "directory", name: "archive", path: "archive", absolute: other },
            ]
          : [],
    })

    await page.goto("/")
    await expect(page.getByText("aTree", { exact: true })).toBeVisible()
    const childNode = page.locator(`[data-atree-directory="${child}"]`)
    await expect(childNode).toBeVisible()

    // Create a session in the child directory the same way the smoke flow does,
    // but without any automation so a single click archives it.
    await page.locator(`[data-atree-new-session="${child}"]`).click()
    await expect(page).toHaveURL(/\/new-session\?draftId=/)

    const editor = page.locator('[contenteditable="true"]').first()
    await expect(editor).toBeVisible()
    await editor.click()
    await editor.fill("归档不变量")
    await page.locator('[data-action="prompt-submit"]').first().click()

    await expect(page).toHaveURL(new RegExp(`/${base64Encode(child)}/session/ses_e2e_`))
    await page.reload()

    const sessionID = /\/session\/(ses_e2e_[^/]+)$/.exec(new URL(page.url()).pathname)?.[1]
    expect(sessionID).toBeTruthy()
    const tab = page.locator(`[data-atree-session-tab][data-session-id="${sessionID}"]`)
    await expect(tab).toBeVisible()

    // Archive the tab (no schedule → single click archives immediately).
    await tab.hover()
    await tab.locator('[aria-label="归档会话"]').click({ force: true })
    await expect(tab).toHaveCount(0)

    // Switch to the sibling directory, then back. The archived tab must not revive.
    const otherNode = page.locator(`[data-atree-directory="${other}"]`)
    await otherNode.click()
    await expect(page.locator(`[data-atree-session-tab][data-session-id="${sessionID}"]`)).toHaveCount(0)

    await childNode.click()
    await expect(page.locator(`[data-atree-session-tab][data-session-id="${sessionID}"]`)).toHaveCount(0)
    expect(errors).toEqual([])
  })
})
