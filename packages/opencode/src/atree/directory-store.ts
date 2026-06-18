import fs from "fs/promises"
import path from "path"

function metaPath(directory: string) {
  return path.join(directory, ".agents", "atree", "meta.yaml")
}

function defaultMeta() {
  const now = Date.now()
  return ["version: 1", `createdAt: ${now}`, `updatedAt: ${now}`, 'source: "atree"', ""].join("\n")
}

export async function ensureAtreeDirectoryStore(directory: string) {
  const target = metaPath(directory)
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(target, defaultMeta(), { flag: "wx" })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
    throw error
  }
}
