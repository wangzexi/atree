# atree 第二版存储计划

本文档记录第二版要调整的核心方向：会话记录必须成为当前目录数据的一部分。

这个方向比 UI 细节更重要。atree 的核心不是做一个带目录树的聊天工具，而是让目录本身成为 AI 可以工作、记忆和迁移的工作区。

## 核心判断

会话不是全局应用数据。会话是在某个目录里发生过的工作。

因此：

```text
目录 = 信息上下文
会话 = 在该上下文中发生的工作
会话记录 = 目录数据的一部分
```

atree 第二版应把业务事实源放回目录自身的 `.agents/atree/` 下。一个目录被复制、同步或迁移时，它的 AI 工作历史、自动化设置、多媒体资产也应该一起走。

## 存储原则

### 1. 不依赖全局业务数据库

atree 不应该把会话、自动化和执行历史的唯一事实源放进全局数据库。

允许存在的全局内容只包括：

- 本机配置
- API Key 或密钥引用
- 最近打开记录
- 可重建缓存
- 可重建索引

这些内容丢失后，不应该导致任何目录里的会话、自动化消息或工作历史丢失。

### 2. `.agents/` 是通用 Agent 目录

`.agents/` 不是 atree 的私有目录，而是通用 Agent 生态目录。

它可以放不同 Agent 工具共享或各自管理的内容：

```text
some-directory/
  .agents/
    skills/        # 通用 Agent Skill
    atree/         # atree 私有事实源
```

`README.md`、业务文件、普通资料目录仍由用户自己决定。

atree 只控制 `.agents/atree/`。`skills/` 保留在 `.agents/` 根下，因为它是通用 Agent 能力，不应该绑死 atree。

边界原则：

- 通用 Agent 能力放在 `.agents/` 根下，例如 `.agents/skills/`。
- atree 专属协议、索引、会话、自动化和资产事实源全部放进 `.agents/atree/`。
- 不在 `.agents/` 根目录散放 atree 私有文件。

### 3. `.agents/atree/` 是 atree 事实源

每个被 atree 管理的目录都可以有：

```text
some-directory/
  .agents/
    skills/
      ...
    atree/
      meta.yaml
      sessions/
```

### 4. 每个会话是自包含目录

第二版不再使用：

```text
.agents/
  atree.yaml
  sessions/
    <session-id>.jsonl
  attachments/
    <session-id>/
```

而是使用：

```text
.agents/
  atree/
    meta.yaml
    sessions/
      <session-id>/
        meta.yaml
        session.jsonl
        assets/
```

这样每个会话都是一个自包含的工作现场。

## 会话目录结构

### `meta.yaml`

保存会话当前状态。

示例：

```yaml
version: 1
id: 01JABC...
title: 每日整理
icon: 🦊
created_at: 2026-06-15T10:00:00+08:00
updated_at: 2026-06-15T10:30:00+08:00
archived_at: null

schedule:
  kind: cron
  expression: "0 9 * * *"
  message: "整理今天新增内容"
```

原则：

- 标题、emoji、归档状态、自动化消息放这里。
- `schedule.kind` 支持 `cron` 和 `at`。
- `next_run_at`、`last_run_at` 可以作为运行投影存在，但不能成为唯一事实。

当前 OpenCode spike 先使用同一会话目录下的 `schedule.json` 保存自动化消息状态，避免 `meta.yaml` 被标题、归档等旧更新链路重写时误删 schedule。`todo.json` 也使用同样的会话目录内过渡方案。它们都满足会话目录自包含；后续切到 Pi core 后，可以再把这些状态折叠进 `meta.yaml` 或 `session.jsonl` 事件流。

### `session.jsonl`

保存会话原始记录。

它是 append-only 的 JSONL 文件，适合任何 AI 工具、脚本和编辑器读取。

它可以包含：

- 用户消息
- AI 回复
- 工具调用
- 工具结果
- 自动化触发记录
- 资产引用
- 错误、中断、恢复等运行事件

文件名选择 `session.jsonl`，不用 `events.jsonl`，因为它更像产品对象本身：这个文件就是此会话的原始记录。

### `assets/`

保存会话资产。

命名使用 `assets`，不用 `attachments`。

原因：

- `attachments` 更像聊天软件里的临时附件。
- `assets` 更像会话工作现场中的长期材料。
- 它可以覆盖图片、音频、PDF、截图、工具产物、导出文件等，不只限于媒体。

示例：

```text
assets/
  image-001.png
  reference.pdf
  output.md
```

`session.jsonl` 中只引用会话内相对路径：

```json
{"type":"asset","path":"assets/image-001.png"}
```

不要写绝对路径。

