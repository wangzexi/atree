#!/usr/bin/env bun

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { pathToFileURL } from "node:url"

type Suite = {
  name: string
  port: number
  backendEnv?: Record<string, string>
  testEnv?: Record<string, string>
  cleanup?: () => Promise<void>
  useRuntimeDefaultExecution?: boolean
}

type Json = Record<string, unknown>

const bun = process.execPath
const root = new URL("..", import.meta.url).pathname
const portBase = Number(process.env.ATREE_GUARDRAIL_PORT_BASE ?? "42196")

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function trimLog(log: string) {
  const max = 12_000
  if (log.length <= max) return log
  return `${log.slice(0, 4_000)}\n\n... omitted ${log.length - max} chars ...\n\n${log.slice(-8_000)}`
}

async function waitForExit(child: ChildProcessWithoutNullStreams) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

async function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const stopped = await Promise.race([waitForExit(child), sleep(2_000).then(() => undefined)])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await waitForExit(child)
  }
}

async function stopProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
  } else {
    child.kill("SIGTERM")
  }
  const stopped = await Promise.race([waitForExit(child), sleep(2_000).then(() => undefined)])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    } else {
      child.kill("SIGKILL")
    }
    await waitForExit(child)
  }
}

async function fetchText(url: string, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${url} returned ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean | undefined>) {
  const url = new URL(path, baseUrl)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

async function fetchJson<T = Json>(
  baseUrl: string,
  path: string,
  options?: RequestInit & { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
): Promise<T> {
  const body =
    options && "body" in options && options.body !== undefined && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : (options?.body as BodyInit | null | undefined)
  const response = await fetch(buildUrl(baseUrl, path, options?.query), {
    ...options,
    body,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${options?.method ?? "GET"} ${path} failed: ${response.status} ${text}`)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function rewriteScheduleRunAt(directory: string, sessionID: string, runAt: number) {
  const path = join(directory, ".agents", "atree", "sessions", sessionID, "meta.yaml")
  const content = await readFile(path, "utf8")
  const next = content.replace(/(^|\n)(\s*run_at:\s*).+/m, (_match, lineStart, prefix) => {
    return `${lineStart}${prefix}${new Date(runAt).toISOString()}`
  })
  if (next === content) throw new Error(`restart persistence smoke could not rewrite schedule run_at in ${path}`)
  await writeFile(path, next, "utf8")
}

async function runCommand(name: string, args: string[], env: Record<string, string | undefined> = {}) {
  console.log(`\n==> ${name}`)
  const child = spawn(bun, args, {
    cwd: root,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "inherit",
  })
  const result = await waitForExit(child)
  if (result.code !== 0) {
    throw new Error(`${name} failed with ${result.signal ?? `exit code ${result.code}`}`)
  }
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listSourceFiles(path)))
    if (entry.isFile() && /\.(tsx?|mjs|js)$/.test(entry.name)) files.push(path)
  }
  return files
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(path)))
    if (entry.isFile()) files.push(path)
  }
  return files
}

async function assertNoFileContains(root: string, needles: Array<{ label: string; value: string }>) {
  const files = await listFiles(root)
  for (const file of files) {
    const content = await readFile(file)
    for (const needle of needles) {
      if (content.includes(Buffer.from(needle.value))) {
        throw new Error(`global cache leaked ${needle.label} into ${file}`)
      }
    }
  }
}

function extractImportSpecifiers(content: string) {
  const specifiers: string[] = []
  const importPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2]
    if (specifier) specifiers.push(specifier)
  }
  return specifiers
}

async function assertRuntimeCoreBoundary() {
  console.log("\n## atree runtime core boundary")
  const runtimeRoot = join(root, "packages/atree-runtime")
  const sourceRoot = join(runtimeRoot, "src")
  const packageJson = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  const dependencyNames = Object.keys(dependencies)
  const opencodeDependencies = dependencyNames.filter((name) => name.startsWith("@opencode"))
  if (opencodeDependencies.length > 0) {
    throw new Error(`atree runtime must not depend on OpenCode packages: ${opencodeDependencies.join(", ")}`)
  }
  if (!dependencyNames.includes("@mariozechner/pi-coding-agent")) {
    throw new Error("atree runtime must depend on @mariozechner/pi-coding-agent")
  }

  const files = await listSourceFiles(sourceRoot)
  let importsPi = false
  const forbiddenImports: string[] = []
  for (const file of files) {
    const content = await readFile(file, "utf8")
    for (const specifier of extractImportSpecifiers(content)) {
      if (specifier === "@mariozechner/pi-coding-agent") importsPi = true
      if (specifier.startsWith("@opencode")) forbiddenImports.push(`${file}: ${specifier}`)
      if (specifier.startsWith(".")) {
        const resolved = resolve(dirname(file), specifier)
        if (resolved.includes("/packages/opencode/") || resolved.includes("/packages/opencode-")) {
          forbiddenImports.push(`${file}: ${specifier}`)
        }
      }
    }
  }
  if (!importsPi) throw new Error("atree runtime source must import @mariozechner/pi-coding-agent")
  if (forbiddenImports.length > 0) {
    throw new Error(`atree runtime must not import OpenCode backend core:\n${forbiddenImports.join("\n")}`)
  }

  const piModule = (await import(
    pathToFileURL(join(runtimeRoot, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "index.js")).href
  )) as {
    SessionManager?: {
      inMemory?: () => unknown
    }
  }
  const manager = piModule.SessionManager?.inMemory?.()
  if (!manager || typeof (manager as { _rewriteFile?: unknown })._rewriteFile !== "function") {
    throw new Error("Pi SessionManager _rewriteFile flush boundary is missing; update atree session.jsonl persistence")
  }

  console.log(
    `runtime boundary ok: ${files.length} source files, Pi core import present, no OpenCode core imports, Pi flush boundary present`,
  )
}

async function startFrontendDev(input: { backendPort: number; frontendPort: number }) {
  let logs = ""
  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined

  const child = spawn(
    bun,
    ["--cwd", "packages/app", "dev", "--host", "127.0.0.1", "--port", String(input.frontendPort)],
    {
      cwd: root,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        VITE_ATREE_SERVER_HOST: "127.0.0.1",
        VITE_ATREE_SERVER_PORT: String(input.backendPort),
        VITE_OPENCODE_SERVER_HOST: "",
        VITE_OPENCODE_SERVER_PORT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  child.stdout.on("data", (chunk) => {
    logs += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    logs += String(chunk)
  })
  child.once("exit", (code, signal) => {
    exitResult = { code, signal }
  })

  const indexUrl = `http://127.0.0.1:${input.frontendPort}/`
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (exitResult) {
      throw new Error(
        `frontend dev server exited before smoke check: ${
          exitResult.signal ?? `exit code ${exitResult.code}`
        }\n${trimLog(logs)}`,
      )
    }
    try {
      const html = await fetchText(indexUrl, 1_000)
      if (html.includes("/src/entry.tsx")) {
        console.log(`frontend ready: ${indexUrl}`)
        return { child, getLogs: () => logs }
      }
    } catch {
      // Keep polling while Vite starts.
    }
    await sleep(100)
  }

  await stopProcessTree(child)
  throw new Error(`frontend dev server did not become ready\n${trimLog(logs)}`)
}

async function assertFrontendBrowserSmoke(input: { frontendPort: number; backendPort: number }) {
  let logs = ""
  const child = spawn(
    bun,
    [
      "-e",
      `
const { chromium } = await import("@playwright/test")
const { mkdtemp, readFile, realpath, rm } = await import("node:fs/promises")
const { tmpdir } = await import("node:os")
const { join } = await import("node:path")
const { base64Encode } = await import("@opencode-ai/core/util/encode")

async function request(path, options = {}) {
  const url = new URL(path, process.env.ATREE_BACKEND_URL)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue
    url.searchParams.set(key, String(value))
  }
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  const response = await fetch(url, {
    method: options.method ?? "GET",
    body,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(\`\${options.method ?? "GET"} \${path} failed: \${response.status} \${text}\`)
  return text ? JSON.parse(text) : undefined
}

async function readSessionJsonl(directory, sessionID, match) {
  const path = join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl")
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, "utf8")
      if (match(content)) return content
    } catch {
      // Keep polling while the runtime creates the session directory.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(\`timed out waiting for session JSONL at \${path}\`)
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch (defaultError) {
    try {
      return await chromium.launch({ channel: "chrome", headless: true })
    } catch (chromeError) {
      throw new Error(
        "Could not launch Playwright Chromium or system Chrome. " +
          "Default browser error: " +
          defaultError.message +
          "\\nSystem Chrome error: " +
          chromeError.message,
      )
    }
  }
}
const browser = await launchBrowser()
const page = await browser.newPage()
const errors = []
const backendRequests = []
let directory
page.on("pageerror", (error) => errors.push(error.message))
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text())
})
page.on("request", (request) => {
  const url = request.url()
  if (url.startsWith(process.env.ATREE_BACKEND_URL + "/")) backendRequests.push(url)
})
try {
  await page.goto(process.env.ATREE_FRONTEND_URL, { waitUntil: "domcontentloaded" })
  await page.getByText("选择一个根目录开始").first().waitFor({ timeout: 15000 })
  const title = await page.title()
  if (title !== "aTree") throw new Error(\`frontend browser smoke expected title aTree, got \${title}\`)
  if (!backendRequests.some((url) => url.endsWith("/global/health"))) {
    throw new Error("frontend browser smoke did not call the atree backend health endpoint")
  }

  directory = await realpath(await mkdtemp(join(tmpdir(), "atree-frontend-browser-")))
  const session = await request("/session", { method: "POST", query: { directory } })
  const sessionID = String(session.id)
  const message = "frontend browser prompt chain"

  await page.goto(\`\${process.env.ATREE_FRONTEND_URL}\${base64Encode(directory)}/session/\${sessionID}\`, {
    waitUntil: "domcontentloaded",
  })
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]').last()
  await editor.waitFor({ timeout: 15000 })
  await editor.click()
  await page.keyboard.type(message)
  await page.locator('[data-action="prompt-submit"]').last().click()

  await page.getByText(message).first().waitFor({ timeout: 15000 })
  await page.getByText(\`atree faux response: \${message}\`).first().waitFor({ timeout: 15000 })

  const sessionJsonl = await readSessionJsonl(
    directory,
    sessionID,
    (content) => content.includes(message) && content.includes(\`atree faux response: \${message}\`),
  )
  if (!sessionJsonl.includes('"type":"message"')) {
    throw new Error("frontend browser smoke did not persist Pi message entries to session.jsonl")
  }

  if (errors.length > 0) throw new Error(\`frontend browser smoke saw browser errors:\\n\${errors.join("\\n")}\`)
  console.log(\`frontend browser sent a prompt through aTree and persisted it under \${directory}\`)
} finally {
  await browser.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}
      `,
    ],
    {
      cwd: join(root, "packages/app"),
      env: {
        ...process.env,
        ATREE_FRONTEND_URL: `http://127.0.0.1:${input.frontendPort}/`,
        ATREE_BACKEND_URL: `http://127.0.0.1:${input.backendPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  child.stdout.on("data", (chunk) => {
    logs += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    logs += String(chunk)
  })
  const result = await waitForExit(child)
  if (result.code !== 0) {
    throw new Error(
      `frontend browser smoke failed with ${result.signal ?? `exit code ${result.code}`}\n${trimLog(logs)}`,
    )
  }
  if (logs.trim()) console.log(logs.trim())
}

async function startBackend(suite: Suite) {
  let logs = ""
  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const env = {
    ...process.env,
    ...(suite.useRuntimeDefaultExecution ? {} : { ATREE_PI_EXECUTION: "none" }),
    ...suite.backendEnv,
  }
  if (suite.useRuntimeDefaultExecution) delete env.ATREE_PI_EXECUTION

  const child = spawn(
    bun,
    ["--cwd", "packages/atree-runtime", "src/index.ts", "--hostname", "127.0.0.1", "--port", String(suite.port)],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  child.stdout.on("data", (chunk) => {
    logs += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    logs += String(chunk)
  })
  child.once("exit", (code, signal) => {
    exitResult = { code, signal }
  })

  const healthUrl = `http://127.0.0.1:${suite.port}/global/health`
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (exitResult) {
      throw new Error(
        `${suite.name} backend exited before health check: ${
          exitResult.signal ?? `exit code ${exitResult.code}`
        }\n${trimLog(logs)}`,
      )
    }

    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        console.log(`backend ready: ${healthUrl}`)
        return {
          child,
          getLogs: () => logs,
        }
      }
    } catch {
      // Keep polling until the server is ready or exits.
    }
    await sleep(100)
  }

  await stopProcess(child)
  throw new Error(`${suite.name} backend did not become healthy\n${trimLog(logs)}`)
}

async function runFrontendConnectionSmoke() {
  console.log("\n## atree frontend connection smoke")
  const backendPort = portBase + 3
  const frontendPort = portBase + 4
  const backend = await startBackend({
    name: "atree frontend smoke backend",
    port: backendPort,
    backendEnv: { ATREE_PI_EXECUTION: "faux" },
  })
  let frontend: Awaited<ReturnType<typeof startFrontendDev>> | undefined
  try {
    frontend = await startFrontendDev({ backendPort, frontendPort })
    const entry = await fetchText(`http://127.0.0.1:${frontendPort}/src/entry.tsx`)
    if (!entry.includes(`"VITE_ATREE_SERVER_HOST": "127.0.0.1"`)) {
      throw new Error("frontend dev bundle did not receive VITE_ATREE_SERVER_HOST=127.0.0.1")
    }
    if (!entry.includes(`"VITE_ATREE_SERVER_PORT": "${backendPort}"`)) {
      throw new Error(`frontend dev bundle did not receive VITE_ATREE_SERVER_PORT=${backendPort}`)
    }
    if (!entry.includes("atree.settings.dat:defaultServerUrl")) {
      throw new Error("frontend dev bundle did not use the atree server localStorage key")
    }
    const health = await fetch(`http://127.0.0.1:${backendPort}/global/health`)
    if (!health.ok) throw new Error(`frontend smoke backend health check failed: ${health.status}`)
    await assertFrontendBrowserSmoke({ frontendPort, backendPort })
    console.log(`frontend bundle points at http://127.0.0.1:${backendPort}`)
  } catch (error) {
    const frontendLogs = frontend?.getLogs()
    if (frontendLogs?.trim())
      console.error(`\n--- frontend smoke Vite log ---\n${trimLog(frontendLogs)}\n--- end Vite log ---`)
    const backendLogs = backend.getLogs()
    if (backendLogs.trim())
      console.error(`\n--- frontend smoke backend log ---\n${trimLog(backendLogs)}\n--- end backend log ---`)
    throw error
  } finally {
    if (frontend) await stopProcessTree(frontend.child)
    await stopProcess(backend.child)
  }
}

async function runRestartPersistenceSmoke() {
  console.log("\n## atree restart persistence smoke")
  const port = portBase + 5
  const baseUrl = `http://127.0.0.1:${port}`
  const directory = await mkdtemp(join(tmpdir(), "atree-restart-persistence-"))
  const globalRoot = await mkdtemp(join(tmpdir(), "atree-global-cache-"))
  const backendEnv = {
    HOME: join(globalRoot, "home"),
    OPENCODE_TEST_HOME: join(globalRoot, "opencode-home"),
    OPENCODE_CONFIG_DIR: join(globalRoot, "opencode-config"),
    PI_CODING_AGENT_DIR: join(globalRoot, "pi-agent"),
    XDG_CACHE_HOME: join(globalRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(globalRoot, "xdg-config"),
    XDG_DATA_HOME: join(globalRoot, "xdg-data"),
    XDG_STATE_HOME: join(globalRoot, "xdg-state"),
  }
  const text = "restart persistence prompt"
  const assetText = "restart persistence asset payload"
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined

  try {
    backend = await startBackend({
      name: "atree restart persistence backend",
      port,
      backendEnv,
    })

    const created = await fetchJson<Json>(baseUrl, "/session", {
      method: "POST",
      query: { directory },
    })
    const sessionID = String(created.id)

    const dueCreated = await fetchJson<Json>(baseUrl, "/session", {
      method: "POST",
      query: { directory },
    })
    const dueSessionID = String(dueCreated.id)

    await fetchJson<Json>(baseUrl, `/session/${sessionID}`, {
      method: "PATCH",
      query: { directory },
      body: {
        title: "Restart persistence session",
        metadata: {
          atree: {
            emoji: "💾",
          },
        },
      },
    })

    await fetchJson<Json>(baseUrl, `/session/${dueSessionID}`, {
      method: "PATCH",
      query: { directory },
      body: {
        title: "Restart due schedule session",
      },
    })

    const schedule = await fetchJson<Json>(baseUrl, `/session/${sessionID}/schedule`, {
      method: "POST",
      query: { directory },
      body: {
        type: "at",
        at: Date.now() + 30 * 60_000,
        message: "restart persistence scheduled message",
      },
    })

    await fetchJson<Json>(baseUrl, `/session/${dueSessionID}/schedule`, {
      method: "POST",
      query: { directory },
      body: {
        type: "at",
        at: Date.now() + 30 * 60_000,
        message: "restart due scheduled message",
      },
    })

    await fetchJson<unknown>(baseUrl, `/session/${sessionID}/prompt_async`, {
      method: "POST",
      query: { directory },
      body: {
        parts: [
          { type: "text", text },
          {
            type: "file",
            mime: "text/plain",
            filename: "restart-note.txt",
            url: `data:text/plain;base64,${Buffer.from(assetText).toString("base64")}`,
          },
        ],
      },
    })

    await stopProcess(backend.child)
    backend = undefined
    await assertNoFileContains(globalRoot, [
      { label: "session user message", value: text },
      { label: "session asset payload", value: assetText },
      { label: "pending schedule message", value: "restart persistence scheduled message" },
      { label: "due schedule message", value: "restart due scheduled message" },
    ])
    await rewriteScheduleRunAt(directory, dueSessionID, Date.now() - 1_000)
    await rm(globalRoot, { recursive: true, force: true })

    backend = await startBackend({
      name: "atree restart persistence backend after restart",
      port,
      backendEnv,
    })

    const sessions = await fetchJson<Json[]>(baseUrl, "/session", {
      query: { directory, roots: true, includeArchived: true, limit: 100 },
    })
    const restored = sessions.find((session) => session.id === sessionID)
    if (!restored) throw new Error("restart persistence smoke did not restore the created session")
    if (restored.title !== "Restart persistence session")
      throw new Error("restart persistence smoke lost session title")
    if (!isRecord(restored.metadata) || !isRecord(restored.metadata.atree) || restored.metadata.atree.emoji !== "💾") {
      throw new Error("restart persistence smoke lost session emoji metadata")
    }

    const schedules = await fetchJson<Json[]>(baseUrl, `/session/${sessionID}/schedule`, {
      query: { directory },
    })
    if (schedules.length !== 1) throw new Error("restart persistence smoke did not restore schedule metadata")
    if (schedules[0]?.id !== schedule.id) throw new Error("restart persistence smoke restored the wrong schedule")
    if (schedules[0]?.message !== "restart persistence scheduled message") {
      throw new Error("restart persistence smoke lost schedule message")
    }

    const messages = await fetchJson<Json[]>(baseUrl, `/session/${sessionID}/message`, {
      query: { directory },
    })
    const hasText = messages.some((message) => {
      if (!isRecord(message.info) || message.info.role !== "user") return false
      if (!Array.isArray(message.parts)) return false
      return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
    })
    if (!hasText) throw new Error("restart persistence smoke did not restore user message text")

    const assetRoot = join(directory, ".agents", "atree", "sessions", sessionID, "assets")
    const assets = await readdir(assetRoot)
    if (assets.length !== 1) throw new Error("restart persistence smoke expected one restored asset")
    const assetName = assets[0]!
    const assetContent = await readFile(join(assetRoot, assetName), "utf8")
    if (assetContent !== assetText) throw new Error("restart persistence smoke restored the wrong asset content")
    const hasFile = messages
      .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
      .some((part) => {
        return (
          isRecord(part) &&
          part.type === "file" &&
          part.url === `assets/${assetName}` &&
          part.filename === "restart-note.txt"
        )
      })
    if (!hasFile) throw new Error("restart persistence smoke did not restore the relative asset file part")

    const dueDeadline = Date.now() + 8_000
    let dueRan = false
    while (Date.now() < dueDeadline) {
      const dueMessages = await fetchJson<Json[]>(baseUrl, `/session/${dueSessionID}/message`, {
        query: { directory },
      })
      const hasDueMessage = dueMessages.some((message) => {
        if (!isRecord(message.info) || message.info.agent !== "automation") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some(
          (part) => isRecord(part) && part.type === "text" && part.text === "restart due scheduled message",
        )
      })
      const dueSchedules = await fetchJson<Json[]>(baseUrl, `/session/${dueSessionID}/schedule`, {
        query: { directory },
      })
      if (hasDueMessage && dueSchedules.length === 0) {
        dueRan = true
        break
      }
      await sleep(250)
    }
    if (!dueRan) throw new Error("restart persistence smoke did not run the restored overdue at schedule")

    console.log(`restart ran restored overdue schedule for session ${dueSessionID}`)
    console.log(`restart restored session ${sessionID} from ${directory}`)
  } catch (error) {
    const logs = backend?.getLogs()
    if (logs?.trim())
      console.error(`\n--- restart persistence backend log ---\n${trimLog(logs)}\n--- end backend log ---`)
    throw error
  } finally {
    if (backend) await stopProcess(backend.child)
    await rm(directory, { recursive: true, force: true })
    await rm(globalRoot, { recursive: true, force: true })
  }
}

async function runInterruptedExecutionSmoke() {
  console.log("\n## atree interrupted execution smoke")
  const port = portBase + 7
  const baseUrl = `http://127.0.0.1:${port}`
  const directory = await mkdtemp(join(tmpdir(), "atree-interrupted-execution-"))
  const globalRoot = await mkdtemp(join(tmpdir(), "atree-interrupted-global-cache-"))
  const baseEnv = {
    HOME: join(globalRoot, "home"),
    OPENCODE_TEST_HOME: join(globalRoot, "opencode-home"),
    OPENCODE_CONFIG_DIR: join(globalRoot, "opencode-config"),
    PI_CODING_AGENT_DIR: join(globalRoot, "pi-agent"),
    XDG_CACHE_HOME: join(globalRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(globalRoot, "xdg-config"),
    XDG_DATA_HOME: join(globalRoot, "xdg-data"),
    XDG_STATE_HOME: join(globalRoot, "xdg-state"),
    ATREE_PI_EXECUTION: "faux",
  }
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined

  try {
    backend = await startBackend({
      name: "atree interrupted execution backend",
      port,
      backendEnv: {
        ...baseEnv,
        ATREE_PI_FAUX_PROMPT_DELAY_MS: "10000",
      },
    })

    const created = await fetchJson<Json>(baseUrl, "/session", {
      method: "POST",
      query: { directory },
    })
    const sessionID = String(created.id)
    const durableText = "interrupted execution durable message"

    await fetchJson<Json>(baseUrl, `/session/${sessionID}`, {
      method: "PATCH",
      query: { directory },
      body: {
        title: "Interrupted execution session",
      },
    })
    await fetchJson<Json>(baseUrl, `/session/${sessionID}/message`, {
      method: "POST",
      query: { directory },
      body: {
        parts: [{ type: "text", text: durableText }],
      },
    })

    let promptSettled = false
    const promptResponse = fetch(buildUrl(baseUrl, `/session/${sessionID}/prompt_async`, { directory }), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "interrupted execution prompt" }],
      }),
    })
      .catch(() => undefined)
      .finally(() => {
        promptSettled = true
      })

    await sleep(750)
    if (promptSettled) {
      throw new Error("interrupted execution smoke expected prompt_async to still be running before shutdown")
    }

    await stopProcess(backend.child)
    backend = undefined
    await promptResponse

    backend = await startBackend({
      name: "atree interrupted execution backend after restart",
      port,
      backendEnv: baseEnv,
    })

    const sessions = await fetchJson<Json[]>(baseUrl, "/session", {
      query: { directory, roots: true, includeArchived: true, limit: 100 },
    })
    const restored = sessions.find((session) => session.id === sessionID)
    if (!restored) throw new Error("interrupted execution smoke did not restore the interrupted session")
    if (restored.title !== "Interrupted execution session") {
      throw new Error("interrupted execution smoke lost session metadata after restart")
    }

    const messages = await fetchJson<Json[]>(baseUrl, `/session/${sessionID}/message`, {
      query: { directory },
    })
    const hasDurableMessage = messages.some((message) => {
      if (!isRecord(message.info) || message.info.role !== "user") return false
      if (!Array.isArray(message.parts)) return false
      return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === durableText)
    })
    if (!hasDurableMessage) throw new Error("interrupted execution smoke lost durable user history")

    const followupText = "interrupted execution recovery followup"
    await fetchJson<unknown>(baseUrl, `/session/${sessionID}/prompt_async`, {
      method: "POST",
      query: { directory },
      body: {
        parts: [{ type: "text", text: followupText }],
      },
    })
    const recoveredMessages = await fetchJson<Json[]>(baseUrl, `/session/${sessionID}/message`, {
      query: { directory },
    })
    const hasFollowupAssistant = recoveredMessages.some((message) => {
      if (!isRecord(message.info) || message.info.role !== "assistant") return false
      if (!Array.isArray(message.parts)) return false
      return message.parts.some(
        (part) => isRecord(part) && part.type === "text" && part.text === `atree faux response: ${followupText}`,
      )
    })
    if (!hasFollowupAssistant) throw new Error("interrupted execution smoke could not continue the session after restart")

    console.log(`interrupted execution recovered session ${sessionID} from ${directory}`)
  } catch (error) {
    const logs = backend?.getLogs()
    if (logs?.trim())
      console.error(`\n--- interrupted execution backend log ---\n${trimLog(logs)}\n--- end backend log ---`)
    throw error
  } finally {
    if (backend) await stopProcess(backend.child)
    await rm(directory, { recursive: true, force: true })
    await rm(globalRoot, { recursive: true, force: true })
  }
}

