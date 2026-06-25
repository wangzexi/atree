# atree 下一阶段实施计划

本文档记录当前 OpenCode-spike 版本之后的主线计划。目标不是继续扩大 UI 细节，而是把 atree 的核心边界收紧：一个本地服务、一个根目录、一棵目录树、目录内会话、自动化消息。

## 当前判断

当前版本已经证明了几个关键体验：

- 左侧目录树可以作为 atree 的主导航。
- 顶部 tab 可以作为当前目录的会话组。
- 会话可以归档、恢复、设置 emoji。
- 自动化消息可以作为会话输入框上的状态展示。
- schedule 可以支持 `cron` 和 `at` 两类触发。
- 打开的根目录已经是服务端状态，通过 `/api/workspace` 和 `/api/workspace/root` 持久化。
- 左侧目录树已经从服务端 root 派生，通过 `/api/tree` 读取。

但当前实现仍然继承了 OpenCode 的大量状态模型：

- 会话仍依赖 OpenCode 全局 SQLite 作为运行时投影和部分兼容缓存。
- 前端仍在消费 OpenCode 的宽接口面。
- schedule 当前是 atree 第一版硬编码服务，不是 Pi 扩展。

下一阶段要继续收紧会话事实源边界，再处理接口收敛和核心替换。

## 新约束：停止业务 fallback

基于当前 demo 阶段判断，atree 下一步不再追求“目录事实源 + 全局 SQLite fallback”并存。

这个兼容层已经开始明显拖慢实现：

- 每做一个会话相关能力，都要回答“目录事实源”和“全局缓存”谁优先。
- copied directory、同 id session、多入口读取时，逻辑会持续分叉。
- 前端 bug 和运行态 bug 很难快速归因，因为数据来源不再单一。

因此主线原则改为：

- 会话存在性、归档状态、emoji、标题、schedule、todo、消息历史、资产路径，全部以目录内 `.agents/atree/` 为唯一业务事实源。
- 找不到目录事实源时，直接视为不存在；不再回退到全局 SQLite 猜测旧数据。
- 全局 SQLite 如果继续存在，只能承载“可丢弃、可重建”的运行态，不再承载任何会改变目录业务语义的数据。
- 如果某个功能必须依赖 fallback 才能跑通，优先删该 fallback，再补最小运行时重建，而不是继续双写。

这意味着后续改造不是“渐进兼容旧 OpenCode 存储”，而是“用可运行的方式逐段切断旧事实源”。

## 2026-06-20 审查结论

另一个 AI 已经推进了一批目录自包含相关改动，其中一部分可以保留并继续沿用。

当前已验证：

