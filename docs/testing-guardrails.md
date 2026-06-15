# atree 测试护栏

本文档说明当前测试的分层方式，避免在替换核心时被 OpenCode 原有测试套件牵着走。

## 现有测试套件是什么

当前仓库继承自 OpenCode，因此已有测试大多验证 OpenCode 自己的内部行为，包括：

- OpenCode session 存储、message、part、projector
- OpenCode server HTTP API
- OpenCode runner、tool、permission、revert、compaction
- 前端 sync reducer、tab、prompt input 等 UI 逻辑
- 少量 Playwright/e2e 测试

这些测试对理解原系统有价值，但它们不是 atree 第二版替换核心的主要护栏。

原因是：第二版目标不是保持 OpenCode core 的内部结构，而是保持 UI 所依赖的接口行为稳定，然后把后端换成 atree runtime + Pi。

## 新增契约测试

新增的契约测试在：

```text
packages/atree-contract/contract.test.ts
```

日常运行方式：

```bash
bun run test
```

或显式运行：

```bash
bun run test:guardrails
```

这个入口会自动：

- 检查 `packages/atree-runtime` 的源码边界：runtime 可以暴露 OpenCode-compatible HTTP/SSE 形状，但不能依赖或 import OpenCode backend core；runtime 必须依赖并 import `@mariozechner/pi-coding-agent`
- 依次启动 atree runtime 的四种测试后端
- 等待 `/global/health` 可用
- 运行对应 contract 测试
- 关闭测试后端
- 启动、写入、关闭、重启 atree runtime，确认目录事实源能跨进程恢复
- 最后执行前端 build
- 启动临时 Vite dev server，确认前端开发入口会连到 atree runtime

最近一次执行记录：

- 2026-06-16：`bun run test:guardrails` 通过；storage contract 36 pass，Pi faux execution contract 45 pass，real/default Pi missing-config boundary contract 各 23 pass / 15 skip，restart persistence smoke、frontend build、frontend browser smoke 均通过。新增 Pi 默认 provider/model 契约、cron `nextRun` 基线契约、手写 Pi tool history 恢复契约，以及网页发送消息到目录 JSONL 的浏览器 smoke 已进入默认护栏。

底层单项运行方式：

```bash
bun run test:contract
```

默认目标服务：

```text
http://127.0.0.1:4096
```

可以用环境变量改目标：

```bash
ATREE_CONTRACT_BASE_URL=http://127.0.0.1:4096 bun run test:contract
```

可以指定测试目录：

```bash
ATREE_CONTRACT_DIRECTORY=/path/to/workspace bun run test:contract
```

## 契约测试测什么

这组测试不测 OpenCode 内部实现，只测前端当前依赖的 HTTP/SSE 行为：

- `/global/health`
- `/global/event`
- `/path`
- `/skill`
- `/session`
- `/session/:id`
- `/session/:id/message`
- `/session/:id/prompt_async`
- `/session/:id/schedule`
- `/session/:id/todo`
- `/question`

基础契约测试刻意不调用真实模型，因此不依赖 API Key。需要触发模型路径的护栏会使用 Pi faux provider 或空 Pi 配置错误边界。

目前覆盖：

- 服务健康检查
- 目录 path 信息
- 用户 home、当前目录和祖先目录的 `.agents/skills/<name>/SKILL.md` 可以通过 `/skill` 被发现，并返回 `name`、`description`、`location` 和正文 `content`
- session 创建、列表、更新、消息读取、删除
- `/provider` 返回固定的 Pi 默认 provider/model，`/agent` 返回绑定该模型的 primary agent
- `prompt_async` 后用户消息立即可从 API 读到
- schedule 创建和删除
- 重复设置 schedule 会返回 409，且不会覆盖现有自动化消息
- 一次性 `at` schedule 到期后写入自动化用户消息，并清除待执行 schedule
- global SSE 中的 `session.created` 事件

## atree 存储契约

Pi runtime 还会额外开启 atree 存储契约：

```bash
bun run test:contract:pi
```

这个命令要求你已经手动启动了 atree runtime：

```bash
bun run dev:pi-backend:none
```

如果不想手动管理后端进程，直接用：

```bash
bun run test:guardrails
```

它会设置：

```text
ATREE_STORAGE_CONTRACT=1
```

额外验证：