async function runSuite(suite: Suite) {
  console.log(`\n## ${suite.name}`)
  const suiteHome = await mkdtemp(join(tmpdir(), "atree-contract-home-"))
  const suiteWithHome: Suite = {
    ...suite,
    backendEnv: {
      HOME: suiteHome,
      ...suite.backendEnv,
    },
  }
  const contractHome = suiteWithHome.backendEnv?.HOME ?? suiteHome
  const backend = await startBackend(suiteWithHome)
  try {
    await runCommand("contract tests", ["run", "test:contract"], {
      ATREE_CONTRACT_BASE_URL: `http://127.0.0.1:${suite.port}`,
      ATREE_CONTRACT_HOME: contractHome,
      ATREE_STORAGE_CONTRACT: "1",
      ATREE_PI_EXECUTION_CONTRACT: "",
      ATREE_PI_REAL_ERROR_CONTRACT: "",
      ATREE_PI_REAL_SUCCESS_CONTRACT: "",
      ...suite.testEnv,
    })
  } catch (error) {
    const logs = trimLog(backend.getLogs())
    if (logs.trim()) console.error(`\n--- ${suite.name} backend log ---\n${logs}\n--- end backend log ---`)
    throw error
  } finally {
    await stopProcess(backend.child)
    await suite.cleanup?.()
    await rm(suiteHome, { recursive: true, force: true })
  }
}

