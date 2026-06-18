import fs from "fs/promises"
import path from "path"
import type { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"

type SessionInfo = Session.Info & {
  id: SessionID
}

function yamlString(value: string | undefined) {
  return JSON.stringify(value ?? "")
}

function yamlMetadata(metadata: SessionInfo["metadata"]) {
  if (!metadata || Object.keys(metadata).length === 0) return "metadata: {}\n"
  return `metadata: ${JSON.stringify(metadata)}\n`
}

function metaYaml(info: SessionInfo) {
  return [
    "version: 1",
    `id: ${yamlString(info.id)}`,
    `directory: ${yamlString(info.directory)}`,
    `title: ${yamlString(info.title)}`,
    `createdAt: ${info.time.created}`,
    `updatedAt: ${info.time.updated}`,
    "source: opencode",
    yamlMetadata(info.metadata).trimEnd(),
    "",
  ].join("\n")
}

async function writeIfMissing(target: string, content: string) {
  try {
    await fs.writeFile(target, content, { flag: "wx" })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
    throw error
  }
}

export async function ensureSessionStore(info: SessionInfo) {
  const root = path.join(info.directory, ".agents", "atree", "sessions", info.id)
  await fs.mkdir(path.join(root, "assets"), { recursive: true })
  await writeIfMissing(path.join(root, "meta.yaml"), metaYaml(info))
  await writeIfMissing(path.join(root, "session.jsonl"), "")
}