- `packages/opencode` 的 session 服务会把会话元数据写入 `.agents/atree/sessions/<session-id>/meta.yaml`。
- 旧版 message/part 事件会写入 `.agents/atree/sessions/<session-id>/session.jsonl`。
- data URL 文件 part 会落盘到会话自己的 `assets/`，JSONL 中只保留相对路径。
- `schedule.json` 和 `todo.json` 已经按会话落在同一个会话目录下。
- 删除 SQLite 投影后，session metadata、message、part、assets、schedule、todo 可以从目录恢复。
- 显式读取某个目录的会话列表时，`sessions/*/meta.yaml` 是成员事实源；全局 SQLite 中残留但目录文件已不存在的缓存会话不会再出现在该目录的 active/archived 列表或 core `SessionV2.list({ directory })` 里。
- `packages/core` 的 `SessionV2` 已能从当前目录或持久化 root 发现 file-backed sessions。
- core `SessionV2.get/messages/context/prompt` 和 server 包 V2 session/message handler 已能传递目录 hint，复制 `.agents/atree/` 后可以显式读取目标目录的同 id 会话。
- `SessionV2.messages/context/message` 已能读取目录内 `session.jsonl` 的用户/助手文本、reasoning、文件资产、event-backed prompted 用户消息、event-backed assistant step/text/reasoning/tool、agent/model/context/synthetic 直接事件、pending/running/completed 工具调用、shell 事件和 compaction 事件投影。
- `SessionV2.prompt` 对 file-backed session 写入用户 prompt 到目录内 `session.jsonl`，不再只依赖 SQLite。
- todo/schedule 在无显式目录时会校验 SQLite 缓存目录仍存在对应 file-backed session；旧目录失效时继续从当前 instance 或持久化 root 定位真实目录。
- core `SessionTodo` 的目录文件读写已经和 opencode 侧对齐：会创建会话 payload 骨架、读取旧 `extensions/todo/state.json` 作为迁移兼容，并在重写后清理旧状态。
- opencode 的 session/message/todo/schedule 已经共享同一个 file-backed session resolver；后续收紧“全局 root 回退”只需要优先改这个解析入口，而不是在多个模块里重复修。
- opencode 的 schedule 根目录查找已复用 file-backed session store 的深度扫描结果，不再维护独立目录遍历策略；schedule 继续作为会话目录内的工具状态读取。
- opencode 的 `Todo` 服务已经停止在 `get/update` 时顺手镜像 `SessionTable`/`ProjectTable` 缓存；它现在直接依赖 file-backed session resolver 和目录内 `todo.json`/`session.jsonl`，不会再因为一次 todo 更新去改写旧的 session 缓存目录。
- opencode 的 `Schedule` 服务仍保留 SQLite `ScheduleTable` / `ScheduleRunTable` 作为运行投影，但已经不再为了 schedule 去补 `SessionTable` / `ProjectTable` 缓存行。目录归档态和目录内自动化消息清理由文件事实源驱动，不再借 schedule 解析顺手制造或改写旧 session 元数据。
- opencode 的 `Schedule` 触发链路已经增加目录事实校验：`tick()`、实际 `process()` 和服务启动时的 schedule hydration 都会先确认该 schedule 仍存在于目录内 `schedule.json/session.jsonl` 投影；缺失或已删除的 stale `ScheduleTable` 行会被清掉，不会再反向触发 phantom schedule。
- opencode 的 `schedule.list` 读模型也继续收紧：列表里的 `lastRanAt/lastRunStatus` 默认取自目录投影，不再从 stale `ScheduleRunTable` 反向回填；只有当前进程里真实存在的 timer 会覆盖瞬时 `nextRun`。
- opencode 的 once schedule 完成态判断也已经切到目录投影：启动恢复、`cleanupCompletedOnceForSession()` 和单次 schedule hydration 都只认目录里的 `lastRanAt/lastRunStatus`，不会再因为旧 `ScheduleRunTable` 记录把还没真正执行过的目录 schedule 提前删掉。与此同时，fresh SQLite 基线 schema 也已补齐 `schedule/schedule_run`，保证内存库和新库行为一致。
- opencode 的 `schedule.create` 限额判断现在也已收紧到“当前目录的活跃 schedule”，不再让别的目录里同一个 `sessionID` 的运行投影行误报 `ScheduleLimitExceeded`。
- opencode 的 `schedule.delete` / `schedule.clear` 也已经继续收紧：没有命中目录里的 schedule 事实源时，它们不再回退去删除或清空 DB-only `ScheduleTable` 行；找不到目录真相时就 `NotFound` 或 no-op，运行表不会再反过来驱动业务删除。
- opencode 的 `Session` 服务也已经把 file-backed session cache sync 收紧为“只补缺失、不覆盖旧行”：`session.get`、消息事件追加和普通 patch 不再因为解析到 copied target 会话就把 `SessionTable.directory` 改写到目标目录。显式 session patch 仍会通过现有 projector 更新运行投影；同时修正了 unarchive 时 `SessionTable.time_archived` 会残留旧值的问题。
- opencode 的 `Session.get` 主读链路现在也不再把 `SessionTable` 里的 metadata/summary/workspace/path/revert/permission 合并回目录会话；目录里的 `meta.yaml + session.jsonl` 是唯一读取结果，读取本身也不再顺手重建 `SessionTable` 行。
- opencode 的 `Session.messages` / `findMessage` / `getPart` 现在也已经切到纯目录消息投影：只要会话是 file-backed，就只认当前目录 `session.jsonl` 里的 message/part 状态；即使同目录 SQLite 里还残留旧 `message/part` 缓存，只要目录日志为空或没有对应条目，也不会再把这些 stale rows 读回来。
- opencode 的 `Session.children` 也已经切到纯目录事实源：父子会话关系直接从同目录 `.agents/atree/sessions/*/meta.yaml` 里的 `parentID` 推导，不再依赖 `SessionTable.parent_id` 缓存行决定子会话归属。
- opencode 的显式目录会话列表 `Session.list({ directory })` 也已经不再先查 `SessionTable` 再 merge；它现在直接扫描目标目录下的 session store，并用目录里的 `archived/path/parentID/title/time` 过滤、排序和分页。
- opencode 的 path-scoped 会话列表 `Session.list({ path })` 也已经切到目录扫描：它直接深度读取当前 worktree 下的 file-backed session store，再按目录里的 `path`/legacy directory 语义过滤，不再需要 `SessionTable` 参与 path list 的发现或去重。
- opencode 的普通当前项目会话列表 `Session.list()` 也已经开始直接从当前 worktree 深扫目录会话；`roots/start/search/limit/metadata` 这些过滤和展示现在都可以在不依赖 `SessionTable` 行存在的前提下工作。
- opencode 的 `listGlobal()` 也继续收紧了展示层依赖：file-backed session 的 `project.id/worktree` 现在可以直接从目录会话本身推导，不再要求 `ProjectTable` 里还留着对应缓存行才能展示全局列表。
- core 的 `QuestionV2` / `PermissionV2` 在显式目录场景下也已经收紧：如果指定目录里不存在该会话，它们不会再回退到别的同 id 会话去追加 asked/replied 事件或借用对方权限配置。
- core 的 `SessionTodo` 也已经不再自己直接扫 persisted root；它现在统一通过 `SessionStore` 解析目录会话，把“根目录扫描 / 显式目录优先 / 歧义拒绝”收口到同一套规则里。
- core 的 `ToolOutputStore` 也已经去掉了自己直接扫 persisted root 的兜底；工具超长输出的附件落盘现在只信任 `SessionStore` 给出的目录归属。
- core 的 `SessionStore` 现在开始承担目录会话列表读取，`V2Session.list` 不再自己直接读 persisted root / deep session store；会话发现规则继续收口到同一层。
- core 的 persisted root 深度扫描入口也继续收口：`SessionStore.list`、`QuestionV2`、`PermissionV2` 现在共享 `readWorkspaceSessionStoresDeep()`，不再各自重复拼 `readWorkspaceRoot() + readSessionStoresDeep()`。
- opencode 的 `session.listGlobal` 现在也已经改成纯目录事实源读取：不再先查 `SessionTable` 再用目录元数据覆盖，global/directory 作用域的会话列表直接由 `.agents/atree/sessions/*` 扫描结果决定。
- core `SessionV2.list` 也已经改成目录扫描优先且不再混入 `SessionTable` 结果；无论是显式目录还是 persisted root，全局/目录列表都直接从 `.agents/atree/sessions/*` 推导。
- core `SessionV2.get` 也已经继续收紧：无论 persisted root 是否存在，只要 file-backed resolver 没找到目录会话，就直接 `NotFound`；它不再在“没有 root / 目录日志已删”时回退去读 `SessionTable` 复活 SQLite-only 会话。
- core `SessionV2.prompt` 在 file-backed 会话重试已有 prompt 时，也已经开始复用目录里的 prompt lifecycle state（`delivery/admittedSeq/promotedSeq/timeCreated`），不再返回一份与 `session.jsonl` 脱节的硬编码 prompt admission。
- file-backed session resolver 当前只按显式目录、当前 instance、持久化 atree root 解析目录事实源；它已经不再把 SQLite 中的目录缓存当作最终兜底 hint，但 core/opencode 两侧在“复制目录歧义”上的实现和测试仍需继续统一。
- opencode 的 file-backed session resolver 现在也支持“显式目录作为一个根提示”向下深搜该目录树内的 session；因此传入 atree 根目录时，嵌套节点里的会话/schedule 已可被正确解析，但一旦同目录树内出现复制歧义，仍会返回 `undefined`，不会猜测。
- 在这套显式根目录语义之上，opencode 的 `schedule.delete` 也已从浅层目录扫描切到对显式目录树的深搜；因此传入 atree 根目录时，删除嵌套节点里的 schedule 已可正常命中，并会把 state/event 写回真实节点目录，而不是误停在根目录层。
- 同时，opencode 的 `schedule.clear(sessionID)` 在“无显式目录 + persisted root 下同 id 复制目录歧义”时，也已经停止猜测并停止误删 `ScheduleTable` 投影；当前找不到唯一目录时，只要目录事实源里仍存在匹配会话，就直接 no-op，等待显式目录提示。
- 与之对应，opencode 的 `schedule.delete(scheduleID)` 在同样的无目录歧义场景下，也已经停止回退到单条 `ScheduleTable` 行去猜测删除；目录事实源仍有匹配副本但无法唯一定位时，现在会返回 `NotFound`，要求显式目录提示。
- 这条歧义规则也已经继续压到了运行态：`schedule.recordRun(...)` 和 `schedule.tick(...)` 在“persisted root 下存在 copied directory、且无显式目录 hint”时都只会 no-op，不会偷偷补写 `ScheduleTable/RunTable`，也不会推进任一副本目录里的 schedule 状态。
- 对于 copied directory 下“同一个 `scheduleID` 被两个目录副本同时拥有”这一类运行态冲突，当前策略也已经继续保守化：显式读取 target 目录的 schedule 列表时，只返回 target 自己的目录投影，不再因为 restore/hydrate 抢占或覆盖 source 目录已经存在的 runtime row / timer。
- `todo` 护栏已经与当前目录歧义规则对齐：当 persisted root 下存在多个复制目录、且同一个 session id 无显式目录 hint 时，不再猜测其中一个 todo 状态，而是视为歧义；但 core/opencode 两侧的 resolver 语义仍未完全统一，这会继续影响 schedule/todo 等工具状态的无目录解析。

