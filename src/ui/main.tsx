import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { AtreeNode, AtreeSessionMeta } from "../types";

interface TreeResponse {
  root: string;
  nodes: AtreeNode[];
}

interface Selection {
  node: AtreeNode;
  session?: AtreeSessionMeta;
}

interface DirectoryOption {
  name: string;
  path: string;
}

interface DirectoriesResponse {
  root: string;
  path: string;
  parent?: string;
  directories: DirectoryOption[];
}

type PiEntry = {
  type: string;
  id?: string;
  timestamp?: string;
  message?: PiMessage;
  customType?: string;
  content?: unknown;
  display?: boolean;
};

type PiMessage = {
  role: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  summary?: string;
};

type ToolExecutionEvent = {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  toolCallId: string;
  toolName: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
};

const SESSION_ICON_OPTIONS = ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🐦", "🦉", "🐢", "🐳", "🐙", "🦋", "🌿", "☕", "📚", "🧰", "💡", "✏️", "📌", "📦", "🔧", "🗂️", "💬"];

function App() {
  const [rootPath, setRootPath] = useState("");
  const [nodes, setNodes] = useState<AtreeNode[]>([]);
  const [selection, setSelection] = useState<Selection | undefined>();
  const [directoryPicker, setDirectoryPicker] = useState<DirectoriesResponse | undefined>();
  const [entries, setEntries] = useState<PiEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [archiveConfirmId, setArchiveConfirmId] = useState<string | undefined>();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [openActivityIds, setOpenActivityIds] = useState<Set<string>>(new Set());
  const [pendingUserEntries, setPendingUserEntries] = useState<PiEntry[]>([]);
  const [liveAssistantMessage, setLiveAssistantMessage] = useState<PiMessage | undefined>();
  const [liveToolEvents, setLiveToolEvents] = useState<Record<string, ToolExecutionEvent>>({});
  const [isThinking, setIsThinking] = useState(false);
  const eventSourceRef = useRef<EventSource | undefined>(undefined);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    void refreshTree();
  }, []);

  useEffect(() => {
    if (!nodes.length) void loadDirectoryOptions();
  }, [nodes.length]);

  useEffect(() => {
    resizeComposer();
  }, [draft]);

  useEffect(() => {
    eventSourceRef.current?.close();
    setEntries([]);
    setOpenActivityIds(new Set());
    setPendingUserEntries([]);
    setLiveAssistantMessage(undefined);
    setLiveToolEvents({});
    setIsThinking(false);
    if (!selection?.session) return;

    void loadPiEntries(selection.node.id, selection.session.id);
    const source = new EventSource(`/api/sessions/${selection.session.id}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "agent_start" || data.type === "turn_start") {
        setIsThinking(true);
      }
      if (data.type === "message_start" || data.type === "message_update" || data.type === "message_end") {
        if (data.message?.role === "assistant") setLiveAssistantMessage(data.message);
        if (data.assistantMessageEvent?.type === "text_start" || data.assistantMessageEvent?.type === "text_delta") {
          setIsThinking(false);
        }
      }
      if (data.type === "tool_execution_start" || data.type === "tool_execution_update") {
        setLiveToolEvents((current) => ({ ...current, [data.toolCallId]: data }));
      }
      if (data.type === "tool_execution_end") {
        setLiveToolEvents((current) => ({ ...current, [data.toolCallId]: data }));
      }
      if (data.type === "message_end" || data.type === "atree_messages_changed") {
        void loadPiEntries(selection.node.id, selection.session!.id);
        void refreshTree(false);
      }
      if (data.type === "atree_error") {
        setError(data.message);
        setIsSending(false);
      }
      if (data.type === "agent_end" || data.type === "turn_end") {
        setIsSending(false);
        setIsThinking(false);
        setLiveAssistantMessage(undefined);
        setLiveToolEvents({});
      }
    };
    eventSourceRef.current = source;
    return () => source.close();
  }, [selection?.node.id, selection?.session?.id]);

  async function refreshTree(selectFirst = true) {
    const response = await fetch("/api/tree");
    const data = (await response.json()) as TreeResponse;
    setRootPath(data.root);
    setNodes(data.nodes);
    if (selectFirst && !selection && data.nodes[0]) {
      const first = firstNode(data.nodes[0]);
      setSelection({ node: first });
      setExpandedNodeIds(new Set([first.id]));
    }
  }

  async function loadDirectoryOptions(path?: string) {
    const params = path ? `?path=${encodeURIComponent(path)}` : "";
    const response = await fetch(`/api/directories${params}`);
    if (!response.ok) {
      setError(await responseErrorMessage(response, "Load directories failed"));
      return;
    }
    setDirectoryPicker(await response.json() as DirectoriesResponse);
  }

  async function openDirectory(path: string, title?: string) {
    await fetch("/api/nodes/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, title: title || directoryName(path) }),
    });
    await refreshTree();
  }

  async function createSession(node = selection?.node) {
    if (!node) return;
    const response = await fetch(`/api/nodes/${node.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新会话" }),
    });
    const data = await response.json();
    await refreshTree(false);
    setExpandedNodeIds((current) => new Set(current).add(node.id));
    setSelection({ node, session: data.session });
  }

  async function loadPiEntries(nodeId: string, sessionId: string) {
    const response = await fetch(`/api/nodes/${nodeId}/sessions/${sessionId}/pi/entries`);
    const data = await response.json();
    const loaded = (data.entries ?? []) as PiEntry[];
    setPendingUserEntries((pending) => {
      const remaining = pending.filter((entry) => !loaded.some((item) => sameUserMessage(item, entry)));
      setEntries([...loaded, ...remaining]);
      return remaining;
    });
  }

  async function sendMessage() {
    const text = (draft || composerRef.current?.value || "").trim();
    if (!selection?.session || !text || isSending) return;
    setError(undefined);
    setIsSending(true);
    setIsThinking(true);
    const optimisticEntry: PiEntry = {
      type: "message",
      id: `optimistic-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: text,
        timestamp: Date.now(),
      },
    };
    setPendingUserEntries((current) => [...current, optimisticEntry]);
    setEntries((current) => [...current, optimisticEntry]);
    setDraft("");
    try {
      const response = await fetch(`/api/nodes/${selection.node.id}/sessions/${selection.session.id}/pi/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response, "Send failed"));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setEntries((current) => current.filter((entry) => entry.id !== optimisticEntry.id));
      setPendingUserEntries((current) => current.filter((entry) => entry.id !== optimisticEntry.id));
      setDraft(text);
      setIsSending(false);
      setIsThinking(false);
    }
  }

  function updateDraft(value: string) {
    setDraft(value);
  }

  function resizeComposer() {
    const textarea = composerRef.current;
    if (!textarea) return;
    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const paddingTop = Number.parseFloat(styles.paddingTop);
    const paddingBottom = Number.parseFloat(styles.paddingBottom);
    const maxRows = 6;
    const maxHeight = lineHeight * maxRows + paddingTop + paddingBottom;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function selectNode(node: AtreeNode) {
    setSelection({ node });
    setEditingTitle(false);
  }

  function toggleNode(node: AtreeNode) {
    selectNode(node);
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }

  async function archiveSession(node: AtreeNode, session: AtreeSessionMeta) {
    const optimistic: AtreeSessionMeta = { ...session, archived: true, updated_at: new Date().toISOString() };
    setNodes((current) => replaceSessionInNodes(current, optimistic));
    setSelection((current) => (current?.session?.id === session.id ? { node: current.node } : current));

    try {
      const response = await fetch(`/api/nodes/${node.id}/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      if (!response.ok) throw new Error(`Archive failed: ${response.status}`);
      const data = await response.json();
      const updated = { ...(data.session as AtreeSessionMeta), archived: true };
      setNodes((current) => replaceSessionInNodes(current, updated));
      setArchiveConfirmId(undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setNodes((current) => replaceSessionInNodes(current, session));
    }
  }

  async function saveSessionIcon(icon: string) {
    if (!selection?.session) return;
    setIconPickerOpen(false);
    const response = await fetch(`/api/nodes/${selection.node.id}/sessions/${selection.session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon }),
    });
    if (!response.ok) {
      setError(`Icon update failed: ${response.status}`);
      return;
    }
    const data = await response.json();
    const updated = data.session as AtreeSessionMeta;
    setSelection((current) => (current?.session?.id === updated.id ? { node: current.node, session: updated } : current));
    setNodes((current) => replaceSessionInNodes(current, updated));
  }

  function startTitleEdit() {
    if (!selection?.session) return;
    setTitleDraft(selection.session.title);
    setEditingTitle(true);
  }

  async function saveTitle() {
    if (!selection?.session || !editingTitle) return;
    const title = titleDraft.trim() || selection.session.title;
    setEditingTitle(false);
    if (title === selection.session.title) return;

    const response = await fetch(`/api/nodes/${selection.node.id}/sessions/${selection.session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = await response.json();
    const updated = data.session as AtreeSessionMeta;
    setSelection((current) => (current?.session?.id === updated.id ? { node: current.node, session: updated } : current));
    setNodes((current) => replaceSessionInNodes(current, updated));
  }

  function cancelTitleEdit() {
    setTitleDraft(selection?.session?.title ?? "");
    setEditingTitle(false);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="tree">
          {nodes.length ? (
            nodes.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                selectedId={selection?.node.id}
                selectedSessionId={selection?.session?.id}
                expandedIds={expandedNodeIds}
                onToggle={toggleNode}
                onSelectSession={(targetNode, session) => setSelection({ node: targetNode, session })}
                onCreateSession={(targetNode) => void createSession(targetNode)}
                onArchiveSession={(targetNode, session) => void archiveSession(targetNode, session)}
                archiveConfirmId={archiveConfirmId}
                onArchiveConfirmChange={setArchiveConfirmId}
              />
            ))
          ) : (
            <DirectoryPicker
              directory={directoryPicker}
              fallbackRoot={rootPath}
              onBrowse={(path) => void loadDirectoryOptions(path)}
              onOpen={(path) => void openDirectory(path)}
            />
          )}
        </div>
      </aside>

      <main className="chat">
        <header className="chat-header">
          <div className="chat-heading">
            {selection?.session && (
              <div className="chat-icon-wrap">
                <button className="chat-icon" title="设置会话 icon" onClick={() => setIconPickerOpen((open) => !open)}>
                  {selection.session.icon || "💬"}
                </button>
                {iconPickerOpen && (
                  <div className="icon-picker">
                    {SESSION_ICON_OPTIONS.map((icon) => (
                      <button key={icon} className="icon-option" onMouseDown={(event) => event.preventDefault()} onClick={() => void saveSessionIcon(icon)}>
                        {icon}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {editingTitle ? (
              <input
                className="chat-title-input"
                value={titleDraft}
                autoFocus
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTitleEdit();
                  }
                }}
              />
            ) : (
              <button className="chat-title" onClick={startTitleEdit} disabled={!selection?.session} title="点击编辑标题">
                {selection?.session?.title ?? selection?.node.title ?? "atree-ng"}
              </button>
            )}
          </div>
        </header>

        <section className="messages">
          <PiEntriesView entries={entries} openIds={openActivityIds} onToggleOpen={(id) => setOpenActivityIds((current) => toggleSetValue(current, id))} />
          {isThinking && !liveAssistantMessage && <ReasoningBlock id="live-thinking" label="正在思考" running openIds={openActivityIds} onToggleOpen={(id) => setOpenActivityIds((current) => toggleSetValue(current, id))} />}
          {liveAssistantMessage && (
            <PiMessageView
              id="live-assistant"
              message={liveAssistantMessage}
              toolResults={new Map()}
              openIds={openActivityIds}
              onToggleOpen={(id) => setOpenActivityIds((current) => toggleSetValue(current, id))}
              live
            />
          )}
          <LiveToolEventsView events={liveToolEvents} openIds={openActivityIds} onToggleOpen={(id) => setOpenActivityIds((current) => toggleSetValue(current, id))} />
          {!selection?.session && <div className="empty">展开左侧目录并选择会话，或点击加号创建新会话。</div>}
        </section>

        {error && <div className="error">{error}</div>}
        <footer className="composer">
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onInput={(event) => updateDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={selection?.session ? "输入消息" : "先创建会话"}
            disabled={!selection?.session}
          />
          <button onClick={sendMessage} disabled={!selection?.session || isSending}>
            ↑
          </button>
        </footer>
      </main>
    </div>
  );
}

function TreeNode({
  node,
  selectedId,
  selectedSessionId,
  expandedIds,
  onToggle,
  onSelectSession,
  onCreateSession,
  onArchiveSession,
  archiveConfirmId,
  onArchiveConfirmChange,
}: {
  node: AtreeNode;
  selectedId?: string;
  selectedSessionId?: string;
  expandedIds: Set<string>;
  onToggle: (node: AtreeNode) => void;
  onSelectSession: (node: AtreeNode, session: AtreeSessionMeta) => void;
  onCreateSession: (node: AtreeNode) => void;
  onArchiveSession: (node: AtreeNode, session: AtreeSessionMeta) => void;
  archiveConfirmId?: string;
  onArchiveConfirmChange: (sessionId: string | undefined) => void;
}) {
  const activeSessions = getActiveSessions(node);
  const loopSessions = getLoopSessions(node);
  const isExpanded = expandedIds.has(node.id);

  return (
    <div className="tree-node">
      <div className={node.id === selectedId ? "tree-row selected" : "tree-row"}>
        <div className="tree-main">
          <button className="tree-button" onClick={() => onToggle(node)} title={node.path}>
            <span className="tree-title">{node.title}</span>
          </button>
          {loopSessions.map((session) => (
            <button
              key={session.id}
              className={session.id === selectedSessionId ? "tree-session active" : "tree-session"}
              title={tooltip(session)}
              onClick={(event) => {
                event.stopPropagation();
                onSelectSession(node, session);
              }}
            >
              {session.icon || "💬"}
            </button>
          ))}
        </div>
        <div className="tree-actions">
          <button
            className="tree-add"
            title="新会话"
            onClick={(event) => {
              event.stopPropagation();
              onCreateSession(node);
            }}
          >
            +
          </button>
        </div>
      </div>
      {isExpanded && activeSessions.length > 0 && (
        <div className="tree-sessions">
          {activeSessions.map((session) => (
            <div key={session.id} className={session.id === selectedSessionId ? "tree-session-row active" : "tree-session-row"}>
              <button className="tree-session-title" title={tooltip(session)} onClick={() => onSelectSession(node, session)}>
                <span className="tree-session-row-icon">{session.icon || "💬"}</span>
                <span className="tree-session-row-text">{session.title}</span>
              </button>
              <button
                className={archiveConfirmId === session.id ? "tree-archive confirming" : "tree-archive"}
                title={archiveConfirmId === session.id ? "确认归档" : "归档"}
                onClick={(event) => {
                  event.stopPropagation();
                  if (archiveConfirmId === session.id) {
                    onArchiveSession(node, session);
                  } else {
                    onArchiveConfirmChange(session.id);
                  }
                }}
              >
                {archiveConfirmId === session.id ? "确认归档" : "归档"}
              </button>
            </div>
          ))}
        </div>
      )}
      {node.children.length > 0 && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              selectedSessionId={selectedSessionId}
              expandedIds={expandedIds}
              onToggle={onToggle}
              onSelectSession={onSelectSession}
              onCreateSession={onCreateSession}
              onArchiveSession={onArchiveSession}
              archiveConfirmId={archiveConfirmId}
              onArchiveConfirmChange={onArchiveConfirmChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DirectoryPicker({
  directory,
  fallbackRoot,
  onBrowse,
  onOpen,
}: {
  directory?: DirectoriesResponse;
  fallbackRoot: string;
  onBrowse: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const currentPath = directory?.path || fallbackRoot;
  return (
    <div className="directory-picker">
      <div className="directory-current" title={currentPath}>
        {currentPath || "选择目录"}
      </div>
      <button className="directory-open" onClick={() => onOpen(currentPath)} disabled={!currentPath}>
        打开此目录
      </button>
      {directory?.parent && (
        <button className="directory-row" onClick={() => onBrowse(directory.parent!)}>
          ..
        </button>
      )}
      {directory?.directories.map((item) => (
        <button key={item.path} className="directory-row" title={item.path} onClick={() => onBrowse(item.path)}>
          {item.name}
        </button>
      ))}
    </div>
  );
}

function firstNode(node: AtreeNode): AtreeNode {
  return node.sessions.length || !node.children.length ? node : firstNode(node.children[0]);
}

function tooltip(session: AtreeSessionMeta): string {
  const rows = [session.title];
  if (session.last_run_at) rows.push(`上次：${formatTime(session.last_run_at)}`);
  if (session.next_run_at) rows.push(`下次：${formatTime(session.next_run_at)}`);
  if (!session.next_run_at) rows.push(`更新：${formatTime(session.updated_at)}`);
  return rows.join("\n");
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function getActiveSessions(node: AtreeNode): AtreeSessionMeta[] {
  return node.sessions
    .filter((session) => !session.archived)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function getLoopSessions(node: AtreeNode): AtreeSessionMeta[] {
  const scheduled = node.sessions
    .filter((session) => session.schedule && !session.archived)
    .sort((a, b) => (a.next_run_at ?? "").localeCompare(b.next_run_at ?? ""));
  return scheduled;
}

function directoryName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function replaceSessionInNodes(nodes: AtreeNode[], updated: AtreeSessionMeta): AtreeNode[] {
  return nodes.map((node) => ({
    ...node,
    sessions: node.sessions.map((session) => (session.id === updated.id ? updated : session)),
    children: replaceSessionInNodes(node.children, updated),
  }));
}

function toggleSetValue(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function TextShimmer({ text }: { text: string }) {
  return (
    <span className="text-shimmer" aria-label={text}>
      <span className="text-shimmer-base" aria-hidden="true">{text}</span>
      <span className="text-shimmer-sweep" aria-hidden="true">{text}</span>
    </span>
  );
}

function PiEntriesView({
  entries,
  openIds,
  onToggleOpen,
}: {
  entries: PiEntry[];
  openIds: Set<string>;
  onToggleOpen: (id: string) => void;
}) {
  const toolResults = new Map<string, PiMessage>();
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type === "message" && message?.role === "toolResult" && message.toolCallId) {
      toolResults.set(message.toolCallId, message);
    }
  }

  return (
    <>
      {entries.map((entry, index) => (
        <PiEntryView key={entry.id ?? `${entry.type}-${index}`} entry={entry} toolResults={toolResults} openIds={openIds} onToggleOpen={onToggleOpen} />
      ))}
    </>
  );
}

function PiEntryView({
  entry,
  toolResults,
  openIds,
  onToggleOpen,
}: {
  entry: PiEntry;
  toolResults: Map<string, PiMessage>;
  openIds: Set<string>;
  onToggleOpen: (id: string) => void;
}) {
  if (entry.type === "message" && entry.message) {
    if (entry.message.role === "toolResult") return null;
    return <PiMessageView id={entry.id ?? crypto.randomUUID()} message={entry.message} toolResults={toolResults} openIds={openIds} onToggleOpen={onToggleOpen} />;
  }
  if (entry.type === "custom_message" && entry.display) {
    return <TextMessage role="assistant" text={contentText(entry.content)} />;
  }
  if (entry.type === "compaction") {
    return <ReasoningBlock id={entry.id ?? "compaction"} label="上下文压缩" detail={readableObjectField(entry, "summary")} openIds={openIds} onToggleOpen={onToggleOpen} />;
  }
  return null;
}

function PiMessageView({
  id,
  message,
  toolResults,
  openIds,
  onToggleOpen,
  live = false,
}: {
  id: string;
  message: PiMessage;
  toolResults: Map<string, PiMessage>;
  openIds: Set<string>;
  onToggleOpen: (id: string) => void;
  live?: boolean;
}) {
  if (message.role === "user") return <TextMessage role="user" text={contentText(message.content)} />;
  if (message.role === "bashExecution") {
    return (
      <ToolBlock
        id={id}
        toolName="bash"
        args={{ command: message.command }}
        output={message.output}
        status={message.exitCode ? "error" : "done"}
        openIds={openIds}
        onToggleOpen={onToggleOpen}
      />
    );
  }
  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    return <ReasoningBlock id={id} label="上下文摘要" detail={message.summary} openIds={openIds} onToggleOpen={onToggleOpen} />;
  }
  if (message.role !== "assistant") return null;

  const parts = contentParts(message.content);
  return (
    <>
      {parts.map((part, index) => {
        const blockId = `${id}-${index}`;
        if (part.type === "text") return <TextMessage key={blockId} role="assistant" text={readableObjectField(part, "text") ?? ""} />;
        if (part.type === "thinking") {
          return (
            <ReasoningBlock
              key={blockId}
              id={blockId}
              label={live ? "正在思考" : "思考"}
              detail={readableObjectField(part, "thinking")}
              running={live}
              openIds={openIds}
              onToggleOpen={onToggleOpen}
            />
          );
        }
        if (part.type === "toolCall") {
          const toolCallId = readableObjectField(part, "id") || blockId;
          const toolResult = toolResults.get(toolCallId);
          return (
            <ToolBlock
              key={blockId}
              id={toolCallId}
              toolName={readableObjectField(part, "name") || "tool"}
              args={objectField(part, "arguments")}
              output={toolResult ? contentText(toolResult.content) : undefined}
              status={toolResult?.isError ? "error" : live ? "running" : "done"}
              openIds={openIds}
              onToggleOpen={onToggleOpen}
            />
          );
        }
        if (part.type === "image") return <TextMessage key={blockId} role="assistant" text="[image]" />;
        return null;
      })}
    </>
  );
}

function LiveToolEventsView({
  events,
  openIds,
  onToggleOpen,
}: {
  events: Record<string, ToolExecutionEvent>;
  openIds: Set<string>;
  onToggleOpen: (id: string) => void;
}) {
  return (
    <>
      {Object.values(events).map((event) => (
        <ToolBlock
          key={event.toolCallId}
          id={`live-${event.toolCallId}`}
          toolName={event.toolName}
          args={event.args}
          output={contentText((event.result ?? event.partialResult) as unknown)}
          status={event.type === "tool_execution_end" ? (event.isError ? "error" : "done") : "running"}
          openIds={openIds}
          onToggleOpen={onToggleOpen}
        />
      ))}
    </>
  );
}

function TextMessage({ role, text }: { role: "user" | "assistant"; text: string }) {
  if (!text.trim()) return null;
  return (
    <article className={`message ${role}`}>
      <div className="message-body">{text}</div>
    </article>
  );
}

function ReasoningBlock({
  id,
  label,
  detail,
  running = false,
  openIds,
  onToggleOpen,
}: {
  id: string;
  label: string;
  detail?: string;
  running?: boolean;
  openIds: Set<string>;
  onToggleOpen: (id: string) => void;
}) {
  const isOpen = openIds.has(id);
  return (
    <div className={`activity-item ${running ? "running" : "done"} thinking`}>
      <button className="activity-trigger" onClick={() => onToggleOpen(id)} title={isOpen ? "折叠" : "展开"}>
        <span className="activity-chevron">{isOpen ? "⌄" : "›"}</span>
        <span className="activity-label">{running ? <TextShimmer text={label} /> : label}</span>
        {detail && <span className="activity-summary">{summarizeLine(detail)}</span>}
      </button>
      {detail && isOpen && (
        <div className="activity-detail">
          <pre>{detail}</pre>
        </div>
      )}
    </div>
  );
}

function ToolBlock({
  id,
  toolName,
  args,
  output,
  status,
  openIds,
  onToggleOpen,
}: {
  id: string;
  toolName: string;
  args: unknown;
  output?: string;
  status: "running" | "done" | "error";
  openIds: Set<string>;
  onToggleOpen: (id: string) => void;
}) {
  const isOpen = openIds.has(id);
  const detail = toolDetail(toolName, args);
  return (
    <div className={`activity-item ${status} tool`}>
      <button className="activity-trigger" onClick={() => onToggleOpen(id)} title={isOpen ? "折叠" : "展开"}>
        <span className="activity-chevron">{isOpen ? "⌄" : "›"}</span>
        <span className="activity-label">{status === "running" ? <TextShimmer text={runningToolLabel(toolName, args)} /> : doneToolLabel(toolName, status)}</span>
        {detail && <span className="activity-summary">{summarizeLine(detail)}</span>}
      </button>
      {(detail || output) && isOpen && (
        <div className="activity-detail">
          {detail && (
            <div className="activity-section">
              <div className="activity-section-label">输入</div>
              <pre>{detail}</pre>
            </div>
          )}
          {output && (
            <div className="activity-section">
              <div className="activity-section-label">输出</div>
              <pre>{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function sameUserMessage(a: PiEntry, b: PiEntry): boolean {
  return a.type === "message" && b.type === "message" && a.message?.role === "user" && b.message?.role === "user" && contentText(a.message.content) === contentText(b.message.content);
}

function contentParts(content: unknown): Array<Record<string, unknown> & { type?: string }> {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Record<string, unknown> & { type?: string } => Boolean(part && typeof part === "object"));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const typed = part as Record<string, unknown>;
        if (typed.type === "text") return readableObjectField(typed, "text");
        if (typed.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && Array.isArray((content as { content?: unknown }).content)) {
    return contentText((content as { content: unknown }).content);
  }
  return "";
}

function runningToolLabel(toolName: string, args: unknown): string {
  if (toolName === "bash") return "正在运行命令";
  if (isEditTool(toolName)) return `正在编辑${toolPath(args) ? "文件" : ""}`;
  if (toolName === "write") return `正在写入${toolPath(args) ? "文件" : ""}`;
  if (toolName === "read") return "正在读取文件";
  if (toolName === "grep" || toolName === "find" || toolName === "ls") return "正在检索";
  return `正在执行工具：${toolName}`;
}

function doneToolLabel(toolName: string, status: "running" | "done" | "error"): string {
  const done = status === "error" ? "执行失败" : "已完成";
  if (toolName === "bash") return status === "error" ? "命令运行失败" : "命令运行完成";
  if (isEditTool(toolName) || toolName === "write") return status === "error" ? "文件编辑失败" : "已编辑文件";
  if (toolName === "read") return `${done}读取`;
  if (toolName === "grep" || toolName === "find" || toolName === "ls") return `${done}检索`;
  return `${done}工具：${toolName}`;
}

function toolDetail(toolName: string, args: unknown): string | undefined {
  if (toolName === "bash") return readableObjectField(args, "command") || readableObjectField(args, "cmd") || stringifyJson(args);
  const path = toolPath(args);
  if (path) return path;
  const query = readableObjectField(args, "query") || readableObjectField(args, "pattern") || readableObjectField(args, "glob");
  if (query) return query;
  return stringifyJson(args);
}

function toolPath(args: unknown): string | undefined {
  return readableObjectField(args, "path") || readableObjectField(args, "filePath") || readableObjectField(args, "file_path") || readableObjectField(args, "filename") || readableObjectField(args, "target");
}

function isEditTool(toolName: string): boolean {
  return toolName === "edit" || toolName === "apply_patch" || toolName.toLowerCase().includes("edit");
}

function objectField(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[field];
}

function readableObjectField(value: unknown, field: string): string | undefined {
  const fieldValue = objectField(value, field);
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue : undefined;
}

function summarizeLine(text: string): string {
  const first = text.trim().split("\n").find(Boolean);
  if (!first) return "";
  return first.length > 80 ? `${first.slice(0, 80)}...` : first;
}

function stringifyJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = JSON.stringify(value, null, 2);
    return text === "{}" ? undefined : text;
  } catch {
    return String(value);
  }
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
  return body?.error ? `${fallback}: ${body.error}` : `${fallback}: ${response.status}`;
}

createRoot(document.getElementById("root")!).render(<App />);
