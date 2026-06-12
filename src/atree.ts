import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { CronExpressionParser } from "cron-parser";
import type { AtreeConfig, AtreeNode, AtreeSessionMeta } from "./types";

const AGENTS_DIR = ".agents";
const CONFIG_FILE = "atree.yaml";

export function encodeNodeId(path: string): string {
  return Buffer.from(resolve(path)).toString("base64url");
}

export function decodeNodeId(id: string): string {
  return Buffer.from(id, "base64url").toString("utf8");
}

export function agentsDir(dir: string): string {
  return join(dir, AGENTS_DIR);
}

export function atreeConfigPath(dir: string): string {
  return join(agentsDir(dir), CONFIG_FILE);
}

export function sessionsDir(dir: string): string {
  return join(agentsDir(dir), "sessions");
}

export function attachmentsDir(dir: string, sessionId?: string): string {
  return sessionId ? join(agentsDir(dir), "attachments", sessionId) : join(agentsDir(dir), "attachments");
}

export function skillsDir(dir: string): string {
  return join(agentsDir(dir), "skills");
}

export function sessionFilePath(dir: string, sessionId: string): string {
  return join(sessionsDir(dir), `${sessionId}.jsonl`);
}

export function ensureAtreeDirectory(dir: string, title = basename(dir)): AtreeConfig {
  mkdirSync(sessionsDir(dir), { recursive: true });
  mkdirSync(attachmentsDir(dir), { recursive: true });
  mkdirSync(skillsDir(dir), { recursive: true });

  const configPath = atreeConfigPath(dir);
  if (existsSync(configPath)) return readAtreeConfig(dir);

  const config: AtreeConfig = { version: 1, title, sessions: [] };
  writeAtreeConfig(dir, config);
  return config;
}

export function readAtreeConfig(dir: string): AtreeConfig {
  const configPath = atreeConfigPath(dir);
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const parsed = raw.trim() ? YAML.parse(raw) : {};
  return normalizeConfig(parsed, basename(dir));
}

export function writeAtreeConfig(dir: string, config: AtreeConfig): void {
  mkdirSync(agentsDir(dir), { recursive: true });
  writeFileSync(atreeConfigPath(dir), YAML.stringify(config), "utf8");
}

export function upsertSessionMeta(dir: string, meta: AtreeSessionMeta): AtreeConfig {
  const config = readAtreeConfig(dir);
  const next = config.sessions.filter((session) => session.id !== meta.id);
  next.push(meta);
  config.sessions = next;
  writeAtreeConfig(dir, config);
  return config;
}

export function patchSessionMeta(
  dir: string,
  sessionId: string,
  patch: Partial<Pick<AtreeSessionMeta, "title" | "icon" | "schedule" | "last_run_at" | "next_run_at" | "updated_at">>,
): AtreeSessionMeta {
  const config = readAtreeConfig(dir);
  const session = config.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  if ("title" in patch && patch.title !== undefined) session.title = patch.title;
  if ("icon" in patch) session.icon = patch.icon || undefined;
  if ("schedule" in patch) {
    session.schedule = patch.schedule || undefined;
    session.next_run_at = session.schedule ? nextRunAt(session.schedule) : undefined;
  }
  if ("last_run_at" in patch) session.last_run_at = patch.last_run_at;
  if ("next_run_at" in patch) session.next_run_at = patch.next_run_at;
  session.updated_at = patch.updated_at ?? new Date().toISOString();

  writeAtreeConfig(dir, config);
  return session;
}

export function findSession(root: string, sessionId: string): { dir: string; meta: AtreeSessionMeta } | undefined {
  const nodes = flattenNodes(scanAtreeTree(root));
  for (const node of nodes) {
    const meta = node.sessions.find((session) => session.id === sessionId);
    if (meta) return { dir: node.path, meta };
  }
  return undefined;
}

export function scanAtreeTree(root: string): AtreeNode[] {
  const rootPath = resolve(root);
  const managed = scanManagedDirectories(rootPath);
  const roots: AtreeNode[] = [];

  for (const dir of managed) {
    const config = readAtreeConfig(dir);
    const parts = relative(rootPath, dir).split(sep).filter(Boolean);

    if (parts.length === 0) {
      upsertTreeNode(roots, rootPath, config.title, config.sessions);
      continue;
    }

    let currentPath = rootPath;
    let siblings = roots;
    for (let index = 0; index < parts.length; index += 1) {
      currentPath = join(currentPath, parts[index]);
      const isLeaf = index === parts.length - 1;
      const node = upsertTreeNode(siblings, currentPath, isLeaf ? config.title : parts[index], isLeaf ? config.sessions : []);
      siblings = node.children;
    }
  }

  sortTree(roots);
  return roots;
}

export function flattenNodes(nodes: AtreeNode[]): AtreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

export function nextRunAt(expression: string, currentDate = new Date()): string {
  return CronExpressionParser.parse(expression, { currentDate }).next().toDate().toISOString();
}

function normalizeConfig(value: unknown, fallbackTitle: string): AtreeConfig {
  const input = (value && typeof value === "object" ? value : {}) as Partial<AtreeConfig>;
  const sessions = Array.isArray(input.sessions) ? input.sessions.map(normalizeSession).filter(Boolean) : [];
  return {
    version: 1,
    title: typeof input.title === "string" && input.title.trim() ? input.title : fallbackTitle,
    sessions: sessions as AtreeSessionMeta[],
  };
}

function normalizeSession(value: unknown): AtreeSessionMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<AtreeSessionMeta>;
  if (!input.id || typeof input.id !== "string") return undefined;
  return {
    id: input.id,
    title: typeof input.title === "string" && input.title.trim() ? input.title : "未命名会话",
    icon: typeof input.icon === "string" && input.icon.trim() ? input.icon : undefined,
    schedule: typeof input.schedule === "string" && input.schedule.trim() ? input.schedule : undefined,
    last_run_at: typeof input.last_run_at === "string" ? input.last_run_at : undefined,
    next_run_at: typeof input.next_run_at === "string" ? input.next_run_at : undefined,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : new Date().toISOString(),
  };
}

function scanManagedDirectories(root: string): string[] {
  const result: string[] = [];
  const ignored = new Set(["node_modules", ".git", "dist", "build", "target"]);

  function walk(dir: string): void {
    if (existsSync(atreeConfigPath(dir))) result.push(dir);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignored.has(entry)) continue;
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
    }
  }

  walk(root);
  return result;
}

function makeNode(path: string, title: string, sessions: AtreeSessionMeta[]): AtreeNode {
  return {
    id: encodeNodeId(path),
    name: basename(path),
    path,
    title,
    sessions,
    children: [],
  };
}

function upsertTreeNode(siblings: AtreeNode[], path: string, title: string, sessions: AtreeSessionMeta[]): AtreeNode {
  const id = encodeNodeId(path);
  let node = siblings.find((item) => item.id === id);
  if (!node) {
    node = makeNode(path, title, sessions);
    siblings.push(node);
  } else {
    node.title = title;
    node.sessions = sessions;
  }
  return node;
}

function sortTree(nodes: AtreeNode[]): void {
  nodes.sort(sortNodes);
  for (const node of nodes) sortTree(node.children);
}

function sortNodes(a: AtreeNode, b: AtreeNode): number {
  return a.title.localeCompare(b.title, "zh-Hans-CN");
}