已通过的护栏：

- `packages/opencode/test/session/atree-self-contained.test.ts`
- `packages/opencode/test/atree/schedule-store.test.ts`
- `packages/core/test/atree-session-store.test.ts`
- `packages/core/test/question-atree.test.ts`
- `packages/core/test/permission-atree.test.ts`
- `packages/opencode/test/server/httpapi-session.test.ts` 中 file-backed v2 相关用例
- `packages/app/e2e/atree/invariants.spec.ts`
- `packages/app/e2e/atree/smoke.spec.ts`

关键缺口：

- OpenCode V1 session 服务和 core `SessionV2` 仍是两套读写入口。
- SQLite 仍承担运行时投影、执行队列和部分兼容缓存；目前还不能删除。
- core `SessionV2` 已经能恢复文本、reasoning、文件资产、event-backed prompted 用户消息、event-backed assistant step/text/reasoning/tool、agent/model/context/synthetic 直接事件、pending/running/completed 工具调用、shell 事件和 compaction 事件。
- core `QuestionV2` 和 `PermissionV2` 已能从目录 `session.jsonl` 恢复 pending question/permission，并把 reply 继续写回对应会话日志；但 permission/question 的更完整 UI 状态和历史展示还没有统一成 typed session view model。
- `QuestionV2` / `PermissionV2` 这一层的目录闭环已经比较明确：恢复 pending、外部 reply/reject、以及 source/target 复制目录下同 session id 的 overlap 场景，都已经有测试覆盖，reply/reject 会回写到各自所属目录的 `session.jsonl`，不会再按同一个 session id 互相串写。
- 真正模型输出链路仍主要由 OpenCode 原有 projector/runtime 推动，目录 JSONL 目前是事实源化过程中的镜像与恢复层。

