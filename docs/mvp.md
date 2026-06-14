# atree MVP 功能任务书

## 目标

MVP 只验证一个闭环：

> 用户选择根目录，系统展示其中被 atree 管理的目录；用户在目录里创建和继续会话；会话保存为本地 JSONL；会话可以设置 schedule，并按周期在同一会话里继续执行。

不要在 MVP 中实现完整知识库、文件预览、复杂 Agent 平台或多平台自动发布。

## 当前实现状态

已实现一个可运行纵切：

- Bun HTTP API。
- React + Vite 网页 UI。
- 左侧只展示 `.agents/atree.yaml` 目录树。
- 右侧显示会话标题、会话 icon、聊天流和输入框。
- 初始化 atree 目录。
- 创建会话并写入 `.agents/atree.yaml`。
- 创建 `.agents/sessions/<session-id>.jsonl`。
- 通过 Pi Coding Agent TypeScript SDK 发送消息。
- SSE 转发 Pi 原始事件。
- 读取 Pi JSONL 并渲染用户/助手文本消息。
- 修改会话 title/icon/schedule。
- CRON schedule 写入 `.agents/atree.yaml` 并计算 `next_run_at`。
- 附件上传到 `.agents/attachments/<session-id>/`。
- 简单周期调度器会按 `next_run_at` 唤醒同一会话。

本地验证结果：

- `bun run typecheck` 通过。
- `bun run build` 通过。
- Agent Browser 打开 `http://127.0.0.1:5173/` 验证通过。
- 页面左侧没有“新对话、搜索、插件、自动化”等入口。
- 页面没有仿 macOS 三个窗口控制按钮。
- 使用 `deepseek/deepseek-v4-flash` 完成真实 Pi SDK 对话并落盘。
- `zexi/gpt-5.3-codex-spark` 已设为默认模型，但当前本机 Pi provider 返回 `400 status code (no body)`，需要后续单独排查 provider 配置或 SDK 兼容问题。

启动方式：

```bash
bun install
ATREE_ROOT=/path/to/root bun run server
bun run dev
```

浏览器访问：

```text
http://127.0.0.1:5173/
```

## 技术约束

- 使用 Bun + TypeScript。
- 前端使用 React。
- 应用以本地 HTTP 服务形式运行。
- 不使用 Electron。
- 服务需要能被局域网或外部机器访问。
- MVP 暂不考虑外部访问鉴权。
- AI 执行层直接使用 Pi Coding Agent / pi-mono 的 TypeScript SDK 和会话设计。
- 不在 Pi SDK 之上再抽象另一套 Agent runtime。
- 每个会话的默认工作目录是它所属的 atree 目录。
- MVP 不做模型执行权限限制；用户指定时，会话可以访问工作目录以外的路径。

## 第一阶段功能

### 1. 根目录选择

用户启动应用时选择一个根目录。

MVP 可以先通过配置或启动参数指定：

```bash
atree --root /Users/zexi/workspace
```

后续再做 UI 选择。

### 2. 扫描 atree 目录

从根目录向下扫描，只展示存在以下文件的目录：

```text
.agents/atree.yaml
```

扫描结果形成左侧目录树。

要求：

- 保持目录层级。
- 不展示没有 `.agents/atree.yaml` 的普通目录。
- 普通目录可以作为路径中间节点出现，但 UI 重点是 atree 节点。

### 3. 初始化目录为 atree 节点

通过会话里的 AI 或后端 API 创建：

```text
.agents/atree.yaml
.agents/sessions/
.agents/attachments/
.agents/skills/
```

MVP 的 `atree.yaml`：

```yaml
version: 1
title: 目录名
sessions: []
```

### 4. 目录会话列表

读取当前目录 `.agents/atree.yaml` 中的 sessions 列表，并检查对应 JSONL 文件是否存在。

会话元数据字段：

```yaml
sessions:
  - id: 01JXYZ
    title: 我的会话
    icon: 🦊
    schedule: "0 9 * * *"
    last_run_at: "2026-06-13T09:00:00+08:00"
    next_run_at: "2026-06-14T09:00:00+08:00"
    updated_at: "2026-06-13T09:00:00+08:00"
```

字段说明：

- `id`：会话 ID。
- `title`：会话标题。
- `icon`：可选，会话显示 icon。
- `schedule`：可选，CRON 表达式，直接存入 `.agents/atree.yaml`。
- `last_run_at`：周期会话上次执行时间。
- `next_run_at`：周期会话下次执行时间。
- `updated_at`：会话最近更新时间。

### 5. 创建会话

用户在某个目录里开始新会话。

行为：

- 生成会话 ID。
- 在 `.agents/sessions/<id>.jsonl` 创建会话文件。
- 在 `.agents/atree.yaml` 追加会话元数据。
- 打开右侧聊天界面。
- 创建 Pi `AgentSession` 时使用当前目录作为会话工作目录，并在系统提示词中注入该路径。

会话标题可以先用第一条用户消息生成或用默认标题。