- 会话创建后存在 `.agents/atree/sessions/<session-id>/meta.yaml`
- 会话创建后存在 `.agents/atree/sessions/<session-id>/session.jsonl`
- 会话创建后存在 `.agents/atree/sessions/<session-id>/assets/`
- atree 私有状态只放在 `.agents/atree/` 下，`.agents/` 根目录只保留通用 `skills/` 和 atree 私有目录本身
- 新鲜业务目录执行 session、schedule 和 prompt 后，runtime 只会自动创建 `.agents/`，不会在业务目录根创建 `.opencode`，也不会主动创建 `.pi`
- `.agents/atree/meta.yaml` 只保存目录级信息，不维护 session 清单、schedule、emoji、归档状态或更新时间，避免和 `sessions/*/meta.yaml` 双写
- 即使 `.agents/atree/meta.yaml` 被手工写入过期的 session 清单或 schedule，runtime 也只通过扫描 `.agents/atree/sessions/*/meta.yaml` 恢复真实会话，不把根 meta 当成会话事实源
- runtime 写出的 `meta.yaml` 是真正的 YAML 文本，而不是 JSON 改扩展名
- 手写的人类可编辑 YAML `meta.yaml` 可以被 runtime 恢复成 session 列表、emoji 和消息历史
- 手写的人类可编辑 ISO `run_at` 可以被 runtime 恢复成一次性自动化消息；API 创建的一次性自动化消息也会以 ISO `run_at` 写入 YAML
- `session.jsonl` 第一行是 Pi session header
- 手工放入的 `.agents/atree/sessions/<session-id>/` 可以被 runtime 恢复为 session 列表和消息历史
- 默认 session 列表隐藏已归档会话，`includeArchived=true` 可以从目录事实源恢复归档会话
- 会话 emoji 会写入 `meta.yaml` 顶层 `icon`，只有顶层 `icon` 的目录也能恢复成前端兼容的 `metadata.atree.emoji`
- session 列表会从 `.agents/atree` 元数据恢复排序：有自动化消息的会话优先，并按下一次触发时间从近到远排序；没有自动化消息的会话再按最近更新排序
- 修改标题、emoji、归档状态、创建或删除未到期自动化消息时，只更新 `meta.yaml`，不会改写原始 `session.jsonl`
- `prompt_async` 后用户消息写入 Pi `session.jsonl`
- `session.jsonl` 可以被 Pi 自己的 `parseSessionEntries` 解析；解析后的 message entry 仍是 Pi 的 `message` 结构，不是前端/OpenCode 的 `info` / `parts` API 结构
- 手写 Pi V3 风格的 `toolCall` + `toolResult` 历史可以从 `session.jsonl` 还原成前端需要的 `tool` part
- 多次 `prompt_async` 会追加新的 JSONL 行，第二次写入不会改写第一次写入后的任何已有行
- 归档带自动化消息的会话时，会清除 schedule
- 到期的一次性 `at` schedule 会把消息写入同一个 Pi `session.jsonl`
- 自动化消息在 `session.jsonl` 中带 `source.type = "schedule"`，API 还原时标记为 `agent = "automation"`
- 一次性 `at` schedule 发送后会从会话 `meta.yaml` 中移除，UI header 不再把它当成待发送消息展示
- 普通用户消息和同一会话的到期自动化消息并发写入时，会串行写入同一个 `session.jsonl`，一次性 schedule 不会被旧的 `meta.yaml` 写回去
- 到期的 `cron` schedule 会把消息写入同一个 Pi `session.jsonl`，但保留 schedule，并更新 `last_ran_at` / `last_run_status` / `nextRun`
- cron 的 `nextRun` 从 `last_ran_at` 之后第一个表达式命中点计算，避免后续改动误把基线改回创建时间或当前时间
- data URL、本地 `file://` 和本地绝对路径文件 part 会写入 `.agents/atree/sessions/<id>/assets/`，`session.jsonl` 只保存会话内相对路径，不保留原始 data URL / base64 payload，刷新后能还原成 file part
- 会话资产目录固定叫 `assets/`，不会创建 `attachments/`
- 删除 session 会删除整个 `.agents/atree/sessions/<id>/` 自包含目录，包括 `meta.yaml`、`session.jsonl` 和 `assets/`
- 整个业务目录复制到新路径后，session、emoji、自动化消息、`session.jsonl` 和 `assets/` 能从复制后的 `.agents/atree/` 恢复，且 Pi session header 的 `cwd` 会修复为新业务目录
- 单个 `.agents/atree/sessions/<id>/` 会话目录移动到另一个业务目录后，目标目录能恢复 session、emoji、自动化消息、消息文本和资产引用，源目录不再列出它，且 Pi session header 的 `cwd` 会修复为目标业务目录

