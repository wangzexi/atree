import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, basename, join } from "node:path";
import {
  createAgentSession,
  CURRENT_SESSION_VERSION,
  ModelRegistry,
  AuthStorage,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import { attachmentsDir, sessionFilePath, sessionsDir } from "./atree";
import type { DisplayMessage } from "./types";

interface SessionHandle {
  session: AgentSession;
  unsub: () => void;
}

const handles = new Map<string, SessionHandle>();
const listeners = new Map<string, Set<(event: unknown) => void>>();

export function subscribePiEvents(sessionId: string, listener: (event: unknown) => void): () => void {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

export function broadcastSessionEvent(sessionId: string, event: unknown): void {
  for (const listener of listeners.get(sessionId) ?? []) {
    listener(event);
  }
}

export async function getPiSession(dir: string, sessionId: string, title?: string): Promise<AgentSession> {
  const cacheKey = `${dir}:${sessionId}`;
  const existing = handles.get(cacheKey);
  if (existing) return existing.session;

  mkdirSync(sessionsDir(dir), { recursive: true });
  const file = sessionFilePath(dir, sessionId);
  const isNew = !existsSync(file);
  if (isNew) initializeSessionFile(dir, sessionId, title);
  const manager = openSessionManager(dir, sessionId);
  if (title && !manager.getSessionName()) {
    manager.appendSessionInfo(title);
  }

  ensureAtreeSkill(manager, dir);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const provider = process.env.ATREE_MODEL_PROVIDER ?? "zexi";
  const modelId = process.env.ATREE_MODEL_ID ?? "gpt-5.3-codex-spark";
  const model = modelRegistry.find(provider, modelId);

  const { session } = await createAgentSession({
    cwd: dir,
    sessionManager: manager,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: (process.env.ATREE_THINKING_LEVEL ?? "minimal") as never,
  });

  const unsub = session.subscribe((event: AgentSessionEvent) => {
    broadcastSessionEvent(sessionId, event);
  });
  handles.set(cacheKey, { session, unsub });
  return session;
}

export function initializeSessionFile(dir: string, sessionId: string, title?: string): void {
  mkdirSync(sessionsDir(dir), { recursive: true });
  const timestamp = new Date().toISOString();
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: dir,
  };
  const info = title
    ? {
        type: "session_info",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp,
        name: title,
      }
    : undefined;
  writeFileSync(
    sessionFilePath(dir, sessionId),
    [header, info].filter(Boolean).map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
}

export function readDisplayMessages(dir: string, sessionId: string): DisplayMessage[] {
  const file = sessionFilePath(dir, sessionId);
  if (!existsSync(file)) return [];
  const manager = SessionManager.open(file, sessionsDir(dir), dir);
  return manager
    .getEntries()
    .filter((entry) => entry.type === "message" || entry.type === "custom_message")
    .flatMap((entry) => {
      if (entry.type === "custom_message") {
        return [{
          id: entry.id,
          role: "system",
          text: sanitizeMessageText(typeof entry.content === "string" ? entry.content : contentToText(entry.content)),
          timestamp: Date.parse(entry.timestamp),
        }];
      }
      const message = entry.message;
      if (message.role === "toolResult") return [];
      return [{
        id: entry.id,
        role: message.role,
        text: sanitizeMessageText("content" in message ? contentToText(message.content) : contentToText(message)),
        timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp),
      }];
    })
    .filter((message) => message.text.trim());
}

export async function saveAttachment(dir: string, sessionId: string, file: File): Promise<string> {
  const targetDir = attachmentsDir(dir, sessionId);
  mkdirSync(targetDir, { recursive: true });
  const safeName = basename(file.name).replace(/[^\w.\-]+/g, "_");
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName || "attachment"}`;
  const target = join(targetDir, name);
  await Bun.write(target, file);
  return `.agents/attachments/${sessionId}/${name}`;
}

export async function attachmentRefsToImages(dir: string, refs: string[] | undefined): Promise<ImageContent[] | undefined> {
  if (!refs?.length) return undefined;
  const images: ImageContent[] = [];
  for (const ref of refs) {
    const file = Bun.file(join(dir, ref));
    if (!(await file.exists())) continue;
    const mediaType = mimeFromPath(ref);
    if (!mediaType.startsWith("image/")) continue;
    const bytes = Buffer.from(await file.arrayBuffer());
    images.push({
      type: "image",
      mimeType: mediaType,
      data: bytes.toString("base64"),
    });
  }
  return images.length ? images : undefined;
}

export async function disposePiSessions(): Promise<void> {
  for (const handle of handles.values()) {
    handle.unsub();
    handle.session.dispose();
  }
  handles.clear();
}

function ensureAtreeSkill(manager: SessionManager, dir: string): void {
  const exists = manager
    .getEntries()
    .some((entry) => entry.type === "custom_message" && entry.customType === "atree.global-skill");
  if (exists) return;

  manager.appendCustomMessageEntry(
    "atree.global-skill",
    [
      "你正在 atree-ng 的一个目录会话中工作。",
      `当前工作目录是：${dir}`,
      "默认在当前目录内读写；MVP 阶段不限制你访问其他路径，但跨目录操作需要用户明确要求。",
      "atree 只控制当前目录下的 .agents/：",
      "- .agents/atree.yaml 保存目录标题、会话列表、会话 icon 和 CRON schedule。",
      "- .agents/sessions/*.jsonl 保存 Pi 兼容会话历史。",
      "- .agents/attachments/<session-id>/ 保存会话附件。",
      "用户要求修改 title/icon/schedule 时，优先编辑 .agents/atree.yaml。",
      "用户要求初始化目录时，创建 .agents/atree.yaml、sessions、attachments、skills。",
    ].join("\n"),
    false,
    { cwd: dir },
  );
}

function openSessionManager(dir: string, sessionId: string): SessionManager {
  const file = sessionFilePath(dir, sessionId);
  if (existsSync(file) && !sessionHasAssistant(file)) {
    unlinkSync(file);
  }
  const manager = SessionManager.open(file, sessionsDir(dir), dir);
  if (!existsSync(file)) {
    const writable = manager as unknown as {
      sessionId: string;
      fileEntries: Array<{ type: string; id?: string; cwd?: string }>;
    };
    writable.sessionId = sessionId;
    const header = writable.fileEntries.find((entry) => entry.type === "session");
    if (header) {
      header.id = sessionId;
      header.cwd = dir;
    }
  }
  return manager;
}

function sessionHasAssistant(file: string): boolean {
  const raw = readFileSync(file, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.type === "message" && entry.message?.role === "assistant";
      } catch {
        return false;
      }
    });
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const typed = part as { type?: string; text?: string; path?: string };
      if (typed.type === "text") return typed.text ?? "";
      if (typed.type === "thinking") return "";
      if (typed.type === "toolCall") return "";
      if (typed.path) return `[attachment: ${typed.path}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function sanitizeMessageText(text: string): string {
  return text
    .replace(/(?:^|\n)\s*TOOLCALL\s*(?=\n|$)/gi, "\n")
    .replace(/[：:]\s*TOOLCALL\s*$/gi, "")
    .trim();
}

function mimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
