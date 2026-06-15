# Pi Core Spike

本分支目标：保留当前 atree UI 经验，替换 OpenCode backend core。

## 当前策略

第一阶段不直接重写前端。

先实现一个 OpenCode-compatible HTTP facade：

```text
当前 atree UI
  -> @opencode-ai/sdk client shape
  -> atree runtime
  -> .agents/atree
  -> Pi SessionManager / AgentSession
```

这让我们可以一边保持 UI 可用，一边逐步替换 backend。

## 当前已完成

新增包：

```text
packages/atree-runtime/
```

它提供一个最小 runtime：

```bash
bun run dev:pi-backend
```

默认监听：

```text
http://127.0.0.1:4196
```

无 API Key 的 Pi 执行测试模式：

```bash
bun run dev:pi-backend:faux
```

只验证目录存储、不调用模型的调试模式：

```bash
bun run dev:pi-backend:none
```

运行 web 前端并连接 Pi runtime：

```bash
bun run dev:pi-split
```

运行 web 前端并连接 faux Pi runtime，适合无 API Key 检查流式回复和工具调用：

```bash
bun run dev:pi-split:faux
```

运行 web 前端但禁用模型执行，适合只检查存储和 UI：

```bash
bun run dev:pi-split:none
```

前端开发入口使用 `VITE_ATREE_SERVER_HOST` / `VITE_ATREE_SERVER_PORT` 指向 runtime；旧的 `VITE_OPENCODE_SERVER_HOST` / `VITE_OPENCODE_SERVER_PORT` 仍保留为兼容回退。默认 server localStorage key 已切换为 `atree.settings.dat:defaultServerUrl`，避免被旧 OpenCode 开发环境保存的 4096 地址覆盖。

已实现：

- `/global/health`
- `/global/event`
- `/path`
- `/project`
- `/project/current`
- `/config`
- `/global/config`
- `/api/provider`
- `/provider`
- `/agent`
- `/command`
- `/question`
- `/session`
- `/session/:id`
- `/session/:id/message`
- `/session/:id/prompt_async`
- `/session/:id/schedule`
- `/session/:id/todo`
- `/atree/session`
- `/atree/session/:id`
- `/atree/session/:id/entries`
- `/atree/session/:id/prompt_async`
- `/atree/session/:id/schedule`

其中 `/session...` 仍是当前前端底层 sync/fallback、SSE 和部分兼容逻辑依赖的 OpenCode-compatible facade；`/atree...` 是 atree native 接口，直接暴露 `.agents/atree` 中的 session `meta.yaml`、schedule 和 Pi `session.jsonl` entries，不返回 OpenCode 的 `slug`、`projectID`、`time`、`tokens`、`info`、`parts` 这些前端兼容形状。目录树的会话元信息读取、启动/目录对象 session list、目录对象 archive、归档菜单、打开会话时的 session detail、permission/question 关联会话预热、新建普通会话、标题编辑、emoji 更新、归档/恢复归档、消息历史读取和布局层预取、diff/todo 状态读取、普通 prompt 写入和自动化消息读/删已经通过前端 adapter 或 native endpoint 消费 `/atree/session` / `/atree/session/:id` / `/atree/session/:id/entries` / `/atree/session/:id/diff` / `/atree/session/:id/todo` / `/atree/session/:id/prompt_async` / `/atree/session/:id/schedule`。adapter 只把 native session meta、schedule 和 Pi message entries 映射成现有 UI 暂时需要的最小 `Session` / `SessionScheduleSummary` / `Message` / `Part` 形状；prompt 写入不重新包装消息协议，只把当前 request parts 发给 native endpoint，且 native 模式下失败不再静默回退到 OpenCode SDK。后续可以继续把底层 sync 和 SSE 迁到 native/Pi 接口，再逐步缩掉 facade。

已落盘到目录事实源：

```text
.agents/
  skills/
  atree/
    meta.yaml
    sessions/
      <session-id>/
        meta.yaml
        session.jsonl
        assets/
```

`session.jsonl` 已使用 Pi session header version，并通过 `@mariozechner/pi-coding-agent` 的 `parseSessionEntries` 读取。

`meta.yaml` 使用真正的 YAML 读写，不再是 JSON 改扩展名；runtime 仍能读取旧的 JSON 风格 `meta.yaml`，因为 JSON 是 YAML 子集。护栏会验证 runtime 写出的 YAML 文本，以及手写 YAML meta 可以恢复成 session。

`prompt_async` 当前有三条路径：