## 重启与全局缓存恢复护栏

完整 runner 还会执行一个进程级 smoke：

- 把 `HOME`、`OPENCODE_TEST_HOME`、`OPENCODE_CONFIG_DIR`、`PI_CODING_AGENT_DIR` 和 XDG 目录指到临时全局目录
- 启动 atree runtime
- 在临时业务目录里创建 session
- 写入标题、emoji、一次性自动化消息、普通消息和会话资产
- 写入另一个未来才到期的一次性自动化消息，并在服务关闭后把它的 `run_at` 改成已过期时间
- 关闭 runtime
- 扫描隔离出来的全局目录，确认其中没有普通消息文本、自动化消息文本或资产 payload
- 删除临时全局目录
- 重新启动 runtime
- 只通过同一个业务目录读取数据

它验证 session、emoji、自动化消息、消息文本、`assets/` 文件内容和相对 file part 都能恢复，并且这些业务 payload 不会泄漏到全局缓存或配置目录。它还会验证重启后重新打开同一个业务目录时，runtime 能从 `.agents/atree` 里发现并执行已经过期的一次性自动化消息，而不是依赖重启前的内存定时器。这个测试的目的不是覆盖所有 API 细节，而是防止未来把会话事实源误改回内存状态或全局数据库。

## Pi 执行契约

`atree-runtime` 支持一个无 API Key 的 Pi faux 执行模式，用于验证真实 `AgentSession.prompt()` 链路：

```bash
bun run dev:pi-backend:faux
bun run test:contract:pi-exec
```

这两个命令是单项调试入口。日常完整护栏仍然用：

```bash
bun run test:guardrails
```

它会设置：

```text
ATREE_PI_EXECUTION=faux
ATREE_PI_EXECUTION_CONTRACT=1
```

额外验证：

- `prompt_async` 通过 Pi `AgentSession.prompt()` 执行
- `prompt_async` 执行期间会通过 SSE 流出 busy、用户消息、assistant text delta、idle
- Pi 执行模式下的文件 part 也会先落入 `assets/`，再把相对路径写入同一个 `session.jsonl`
- Pi `DefaultResourceLoader` 会额外接收 `~/.agents/skills`、当前目录和祖先目录的 `.agents/skills`，并由 contract 直接验证这三类 skill root 都能被 `/skill` 发现，避免当前 Pi 0.73.1 默认只发现 `.pi/skills` 时丢失 atree 的通用 Agent Skills 目录
- Pi 执行模式会显式调用 `AgentSession.bindExtensions({})`；测试会写入真实 `.pi/extensions/*.ts`，验证 `session_start`、`resources_discover` 和 `before_agent_start` 都被触发
- Pi 工具调用会通过 SSE 映射成前端可折叠的 `tool` part，而不是泄漏成普通文本
- Pi 内置 `read` 工具可以由 faux 模型触发，执行真实文件读取，并映射成同一套 `tool` part
- Pi 内置 `write` 工具可以由 faux 模型触发，执行真实文件写入，并把结果写入同一个 `session.jsonl`
- Pi 内置 `edit` 工具可以由 faux 模型触发，执行真实局部替换，并把结果写入同一个 `session.jsonl`
- Pi 内置 `bash` 工具可以由 faux 模型触发，执行真实命令，并把命令输出写入同一个 `session.jsonl`
- assistant 输出可以从 `/session/:id/message` 读到
- assistant 输出写入同一个 `.agents/atree/sessions/<id>/session.jsonl`
- 工具调用结果写入同一个 `session.jsonl`，刷新后能从 `/session/:id/message` 还原成 `tool` part
- 到期的一次性 `at` schedule 在 Pi 执行模式下会通过 `AgentSession.prompt()` 执行，既写入自动化 user 消息，也写入 assistant 回复

## 真实 Pi 错误边界契约

真实模式需要用户本机已经配置 Pi 模型和 API Key。为了避免测试误调用真实模型，完整护栏只跑空 Pi 配置下的错误边界契约，不跑真实模型成功路径。

