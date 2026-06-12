import React, { useEffect, useMemo, useRef, useState } from "react";
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

function App() {
  const [rootPath, setRootPath] = useState("");
  const [nodes, setNodes] = useState<AtreeNode[]>([]);
  const [selection, setSelection] = useState<Selection | undefined>();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const eventSourceRef = useRef<EventSource | undefined>(undefined);

  useEffect(() => {
    void refreshTree();
  }, []);

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

  const visibleSessions = useMemo(() => {
    if (!selection?.node) return [];
    const scheduled = selection.node.sessions
      .filter((session) => session.schedule)
      .sort((a, b) => (a.next_run_at ?? "").localeCompare(b.next_run_at ?? ""));
    const normal = selection.node.sessions
      .filter((session) => !session.schedule)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return [...scheduled, ...normal.slice(0, 1)];
  }, [selection?.node]);

  async function refreshTree(selectFirst = true) {
    const response = await fetch("/api/tree");
    const data = (await response.json()) as TreeResponse;
    setRootPath(data.root);
    setNodes(data.nodes);
    if (selectFirst && !selection && data.nodes[0]) {
      const first = firstNode(data.nodes[0]);
      setSelection({ node: first, session: first.sessions[0] });
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

  async function createSession() {
    if (!selection?.node) return;
    const response = await fetch(`/api/nodes/${selection.node.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新会话" }),
    });
    const data = await response.json();
    await refreshTree(false);
    setSelection({ node: selection.node, session: data.session });
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
    setDraft("");
    await fetch(`/api/nodes/${selection.node.id}/sessions/${selection.session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  function selectNode(node: AtreeNode) {
    setSelection({ node, session: node.sessions[0] });
  }

  function selectSession(session: AtreeSessionMeta) {
    if (!selection?.node) return;
    setSelection({ node: selection.node, session });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">目录</div>
        <div className="root-path" title={rootPath}>
          {rootPath || "未连接"}
        </div>
        <div className="tree">
          {nodes.length ? (
            nodes.map((node) => <TreeNode key={node.id} node={node} selectedId={selection?.node.id} onSelect={selectNode} />)
          ) : (
            <button className="init-button" onClick={initRoot}>
              初始化根目录
            </button>
          )}
        </div>
      </aside>

      <main className="chat">
        <header className="chat-header">
          <div>
            <div className="chat-title">{selection?.session?.title ?? selection?.node.title ?? "atree-ng"}</div>
            <div className="chat-subtitle">{selection?.node.path ?? "选择一个 .agents/atree.yaml 目录"}</div>
          </div>
          {selection?.node && (
            <div className="session-icons">
              {visibleSessions.map((session) => (
                <button
                  key={session.id}
                  className={session.id === selection.session?.id ? "session-icon active" : "session-icon"}
                  title={tooltip(session)}
                  onClick={() => selectSession(session)}
                >
                  {session.icon || "◌"}
                </button>
              ))}
              {selection.node.sessions.length > visibleSessions.length && (
                <button className="session-icon" title={selection.node.sessions.map((session) => session.title).join("\n")}>
                  …
                </button>
              )}
              <button className="new-session" onClick={createSession} title="新会话">
                +
              </button>
            </div>
          )}
        </header>

        <section className="messages">
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-role">{roleLabel(message.role)}</div>
              <div className="message-body">{message.text}</div>
            </article>
          ))}
          {streamText && (
            <article className="message assistant">
              <div className="message-role">assistant</div>
              <div className="message-body">{streamText}</div>
            </article>
          )}
          {!selection?.session && <div className="empty">选择目录后创建或打开一个会话。</div>}
        </section>

        {error && <div className="error">{error}</div>}
        <footer className="composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
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

function TreeNode({ node, selectedId, onSelect }: { node: AtreeNode; selectedId?: string; onSelect: (node: AtreeNode) => void }) {
  return (
    <div className="tree-node">
      <button className={node.id === selectedId ? "tree-button selected" : "tree-button"} onClick={() => onSelect(node)}>
        <span className="folder">▱</span>
        <span>{node.title}</span>
      </button>
      {node.children.length > 0 && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} />
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

function roleLabel(role: string): string {
  if (role === "assistant") return "assistant";
  if (role === "user") return "you";
  return role;
}

createRoot(document.getElementById("root")!).render(<App />);
