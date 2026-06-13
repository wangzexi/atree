import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { AtreeNode, AtreeSessionMeta, DisplayMessage } from "../types";

interface TreeResponse {
  root: string;
  nodes: AtreeNode[];
}

interface Selection {
  node: AtreeNode;
  session?: AtreeSessionMeta;
}

const SESSION_ICON_OPTIONS = ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🐦", "🦉", "🐢", "🐳", "🐙", "🦋", "🌿", "☕", "📚", "🧰", "💡", "✏️", "📌", "📦", "🔧", "🗂️", "💬"];

function App() {
  const [rootPath, setRootPath] = useState("");
  const [nodes, setNodes] = useState<AtreeNode[]>([]);
  const [selection, setSelection] = useState<Selection | undefined>();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [archiveConfirmId, setArchiveConfirmId] = useState<string | undefined>();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const eventSourceRef = useRef<EventSource | undefined>(undefined);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    void refreshTree();
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [draft]);

  useEffect(() => {
    eventSourceRef.current?.close();
    setMessages([]);
    setStreamText("");
    if (!selection?.session) return;

    void loadMessages(selection.node.id, selection.session.id);
    const source = new EventSource(`/api/sessions/${selection.session.id}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "message_update" && data.assistantMessageEvent?.type === "text_delta") {
        setStreamText((text) => text + data.assistantMessageEvent.delta);
      }
      if (data.type === "message_end" || data.type === "atree_messages_changed") {
        setStreamText("");
        void loadMessages(selection.node.id, selection.session!.id);
        void refreshTree(false);
      }
      if (data.type === "atree_error") {
        setError(data.message);
        setIsSending(false);
      }
      if (data.type === "agent_end" || data.type === "turn_end") {
        setIsSending(false);
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

  async function initRoot() {
    await fetch("/api/nodes/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: rootPath || undefined, title: "我的 atree" }),
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

  async function loadMessages(nodeId: string, sessionId: string) {
    const response = await fetch(`/api/nodes/${nodeId}/sessions/${sessionId}/messages`);
    const data = await response.json();
    setMessages(data.messages ?? []);
  }

  async function sendMessage() {
    if (!selection?.session || !draft.trim() || isSending) return;
    setError(undefined);
    setIsSending(true);
    const text = draft;
    const optimisticMessage: DisplayMessage = {
      id: `optimistic-${crypto.randomUUID()}`,
      role: "user",
      text,
      timestamp: Date.now(),
    };
    setMessages((current) => [...current, optimisticMessage]);
    setDraft("");
    try {
      const response = await fetch(`/api/nodes/${selection.node.id}/sessions/${selection.session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`Send failed: ${response.status}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setMessages((current) => current.filter((message) => message.id !== optimisticMessage.id));
      setDraft(text);
      setIsSending(false);
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
            <button className="init-button" onClick={initRoot}>
              初始化根目录
            </button>
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
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-body">{message.text}</div>
            </article>
          ))}
          {streamText && (
            <article className="message assistant">
              <div className="message-body">{streamText}</div>
            </article>
          )}
          {!selection?.session && <div className="empty">展开左侧目录并选择会话，或点击加号创建新会话。</div>}
        </section>

        {error && <div className="error">{error}</div>}
        <footer className="composer">
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={selection?.session ? "输入消息" : "先创建会话"}
            disabled={!selection?.session}
          />
          <button onClick={sendMessage} disabled={!selection?.session || !draft.trim() || isSending}>
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

function replaceSessionInNodes(nodes: AtreeNode[], updated: AtreeSessionMeta): AtreeNode[] {
  return nodes.map((node) => ({
    ...node,
    sessions: node.sessions.map((session) => (session.id === updated.id ? updated : session)),
    children: replaceSessionInNodes(node.children, updated),
  }));
}

createRoot(document.getElementById("root")!).render(<App />);