### 6. 会话保存

会话以 JSONL 事件流保存，格式尽可能和 Pi Coding Agent 保持一致。

MVP 不立即锁死 schema，但至少需要表达：

- 用户消息。
- 助手消息。
- 工具调用。
- 工具结果。
- 调度唤醒事件，以 Pi 兼容的自定义/扩展消息形式表达。
- 附件引用。

示例方向：

```jsonl
{"type":"session","id":"01JXYZ","created_at":"2026-06-13T10:00:00+08:00"}
{"type":"user_message","created_at":"2026-06-13T10:01:00+08:00","content":[{"type":"text","text":"帮我整理这个目录"}]}
{"type":"assistant_message","created_at":"2026-06-13T10:01:10+08:00","content":[{"type":"text","text":"我先读取目录结构。"}]}
```

最终 schema 应参考：

- `/Users/zexi/workspace/refs/pi-mono/packages/coding-agent`
- `/Users/zexi/workspace/refs/pi-mono/packages/mom`

### 7. 图片和附件

聊天中的图片不写入 JSONL。

附件保存到：

```text
.agents/attachments/<session-id>/
```

JSONL 中只保存相对路径引用。

示例：

```jsonl
{"type":"user_message","content":[{"type":"text","text":"看这张图"},{"type":"image","path":".agents/attachments/01JXYZ/20260613-001.png"}]}
```

说明：

- Pi Coding Agent 当前会话格式支持把图片作为 base64 `ImageContent` 嵌入 JSONL。
- atree MVP 选择把图片作为文件保存，并在 JSONL 中引用相对路径。
- 这样更符合 atree 的目录长期管理模型，也避免会话 JSONL 因多媒体变得过大。

### 8. 会话 icon 展示

右侧当前目录标题附近展示会话 icon 组。

规则：

- 周期会话全部展示。
- 周期会话按 `next_run_at` 升序排序。
- 非周期会话最多展示最近更新的一个。
- 其他非周期会话折叠为 `…`。
- hover 周期会话显示标题、上次执行、下次执行。
- hover 非周期会话显示标题、最近更新。
- 点击 icon 打开会话。
- 点击 `…` 展开更多会话列表。

不做重要会话，不做手动排序，不做 pin。

### 9. 修改会话元数据

用户通过对话让 AI 修改会话元数据。

MVP 需要提供后端能力或全局技能，让 AI 能安全修改：

- title
- icon
- schedule

典型指令：

```text
把这个会话 icon 改成 🦊。
每天上午 9 点运行这个会话。
取消这个会话的周期执行。
```

### 10. 周期会话调度

有 `schedule` 的会话是周期会话。

行为：

- 调度器根据 `next_run_at` 唤醒会话。
- 在同一个 JSONL 中追加调度唤醒事件。
- 继续运行该会话。
- 更新 `last_run_at`、`next_run_at`、`updated_at`。

MVP 中每个周期不创建新会话，也不创建独立 run 目录。

### 11. 全局技能注入

所有会话启动时注入 atree 全局技能说明。

技能至少说明：

- `.agents/atree.yaml` 的作用。
- `.agents/sessions/*.jsonl` 的作用。
- 如何初始化目录。
- 如何创建会话。
- 如何修改会话 title/icon/schedule。
- 如何读取当前目录会话列表。

实现上可以先作为系统 prompt 片段，后续再整理为 Skill 标准目录。

## 前后端协议方向

MVP 需要以下 API：

```text
GET  /api/tree
GET  /api/directories/:id
GET  /api/directories/:id/sessions
POST /api/directories/:id/sessions
GET  /api/sessions/:id/events
POST /api/sessions/:id/messages
PATCH /api/sessions/:id
POST /api/sessions/:id/attachments
```

会话响应需要流式事件，事件格式以 Pi Coding Agent 为准。

传输层 MVP 可以采用 Server-Sent Events：

- 本地单用户服务实现简单。
- 浏览器原生支持。
- 适合从后端向前端推送会话增量、调度状态和工具执行状态。
- 后续确实需要双向低延迟通道时再补 WebSocket。

注意：

- SSE 只是传输层选择。
- 事件 payload 不参考 opencode，优先直接转发 Pi 事件；只有 UI 必需时才做最小字段适配。

备选传输方向：

- fetch streaming。
- WebSocket。

MVP 优先选择实现简单、适合单用户本地服务的方案。

## 参考实现结论

### Pi Coding Agent / pi-mono

本地路径：

- `/Users/zexi/workspace/refs/pi-mono`

远程参考：

- `https://github.com/badlogic/pi-mono`
- `https://github.com/earendil-works/pi`

关键结论：

- 会话默认保存为 JSONL。
- 会话条目通过 `id` / `parentId` 形成树结构。
- TypeScript SDK 入口是 `createAgentSession()`。
- `AgentSession.subscribe()` 提供事件订阅。
- `prompt()` 支持图片输入。
- Pi 当前图片通常作为 base64 `ImageContent` 进入会话，atree MVP 会改成附件文件引用。

