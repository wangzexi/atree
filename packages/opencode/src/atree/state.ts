import { Global } from "@opencode-ai/core/global"
import { randomUUID } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"

export type WorkspaceState = {
  version: 1
  rootDirectory: string | null
  updatedAt: number | null
}

export type TreeNode = {
  type: "directory"
  name: string
  path: string
  absolute: string
  children: TreeNode[]
}

const MaxTreeDepth = 8
const MaxTreeNodes = 2_000
const IgnoredDirectories = new Set([
  ".agents",
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

async function atomicWriteJson(target: string, value: unknown) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
  await fs.writeFile(temp, JSON.stringify(value, null, 2))
  await fs.rename(temp, target)
}

async function isDirectory(target: string) {
  const stat = await fs.stat(target)
  return stat.isDirectory()
}

export async function normalizeRootDirectory(directory: string) {
  const resolved = path.resolve(os.homedir(), directory)
  const real = await fs.realpath(resolved)
  if (!(await isDirectory(real))) throw new Error(`Not a directory: ${directory}`)
  return real
}

export async function readWorkspaceState(): Promise<WorkspaceState> {
  try {
    const raw = await fs.readFile(stateFile(), "utf8")
    const parsed = JSON.parse(raw) as Partial<WorkspaceState>
    return {
      version: 1,
      rootDirectory: typeof parsed.rootDirectory === "string" ? parsed.rootDirectory : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: 1, rootDirectory: null, updatedAt: null }
    }
    throw error
  }
}

export async function readWorkspaceRootDirectory() {
  const state = await readWorkspaceState()
  return state.rootDirectory ?? undefined
}

export async function writeWorkspaceRoot(directory: string): Promise<WorkspaceState> {
  const rootDirectory = await normalizeRootDirectory(directory)
  const state: WorkspaceState = {
    version: 1,
    rootDirectory,
    updatedAt: Date.now(),
  }
  await atomicWriteJson(stateFile(), state)
  return state
}

function relativePath(root: string, absolute: string) {
  const relative = path.relative(root, absolute)
  return relative === "" ? "." : relative.split(path.sep).join("/")
}

async function scanDirectory(root: string, absolute: string, depth: number, budget: { count: number }): Promise<TreeNode> {
  const entries = await fs
    .readdir(absolute, { withFileTypes: true })
    .catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EACCES") return []
      throw error
    })
  const children: TreeNode[] = []
  if (depth < MaxTreeDepth) {
    for (const entry of entries) {
      if (budget.count >= MaxTreeNodes) break
      if (!entry.isDirectory()) continue
      if (IgnoredDirectories.has(entry.name)) continue
      const child = path.join(absolute, entry.name)
      budget.count++
      children.push(await scanDirectory(root, child, depth + 1, budget))
    }
  }
  children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  return {
    type: "directory",
    name: path.basename(absolute) || absolute,
    path: relativePath(root, absolute),
    absolute,
    children,
  }
}

export async function readTree() {
  const state = await readWorkspaceState()
  if (!state.rootDirectory) return { rootDirectory: null, tree: null }
  const rootDirectory = await normalizeRootDirectory(state.rootDirectory)
  return {
    rootDirectory,
    tree: await scanDirectory(rootDirectory, rootDirectory, 0, { count: 1 }),
  }
}
