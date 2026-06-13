import { dirname, join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import {
  decodeNodeId,
  ensureAtreeDirectory,
  encodeNodeId,
  patchSessionMeta,
  readAtreeConfig,
  scanAtreeTree,
  sessionFilePath,
  upsertSessionMeta,
} from "./atree";
import {
  attachmentRefsToImages,
  broadcastSessionEvent,
  getPiSession,
  initializeSessionFile,
  readSessionEntries,
  saveAttachment,
  subscribePiEvents,
} from "./pi";
import { startScheduler } from "./scheduler";
import type { AtreeSessionMeta } from "./types";

const root = resolve(getArg("--root") ?? process.env.ATREE_ROOT ?? process.cwd());
const port = Number(getArg("--port") ?? process.env.PORT ?? 8787);
const serveDist = process.argv.includes("--serve-dist");

ensureInsideRoot(root, root);
const stopScheduler = startScheduler(root);

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  idleTimeout: 255,
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, url);
      if (serveDist) return await serveStatic(url);
      return json({ ok: true, root, ui: "run `bun run dev` for the React UI" });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});

process.on("SIGINT", () => {
  stopScheduler();
  server.stop();
  process.exit(0);
});

console.log(`atree-ng API listening on http://0.0.0.0:${port}`);
console.log(`root: ${root}`);

async function handleApi(request: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, root });
  }

  if (request.method === "GET" && url.pathname === "/api/tree") {
    return json({ root, nodes: scanAtreeTree(root) });
  }

  if (request.method === "GET" && url.pathname === "/api/directories") {
    const target = resolve(url.searchParams.get("path") ?? root);
    ensureInsideRoot(root, target);
    return json(readDirectoryOptions(target));
  }

  if (request.method === "POST" && url.pathname === "/api/nodes/init") {
    const body = await request.json().catch(() => ({})) as { path?: string; title?: string };
    const target = resolve(body.path ?? root);
    ensureInsideRoot(root, target);
    const config = ensureAtreeDirectory(target, body.title);
    return json({ node: { id: encodeNodeId(target), path: target, config } });
  }

  if (parts[1] === "nodes" && parts[2]) {
    const dir = decodeNodeId(parts[2]);
    ensureInsideRoot(root, dir);

    if (request.method === "GET" && parts.length === 4 && parts[3] === "sessions") {
      return json({ sessions: readAtreeConfig(dir).sessions });
    }

    if (request.method === "POST" && parts.length === 4 && parts[3] === "sessions") {
      ensureAtreeDirectory(dir);
      const body = await request.json().catch(() => ({})) as { title?: string; icon?: string };
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const title = body.title?.trim() || "新会话";
      const meta: AtreeSessionMeta = {
        id,
        title,
        icon: body.icon?.trim() || undefined,
        updated_at: now,
      };
      upsertSessionMeta(dir, meta);
      initializeSessionFile(dir, id, title);
      return json({ session: meta });
    }

    if (parts.length >= 5 && parts[3] === "sessions") {
      const sessionId = parts[4];
      const action = parts[5];

      if (request.method === "PATCH" && parts.length === 5) {
        const body = await request.json().catch(() => ({})) as Partial<AtreeSessionMeta>;
        const patch: Partial<AtreeSessionMeta> = {};
        if ("title" in body) patch.title = body.title;
        if ("icon" in body) patch.icon = body.icon;
        if ("schedule" in body) patch.schedule = body.schedule;
        if ("archived" in body) patch.archived = body.archived;
        const meta = patchSessionMeta(dir, sessionId, patch);
        return json({ session: meta });
      }

      if (request.method === "GET" && (action === "messages" || (action === "pi" && parts[6] === "entries"))) {
        return json({ entries: readSessionEntries(dir, sessionId) });
      }

      if (request.method === "POST" && (action === "messages" || (action === "pi" && parts[6] === "prompt"))) {
        const body = await request.json().catch(() => ({})) as { text?: string; attachments?: string[] };
        const text = body.text?.trim();
        if (!text) return json({ error: "message text is required" }, 400);
        const config = readAtreeConfig(dir);
        const meta = config.sessions.find((session) => session.id === sessionId);
        if (!meta) return json({ error: "session not found" }, 404);

        void runPrompt(dir, sessionId, text, body.attachments);
        return json({ accepted: true });
      }

      if (request.method === "POST" && action === "attachments") {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return json({ error: "file is required" }, 400);
        const ref = await saveAttachment(dir, sessionId, file);
        return json({ ref });
      }
    }
  }

  if (request.method === "GET" && parts[1] === "sessions" && parts[2] && parts[3] === "events") {
    const sessionId = parts[2];
    return eventStream(sessionId);
  }

  return json({ error: "not found" }, 404);
}

async function runPrompt(dir: string, sessionId: string, text: string, attachmentRefs?: string[]): Promise<void> {
  try {
    const meta = readAtreeConfig(dir).sessions.find((session) => session.id === sessionId);
    const session = await getPiSession(dir, sessionId, meta?.title);
    const images = await attachmentRefsToImages(dir, attachmentRefs);
    if (session.isStreaming) {
      await session.prompt(text, { images, streamingBehavior: "followUp" });
    } else {
      await session.prompt(text, { images });
    }
    patchSessionMeta(dir, sessionId, { updated_at: new Date().toISOString() });
    broadcastSessionEvent(sessionId, { type: "atree_messages_changed" });
  } catch (error) {
    broadcastSessionEvent(sessionId, {
      type: "atree_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function eventStream(sessionId: string): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      unsubscribe = subscribePiEvents(sessionId, send);
      ping = setInterval(() => send({ type: "atree_ping", timestamp: new Date().toISOString() }), 15_000);
      send({ type: "atree_connected", sessionId });
    },
    cancel() {
      if (ping) clearInterval(ping);
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function serveStatic(url: URL): Promise<Response> {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = Bun.file(join(process.cwd(), "dist", pathname));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(process.cwd(), "dist", "index.html")));
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function ensureInsideRoot(base: string, target: string): void {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(`${resolvedBase}/`)) {
    throw new Error(`Path is outside root: ${target}`);
  }
}

function readDirectoryOptions(path: string) {
  const resolvedPath = resolve(path);
  const directories = readdirSync(resolvedPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const fullPath = join(resolvedPath, entry.name);
      return { name: entry.name, path: fullPath };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    root,
    path: resolvedPath,
    parent: resolvedPath === root ? undefined : dirname(resolvedPath),
    directories,
  };
}
