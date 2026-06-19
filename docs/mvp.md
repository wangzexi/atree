# atree MVP 功能任务书

## 目标

MVP 只验证一个闭环：

> 用户选择一个根目录，系统展示根目录里的目录树；用户在某个目录里创建和继续会话；会话记录、附件、归档状态和自动化消息逐步回到该目录自己的 `.agents/atree/` 下；会话可以设置一次性或周期性自动化消息，并在同一会话里继续执行。

不要在 MVP 中实现完整知识库、复杂 Agent 平台、多平台发布、同步系统或权限沙箱。

## 当前实现状态

当前 `main` 是基于 OpenCode 的 spike，不是从零自研后端。

已跑通的主线：

- Bun + TypeScript 本地 HTTP 服务。
- Web UI 基于 OpenCode app 改造。
- 用户视角只打开一个根目录。
- 左侧是 atree 目录树；普通目录可以浏览，带会话/自动化的目录优先展示。
- 选中目录后，右侧 tab 只展示该目录自身的会话，不混入子目录会话。
- 会话可以创建、继续、归档、从归档恢复。
- 会话 emoji 可设置；未归档 tab 和归档列表互斥。
- 自动化消息支持 `at` 一次性时间和 `cron` 周期时间。
- 一个会话最多一条自动化消息；重复设置必须先删除旧任务。
- 自动化触发后会追加到同一会话，并刷新输入框上方的自动化消息状态。
- 有自动化的会话在 tab 中排在前面，并按下次触发时间从近到远排序。
- 有自动化的目录在左侧节点上外露即将执行会话的 emoji。
- data URL 文件 part 会落盘到会话目录的 `assets/`，JSONL 中保存相对路径引用。

已开始落地的目录事实源：

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
```

当前重要限制：

- OpenCode SQLite 仍存在，但定位应收缩为投影缓存和运行缓存，不应继续作为 atree 业务唯一事实源。
- OpenCode 的大量原始 HTTP API 仍在代码中，尚未收敛成 atree 自己的精简接口。
- Pi core 尚未替换 OpenCode core。Pi 替换属于下一阶段，不要在当前 MVP 文档里假设已经完成。
- `schedule.json`、`todo.json` 是当前 OpenCode spike 的过渡实现；长期可以折叠进 `meta.yaml` 或 `session.jsonl` 事件流。

## 技术约束

- 使用 Bun + TypeScript。
- 前端继续复用并改造 OpenCode Web UI。
- 应用以本地 HTTP 服务形式运行，不使用 Electron。
- 服务需要能通过局域网或外部机器访问。
- MVP 暂不考虑外部访问鉴权。
- MVP 不做模型执行权限限制；会话默认以所属目录为工作目录，但用户明确要求时可以访问其他路径。
- 当前阶段优先把状态事实源移回目录；Pi core 替换在状态边界稳定后推进。

## 启动方式

安装依赖：

```bash
bun install
```

一体服务：

```bash
bun run web --hostname 0.0.0.0 --port 3001
```

前后端分离开发：

```bash
bun run dev:split
```

默认分离端口：

- 后端：`http://127.0.0.1:4096`
- 前端：`http://127.0.0.1:3000`

## 核心对象

MVP 只保留两个核心对象，外加一个会话属性：

```text
Directory
Session
Automation message  # 会话里的自动化消息
```

### Directory

目录是上下文作用域，也是状态归属边界。

一个目录下发生的会话、附件、自动化消息和工具状态，都应该能在该目录的 `.agents/atree/` 下找到事实源。

### Session

会话是 atree 中 Agent 的唯一表现形式。

不单独建立 Agent 注册表，不让用户通过表单创建“某某 Agent”。用户只是在目录里开启会话；当会话被长期复用或设置自动化时，它自然成为常驻工作单元。

### Automation Message

自动化消息本质上是一条未来会自动发送到当前会话的用户消息。

它支持两种时间类型：

- `at`：一次性时间点。
- `cron`：周期表达式。

一个会话最多一条自动化消息。

## 存储规则

### 目录元数据

目录是否被 atree 初始化，由以下文件表示：

```text
.agents/atree/meta.yaml
```

这个文件只保存目录级轻量信息。会话索引不应该长期集中写在这里；会话列表应通过扫描 `sessions/*/meta.yaml` 得到。

### 会话目录

每个会话是一个自包含目录：

```text
.agents/atree/sessions/<session-id>/
  meta.yaml
  session.jsonl
  assets/
  schedule.json
  todo.json
```

职责：