const realPiDir = await mkdtemp(join(tmpdir(), "atree-pi-empty-config-"))
const defaultPiDir = await mkdtemp(join(tmpdir(), "atree-pi-default-empty-config-"))

const suites: Suite[] = [
  {
    name: "atree storage contract",
    port: portBase,
  },
  {
    name: "atree Pi faux execution contract",
    port: portBase + 1,
    backendEnv: {
      ATREE_PI_EXECUTION: "faux",
    },
    testEnv: {
      ATREE_PI_EXECUTION_CONTRACT: "1",
    },
  },
  {
    name: "atree real Pi missing-config boundary contract",
    port: portBase + 2,
    backendEnv: {
      ATREE_PI_EXECUTION: "real",
      PI_CODING_AGENT_DIR: realPiDir,
    },
    testEnv: {
      ATREE_PI_REAL_ERROR_CONTRACT: "1",
    },
    cleanup: async () => {
      await rm(realPiDir, { recursive: true, force: true })
    },
  },
  {
    name: "atree default Pi missing-config boundary contract",
    port: portBase + 6,
    useRuntimeDefaultExecution: true,
    backendEnv: {
      PI_CODING_AGENT_DIR: defaultPiDir,
    },
    testEnv: {
      ATREE_PI_REAL_ERROR_CONTRACT: "1",
    },
    cleanup: async () => {
      await rm(defaultPiDir, { recursive: true, force: true })
    },
  },
]

try {
  await assertRuntimeCoreBoundary()
  for (const suite of suites) await runSuite(suite)
  await runRestartPersistenceSmoke()
  await runInterruptedExecutionSmoke()
  await runCommand("frontend build", ["--cwd", "packages/app", "build"], {
    VITE_ATREE_SERVER_PORT: "4196",
  })
  await runFrontendConnectionSmoke()
  console.log("\nAll atree guardrails passed.")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
