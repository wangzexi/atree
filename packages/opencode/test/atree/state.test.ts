import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readTree, readWorkspaceState, writeWorkspaceRoot } from "../../src/atree/state"

const temps: string[] = []
let previousData = Global.Path.data

async function tempdir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

beforeEach(async () => {
  previousData = Global.Path.data
  ;(Global.Path as { data: string }).data = await tempdir("atree-state-data-")
})

afterEach(async () => {
  ;(Global.Path as { data: string }).data = previousData
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("atree workspace state", () => {
  test("persists the selected root outside the root directory", async () => {
    const data = Global.Path.data
    const root = await tempdir("atree-state-root-")

    expect(await readWorkspaceState()).toEqual({ version: 1, rootDirectory: null, updatedAt: null })

    const state = await writeWorkspaceRoot(root)
    const realRoot = await fs.realpath(root)

    expect(state.rootDirectory).toBe(realRoot)
    expect(typeof state.updatedAt).toBe("number")
    expect(await readWorkspaceState()).toEqual(state)

    const stateFile = path.join(data, "atree", "state.json")
    const raw = JSON.parse(await fs.readFile(stateFile, "utf8")) as typeof state
    expect(raw.rootDirectory).toBe(realRoot)
    expect(stateFile.startsWith(path.join(realRoot, ".agents"))).toBe(false)
  })

  test("reads a directory tree from the persisted root", async () => {
    const root = await tempdir("atree-state-tree-")
    await fs.mkdir(path.join(root, "inbox"), { recursive: true })
    await fs.mkdir(path.join(root, "archive", "nested"), { recursive: true })
    await fs.mkdir(path.join(root, "node_modules", "ignored"), { recursive: true })
    await fs.mkdir(path.join(root, ".git", "ignored"), { recursive: true })

    await writeWorkspaceRoot(root)
    const result = await readTree()

    expect(result.rootDirectory).toBe(await fs.realpath(root))
    expect(result.tree).toMatchObject({
      type: "directory",
      path: ".",
      absolute: await fs.realpath(root),
    })
    expect(result.tree?.children.map((child) => child.name)).toEqual(["archive", "inbox"])
    expect(result.tree?.children.find((child) => child.name === "archive")?.children[0]?.path).toBe("archive/nested")
  })
})
