# atree 基于 OpenCode 的 MVP 删减分析

上游来源：`sst/opencode`

导入 commit：`dbbe67f066fef47761c637624a34b2350cb109c0`

## 目标判断

atree MVP 不应该重新实现 AI chat/runtime 的基础设施。OpenCode 已经覆盖了会话、流式事件、工具调用、权限、文件读写、模型配置、Web UI 等细节。atree 的核心应该收缩到：

- 目录树上的治理节点
- 目录上的常驻会话
- 周期会话 / CRON 调度
- 左侧只展示纳入 atree 管理的目录
- 目录级配置和会话元数据

因此第一阶段不替换 OpenCode 核心。先保留 OpenCode core/server/app，把 atree 做成外层组织模型。

## 优先保留

### `packages/app`

OpenCode 的 Web 应用。这里包含现成的 ChatView、PromptInput、session timeline、tool/thinking 展示、目录选择、设置弹窗等。

atree MVP 应该主要改这里：

- 左侧项目/会话列表改成 atree 目录树
- 会话列表按目录分组
- 隐藏不需要的项目功能
- 保留聊天区域和输入框

重点文件区域：

- `packages/app/src/app.tsx`
- `packages/app/src/components/session/*`
- `packages/app/src/components/prompt-input*`
- `packages/app/src/context/server*.tsx`
- `packages/app/src/context/sync.tsx`
- `packages/app/src/context/global-sync/*`

### `packages/server`

OpenCode HTTP API。atree 可以在这里新增目录树和调度相关 API。

优先保留：

- session/message/event/model/provider/permission/tool 相关 routes
- fs/location/project 相关能力，后续可改成 atree directory

可新增：

- `/atree/tree`
- `/atree/directories`
- `/atree/nodes`
- `/atree/schedules`

### `packages/core`

OpenCode 核心 runtime。MVP 先不要动太多。

优先保留：

- `session`
- `project`
- `location`
- `filesystem`
- `tool-*`
- `permission`
- `provider/model`
- `database`
- `event`

后续 atree 可以在这里加 directory/session schedule 的核心模型。

### `packages/ui`

共享 UI 组件和样式。`packages/app` 依赖它，先保留。

## 明确不需要

### `packages/tui`

终端 UI。atree MVP 是本地 HTTP Web GUI，不需要 TUI。

可以在第一轮删减中移除，但要注意 `packages/cli` 依赖它。如果继续使用 CLI 启动 server，需要先拆 `packages/cli`。

### `packages/desktop`

Electron 桌面端。用户已经明确不需要 Electron。

可删。

### `packages/web`

官网/文档站。不是产品运行时。

可删。

### `packages/console/*`

OpenCode 云控制台、账号、计费、邮件、资源等。atree MVP 不做 OpenCode SaaS。

可删。

### `packages/stats/*`

统计站和统计服务。MVP 不需要。

可删。

### `packages/enterprise`

企业版 Web/Cloudflare 相关。MVP 不需要。

可删。

### `packages/slack`

Slack 集成。MVP 不需要。

可删。

### `sdks/vscode`

VS Code 插件。MVP 不需要。

可删。

### `github/`

GitHub Action 包。MVP 不需要。

可删。

### `infra/`

SST 云基础设施。MVP 是本地服务。

可删。

### `.github/workflows`

OpenCode 官方发布、部署、triage、文档同步 CI。这个仓库不需要继承。

可以大幅删减，只保留基础 typecheck/build workflow，甚至 MVP 阶段可以先不保留。

### 多语言 README / 文档翻译

`README.*.md` 和 `packages/web/src/content/docs/*` 主要服务 OpenCode 官方文档站。

可删。

## 暂时保留但后续评估

### `packages/opencode`

这是 OpenCode CLI/runtime 聚合包，可能包含启动 server、schema、构建、provider/tool glue。

如果 atree 只需要 Web + server，可以逐步减少对它的依赖。但第一阶段不要急删，先跑通原始 Web。

### `packages/cli`

CLI 目前依赖 server、core、sdk、tui。MVP 如果只用 HTTP server，可以不需要 CLI；但它可能包含启动逻辑，可以先保留，等确认 `packages/server` 可独立启动后再删。

### `packages/sdk`

Web app 可能通过 SDK 调 OpenCode server。先保留。

### `packages/plugin`

OpenCode 插件机制可能短期不需要，但它和 core/tui/app 可能有关联。先保留，等依赖图清楚后再删。

### `packages/llm`

OpenCode LLM abstraction。如果继续用 OpenCode 核心，先保留。

### SQLite helper packages

- `packages/effect-drizzle-sqlite`
- `packages/effect-sqlite-node`

OpenCode core 使用 SQLite/Drizzle，先保留。

## 建议迁移顺序

1. 保持 OpenCode 原始代码可运行，不先删功能。
2. 跑通 `packages/app` + `packages/server` 的本地 Web。
3. 找到 OpenCode 的 project/session 数据模型入口。
4. 新增 atree directory/node 数据模型，不先改 chat runtime。
5. 将左侧 UI 从 OpenCode project/session list 改成 atree directory tree。
6. 增加 directory 下的常驻 session 元数据。
7. 增加 CRON schedule，定时调用现有 session prompt。
8. 确认 MVP 链路后，再删除 TUI/Desktop/Web/Console/Stats/Slack/Enterprise/Infra 等外围包。

## MVP 不做

- 不替换 OpenCode 模型核心
- 不重写 ChatView
- 不重写 tool call/thinking 渲染
- 不做 Electron
- 不做 TUI
- 不做 OpenCode SaaS/账号/计费/团队
- 不做 VS Code 插件
- 不做外部鉴权

## 当前结论

这条路线成立。atree 应该把 OpenCode 当作成熟 agent runtime 和 Web shell，优先验证目录树、常驻会话和周期调度，而不是继续自研聊天细节。