当前 OpenCode spike 中，data URL 文件 part 会先写入 `assets/`，再把 `session.jsonl` 里的 part URL 改成 `assets/...`。读取投影时会从相对路径恢复成 data URL，以兼容现有 UI 和 LLM 输入链路。

### 当前已验证切片

OpenCode spike 当前已经把一部分关键事实源移回目录：

- 创建会话会写入 `.agents/atree/sessions/<session-id>/meta.yaml`、`session.jsonl` 和 `assets/`。
- 会话列表会扫描 `sessions/*/meta.yaml`，并用目录文件覆盖陈旧 SQLite row。
- 标题、emoji/metadata、归档状态、workspace/project identity、compacting time 等会话元数据会持久化到 `meta.yaml`。
- 消息、消息片段、删除消息、删除片段会写入 `session.jsonl`，并能在 SQLite 投影缺失时恢复。
- data URL 文件 part 会物化到会话自己的 `assets/`，fork 会话时也会复制到 fork 会话自己的 `assets/`。
- 写入消息事件后会推进 `meta.yaml` 的 `updatedAt`，目录列表排序不会只依赖 SQLite 的更新时间。
- 复制 `.agents/atree/` 到另一个目录后，显式传入目标目录的元数据、消息和 part 写入只落在目标目录；读取源目录时不会再被同一 session id 的全局 MessageV2 投影串入目标消息。
- HTTP prompt 路由在 `directory` hint 指向一个复制出来的 file-backed session 时，会优先使用该目标目录；如果 hint 目录没有对应 session，则回退到 session 自己持久化的目录。
- prompt 用户消息、自动标题、主循环 assistant 初始化/收尾、subtask assistant/tool 写入、shell 工具执行记录、summary/revert 清理、processor tool-call 元数据写入开始显式携带 session 目录上下文，减少对外层 InstanceState 和全局 SQLite row 的隐性依赖。
- plan/reminder 相关 synthetic 消息和 part 写入开始携带当前 session 目录上下文，避免 plan agent 切换、plan_exit 工具产生的内部消息落到错误目录。
- processor 的重复工具调用检测会从目录会话历史读取 assistant tool parts；即使全局 SQLite `part` 投影被删除，只要 `session.jsonl` 仍在，doom-loop 检测仍可工作。
- processor 会使用 assistant message 的 `path.cwd` 作为目录 hint 解析当前会话；流式文本、reasoning、step、patch、cleanup 等 assistant 写入都会显式落到该目录的 `session.jsonl`，复制 `.agents/atree/` 后不会把新回复写回源目录。
- compaction 的 prune/create/process 会接受并传递目录 hint；压缩标记、summary assistant、replay/continue 用户消息和被裁剪 tool part 都会写入当前会话目录。
- `MessageV2.page/stream/get/parts` 开始支持可选目录 hint；当目标目录存在对应 session store 时，会直接从该目录的 `session.jsonl` 投影读取，即使全局 SQLite message/part 投影被删除也能恢复。
- `schedule.json` 和 `todo.json` 已经按会话落到同一个会话目录下；写入它们时会确保 `session.jsonl` 和 `assets/` 骨架存在。
- schedule 执行后的 `lastRanAt`、`lastRunStatus` 会回写到目录 `schedule.json`，重启后可以恢复运行状态。
- 删除单个 schedule 时会携带当前会话目录上下文；复制 `.agents/atree/` 后，在目标目录删除自动化消息只会清目标目录的 `schedule.json`，不会清源目录。
- schedule 的运行 timer 会携带创建/恢复时的目录上下文；一次性自动化消息触发后，会在同一个目录的 `schedule.json` 中清空，不再依赖全局 SQLite session cache 推断目录。
- 删除 session 会移除整个会话目录；归档 session 不删除会话目录，但会清除自动化消息状态。

仍未完成的部分：

- 全局 SQLite 仍然存在，并且仍承担运行时投影和部分 OpenCode 兼容链路。
- `EventV2` 的 durable event log 还没有迁移到每个目录的 `session.jsonl`。
- 未传目录 hint 的 `MessageV2.page/stream/get/parts`、projector、部分 CLI/旧同步导出仍以 SQLite 为中心。
- `schedule.json`、`todo.json` 仍是 OpenCode spike 的过渡文件，长期应折叠进 Pi/core session 事件或更清晰的 atree 扩展协议。

## `.agents/atree/meta.yaml` 的职责

`.agents/atree/meta.yaml` 只描述目录级信息。

示例：

```yaml
version: 1
title: 内容生产
```

第二版不建议在 `.agents/atree/meta.yaml` 中维护完整会话列表，因为那会造成双写一致性问题。

目录下有哪些会话，应通过扫描得到：

```text
.agents/atree/sessions/*/meta.yaml
```

