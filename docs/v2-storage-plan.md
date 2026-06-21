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
- `.agents/` 是协议目录，不是用户业务目录；目录树展示和递归扫描都应跳过 `.agents`，避免把 atree 自己的存储再当作普通节点处理。

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
- core `SessionV2.create` 在真实可写目录中也会创建 `.agents/atree/sessions/<session-id>/` 骨架；对不可写的旧测试/虚拟目录，目录镜像失败不会阻断原有 SQLite 创建流程。
- core `SessionV2.create` 和 opencode `Session.create` 会把 `session.created` 追加到当前会话目录的 `session.jsonl`；如果 `meta.yaml` 投影缺失，session store 可以从创建事件恢复会话元数据，再叠加后续 `session.updated` 事件。
- opencode 的标题、归档、icon/metadata、permission、summary/share/revert/workspace 等会话元数据更新会先追加 `session.updated` 到 `session.jsonl`，再刷新 `meta.yaml` 和 SQLite 投影；如果投影刷新前中断，后续读取仍能从 JSONL 恢复最新元数据。
- opencode 读取 file-backed session 时也会从 `session.updated` JSONL 重放 `agent`、`model`、`cost`、`tokens`、`projectID`、`parentID`、`path` 和时间字段；完整 info 事件和局部 patch 事件都可以覆盖陈旧 `meta.yaml`。
- 会话列表会扫描 `sessions/*/meta.yaml`，并用目录文件覆盖陈旧 SQLite row。
- 显式按目录读取会话列表时，目录下 `sessions/*/meta.yaml` 是成员事实源；只有 SQLite 中存在但目录文件已不存在的缓存会话不会再出现在 active、archived 或 core `SessionV2.list({ directory })` 结果里。
- opencode `Session.listGlobal()` 在没有显式目录时也会扫描持久化 atree root 下的 file-backed sessions；即使全局 SQLite 中没有投影行，只要会话目录在当前 root 下，全局/experimental 会话列表也能恢复它。
- 显式按目录读取单个会话时，如果该目录下不存在对应 `.agents/atree/sessions/<session-id>/`，则直接返回 NotFound，不再用 SQLite 里的旧 row 冒充目录事实源。
- file-backed session 回填 SQLite 缓存时会保护已有仍有效的目录行；如果同一个 session id 已经在另一个仍有 `meta.yaml` 的目录中存在，显式读取复制目录不会把全局缓存行漂移到复制目录。
- 标题、emoji/metadata、归档状态、workspace/project identity、compacting time 等会话元数据会持久化到 `meta.yaml`。
- 显式标题、emoji/metadata、权限、归档状态、workspace、share、summary 和 revert 状态变更会追加到当前会话目录的 `session.jsonl`，让会话状态变化也成为目录原始记录的一部分。
- 读取会话元数据时会重放 `session.jsonl` 中的 `session.updated` 事件覆盖陈旧 `meta.yaml`；目录会话列表排序也会使用这些事件推进后的 `updatedAt`。
- core `SessionV2.get({ directory })` 读取 file-backed session 时也会重放 `session.updated`，因此标题、归档状态和 `updatedAt` 不再只依赖陈旧 `meta.yaml`。
- core `SessionV2.get({ directory })` 重放 `session.updated` 时也会恢复 `workspaceID`，让目录会话的 workspace 归属可以从 `session.jsonl` 事件恢复。
- core `SessionV2.list({ directory })` 默认会过滤归档的 file-backed session；只有显式传 `archived: true` 时才会把归档会话并入结果。
- 消息、消息片段、删除消息、删除片段会写入 `session.jsonl`，并能在 SQLite 投影缺失时恢复。
- data URL 文件 part 会物化到会话自己的 `assets/`，fork 会话时也会复制到 fork 会话自己的 `assets/`。
- 写入消息事件后会推进 `meta.yaml` 的 `updatedAt`，目录列表排序不会只依赖 SQLite 的更新时间。
- 复制 `.agents/atree/` 到另一个目录后，显式传入目标目录的元数据、消息和 part 写入只落在目标目录；读取源目录时不会再被同一 session id 的全局 MessageV2 投影串入目标消息。
- 复制 `.agents/atree/` 到另一个目录后，显式传入目标目录的 fork 会从目标目录读取历史，并把新 fork 会话写入目标目录。
- HTTP prompt 路由在 `directory` hint 指向一个复制出来的 file-backed session 时，会优先使用该目标目录；如果 hint 目录没有对应 session，则回退到 session 自己持久化的目录。
- HTTP prompt、promptAsync、command、shell、init、summarize/loop 入口会先解析当前 session 的目录，并把目录上下文显式传给执行链路，减少模型执行写回旧 SQLite/cache 目录的可能。
- Shell 执行内部的 session resolve 也使用传入的目录上下文；shell 用户消息、工具 part 和后续恢复 loop 会继续写入当前目录会话。
- Summary diff/summarize 读取和写入也接受目录上下文；HTTP diff 会用解析出的当前 session 目录读取消息摘要，避免同 session id 的旧缓存目录影响 diff 展示。
- Revert/unrevert 也接受目录上下文；HTTP revert/unrevert 会把当前 session 目录传给回滚链路，让 revert 状态、message/part 清理继续落在目录会话内。
- Share/unshare 写入 share 元数据时也接受目录上下文；HTTP share/unshare 会把当前 session 目录传给 metadata 写入链路。
- ShareNext 创建分享后的 full sync 也会继续使用显式目录上下文；复制 `.agents/atree/` 到目标目录后，首次分享同步出去的 session/messages/diffs 会来自目标目录事实源，而不是源目录或全局 SQLite 缓存。
- CLI `import` 导入分享或 JSON 文件时，会先写入当前目录的 `.agents/atree/sessions/<session-id>/meta.yaml` 和 `session.jsonl`，再刷新 SQLite 兼容投影；导入来的会话不再只是全局数据库里的会话。
- CLI `stats` 聚合会话时会通过 `Session.listGlobal()` 和带目录上下文的 `Session.messages()` 读取；只有目录事实源、没有 SQLite session row 的会话也会被统计。
- Project 识别从 global 或旧 root project 升级为真实 git/remote project 时，会同步迁移当前目录下 file-backed sessions 的 `projectID`，并把 `session.updated` 写入各自 `session.jsonl`；即使没有 SQLite session row，目录会话也不会停留在旧 project 归属。
- opencode session 模块已删除旧的顶层 `listGlobal` 生成器；全局会话列表只保留 `Session.Service.listGlobal()` 这一条会合并目录事实源的路径，避免出现纯 SQLite 列表旁路。
- Schedule 服务启动时会读取持久化 atree root，自动恢复 root 下 file-backed sessions 的 `schedule.json`/`session.jsonl` schedule 投影；即使没有 SQLite session row，目录里的自动化消息也会在服务重启后恢复到运行时缓存。
- 工具执行上下文会携带当前 session 目录；schedule、todowrite、task 和 plan_exit 读取当前会话时会优先使用该目录，避免工具通过同 session id 的全局 SQLite 投影把状态写回旧目录。
- prompt 用户消息、自动标题、主循环 assistant 初始化/收尾、subtask assistant/tool 写入、shell 工具执行记录、summary/revert 清理、processor tool-call 元数据写入开始显式携带 session 目录上下文，减少对外层 InstanceState 和全局 SQLite row 的隐性依赖。
- core `SessionContextEpoch.prepare` 产生的上下文更新事件会在保留原有 commit guard 的同时追加到当前目录会话的 `session.jsonl`；系统上下文变化不再只是全局 EventV2/SQLite 投影。
- plan/reminder 相关 synthetic 消息和 part 写入开始携带当前 session 目录上下文，避免 plan agent 切换、plan_exit 工具产生的内部消息落到错误目录。
- processor 的重复工具调用检测会从目录会话历史读取 assistant tool parts；即使全局 SQLite `part` 投影被删除，只要 `session.jsonl` 仍在，doom-loop 检测仍可工作。
- processor 会使用 assistant message 的 `path.cwd` 作为目录 hint 解析当前会话；流式文本、reasoning、step、patch、cleanup 等 assistant 写入都会显式落到该目录的 `session.jsonl`，复制 `.agents/atree/` 后不会把新回复写回源目录。
- compaction 的 prune/create/process 会接受并传递目录 hint；压缩标记、summary assistant、replay/continue 用户消息和被裁剪 tool part 都会写入当前会话目录。
- `MessageV2.page/stream/get/parts` 开始支持可选目录 hint；当目标目录存在对应 session store 时，会直接从该目录的 `session.jsonl` 投影读取，即使全局 SQLite message/part 投影被删除也能恢复。
- `MessageV2.page/get/parts` 在调用方显式传入目录时，如果该目录下没有对应 file-backed session，不再继续读取全局 SQLite 中残留的 message/part 投影；`page/get` 返回 NotFound，`parts` 保持旧契约返回空数组。
- `MessageV2.page/get/parts` 在没有目录 hint 时也会通过共享 resolver 优先扫描持久化 atree root；只有当前 root 内没有 file-backed session 时才回退旧 SQLite message/part 投影，避免同 session id 复制后直接读到旧目录缓存。
- opencode `Session.getPart({ directory })` 也遵守同样的显式目录边界：目标目录没有对应 file-backed session 时直接返回空，不再读取全局 SQLite `PartTable` 中的旧投影。
- core `SessionV2.get/messages/context/prompt` 开始支持可选目录 hint；当同一 session id 被复制到另一个目录时，显式传入目标目录会优先读取和写入目标目录的 `meta.yaml` / `session.jsonl`，而不是先命中全局 SQLite row。
- core `SessionStore.get` 会优先从持久化 atree root 查找目录事实源；只有当前 root 内没有 file-backed session 时，才回退 SQLite 中仍有效的旧目录 row 以兼容非 atree 旧会话。
- server 包的 `SessionLocationMiddleware` 会优先校验 SQLite 缓存目录中的 file-backed session，旧目录失效时从持久化 root 查找目录事实源；V2 `session.get`、`session.prompt`、`session.context` 和 `session.messages` handler 会把解析出的当前目录继续传给 core `SessionV2`。
- core `appendSessionJsonl` 会和 opencode 侧一样为追加事件补 `version` 和 `at`，让目录事件流有统一的时间戳外壳。
- core `SessionV2.create` 在真实可写目录下会先写 `.agents/atree/sessions/<session-id>/meta.yaml` 和 `session.jsonl` 的 `session.created`，再发布 Created 事件刷新 SQLite projector；不可写的虚拟目录仍保留 best-effort 兼容行为。因此新会话的目录事实源不再晚于全局投影。
- core 读取 file-backed session 时会从 `session.updated` JSONL 重放 `title`、`agent`、`model`、`cost`、`tokens`、`projectID`、`parentID`、`workspaceID`、`subpath/path` 和时间字段；即使 `meta.yaml` 是陈旧投影，core 层也会以目录事件流为准。
- core/opencode 的会话元数据 replay 同时兼容目录事件的顶层字段形态和原始 EventV2 `data` 嵌套形态；后续把更多 EventV2 原始日志搬进 `session.jsonl` 时，不需要先把字段拍平成专用格式。
- core/opencode 的消息 replay 也兼容原始 EventV2 `data` 嵌套形态；`message.updated`、`message.part.updated`、`message.part.delta`、`message.removed`、`message.part.removed` 可以直接从目录 `session.jsonl` 恢复为现有消息投影。
- question/permission 的 asked/replied/rejected 事件会尽力追加到当前会话目录的 `session.jsonl`；dispose/reload 导致的 pending 取消也会记录为 rejected/reject。这些请求仍然是运行时 pending 状态，但会话里发生过的澄清问题和权限决策已经会随目录一起复制、归档和读取。
- opencode `session.error` 事件会在 EventV2Bridge 层镜像到当前目录会话的 `session.jsonl`；显式 event location 优先，缺失时再回退当前 instance 或服务端记录的 atree root。
- opencode `command.executed` 事件也会在 EventV2Bridge 层镜像到当前目录会话的 `session.jsonl`，让通过 slash/command 入口触发过的命令成为目录会话原始记录的一部分。
- opencode `session.compacted` 事件会在 EventV2Bridge 层镜像到当前目录会话的 `session.jsonl`，作为一次压缩已经完成的高层会话事实；具体 compaction started/ended 事件仍由 compaction 链路记录。
- opencode `session.diff` 事件会在 EventV2Bridge 层镜像到当前目录会话的 `session.jsonl`，先保留 diff 事件原始事实；全局 `session_diff` storage 仍作为现有 HTTP/UI 兼容投影，后续再单独迁移。
- opencode 侧读取 `meta.yaml` 时会重放 `session.diff` 并恢复会话级 summary 统计；HTTP `session.diff` 在不传 `messageID` 时会返回目录事实源里的会话级 diff，旧全局 `session_diff` storage 仍不作为事实源。
- HTTP `session.diff` 会先按当前实例目录解析 session；如果当前目录没有该 file-backed session，则返回空 diff，不再通过无目录 `session.get` 读取全局缓存会话。
- core `SessionV2.prompt` 写入 file-backed session 时，会把 prompt file 的 data URL 物化到同一会话目录的 `assets/`，并在 `session.jsonl` 中只保留 `assets/...` 相对路径；读取时可恢复成现有 v2 message 的 file attachment。
- core `SessionV2.messages/context/message` 读取 file-backed session 时，已经能恢复用户/助手文本、reasoning、event-backed prompted 用户消息、event-backed assistant step/text/reasoning/tool、用户文件资产、agent/model/context/synthetic 直接事件、shell 事件、compaction 事件，以及 pending/running/completed 的 `tool-invocation` / v1 `tool` 调用状态。
- core `SessionV2.switchModel` 会先把 `session.next.model.switched` 追加到当前会话目录的 `session.jsonl`，再发布 EventV2 事件；读取 `meta.yaml` 时也会重放 `session.next.agent.switched` / `session.next.model.switched`，让目录里的事件流能恢复当前 agent/model，而不是只恢复一条展示消息。
- opencode 侧读取 `meta.yaml` 时也会重放 `session.next.agent.switched` / `session.next.model.switched`，并把 `modelID` 形态归一为当前 `Session.Info.model.id` 形态；core 和 web 侧对目录会话当前 agent/model 的恢复语义保持一致。
- opencode prompt 创建用户消息时产生的 agent/model 切换事件会先追加到当前会话目录的 `session.jsonl`，再发布 EventV2；即使全局投影丢失，也能从目录恢复当前会话使用的 agent/model。
- `moveSession` 在源目录存在 file-backed session store 时，会把 `.agents/atree/sessions/<session-id>/` 整个移动到目标目录，并把 `session.next.moved` 追加到移动后的 `session.jsonl`；如果源会话不是目录事实源，仍保留旧 SQLite/EventV2 行为。
- core 和 opencode 读取会话元数据时都会重放 `session.next.moved`，但不会信任事件中的旧绝对目录路径；当前承载目录仍是事实源，只从 moved 事件恢复 workspace/subpath/path 和更新时间。
- core `SessionV2.interrupt` 会把 `session.next.interrupt.requested` 镜像到当前会话目录的 `session.jsonl`，同时保留原有 EventV2 seq 传给 execution 的控制语义。
- core runner 的 LLM 事件 publisher 在真实 file-backed session 上会把 provider turn 产生的 step/text/reasoning/tool 事件 best-effort 镜像到同一会话目录的 `session.jsonl`；EventV2/SQLite projector 仍是运行时投影，但模型回复和工具调用原始事件已经开始随目录一起落地。
- core runner 里绕过 publisher 的失败路径也会带当前 session：中断未完成工具、LLM step failed，以及 provider context overflow 后触发的 compaction recovery 都会继续写回当前会话目录，而不是只写全局 EventV2/SQLite。
- core compaction 会把 `session.next.compaction.started/ended` best-effort 镜像到当前会话目录的 `session.jsonl`，让压缩摘要也能随目录文件恢复。
- core 和 opencode 的 `session.jsonl` reader 会同时接受无版本事件名和 EventV2 sync 使用的 `.1` / `.2` 等版本化事件名；opencode reader 也会按最后事件清理 message/part 删除 tombstone；todo/schedule 的 JSONL 投影读取也同样兼容版本化事件名。
- core `session.jsonl` 读取会暂存先于 `message.updated` 到达的 orphan part，并在 message 到达后归并；delta/removal 也能作用到这类暂存 part，避免 JSONL 行顺序轻微乱序时丢消息内容。
- core `SessionStore.context` 会先尝试从当前 root 的 file-backed session 读取 `session.jsonl`；只有目录消息缺失时才回退现有 SQLite 投影，避免复制目录后旧投影盖过当前目录事实源。
- core `SessionStore.runnerContext` 和 `runnerEntries` 也采用同样的目录优先策略；runner 主循环不再直接读取 SQLite `SessionHistory.entriesForRunner`，模型上下文和 compaction entries 都先来自当前 root 下的 `session.jsonl`。
- core `SessionStore.message` 会优先从持久化 atree root 的 file-backed sessions 查找对应 `session.jsonl` 消息；只有目录事实源没有这条消息时才回退现有 SQLite 单条消息查询，避免同 message id 的陈旧全局投影盖过目录记录。
- core `SessionStore.get/context/runnerContext` 和 `SessionTodo` 的无显式目录读取会优先扫描持久化 atree root；只有当前 root 内找不到对应会话时，才回退 SQLite 中仍有效的旧目录缓存。这样复制 `.agents/atree/` 后，当前 root 副本不会被旧绝对路径压过。
- `schedule.json` 和 `todo.json` 已经按会话落到同一个会话目录下；写入它们时会确保 `session.jsonl` 和 `assets/` 骨架存在。
- schedule 的显式目录操作已经按目录边界收紧：当调用方传入 `directory`，但该目录没有对应 file-backed session 时，`list` 返回空，`delete` 返回 NotFound，`clear` 不会清理全局 DB 投影，`create` 不会创建 DB-only 自动化消息。
- core `SessionTodo` 会在能定位到 file-backed session 时把 todo 状态镜像到同一会话目录的 `todo.json`，读取时目录状态优先；即使 SQLite todo 投影缺失，也能从目录恢复。
- core `SessionTodo` 的文件态行为已经和 opencode 侧保持一致：写入 todo 时会确保 `session.jsonl` / `assets/` 骨架存在，读取旧 `extensions/todo/state.json` 作为迁移兼容，重写该会话 todo 后会从旧扩展状态中移除对应 session，并推进会话 `meta.yaml` 的更新时间。
- core 和 opencode 的 todo 更新会先追加到当前会话目录的 `session.jsonl`，再刷新 SQLite/`todo.json` 投影；当会话目录的 `todo.json` 投影文件缺失，或 `session.jsonl` 中存在更新的 `todo.updated` 事件时，todo store 可以从最近一条事件恢复当前 todo 状态，并保留“显式空 todo”和“缺失 todo 状态”的区别。
- todo 的显式目录写入也已经按目录边界收紧：当调用方传入 `directory`，但该目录没有对应 file-backed session 时，`update` 不会写入全局 `TodoTable`，也不会在错误目录创建 todo 投影。
- todo/schedule 的无显式目录解析不再直接信任 SQLite 中缓存的 `SessionTable.directory`；会优先从当前 instance 或持久化 root 查找真实 file-backed session，最后才接受仍有效的旧缓存目录。
- todo 的显式目录读取如果找不到该目录下的 file-backed session，会返回空列表，不再读取全局 SQLite `TodoTable` 中的旧投影。
- opencode 的 session、message、todo、schedule 现在共享同一个 file-backed session resolver。解析顺序集中为：显式目录、当前 instance 目录、持久化 atree root 扫描、最后才回退仍有效的 SQLite 缓存目录。复制 `.agents/atree/` 到当前 root 后，即使旧 SQLite 目录仍然存在，相关读写也会优先定位到当前 root 内的目录事实源。
- core `ToolOutputStore` 在能通过 `SessionStore` 定位到 file-backed session 时，会把超长工具输出写入该会话的 `assets/tool-output/`；不能定位会话目录时仍回退到全局 `tool-output`，保持旧链路兼容。
- opencode V1 工具截断链路也会携带当前 `sessionID`：普通工具、插件工具、shell 输出和 session tools 的超长输出会优先写入 `.agents/atree/sessions/<session-id>/assets/tool-output/`；缺少会话或 instance 上下文时仍回退全局 `tool-output`。
- opencode V1 截断链路写入 `assets/tool-output/` 前会先解析真实 file-backed session；从根目录执行子目录会话时，超长工具输出也会落到子目录自己的会话资产目录，而不会在根目录下凭空创建同名 session payload。
- plan 文件不再写入全局 `plans/` 或 git 项目的 `.opencode/plans/`，而是统一写入当前会话的 `assets/plans/`。plan agent 默认权限已经允许编辑会话内 `assets/plans/*.md`。
- schedule 执行后的 `lastRanAt`、`lastRunStatus` 和 `nextRun` 会回写到目录 `schedule.json`，并写入 `session.jsonl` 的运行事件；重启后可以恢复运行状态和下次执行时间。
- 删除单个 schedule 时会携带当前会话目录上下文；复制 `.agents/atree/` 后，在目标目录删除自动化消息只会清目标目录的 `schedule.json`，不会清源目录。
- 当 SQLite 中没有 schedule row 但调用方给出目录时，删除单个 schedule 会直接扫描该目录 file-backed sessions，并从对应会话的 `schedule.json` 中移除该自动化消息。
- 当 SQLite 中没有 schedule row 且调用方没有目录 hint 时，删除单个 schedule 会回到服务端记录的 atree root，递归查找包含该 schedule id 的会话目录并更新其 `schedule.json`。
- schedule list 在定位到目录 projection 后会以目录状态为准：显式空 `schedule.json` 或较新的 `schedule.deleted` 事件会清理旧 `ScheduleTable` row；同 ID schedule 的 message、runAt、expression 也会从目录状态重建 DB/timer 投影，避免旧全局投影把目录里的定时任务复活或覆盖。
- schedule 的运行 timer 会携带创建/恢复时的目录上下文；一次性自动化消息触发后，会在同一个目录的 `schedule.json` 中清空，不再依赖全局 SQLite session cache 推断目录。
- schedule 触发时会把恢复到的目录上下文继续传给 prompt/loop；复制 `.agents/atree/` 后，自动化消息产生的新用户消息和后续回复会写入目标目录，而不是写回源目录或陈旧 SQLite row 指向的目录。
- 服务启动恢复 schedule 时会递归扫描当前 atree root 下的嵌套目录，并用每个 file-backed session 自己的目录恢复 timer；嵌套节点的自动化消息不再依赖旧 SQLite `SessionTable` 行才能启动。
- schedule 的创建、运行记录和删除会先追加到当前会话目录的 `session.jsonl`，再刷新 `schedule.json` 投影；归档会话导致的自动化清理也会留下 `schedule.deleted` 记录。即使是重启/恢复时发现 archived 会话里残留了旧 `schedule.json`，清理投影前也会补写删除事件。因此自动化消息不只是外部投影状态，也是会话原始记录的一部分。
- schedule 到点触发的 `schedule.triggered` 事件会在 EventV2Bridge 层镜像到当前目录会话的 `session.jsonl`；它不改变 `schedule.json` 当前状态投影，但保留“自动化消息曾经被触发”的原始事实。
- 当会话目录的 `schedule.json` 投影文件缺失，或 `session.jsonl` 中存在更新的 `schedule.created` / `schedule.ran` / `schedule.deleted` 事件时，schedule store 可以重放 JSONL 恢复当前自动化状态，包括最近运行状态和下次执行时间；这些投影读取同时接受扁平事件和 EventV2 风格的 `data` 嵌套事件。
- todo 投影也可以从扁平或 EventV2 `data` 嵌套的 `todo.updated` 事件恢复，确保工具状态的目录内事实源和事件总线镜像格式保持兼容。
- 当 `meta.yaml` 缺失时，core 和 opencode 都可以从 `session.jsonl` 的 `session.created` 重建会话元数据；该恢复路径同时接受扁平 `info` 和 EventV2 风格的 `data.info`，随后继续重放 `session.updated` 得到最新状态。
- 删除 session 会移除整个会话目录；归档 session 不删除会话目录，但会清除自动化消息状态。
- 即使全局 SQLite 中没有 session/schedule 缓存行，只要会话能从目录 `meta.yaml` 恢复，归档该会话也必须清空同目录的 `schedule.json`。
- 删除 workspace 时会通过 session service 查找当前 workspace 的会话；只有目录事实源、没有 SQLite session row 的 workspace 会话也会被删除，不会因为旧 `SessionTable.workspace_id` 缺失而残留在 `.agents/atree/`。

仍未完成的部分：

- 全局 SQLite 仍然存在，并且仍承担运行时投影和部分 OpenCode 兼容链路。
- `EventV2` 的 durable event log 还没有完整迁移到每个目录的 `session.jsonl`；当前 core reader 已能恢复 prompted 用户消息和 assistant step/text/reasoning/tool，question/permission 事件已开始写入 JSONL，但 pending 状态的重放/恢复仍待单独设计。
- projector、部分 CLI/旧同步导出仍以 SQLite 为中心；CLI `import` / `stats` 已开始读写目录事实源，`MessageV2.page/get/parts` 和 session/todo/schedule 的常用读取链路已经会先尝试 file-backed session resolver。
- snapshot/worktree 等派生产物仍会落到全局 data dir；它们需要后续单独设计迁移路径，不能在没有 session/location 上下文的情况下直接搬进目录。
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
