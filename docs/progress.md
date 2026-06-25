# atree 开发进度

最后更新：2026-06-26

## 当前目标

把会话聊天记录完整落地到工作目录的 `.agents/atree/sessions/<id>/session.jsonl`，让目录成为唯一事实源，摆脱对全局 SQLite 的依赖。

---

## 技术背景

- 后端：`packages/core`（V2 session runtime）+ `packages/opencode`（HTTP 服务层）
- 前端：`packages/app`（SolidJS Web UI）
- 运行方式：本地 HTTP 服务，端口 4096（后端）/ 3000（前端）
- 原底座：OpenCode，现已在 core 层重写为 V2 session runtime（SessionV2、SessionRunner、SystemContext 等）

---

## session.jsonl 落地状态

### 已完成

**写入路径（完整）**

所有关键事件均写入 `.agents/atree/sessions/<id>/session.jsonl`：

| 事件类别 | 写入 |
|---|---|
| 用户消息 | 是（`session.next.prompted` / `session.next.prompt.admitted`） |
| 助手消息 | 是（`session.next.text.*`，非 delta） |
| 工具调用 | 是（`session.next.tool.*`，非 delta） |
| 工具结果 | 是（`session.next.step.*`、`session.next.shell.*`） |
| todo 状态 | 是（`todo.updated`） |
| schedule 状态 | 是（`schedule.*`） |
| permission/question | 是（best-effort） |

写入入口：`packages/opencode/src/atree/session-store.ts` 的 `appendSessionJsonl()`，由 `event-v2-bridge.ts` 监听事件后触发。

高频 delta 类型故意跳过（避免文件膨胀）：`text.delta`、`reasoning.delta`、`tool.input.delta`、`compaction.delta`。

**读取路径（完整）**

| 操作 | 来源 |
|---|---|
| session list | 扫描目录 `meta.yaml`，全走文件 |
| session get | 读 `meta.yaml`，缺失时从 JSONL 的 `session.created` 事件恢复 |
| session messages | `readSessionJsonlProjection()` 全量重放 JSONL，无 SQLite |
| listGlobal | `readWorkspaceSessionStoresDeep()` 全局扫描，全走文件 |

HTTP API 全部基于文件读取，无 SQLite 依赖。

**Session resolver 优先级**

1. 显式 directory（精确匹配 + 深度搜索）
2. instanceDirectory（同上）
3. 全局扫描（歧义时拒绝，不猜测）

**测试覆盖**

`packages/opencode/test/atree/` 下 7 个专项测试，覆盖：
- session-store：meta.yaml 原子写、payload 文件保留
- session-resolver：歧义拒绝、instanceDirectory 优先、SQLite 不作为 hint
- todo-store / schedule-store：JSONL 重放、跨 session 隔离、版本兼容
- interaction-store：pending 恢复、copied session 独立

`packages/opencode/test/server/` 下 HTTP 端到端测试覆盖 session list/get/messages/actions/schedule。

### 残留问题

**1. core 层 projector 仍双写 SQLite（低优先级）**

`packages/core/src/session/projector.ts` 仍然把 session 消息投影到 `SessionMessageTable`，供 `SessionMessageUpdater` 在运行时维护流式 assistant 消息状态机（getCurrentAssistant / appendMessage）。

opencode 主链路不依赖这些 SQLite 写入，但 core V2 runner 内部用它维护 in-flight 的 assistant 消息状态。这是运行时关注点，不是存储事实源关注点，可后续替换为从 JSONL 重建。

**2. V1 遗留表仍在双写（待清理）**

`projector.ts` 仍然处理 `SessionV1.Event.MessageUpdated` / `SessionV1.Event.PartUpdated`，向 `MessageTable` 和 `PartTable`（V1 表）写入。file-backed session 不需要这些，但目前还没有护栏区分。

**3. schedule 有意双写（正常）**

schedule 同时写 SQLite（`ScheduleTable` / `ScheduleRunTable`，用于触发查询）和目录文件（`schedule.json` + JSONL 事件，用于事实记录）。这是有意设计，不需要改变。

**4. 缺 JSONL 完整链路集成测试（待补）**

目前没有一个测试覆盖：HTTP 发消息 → LLM 响应 → JSONL 写入 → HTTP 读回 的完整链路。

---

## 核心对象状态

| 对象 | 目录事实源 | SQLite 角色 |
|---|---|---|
| Session（元数据） | `meta.yaml` | 运行投影缓存，可丢弃 |
| Session（消息/对话） | `session.jsonl` | V2 runner 流式状态，可重建 |
| Schedule | `schedule.json` + JSONL 事件 | 触发索引，有意保留 |
| Todo | JSONL 事件（`todo.updated`） | 无 |
| Assets | `assets/` 目录 | 无 |
| Permission / Question | JSONL 事件（best-effort） | 无 |

---

## 下一步

优先级从高到低：

1. **补 JSONL 链路集成测试**：HTTP 发消息 → JSONL 写入 → HTTP 读回，锁住现有行为
2. **清理 V1 遗留表双写**：projector 里对 file-backed session 跳过 `MessageTable` / `PartTable` 写入
3. **Playwright 冒烟测试**：覆盖 选目录→开会话→发消息→设自动化→触发→header 消失 的 UI 主流程
4. **projector 运行时解耦**：将 `SessionMessageUpdater` 从 SQLite 迁移到 JSONL 重放，彻底去掉 `SessionMessageTable` 依赖
5. **收窄 HTTP 接口**：清理剩余 OpenCode 原始接口，收敛成 atree 自己的最小接口集

---

## 参考文档

- `docs/design.md` — 核心产品设计
- `docs/mvp.md` — MVP 任务书和当前实现状态
- `docs/next-implementation-plan.md` — 实施计划（部分已过时，以本文件为准）
- `docs/v2-storage-plan.md` — V2 目录存储计划
- `packages/opencode/src/atree/` — 目录事实源读写实现
- `packages/opencode/src/event-v2-bridge.ts` — JSONL 写入触发点
- `packages/core/src/session/projector.ts` — SQLite 投影器（残留双写所在）
