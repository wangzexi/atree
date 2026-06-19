# atree

atree 是一个围绕文件目录树组织的本地 AI 工作区。

核心观点很简单：知识库不应该只是记录信息的地方。信息结构、信息本身，以及围绕这些信息执行工作的 AI 会话，应该放在一起。

在 atree 里，目录不是普通文件夹，而是工作上下文。用户在目录中开启会话；会话默认以这个目录作为工作范围。当一个会话被反复使用，或者被设置为自动化消息，它就自然变成了这个目录里的轻量 Agent。

所以 atree 的文件树同时是：

- 信息结构；
- 执行界面；
- 会话和自动化的事实源。

## 为什么做

大多数知识管理工具擅长记录，但不擅长执行。大多数自动化工具擅长执行，但和真实的信息结构脱节。

atree 想把这两层合在一起。

用户只需要管理自己的外层目录结构。在关键目录里，AI 会话可以读取、写入、整理、转换、计划和继续工作。重复发生的工作可以逐渐沉淀成自动化消息，在同一个目录上下文里长期执行。

这意味着知识不再只是被动保存。保存上下文的目录，也能承载维护和使用这个上下文的执行过程。

## 当前形态

当前 MVP 是一个本地 HTTP 服务提供的 Web 应用。

- 左侧是 atree 目录树。
- 右侧是会话工作区。
- 选中的目录拥有自己的会话 tab 组。
- 会话可以归档和恢复。
- 一个会话最多有一条自动化消息。
- 自动化消息支持一次性时间和 cron 周期。
- 有自动化的会话会按下次执行时间排在普通会话前面。

当前运行底座仍基于 OpenCode。atree 复用它成熟的聊天、工具执行、流式事件和文件交互能力，同时把外层产品模型改成目录工作区模型。

## 目录事实源

atree 的长期方向是让会话成为目录数据的一部分，而不是只存在全局数据库里。

当前正在落地的结构是：

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

其中：

- `.agents/skills/` 是通用 Agent Skill。
- `.agents/atree/` 是 atree 专属事实源。
- `session.jsonl` 是会话原始记录。
- `assets/` 保存图片、文件等会话资产。
- `schedule.json` 和 `todo.json` 是当前 OpenCode spike 的过渡状态文件。

SQLite 可以作为可重建缓存和运行投影，但不应该成为目录会话的唯一事实源。

## 设计模型

MVP 只保留两个核心对象，外加一个会话属性：

```text
Directory
Session
Automation message  # 会话里的自动化消息
```

会话就是 Agent 的可见形态。MVP 不单独建立 Agent 对象，也不做复杂 Agent 配置表单。

自动化消息是一条未来会自动发送到当前会话的用户消息。它可以是一次性的，也可以是周期性的。

## 开发

安装依赖：

```sh
bun install
```

启动一体服务：

```sh
bun run web --hostname 0.0.0.0 --port 3001
```

前后端分离开发：

```sh
bun run dev:split
```

默认分离端口：

- 后端：`http://127.0.0.1:4096`
- 前端：`http://127.0.0.1:3000`

## 文档

建议从这些文档开始：

- `docs/design.md`：产品核心设计
- `docs/mvp.md`：MVP 范围和当前状态
- `docs/v2-storage-plan.md`：目录自包含存储计划
- `docs/next-implementation-plan.md`：下一阶段实现计划
- `docs/acceptance/atree-mvp-bdd.md`：BDD 验收场景
- `docs/future.md`：未来需求池
- `docs/history.md`：分支与设计历史
- `docs/atree-opencode-pruning.md`：OpenCode 裁剪记录

## 许可证

MIT。许可证保持和 OpenCode 一致。