需要验证未配置时的错误边界，可以用空 Pi 配置目录启动 runtime：

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" ATREE_PI_EXECUTION=real bun run dev:pi-backend
bun run test:contract:pi-real-error
```

完整护栏 runner 会自动创建一个空的临时 `PI_CODING_AGENT_DIR`，所以日常不需要手写这组命令。

它验证：

- `prompt_async` 进入 busy
- Pi 未配置模型或认证时发出 `session.error`
- 失败后恢复 idle，不让 UI 卡在思考状态
- 到期的自动化消息在 Pi 未配置时会发出 `session.error`，记录 `schedule.ran` 的 `status = "skipped"`，并恢复 idle
- 一次性 `at` 自动化消息失败后会清除 pending schedule，避免每秒重复报错
- 不设置 `ATREE_PI_EXECUTION` 时默认进入真实 Pi 路径；完整护栏会用另一组空 Pi 配置证明默认模式不会退回 no-op 存储模式

## 真实 Pi 成功路径契约

真实 Pi 成功路径不会进入默认 `bun run test`，因为它会调用用户本机配置的真实模型，可能消耗 API 或本地模型资源。

如果要显式验证真实 Pi 配置可用，先启动真实 runtime：

```bash
ATREE_PI_EXECUTION=real bun run dev:pi-backend
```

然后在另一个终端运行：

```bash
bun run test:contract:pi-real-success
```

它设置：

```text
ATREE_PI_REAL_SUCCESS_CONTRACT=1
```

并只做一条最小成功链路验证：

- `prompt_async` 会进入 busy
- 真实 Pi 模型可以完成一次回复
- 完成后回到 idle
- `/session/:id/message` 可以读到 assistant 消息
- 当前目录 `.agents/atree/sessions/<id>/session.jsonl` 同时写入 user 原始消息和 assistant 回复

这个契约不强行断言模型回复的具体措辞，只证明真实 Pi 执行链路和目录事实源是通的。

已执行记录：

- 2026-06-16：使用用户本机 Pi 配置启动 `ATREE_PI_EXECUTION=real bun run dev:pi-backend`，随后执行 `bun run test:contract:pi-real-success`。结果：8 pass / 28 skip / 0 fail；真实 Pi `prompt_async` 成功进入 busy、完成回复、回到 idle，并把 user / assistant 写入当前目录 `.agents/atree/sessions/<id>/session.jsonl`。
- 2026-06-16：扩展 `test:contract:pi-real-success`，加入真实 Pi 配置下的 extension lifecycle 验证。结果：9 pass / 28 skip / 0 fail；真实 `.pi/extensions/*.ts` 在真实模型执行路径下触发 `session_start`、`resources_discover` 和 `before_agent_start`，并记录到当前目录 `.agents/atree-contract/extension-events.jsonl`。
- 2026-06-16：扩展 `test:contract:pi-real-success`，加入真实 Pi 配置下的一次性 `at` 自动化消息验证。结果：10 pass / 28 skip / 0 fail；到期 schedule 通过真实 `AgentSession.prompt()` 执行，清除 pending schedule，并把带 `source.type = "schedule"` 的自动化 user message 和 assistant 回复写入当前目录 `session.jsonl`。

## Web 前端连接护栏

当前前端仍复用 OpenCode SDK client shape，但开发入口应连 atree runtime。

启动方式：

```bash
bun run dev:pi-split:faux
```

`bun run test:guardrails` 会自动执行一个轻量 dev bundle smoke：

- 启动 faux atree runtime
- 启动 Vite dev server
- 读取 Vite 转换后的 `/src/entry.tsx`
- 确认 `VITE_ATREE_SERVER_HOST` / `VITE_ATREE_SERVER_PORT` 注入到 bundle
- 确认默认 server localStorage key 是 `atree.settings.dat:defaultServerUrl`
- 确认临时 backend `/global/health` 可用
- 使用 Playwright 打开真实浏览器页面；优先使用 Playwright 自带 Chromium，如果本机未安装 Playwright 浏览器缓存，则回退到系统 Chrome
- 确认页面 title 是 `aTree`
- 确认首屏能渲染“选择一个根目录开始”
- 确认浏览器请求的是本次 guardrail 启动的 atree backend `/global/health`
- 创建临时业务目录和 session，打开 `/:dir/session/:id`
- 在真实 contenteditable 输入框发送一条消息，等待页面展示 Pi faux assistant 回复
- 确认同一条 user / assistant 写入该目录 `.agents/atree/sessions/<id>/session.jsonl`

手工浏览器验证仍可继续补充更复杂交互，目前自动护栏已经覆盖：

- Vite 注入 `VITE_ATREE_SERVER_PORT=4196`
- 页面 title 是 `aTree`
- 页面首屏能渲染“选择一个根目录开始”
- 前端请求的是 `http://127.0.0.1:4196/global/config`、`/provider`、`/path`、`/project`、`/global/health`、`/global/event`
- 前端可以用默认 Pi provider/model 发送消息，并在 ChatView 中看到 faux assistant 回复
- 消息最终落入当前目录的 `.agents/atree/sessions/<id>/session.jsonl`
- 没有请求 4096

## 与第二版存储计划的对应关系

这组护栏优先对齐 `docs/v2-storage-plan.md`，而不是 OpenCode 原始内部测试。当前覆盖关系如下：

| 第二版要求                                                                     | 当前证据                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话、自动化和执行历史不以全局数据库为唯一事实源                               | `atree restart persistence smoke` 会先扫描隔离出来的全局目录，确认里面没有普通消息、自动化消息或资产 payload，再删除全局目录并重启，只从业务目录 `.agents/atree/` 恢复 session、emoji、自动化消息、消息文本和资产                                                                               |
| `.agents/` 根目录是通用 Agent 生态目录，atree 私有状态只在 `.agents/atree/`    | 存储契约验证 `.agents/` 根目录只保留 `skills/` 和 `atree/`，并验证 `.agents/atree/meta.yaml` 不维护 session 清单、schedule、emoji、归档状态或更新时间；新鲜业务目录执行 session、schedule 和 prompt 后，runtime 不会自动创建 `.opencode` 或 `.pi`                                               |
| `~/.agents/skills`、当前目录和祖先目录 `.agents/skills` 都进入 skill discovery | OpenCode-compatible contract 分别写入 home、当前目录和祖先目录的 `SKILL.md`，并验证 `/skill` 能返回 `name`、`description`、`location` 和正文                                                                                                                                                    |
| 每个会话是 `.agents/atree/sessions/<id>/` 下的自包含目录                       | 存储契约验证每个 session 目录含 `meta.yaml`、`session.jsonl`、`assets/`，并验证删除 session 会删除整个自包含目录                                                                                                                                                                                |
| `.agents/atree/meta.yaml` 只保存目录级信息，session 清单通过扫描恢复           | 存储契约会向根 meta 写入过期 session 清单和 schedule，验证 runtime 只扫描 `sessions/*/meta.yaml` 作为真实会话来源                                                                                                                                                                               |
| `sessions/<id>/meta.yaml` 保存标题、emoji、归档状态和最多一个自动化消息        | 契约覆盖标题/emoji 更新、归档恢复、重复 schedule 返回 409、归档带 schedule 的会话会清除 schedule                                                                                                                                                                                                |
| 自动化支持 `at` 和 `cron`                                                      | 存储契约分别覆盖一次性 `at` 和周期 `cron` 的创建、恢复、到期执行和 UI 可读字段                                                                                                                                                                                                                  |
| `at` 发送后从 meta 删除，`cron` 发送后保留并更新运行状态                       | 契约验证 `at` 到期后 schedule 列表为空，`cron` 到期后仍有 schedule，且有 `lastRanAt`、`lastRunStatus` 和新的 `nextRun`                                                                                                                                                                          |
| `cron` 的下一次执行从 `last_ran_at` 之后计算                                   | 存储契约写入手工 cron session，验证 `nextRun` 是 `last_ran_at` 之后第一个表达式命中点，不会回退到创建时间或当前时间                                                                                                                                                                             |
| `session.jsonl` 是 append-only 原始记录                                        | 契约验证 `session.jsonl` 可以被 Pi 自己的 `parseSessionEntries` 解析，message entry 使用 Pi 原始 `message` 结构而不是前端/OpenCode 的 `info` / `parts` API 结构；同时验证第二次 `prompt_async` 不改写第一次写入后的任何已有 JSONL 行，只追加新行                                                |
| Pi 工具调用历史可以从原始 JSONL 恢复                                           | 存储契约手写 Pi V3 风格的 assistant `toolCall` 和 `toolResult` 消息，验证 `/session/:id/message` 能还原成前端需要的 completed `tool` part                                                                                                                                                       |
| assistant 消息能显示在当前 user 消息下                                         | Pi faux execution contract 验证 assistant `parentID` 指向本轮 user message；frontend browser smoke 进一步验证 ChatView 能显示 faux assistant 回复                                                                                                                                               |
| 自动化消息写入同一个 `session.jsonl`，并带 `source.type = "schedule"`          | 存储契约验证到期 `at` / `cron` 都写入同一个 JSONL，消息带 schedule source，API 还原时标记为 `agent = "automation"`                                                                                                                                                                              |
| 同一会话写入串行化                                                             | 存储契约用 FIFO 附件稳定制造普通 prompt 和到期 `at` schedule 的并发写入，验证两条消息都进入同一个 `session.jsonl`，且一次性 schedule 不会被 stale meta 写回去                                                                                                                                   |
| 会话资产目录叫 `assets/`，不是 `attachments/`                                  | 文件 part 契约覆盖 data URL、`file://` 和绝对路径，验证文件落入 `assets/`、JSONL 只保存相对路径，不保留原始 data URL / base64 payload，并验证不会创建 `attachments/`                                                                                                                            |
| 复制业务目录后会话、自动化和资产可恢复                                         | 存储契约复制整个业务目录后，验证 session、emoji、自动化消息、消息文本、资产内容和相对 file part 都能恢复                                                                                                                                                                                        |
| 单个会话目录移动到另一个业务目录后可恢复                                       | 存储契约移动单个 `sessions/<id>/` 后，验证目标目录恢复标题、emoji、自动化消息、消息历史和资产，源目录不再列出该 session                                                                                                                                                                         |
| 复制或移动后修复 Pi session header 的 `cwd`                                    | 复制目录和移动单会话两条契约都会检查 `session.jsonl` 第一行 `cwd` 对齐到新的业务目录                                                                                                                                                                                                            |
| runtime 通过 Pi `AgentSession` 执行，而不是只写存储                            | 源码边界护栏验证 `packages/atree-runtime` 依赖并 import `@mariozechner/pi-coding-agent`，且不依赖或 import OpenCode backend core；Pi faux execution contract 验证 `prompt_async`、到期 `at` schedule、工具调用、内置 read/write/edit/bash 都穿过 Pi `AgentSession` 并写回同一个 `session.jsonl` |
| Pi `session.jsonl` 落盘边界明确                                                | 源码边界护栏动态检查当前 Pi `SessionManager` 仍提供 atree 使用的 `_rewriteFile` durability boundary；runtime 缺失该能力时会显式失败，不会静默丢失 optimistic user message 落盘                                                                                                                  |
| 未配置真实 Pi 时错误边界明确                                                   | real missing-config contract 验证 `prompt_async` 和到期自动化失败后会发出错误、恢复 idle，一次性 `at` 会清除 pending schedule                                                                                                                                                                   |
| 当前 UI 可以连 atree runtime 并完成基本聊天                                    | frontend connection smoke build 前端、启动 Vite、用浏览器打开页面，确认标题、首屏和 `/global/health` 请求指向 atree backend；随后通过真实输入框发送消息，验证 ChatView 展示 faux assistant 回复，并确认消息落入当前目录 JSONL                                                                   |