### 运行层边界审查

当前代码里仍然有一些全局 SQLite 或全局 storage 写入，但它们的性质不同，不能一概视为目录事实源缺口：

- `SessionInputTable` 是 prompt admit/promote 的运行队列和并发护栏。目录事实源要求是：prompt 一旦被 durable 接收，必须能从当前目录的 `session.jsonl` 恢复；队列本身可以暂时保留在 SQLite，后续再迁移为可重建运行态。
- `SessionContextEpochTable` 是系统上下文 baseline、replacement 和 revision 的运行锁/快照。当前已经能为 file-backed session 自动重建必要的 SQLite 投影，并把 context update 写回 `session.jsonl`；后续要做的是把 typed view model 和重建逻辑收敛，而不是直接删除表。
- 但 `SessionInputTable` / `SessionContextEpochTable` 当前仍然是按 `session_id` 单键表达的全局运行态。对于 copied source/target 同 id 并存的场景，它们还不能像 `question/permission` 那样天然区分“每个目录副本各自的 pending/epoch”；这一层后续如果要彻底目录自包含，要么改成目录作用域 key，要么改成纯目录内可重建运行模型。
- `storage.write(["session_diff", sessionID], ...)` 目前仍作为旧 HTTP/UI 兼容投影存在。目录事实源已经通过 `session.diff` 事件和 session summary replay 恢复会话级 diff；后续迁移目标是让读取链路不再依赖这个全局 storage。