- 默认模式：不设置 `ATREE_PI_EXECUTION` 时按 `real` 处理，通过 Pi `createAgentSession(...)` 和 `AgentSession.prompt(...)` 执行，复用 Pi 默认的 agentDir、auth、model、skills、extensions 和内置工具配置。这个模式需要用户本机已经按 Pi 的方式配置好模型和 API Key。
- `ATREE_PI_EXECUTION=none`：不调用模型，只用 Pi `SessionManager` 追加用户消息，并立刻 flush，保证 UI 和刷新后都能看到用户消息。它只用于存储调试和护栏测试。
- `ATREE_PI_EXECUTION=faux`：通过 Pi `createAgentSession(...)` 和 `AgentSession.prompt(...)` 执行，使用 Pi 自带 faux provider，无需 API Key，assistant 输出会写回同一个 `session.jsonl`。
- `ATREE_PI_EXECUTION=real`：显式指定真实 Pi 执行路径，语义和默认模式一致。
- faux 执行模式会把 Pi `message_start` / `message_update` / `message_end` 映射成当前 UI 使用的 `message.updated`、`message.part.updated`、`message.part.delta` 和 `session.status` SSE 事件。当前已覆盖 text/reasoning part。
- faux 执行模式已注册一个受控的 `atree_echo` 工具，用来验证 Pi `tool_execution_start` / `tool_execution_update` / `tool_execution_end` 可以映射成当前 UI 使用的 `tool` part。工具调用结果会写入同一个 `session.jsonl`，刷新后仍能从历史还原为 `tool` part。
- faux 执行模式还会触发 Pi 内置 `read` 工具读取测试目录中的真实文件，用来验证内置工具可以复用同一套 tool part 映射和历史还原。
- 存储契约会手写 Pi V3 风格的 assistant `toolCall` 和 `toolResult` 消息，验证不经过模型执行时，原始 `session.jsonl` 也能还原成前端需要的 completed `tool` part。
- `/skill` 已接到 Pi 的 skill discovery。当前 Pi 0.73.1 代码默认加载 `.pi/skills`，但 atree 额外把 `~/.agents/skills`、当前目录和祖先目录的 `.agents/skills` 传入 `DefaultResourceLoader` / `loadSkills`，保证通用 Agent Skills 目录能成为当前目录上下文的一部分。
- Pi 执行模式会在创建 `AgentSession` 后显式调用 `session.bindExtensions({})`。护栏会在临时目录写入真实 `.pi/extensions/*.ts`，验证 `session_start`、`resources_discover` 和 `before_agent_start` 都会被 Pi extension lifecycle 触发。
- 一次性 `at` 自动化消息已经由 runtime 内置 tick 执行。runtime 只扫描当前服务请求过的目录；`ATREE_PI_EXECUTION=none` 会把自动化用户消息写入当前会话的 `session.jsonl`。默认模式、`ATREE_PI_EXECUTION=faux` 和 `ATREE_PI_EXECUTION=real` 都会通过 `AgentSession.prompt()` 执行，assistant 输出也写回同一个 `session.jsonl`。消息带 `source.type = "schedule"`，完成后清除 `meta.yaml` 中的待执行 schedule，并发出 `schedule.ran` / `schedule.deleted` 事件。
- API 创建的一次性 `at` 自动化消息会把 `run_at` 写成 ISO 字符串，方便人类直接阅读和编辑；runtime 仍兼容旧的数字毫秒时间戳，以及手写 YAML 中的 ISO `run_at`。
- `cron` 周期自动化消息已经由同一个 tick 执行。到期后写入同一个 `session.jsonl`，Pi 执行模式下同样会通过 `AgentSession.prompt()` 得到 assistant 回复。`cron` 不会删除 schedule，而是更新 `last_ran_at` / `last_run_status`。`nextRun` 由 `croner` 根据表达式和 `last_ran_at` 之后的第一个命中点计算。
- Pi 未配置模型或认证时，自动化触发会发出 `session.error`，把本次运行标记为 `skipped`，并回到 idle；一次性 `at` 会清除 pending schedule，避免反复报错。
- 文件 part 已经写入当前会话的 `assets/`：`data:` 资产会解码写入，本地 `file://` 或本地路径引用会复制写入。`session.jsonl` 只保存 `assets/<file>` 相对路径；`none`、`faux` 和真实 Pi 执行模式都走同一个落盘逻辑。
- `prompt_async` 的 optimistic user message 需要立即刷新到 `session.jsonl`，当前 runtime 使用 Pi `SessionManager` 的 `_rewriteFile` 作为 durability boundary；guardrail 会检查该边界存在，runtime 也会在缺失时显式报错。