仍然不把 OpenCode 原始测试当成完成标准。它们可以帮助理解继承代码，但第二版完成度以这张表和对应 contract 为准。

## 后续扩展

真实 Pi 内置工具调用先保留为手动验收，不进入默认自动契约。真实模型是否调用工具有非确定性；确定性工具链路由 faux 模型覆盖 `atree_echo`、`read`、`write`、`edit` 和 `bash`。

手动验收清单：

- 真实 Pi runtime 下发送“读取 README.md 前 20 行”，确认 `read` tool part 实时出现，刷新后仍能还原。
- 发送“在当前目录创建 atree-tool-smoke.txt 写入 hello”，确认文件落盘，历史里出现 `write` tool part。
- 发送“把 atree-tool-smoke.txt 里的 hello 替换成 world”，确认文件被修改，历史里出现 `edit` tool part。
- 发送“运行 ls”，确认命令输出出现在 `bash` tool part。
- 重启 runtime 后重新打开目录，确认上述工具调用仍从 `.agents/atree/sessions/<id>/session.jsonl` 还原。

替换到 Pi backend 后，应该继续扩展契约测试：

- `cron` 周期 schedule 的错过执行时间补偿策略、失败重试策略和忙碌跳过策略
- `.agents/atree/sessions/<id>/session.jsonl` 成为唯一事实源

原则是：每替换一块 backend，就先补一条接口契约测试，再保持 UI 行为通过。