判断原则：

- 会话历史、标题、归档、emoji、自动化消息、todo、权限/问题决策、工具调用结果和长期资产必须能随目录迁移。
- 运行锁、执行队列、SSE 投影、搜索索引和最近打开记录可以暂时留在全局运行层，但必须能从目录事实源重建或失效后安全丢弃。

### 运行层收紧结论

如果按新的 demo 策略继续推进，运行层也应该继续收紧：

- `SessionTable` / `ProjectTable` 不再作为“会话目录归属”的兜底来源。
- `SessionRunner` 读取目录会话时也不该再依赖全局 workspace root；当前已经改成“先按当前 `Location.directory` 取 file-backed session，再按旧全局路径兼容纯 SQLite session”。
- `SessionRunner` 的 pending-input 判断也已经加了护栏：只要当前目录下存在 file-backed session，就以该目录的 prompt state 为准，不再让脏 `SessionInputTable` 队列误触发额外 provider turn。
- `SessionInputTable` / `SessionContextEpochTable` 可以短期保留，但要被明确标记为纯运行态；它们丢失后，不能导致会话业务事实丢失。
- core `SessionContextEpoch` 现在也已有护栏覆盖“删除 `SessionTable` 缓存行后可从目录事实源重建 epoch”；这进一步确认了 context epoch 属于可丢弃运行态，而不是目录业务事实本身。
- `ScheduleTable` / `ScheduleRunTable` 也应该逐步降级为运行投影，最终由目录内 schedule 状态和 `session.jsonl` 恢复。
- 后续如果某个运行表无法自然重建，就说明它仍然混入了业务事实，应该继续拆。

下一步优先级：

1. 继续补护栏测试，固定当前可用行为，尤其是直接打开 session URL、切换目录、归档、一次性 schedule 触发后清空 header。
2. 把“会话读写事实源”集中到一个 atree session store 模块，减少 `packages/core/src/atree/session-store.ts` 和 `packages/opencode/src/atree/session-store.ts` 的重复逻辑。
3. 把 `SessionTable` / `ProjectTable` 在 atree 主链路上的读取责任继续剥离，只保留必要运行态，不再让它们决定业务真相。
4. 统一 core/opencode `session resolver` 对“复制目录歧义”的规则，再继续扩展 core JSONL reader 和 typed view model，让 permission/question、schedule、todo 等目录状态在 UI/API 侧有统一投影。
5. 等目录事实源链路稳定后，再收敛 HTTP facade；不要先删 OpenCode 接口，否则测试护栏会不够。
6. Pi core 替换应新开分支做，保留当前 OpenCode spike 作为可运行对照。