- `meta.yaml`：标题、emoji、归档时间、所属目录、更新时间等会话元数据。
- `session.jsonl`：会话原始事件流。
- `assets/`：图片、文件等会话资产。
- `schedule.json`：当前 spike 的自动化消息状态。
- `todo.json`：当前 spike 的工具状态。

### JSONL

`session.jsonl` 是会话原始数据，不只是渲染后的聊天文本。

它需要能表达：

- 用户消息。
- 助手消息。
- 工具调用。
- 工具结果。
- 文件 part。
- 自动化唤醒事件。

当前 OpenCode spike 会把 OpenCode 消息/part 写入 `session.jsonl`，并在读取时把它投影回现有 UI 和模型调用链路需要的数据形状。

### Assets

多媒体不直接塞进 JSONL。

会话中的 data URL 文件 part 会保存到：

```text
.agents/atree/sessions/<session-id>/assets/
```

`session.jsonl` 中只保存 `assets/...` 相对路径。这样目录迁移、复制和 AI 读取都更自然。

## UI 范围

### 左侧目录树

- 左侧展示根目录下的目录树。
- 有会话或自动化的目录优先展示。
- 普通目录可以通过展开父节点查看。
- 有自动化的目录用即将执行的会话 emoji 作为外露信号。
- 点击目录只切换右侧会话分组，不创建新会话。
- 新会话入口在目录条目右侧，图标为 `square-pen` 风格。

### 顶部 tab

- tab 属于当前选中的目录。
- 切换目录时，tab 组必须完全换成该目录自身的会话。
- tab 不包含子目录会话。
- 有自动化的会话排在左侧，并按下次触发时间排序。
- 普通会话按最后交互时间倒序。
- 归档会话只出现在归档菜单，不和 tab 重复。
- “新会话” tab 只是草稿入口；不发消息不落盘。

### 聊天区

- 用户消息靠右，助手消息靠左。
- 工具调用和思考内容保持可折叠。
- 自动化消息显示在输入框上方，与输入框视觉上连成一组。
- 自动化触发或删除后，UI 必须立即反映最新状态，不依赖刷新。

## 调度行为

自动化消息的行为：

1. 用户通过自然语言设置自动化。
2. 后端创建 `at` 或 `cron` schedule。
3. 状态写入当前会话目录的 `schedule.json`。
4. UI 在输入框上方展示自动化消息。
5. 到期后，调度器把消息发送回同一会话。
6. 一次性 `at` 执行后清空 `schedule.json` 中的任务。
7. 周期 `cron` 执行后计算下一次触发时间。
8. 会话归档时，如果存在自动化，必须二次确认；归档成功后清空自动化。

## 测试策略

当前阶段测试重点是固定已经跑通的产品行为，为后续替换存储和核心做护栏。

已存在的关键测试：

- `packages/app/e2e/atree/smoke.spec.ts`
- `packages/app/e2e/atree/invariants.spec.ts`
- `packages/opencode/test/session/atree-self-contained.test.ts`
- `packages/opencode/test/session/schedule-atree.test.ts`
- `packages/opencode/test/session/schedule.test.ts`
- `packages/opencode/test/session/session.test.ts`
- `packages/opencode/test/server/session-list.test.ts`
- `packages/opencode/test/server/global-session-list.test.ts`
- `packages/opencode/test/atree/session-store.test.ts`
- `packages/opencode/test/atree/schedule-store.test.ts`
- `packages/opencode/test/atree/todo-store.test.ts`

推荐每次动到会话存储、归档、schedule 或目录扫描时运行：

```bash
cd packages/opencode
bun test test/server/session-list.test.ts test/server/global-session-list.test.ts test/session/session.test.ts test/session/schedule.test.ts test/session/schedule-atree.test.ts test/session/atree-self-contained.test.ts
bun run typecheck
```

动到 UI 行为时运行：

```bash
cd packages/app
bun run test:e2e -- e2e/atree/smoke.spec.ts
bun run test:e2e -- e2e/atree/invariants.spec.ts
```

## 下一步

优先级从高到低：

1. 继续让目录内 `.agents/atree/` 成为会话、归档、附件、schedule、todo 的事实源。
2. 明确 SQLite 只作为可重建投影缓存，不作为业务唯一来源。
3. 固定核心浏览器冒烟路径，防止 UI 回归。
4. 在存储边界稳定后，收敛 OpenCode 原始 API。
5. 再推进 Pi core 替换或 facade 重写。

## 暂不实现

- interface session。
- 父子目录访问拦截。
- 自治目录权限边界。
- 多设备同步。
- 外部社交平台挂载。
- 多平台发布。
- 预算系统。
- 独立 Agent 注册表。
- 插件管理 UI。
- 自动化管理 UI。
- Electron。
- 模型执行权限控制。
- 目录沙箱。