重点阅读：

- `/Users/zexi/workspace/refs/pi-mono/packages/coding-agent/docs/sdk.md`
- `/Users/zexi/workspace/refs/pi-mono/packages/coding-agent/docs/session.md`
- `/Users/zexi/workspace/refs/pi-mono/packages/coding-agent/docs/rpc.md`
- `/Users/zexi/workspace/refs/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `/Users/zexi/workspace/refs/pi-mono/packages/coding-agent/src/core/session-manager.ts`
- `/Users/zexi/workspace/refs/pi-mono/packages/coding-agent/src/cli/file-processor.ts`

### pi-mono web-ui

本地路径：

- `/Users/zexi/workspace/refs/pi-mono/packages/web-ui`

可参考：

- ChatPanel / AgentInterface 的消息流、工具展示和附件交互。
- 不建议照搬 IndexedDB 存储，因为 atree 的状态应落在目录 `.agents/` 下。

### pi-mono mom

本地路径：

- `/Users/zexi/workspace/refs/pi-mono/packages/mom`

可参考：

- `log.jsonl` / `context.jsonl` 分层。
- `attachments/` 下载和本地路径引用。
- 长期会话和外部消息同步的设计。

### opencode

本地路径：

- `/Users/zexi/workspace/refs/opencode`

可参考：

- 本地 HTTP GUI 启动。
- SPA 静态资源和 API 分层。
- 服务进程与浏览器 UI 的组织方式。

不参考：

- Agent 事件格式。
- 会话语义。
- SQLite 会话模型。

重点阅读：

- `/Users/zexi/workspace/refs/opencode/packages/opencode/src/cli/cmd/web.ts`
- `/Users/zexi/workspace/refs/opencode/packages/opencode/src/server/routes/instance/httpapi/server.ts`
- `/Users/zexi/workspace/refs/opencode/packages/opencode/src/server/shared/ui.ts`

## 暂不实现

- interface session。
- 父子目录访问拦截。
- 自治目录权限边界。
- 完整文件树浏览器。
- 文件内容预览。
- 多平台发布。
- 外部社交平台挂载。
- 多设备同步和冲突处理。
- 预算系统。
- 独立 Agent 注册表。
- 插件管理 UI。
- 自动化管理 UI。
- Electron。
- 模型执行权限控制。
- 目录沙箱。

## 验收标准

MVP 完成时应能做到：

1. 启动本地 HTTP 服务并打开 GUI。
2. 指定一个根目录。
3. 左侧展示根目录下存在 `.agents/atree.yaml` 的目录树。
4. 进入某个目录后看到当前目录会话区。
5. 创建新会话并保存为 JSONL。
6. 新会话默认以当前目录作为工作目录。
7. 在会话中发送消息并看到流式助手回复。
8. 会话历史刷新后仍可恢复。
9. 上传或粘贴图片后，图片保存到 `.agents/attachments/<session-id>/`，JSONL 保存引用。
10. 通过对话修改会话 icon。
11. 通过对话设置 CRON schedule。
12. 周期会话按计划唤醒，并向同一个 JSONL 追加消息。
13. 右侧 icon 组按规则展示周期会话和最近临时会话。

## 测试策略

MVP 必须被完整跑通和验证，因为它是纯网页应用，天然适合通过浏览器验证。

行为层面的验收测试放在：

- [docs/acceptance/atree-mvp-bdd.md](docs/acceptance/atree-mvp-bdd.md)

测试策略以真实体验为主：

- 优先使用 Agent Browser 或本机 Chrome CDP 做端到端验证。
- 每次完成关键功能后，打开本地 HTTP GUI 实际操作。
- 验证左侧目录树、右侧会话、消息流、附件、CRON 设置和周期唤醒等核心路径。
- UI 参考 Codex App，但实际可用性以本项目真实体验为准。

自动化测试不强制一开始写满。

原因：

- 项目仍处于 demo 阶段。
- 需求和交互会快速变化。
- 过早沉淀大量固定 Playwright 用例，可能很快失效。

取舍原则：

- 高频、稳定、会反复执行的路径，可以写 Playwright 或其他自动化用例。
- 变化快、一次性验证、交互仍未定型的路径，可以用 Agent Browser 或手动浏览器验证。
- 自动化测试的目标是节省重复验证成本，不是提前固化尚未稳定的产品行为。

可优先自动化的路径：

- 服务启动后页面可打开。
- 左侧能展示存在 `.agents/atree.yaml` 的目录。
- 能创建会话并落盘 JSONL。
- 能恢复已有会话。
- 图片附件能落到 `.agents/attachments/<session-id>/`。
- 设置 CRON 后 UI 能按周期会话排序展示。

不优先自动化的路径：

- 细节 UI 样式。
- 会话 icon 的具体视觉表现。
- 暂未稳定的快捷交互。
- 未来可能改动的全局面板、模拟经营视图、扩展系统。