## 当前未完成

真实模型执行路径已经接到 Pi `AgentSession.prompt()`，并提供了显式 opt-in 的最小成功契约：

```bash
ATREE_PI_EXECUTION=real bun run dev:pi-backend
bun run test:contract:pi-real-success
```

这个入口不会被默认 `bun run test` 调用，避免误触真实模型。

已执行记录：

- 2026-06-16：使用用户本机 Pi 配置启动 `ATREE_PI_EXECUTION=real bun run dev:pi-backend`，随后执行 `bun run test:contract:pi-real-success`。结果：8 pass / 28 skip / 0 fail；真实 Pi `prompt_async` 成功进入 busy、完成回复、回到 idle，并把 user / assistant 写入当前目录 `.agents/atree/sessions/<id>/session.jsonl`。
- 2026-06-16：扩展 `test:contract:pi-real-success`，加入真实 Pi 配置下的 extension lifecycle 验证。结果：9 pass / 28 skip / 0 fail；真实 `.pi/extensions/*.ts` 在真实模型执行路径下触发 `session_start`、`resources_discover` 和 `before_agent_start`，并记录到当前目录 `.agents/atree-contract/extension-events.jsonl`。
- 2026-06-16：扩展 `test:contract:pi-real-success`，加入真实 Pi 配置下的一次性 `at` 自动化消息验证。结果：10 pass / 28 skip / 0 fail；到期 schedule 通过真实 `AgentSession.prompt()` 执行，清除 pending schedule，并把带 `source.type = "schedule"` 的自动化 user message 和 assistant 回复写入当前目录 `session.jsonl`。
- 2026-06-16：扩展 `test:contract:pi-real-success`，加入真实 Pi 流式 SSE 验证。结果：11 pass / 30 skip / 0 fail；真实 `prompt_async` 会流出 user `message.updated` 和 assistant `message.part.delta`，并验证 assistant `parentID` 指向本轮 user message，避免真实链路下 ChatView 隐藏回复。

当前默认护栏已经用浏览器跑通 faux Pi 链路：页面打开真实 session，发送消息，展示 faux assistant 回复，并确认消息写入目录 `session.jsonl`。还缺的是会消耗真实模型资源的浏览器端验收：

- 浏览器 UI 下真实模型回复的人工验证记录
- 使用用户真实 Pi 配置跑浏览器 UI 下的自动化端到端验证

真实 Pi 内置工具调用暂时不做自动契约测试：真实模型是否选择 `read` / `write` / `edit` / `bash` 工具不可完全确定，默认护栏只用 faux 模型覆盖确定性工具链路。真实模型下的工具调用先作为手动验收：

- 发送“读取 README.md 前 20 行”，确认 SSE 和刷新后的历史里都出现 `read` tool part。
- 发送“在当前目录创建 atree-tool-smoke.txt 写入 hello”，确认文件落盘，历史里出现 `write` tool part。
- 发送“把 atree-tool-smoke.txt 里的 hello 替换成 world”，确认文件被修改，历史里出现 `edit` tool part。
- 发送“运行 ls”，确认命令输出出现在 `bash` tool part。
- 重启 runtime 后重新打开该目录，确认上述工具调用历史仍能从当前目录 `.agents/atree/sessions/<id>/session.jsonl` 还原。

`cron` 的 MVP 边界语义先固定为：

- runtime 停机期间错过的多轮 cron 不追赶补跑；重启后只按当前扫描发现的一次到期任务执行一轮。
- cron 执行失败时记录 `last_run_status: skipped`，不立即重试，下一轮仍按表达式继续。
- 同一 session 的普通 prompt 和自动化 prompt 通过 runtime 的 per-session 写锁串行执行，不并发写同一个 Pi session。

多轮补跑、失败重试和更细的忙碌跳过策略放到后续版本权衡。

## 护栏

契约测试在：

```text
packages/atree-contract/contract.test.ts
```

运行当前 runtime 的完整护栏：

```bash
bun run dev:pi-backend:none
bun run test:contract:pi
```

运行 Pi faux 执行护栏：

```bash
bun run dev:pi-backend:faux
bun run test:contract:pi-exec
```

当前要求：