## 行为要求

### 会话创建

在某个目录创建会话时，应创建：

```text
.agents/atree/sessions/<session-id>/
  meta.yaml
  session.jsonl
  assets/
```

### 会话读取

切换到目录节点时，UI 应扫描当前目录：

```text
.agents/atree/sessions/*/meta.yaml
```

并据此恢复：

- 未归档会话 tab
- 归档会话列表
- 自动化消息排序
- 会话 emoji 和标题

### 会话写入

所有消息和工具事件追加到：

```text
.agents/atree/sessions/<session-id>/session.jsonl
```

二进制内容写入：

```text
.agents/atree/sessions/<session-id>/assets/
```

### 归档

归档不移动目录，不删除数据，只更新：

```yaml
archived_at: 2026-06-15T10:30:00+08:00
```

如果会话有自动化消息，归档时应清除或禁用自动化消息。

### 删除

删除才可以移除整个会话目录。

当前 OpenCode spike 已经实现真删除的核心语义：

- 删除 session 时移除 `.agents/atree/sessions/<session-id>/`。
- 删除 session 时清理该 session 的 schedule runtime/cache。
- 归档仍然只更新 `archived_at`，不删除会话目录。

## 与当前实现的关系

当前实现仍继承了 OpenCode 的全局会话存储方式。

这会是第二版里最难的一部分。它不是简单 UI 调整，而是要触碰 OpenCode 的核心存储、会话索引、消息读取、流式写入、附件处理、自动化调度恢复等链路。

因此第二版不能一次性“大爆炸”替换。更科学的路线是把当前 OpenCode 版本视为 UI 和交互 spike，新的核心运行时改为围绕 Pi 和 atree 目录事实源重新建立。

### 当前 OpenCode 存储结构简析

当前代码里有几层存储：

1. 全局 SQLite 数据库

   路径由 `packages/core/src/database/database.ts` 决定，默认在 OpenCode 的全局 data 目录下，例如 `opencode.db`。

2. 会话投影表

   `packages/core/src/session/sql.ts` 定义了：

   - `session`
   - `message`
   - `part`
   - `todo`
   - `session_message`
   - `session_input`
   - `session_context_epoch`

   这些表保存会话列表、消息、消息片段、任务、V2 会话消息、输入队列和上下文 epoch。

3. 事件表

   `packages/core/src/event/sql.ts` 定义了：

   - `event_sequence`
   - `event`

   OpenCode 新链路已经在使用事件源思想：同步事件按 session aggregate 写入全局 SQLite，然后 projector 生成 `session`、`message`、`part`、`session_message` 等投影表。

4. Projector

   `packages/core/src/session/projector.ts` 负责把事件投影到 SQLite 表。

   典型链路是：

   ```text
   Session service 发布事件
     -> EventV2 写入全局 SQLite event 表
     -> SessionProjector 写入 session/message/part/session_message 等表
   ```

5. Schedule 表

   atree 第一版新增的 schedule 当前是独立 SQLite 表：

   - `schedule`
   - `schedule_run`

   服务启动时会从 `schedule` 表 hydrate timer。这和第二版希望的 `.agents/atree/sessions/<session-id>/meta.yaml` 事实源相反。

6. 旧 JSON storage service

   `packages/opencode/src/storage/storage.ts` 仍有旧 JSON 文件存储和 migration 代码，但当前主链路已经主要走 SQLite + EventV2/projector。

### 对第二版的含义

第二版不能只改 UI 或 API handler。真正的改造点在：

- `EventV2` 的持久化位置
- `SessionProjector` 的投影目标
- `SessionStore` / `Session.Service` 的读取来源
- `MessageV2.page` / `MessageV2.get` 的读取来源
- `Schedule.Service` 的事实源
- 文件/多媒体从 data URL 或全局消息 part 迁移到 `assets/`

最自然的方向是：

```text
session.jsonl = 当前 session aggregate 的 durable event log
SQLite = 从 session.jsonl 重建出来的本机投影缓存
```

也就是说，`session.jsonl` 不一定只是“渲染后的聊天消息”。它更适合作为这个会话的可重放原始事件流。UI 要展示的消息列表可以由它投影出来。

这样既符合 atree 的目录事实源原则，也尽量复用 OpenCode 已经存在的 event/projector 架构。

但这条路线本质上仍然是在改 OpenCode core。它会持续受到全局 SQLite、projector、session API 和 schedule service 的牵引。第二版更推荐的路线是直接使用 Pi 作为 Agent core。

## 推荐路线：Pi core + atree UI

Pi 的会话模型天然更接近 atree 第二版：