## 阶段 0：固定当前可用版本

目的：保证当前 demo 不再因为状态边界反复回归。

已完成或正在完成：

- 直接打开首页时，不显示历史 session tab。
- 直接打开某个 session URL 时，只显示当前 session tab 和新会话占位。
- 只有从左侧点击目录节点时，才显示该目录的会话 tab group。
- 归档 tab 后，同步移除 server sync 和目录树本地缓存，避免被旧缓存重新加回来。
- 直接打开 session URL 时，会恢复该 session 所在目录的完整 tab group。
- 切换目录时，tab group 只展示当前目录自身的会话，不包含子目录会话。
- 有自动化消息的会话归档需要二次确认，确认后清除自动化消息。

后续补充：

- 继续为新增不变量补 Playwright 测试。
- 当前提交不再继续扩大 UI 交互细节，除非影响主流程。

## 阶段 1：服务端 root workspace 状态

atree 用户视角中，服务实例只打开一个根目录。这个 root 是服务端状态，不应该属于浏览器 localStorage。

当前状态：已实现。后续只在发现 root 切换缓存污染时继续补测试或清理。

### 目标

最小 workspace API：

```text
GET /api/workspace
PUT /api/workspace/root
```

返回结构示例：

```json
{
  "rootDirectory": "/Users/zexi/workspace",
  "updatedAt": 1781712000000
}
```

### 存储位置

root workspace 状态不应放入 root 目录自己的 `.agents/atree/`，因为它描述的是 atree 服务实例“当前打开哪个根目录”，不是该目录内部数据。

当前实现复用 OpenCode data dir 下的 atree 专属状态文件：

```text
<opencode-data-dir>/atree/state.json
```

状态文件只保留最小字段：

```json
{
  "version": 1,
  "rootDirectory": "/Users/zexi/workspace",
  "updatedAt": 1781712000000
}
```

实现要求：

- 写入前把目录规范化为绝对路径。已实现。
- 写文件使用原子写入，避免中途崩溃损坏状态。已实现。
- `PUT /api/workspace/root` 覆盖旧 root。已实现。
- 切换 root 时前端必须清空当前 tab group 和目录缓存。已通过 E2E 保护主路径，后续继续补边界。

### 前端行为

- 启动时 `GET /api/workspace`。
- 无 `rootDirectory` 时显示“选择一个根目录开始”。
- 选择目录后 `PUT /api/workspace/root`。
- 前端用服务端返回的 root 初始化目录树。
- 切换根目录时，服务端覆盖旧 root；前端清空当前 tab group。

### 不做

- 不支持多 root。
- 不做多人协作冲突。
- 不做远程鉴权。

## 阶段 2：薄 tree 读模型

不要马上铺完整 atree facade。第二步只做 root 之上的派生读模型：

```text
GET /api/tree
```

它只负责基于当前服务端 root 扫描目录树，并返回前端左侧树需要的最小数据。

不在这个接口里混入：

- session 消息流
- assets 上传
- extension 状态
- OpenCode project/worktree 语义
- Pi adapter 细节

这个阶段的目标是先让“当前根目录”从服务端驱动 UI，而不是一次性重构所有数据模型。

## 阶段 3：atree-shaped facade contract

完整 facade 要晚一点做，而且必须按 atree/Pi 产品模型设计，不能按 OpenCode 现有能力倒推。OpenCode 只能作为临时 adapter，不能让 facade 固化成 OpenCode 兼容层。

### 最终接口候选

