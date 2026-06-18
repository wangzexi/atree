# atree 下一阶段实施计划

本文档记录当前 OpenCode-spike 版本之后的主线计划。目标不是继续扩大 UI 细节，而是把 atree 的核心边界收紧：一个本地服务、一个根目录、一棵目录树、目录内会话、自动化消息。

## 当前判断

当前版本已经证明了几个关键体验：

- 左侧目录树可以作为 atree 的主导航。
- 顶部 tab 可以作为当前目录的会话组。
- 会话可以归档、恢复、设置 emoji。
- 自动化消息可以作为会话输入框上的状态展示。
- schedule 可以支持 `cron` 和 `at` 两类触发。

但当前实现仍然继承了 OpenCode 的大量状态模型：

- 打开的根目录主要存在前端持久化状态里。
- 会话事实源仍是 OpenCode 全局 SQLite。
- 前端仍在消费 OpenCode 的宽接口面。
- schedule 当前是 atree 第一版硬编码服务，不是 Pi 扩展。

下一阶段要先处理状态边界，再处理核心替换。

## 阶段 0：固定当前可用版本

目的：保证当前 demo 不再因为状态边界反复回归。

已完成或正在完成：

- 直接打开首页时，不显示历史 session tab。
- 直接打开某个 session URL 时，只显示当前 session tab 和新会话占位。
- 只有从左侧点击目录节点时，才显示该目录的会话 tab group。
- 归档 tab 后，同步移除 server sync 和目录树本地缓存，避免被旧缓存重新加回来。

后续补充：

- 为这些不变量补 Playwright 测试。
- 当前提交不再继续扩大 UI 交互细节，除非影响主流程。

## 阶段 1：服务端 root workspace 状态

atree 用户视角中，服务实例只打开一个根目录。这个 root 是服务端状态，不应该属于浏览器 localStorage。

### 目标

增加最小 workspace API：

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

MVP 可选存储：

```text
~/.config/atree/state.json
```

或者复用当前 OpenCode data dir 下的 atree 专属状态文件：

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

- 写入前把目录规范化为绝对路径。
- 写文件使用原子写入，避免中途崩溃损坏状态。
- 服务启动时读取一次并放入内存。
- `PUT /api/workspace/root` 覆盖旧 root，并清掉旧 root 相关的运行期缓存。

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
      extensions/
        schedule/
          state.json
```

关键约束：

- `.agents/` 是通用 Agent 目录。
- `.agents/atree/` 是 atree 专属事实源。
- `session.jsonl` 是会话原始事件流，不只是渲染后的聊天文本。
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
  -> write .agents/atree/extensions/schedule/state.json

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