- Pi session 已经是 JSONL。
- Pi 支持按 session path 或 session dir 组织会话。
- Pi 的 Agent 状态可以在运行时从 session 文件恢复。
- Pi 的扩展生态和工具协议更适合作为 atree 后续 Agent 能力基础。
- atree 不需要在 Pi 之上再长期维护一层复杂的消息格式转换。

因此第二版建议把目标调整为：

```text
atree UI
  -> atree runtime API
  -> Pi agent/session
  -> 当前目录/.agents/atree/sessions/<session-id>/session.jsonl
```

当前 OpenCode 版本保留价值主要是：

- 左侧目录树交互
- 顶部 session tab
- 归档会话入口
- 自动化消息 header
- ChatView 的视觉参考

不建议继续把 OpenCode core 当成长期底座。OpenCode core 可以作为短期参考和迁移对象，但不应该成为第二版事实源架构。

### 过渡适配层

初期可以存在一个很薄的适配层，用于让当前 UI 继续工作：

```text
Pi event / Pi session
  -> atree session view model
  -> 当前 ChatView
```

这个适配层只负责视图需要的最小信息：

- session 列表
- message 列表
- 流式输出状态
- 工具调用状态
- 自动化消息状态
- 归档状态
- emoji 和标题

它不应该成为新的核心协议。最终 atree UI 应该直接理解 atree 自己的 session 结构。

## 还需要进一步设计的问题

### `session.jsonl` 的行格式

需要决定 `session.jsonl` 每一行到底保存什么。

候选方案：

1. 保存 OpenCode 的 `EventV2.SerializedEvent`。
2. 保存更产品化的 atree session event。
3. 保存渲染后的 user/assistant/tool message。

当前倾向是第一种或第二种，不建议只保存渲染后的消息。因为工具调用、流式输出、自动化触发、compaction、shell、revert 都需要可重放事件。

### 投影缓存策略

第二版可以允许 SQLite 继续存在，但只能作为可重建缓存。

启动时可以：

```text
扫描 .agents/atree/sessions/*/session.jsonl
  -> replay events
  -> 重建 SQLite 投影表或内存索引
```

缓存丢失不能导致会话丢失。

### 写入原子性

`session.jsonl` 是 append-only 文件，需要考虑：

- 单行 JSON 写入必须完整。
- 同一个 session 需要串行追加。
- 多进程写同一个 session 时需要文件锁。
- 写入 `meta.yaml` 和追加 `session.jsonl` 的顺序要定义清楚。

MVP 可以先假设单进程，但第二版计划里需要保留这个约束。

### 自动化调度恢复

调度器不应从全局 `schedule` 表恢复，而应扫描：

```text
.agents/atree/sessions/*/meta.yaml
.agents/atree/sessions/*/schedule.json
```

读取其中的自动化消息定义，例如：

```yaml
schedule:
  kind: cron | at
  expression: ...
  run_at: ...
  message: ...
  enabled: true
```

然后重建运行队列。

### 资产落盘

当前 OpenCode 的文件/媒体可能以 `data:` URL、base64 或 part 数据存在。

第二版需要统一成：

```text
.agents/atree/sessions/<session-id>/assets/
```

并在 `session.jsonl` 中保存相对路径引用。

### 迁移兼容

需要提供从现有 OpenCode 全局 SQLite 会话到 `.agents/atree/` 的迁移路径。

至少要考虑：

- 当前 session 表里的 title、directory、archived、metadata。
- message/part 表里的历史消息和工具结果。
- schedule/schedule_run 表里的自动化消息和运行记录。
- data URL 或 base64 附件如何抽出成 assets 文件。

第二版迁移目标是：

```text
OpenCode 全局 session store
  -> atree 目录内 .agents/atree/sessions/<session-id>/
```

可以分阶段做：

1. 新会话写入 `.agents/atree/sessions/<session-id>/`。
2. UI 从 `.agents/atree/` 扫描会话列表。
3. 自动化消息从 `meta.yaml` 恢复。
4. 旧全局会话提供一次性迁移或兼容读取。
5. 最终移除全局业务事实源。

## 验收标准

第二版完成时，应该满足：

- 复制一个业务目录后，会话记录和资产一起复制。
- 删除全局缓存后，目录里的会话仍然可以恢复。
- UI 的 tab、归档列表和自动化排序都能从 `.agents/atree/` 重建。
- `session.jsonl` 可以被普通文本工具和 AI 工具直接读取。
- `assets/` 中的文件都通过相对路径被引用。
- 一个会话目录可以被整体移动、压缩、归档或备份。

## 暂不处理

第二版先不扩大到：

- 多设备同步冲突解决
- 多进程并发写锁
- 真正权限沙箱
- interface session
- 外部平台挂载
- Git 默认策略

这些问题重要，但应在目录事实源稳定后再单独设计。