```text
GET   /api/workspace
PUT   /api/workspace/root

GET   /api/tree

GET   /api/directories/:directoryRef/sessions
POST  /api/directories/:directoryRef/sessions
PATCH /api/sessions/:sessionID

POST  /api/sessions/:sessionID/messages
GET   /api/sessions/:sessionID/events

POST  /api/sessions/:sessionID/assets

GET   /api/directories/:directoryRef/extensions/:name/*path
GET   /api/sessions/:sessionID/extensions/:name/*path
```

### 设计原则

- 前端只依赖 atree facade，不直接依赖 OpenCode 的 session/project/worktree API。
- facade 可以先由 OpenCode core 适配实现，后续替换为 Pi core。
- `directoryRef` 在 MVP 中可以是 root-relative path token 或 base64 path，但不要承诺它是长期稳定身份。
- 稳定身份优先只承诺给 `sessionID`。
- 扩展数据可以走通用 extension endpoint，但必须保留 directory/session 作用域，不能变成任意文件读取接口。
- schedule 的执行机制可以是扩展，但“一个会话最多一个自动化消息、tab 排序、归档确认”属于产品核心状态，必须进入 typed session view model / `meta.yaml`。

### 现在推迟的接口

以下接口不要在 root state 阶段一次性实现：

- `GET /api/directories/:directoryRef/sessions`
- `POST /api/directories/:directoryRef/sessions`
- `PATCH /api/sessions/:sessionID`
- `POST /api/sessions/:sessionID/messages`
- `GET /api/sessions/:sessionID/events`
- `POST /api/sessions/:sessionID/assets`
- extension endpoint

推迟原因：

- session 的目录内事实源格式还在落地中。
- directoryRef/sessionID 映射策略还没稳定。
- extension 机制尚未出现必须通过 HTTP 暴露的刚需。
- 过早冻结 messages/events 接口，会和 Pi/JSONL 事件模型重复建模。

## 阶段 4：目录内事实源

会话是目录数据的一部分。长期目标是把业务事实源放回目录：

```text
some-directory/
  .agents/
    skills/
    atree/
      meta.yaml
      sessions/
        <session-id>/
          meta.yaml
          session.jsonl
          assets/
          schedule.json
          todo.json
      extensions/
        ...
```

关键约束：

- `.agents/` 是通用 Agent 目录。
- `.agents/atree/` 是 atree 专属事实源。
- `session.jsonl` 是会话原始事件流，不只是渲染后的聊天文本。
- `schedule.json`、`todo.json` 是当前 OpenCode spike 的过渡实现，用来先把会话工具状态放回会话目录；长期可以折叠进 `meta.yaml` 或 session event。
- data URL 文件 part 已经会落盘到 `assets/`，`session.jsonl` 只保留 `assets/...` 相对路径；读取投影会按需恢复成现有 UI/LLM 链路可用的 data URL。
- SQLite 只能作为可重建缓存，不应是唯一事实源。
- `assets/` 保存会话长期材料，不使用绝对路径引用。

这一阶段的详细存储计划见 `docs/v2-storage-plan.md`。

### 最小可执行切片

优先做一个无模型调用的端到端切片：

1. 在目标目录创建 `.agents/atree/sessions/<session-id>/`。
2. 写入 `meta.yaml`、空 `session.jsonl`、`assets/`。
3. session 列表通过扫描 `sessions/*/meta.yaml` 得到。
4. 不读 OpenCode SQLite 作为新会话事实源。
5. Playwright 验证刷新后仍能从目录恢复 session tab。

这个切片能同时验证 root 是服务状态、目录是事实源、facade 是 atree 形状。

## 阶段 5：Pi core 替换

最终目标：

```text
atree UI
  -> atree runtime API
  -> Pi SDK
  -> .agents/atree/sessions/<session-id>/session.jsonl
```

### 迁移策略

先构造薄适配层，让当前 UI 继续工作：

```text
Pi session/event
  -> atree session view model
  -> 当前 ChatView
```

适配层只负责：

- session 列表
- message 列表
- streaming event
- tool call state
- schedule state
- archive/title/icon metadata