- OpenCode-compatible HTTP/SSE 契约通过。
- atree native 只读 HTTP 契约通过：`/atree/session` 和 `/atree/session/:id/entries` 能直接从 `.agents/atree` 返回原生 meta / Pi entries，且不混入 OpenCode message shape。
- atree native session mutation 契约通过：`POST /atree/session`、`PATCH /atree/session/:id` 和 `DELETE /atree/session/:id` 都只读写当前目录 `.agents/atree`。
- atree native prompt 写入契约通过：`/atree/session/:id/prompt_async` 会把消息写进同一个 Pi `session.jsonl`，并能通过 native entries 读回原始 Pi entry。
- atree 目录存储结构契约通过。
- Pi `AgentSession.prompt()` faux 执行契约通过。
- Pi faux 工具调用流式事件和历史还原契约通过。
- Pi 内置 `read` 工具 faux 触发契约通过。
- Pi 内置 `write` / `edit` / `bash` 工具 faux 触发契约通过。
- Pi extension lifecycle faux 契约通过：真实 `.pi/extensions/*.ts` 会触发 `session_start`、`resources_discover` 和 `before_agent_start`。
- `/provider` 暴露固定的 Pi 默认 provider/model，`/agent` 暴露绑定该模型的 primary agent，前端无需手动选择模型即可发送。
- Pi assistant 消息会通过 `parentID` 挂在本轮 user message 下；否则 OpenCode ChatView 会把 assistant 隐藏在时间线之外。
- 当前目录 `.agents/skills/<name>/SKILL.md` 可以通过 `/skill` 被发现，返回 OpenCode-compatible 的 `name`、`description`、`location` 和 `content`。
- 一次性 `at` 自动化消息到期后写入 `session.jsonl`、发出 schedule 事件并清除 pending schedule。
- 一次性 `at` 自动化消息以 ISO `run_at` 写入 `meta.yaml`，并能从手写 ISO YAML 和旧数字时间戳两种格式恢复。
- `cron` 周期自动化消息到期后写入 `session.jsonl`、发出 schedule 事件并保留 recurring schedule。
- Pi faux 模式下，一次性 `at` 自动化消息会穿过 `AgentSession.prompt()` 并持久化 assistant 回复。
- Pi real 未配置时，自动化消息会标记 skipped、发出错误事件并回到 idle。
- 不设置 `ATREE_PI_EXECUTION` 时默认进入真实 Pi 路径；护栏会用空 Pi 配置证明它不会退回 no-op 存储模式。
- 真实 Pi 成功路径有显式 opt-in 契约入口：它会验证真实模型回复可以穿过 `prompt_async` 并写回当前目录的 `session.jsonl`，但不进入默认护栏。
- 文件 part 会落入 `assets/` 并从 `session.jsonl` 还原成 file part。
- atree runtime 重启后，即使隔离出来的全局缓存/config 目录被删除，也可以只依赖同一个业务目录里的 `.agents/atree/` 恢复 session、emoji、自动化消息、消息文本和资产引用。
- 同一个 runtime 访问多个业务目录后，即使隔离出来的全局缓存/config 目录被删除，重启后也只能从各自业务目录里的 `.agents/atree/` 恢复各自 session、消息和资产，不能依赖全局 session registry，也不能串目录。
- 单个 `.agents/atree/sessions/<id>/` 目录移动到另一个业务目录后，可以作为自包含会话单元恢复。
- 复制业务目录或移动单个会话目录后，runtime 会在打开会话时把 `session.jsonl` 第一行 Pi session header 的 `cwd` 修复为当前业务目录。
- `bun run test:guardrails` 会模拟 faux Pi 执行过程中 runtime 被关闭；重启后只依赖同一个业务目录里的 `.agents/atree/` 恢复 session 和已落盘历史，并验证后续 `prompt_async` 仍可继续执行。
- `bun run test:guardrails` 会在同一个 runtime 里写入两个业务目录，删除全局缓存后重启，验证 `/session` 和 `/atree/session` 都只从当前目录 `.agents/atree/` 恢复当前目录自己的 session 和 assets。
- Web 前端通过 `dev:pi-split:faux` 启动时请求 4196 的 atree runtime，而不是 4096 的 OpenCode backend；`bun run test:guardrails` 会自动跑 Vite dev bundle smoke，并用 Playwright 打开真实浏览器页面验证 `aTree` 首屏渲染、backend 连接、网页发送消息、faux assistant 回复展示和 `.agents/atree/sessions/<id>/session.jsonl` 落盘。
- 目录树、归档菜单、session detail、消息历史读取和自动化消息读/删已经走 `/atree/session` / `/atree/session/:id` / `/atree/session/:id/entries` / `/atree/session/:id/schedule`，默认护栏中的前端 build 和浏览器 smoke 覆盖了这些 adapter 可以在真实页面中加载、发送消息并保持目录 JSONL 落盘；浏览器 smoke 会明确断言会话页请求过 native detail、native entries 和 native schedule endpoint。