它不能发展成新的复杂协议。最终 atree UI 应该直接理解 atree session 结构。

### 不建议

- 不建议继续深挖 OpenCode core 作为长期底座。
- 不建议把 Pi 消息再包一层复杂消息格式。
- 不建议先删旧接口再迁移 UI。

## 阶段 6：schedule 作为扩展

schedule 不是核心 HTTP 模块，而是 Pi/atree 扩展。

目标模型：

```text
Pi extension
  -> registerTool("create_schedule")
  -> appendEntry(session.jsonl)
  -> write .agents/atree/sessions/<session-id>/schedule.json

atree runtime
  -> tick 扫描到期任务
  -> 调 Pi SDK 唤醒会话
  -> 更新 session meta / extension state

Web UI
  -> 通过 extension endpoint 读取状态
  -> 展示自动化消息 header
```

一个会话最多一个自动化消息。重复设置必须报错，除非先删除旧自动化消息。

## Playwright 护栏

当前阶段不需要写大量稳定 UI 快照，但需要覆盖状态不变量。

优先测试：

1. 无 root 时，左侧和右侧都显示“选择一个根目录开始”，顶部没有 session tab。
2. 设置 root 后，刷新页面仍能从服务端恢复 root。
3. 直接打开 session URL 时，顶部只显示当前 session 和新会话占位。
4. 点击左侧目录节点时，顶部显示该目录的会话 tab group。
5. 归档当前 tab 后，tab 消失，归档菜单出现，切换目录后不会复活。
6. 归档有 schedule 的会话时，需要二次确认，并清除自动化消息。
7. 设置 `at` 自动化消息后，header 立即出现；取消后立即消失。

测试策略：

- 用 Playwright 做关键用户流，不追求覆盖每个 UI 细节。
- 优先使用 mock 后端或临时目录 fixture，避免污染真实 workspace。
- 避免依赖真实模型调用；发送消息相关测试可使用 mock server 或 fake backend。
- 每个测试验证一个状态不变量，避免长链路脆弱用例。
- 每个测试前清理 `localStorage` 和 `sessionStorage`，避免历史 tab 泄漏。
- 临时排障测试应放到 `e2e/manual/` 或被 `testIgnore` 排除，不进入主回归。
- 未 mock 的后端请求应直接 fail，避免测试误连真实服务。

## 推荐顺序

1. 先补 Playwright 不变量测试，固定当前 demo 行为。
2. 实现服务端 root workspace 状态。
3. 把前端 root 选择迁移到服务端状态。
4. 新增薄 `GET /api/tree`，让目录树由服务端 root 驱动。
5. 定义 atree-shaped facade contract，但只实现当前最小切片。
6. 新会话先写入 `.agents/atree/sessions/<session-id>/`。
7. 开 Pi core 分支，实现同一 contract 的 Pi 后端。
8. 对比通过测试后，再决定是否合并 Pi core 主线。

## 风险

- 如果先替换 Pi core，当前 UI 细节会大量回归，成本高。
- 如果继续在 OpenCode core 上补功能，会被全局 SQLite 和宽接口面牵制。
- 如果没有 Playwright 护栏，tab/root/archive 这类状态问题会反复出现。
- 如果 extension endpoint 过早泛化，可能变成无结构的文件读取接口，需要保留 directory/session 作用域。
- 如果 facade 先按 OpenCode 能力设计，后续 Pi core 和目录事实源都会被迫适配错误抽象。
- 如果 root 切换时没有清掉目录树、tab、session 列表和归档缓存，旧状态会复活。

## 当前结论

下一步最值得做的是：

```text
Playwright 护栏
  -> 服务端 root workspace state
  -> 薄 tree 读模型
  -> atree-shaped facade contract
  -> 目录内新会话事实源切片
  -> Pi core 替换
```

这条路径能把当前 demo 先稳定住，再逐步减少 OpenCode 依赖，而不是一次性重写导致 UI 和核心同时失控。
