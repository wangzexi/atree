# atree 总体设计

## 一句话

`atree` 是一个运行在个人电脑或个人服务器上的目录会话系统。

它不是传统笔记软件，也不是复杂 Agent 平台。它的核心是：用户在自己的信息目录里和 AI 工作，反复发生的工作逐渐沉淀为周期会话，让目录获得一部分持续执行能力。

## 目标

传统知识管理软件主要记录信息，缺少执行能力。

`atree` 希望在用户已有的知识结构、文件结构和信息结构上，增加一层轻量执行能力：

- 目录保存上下文。
- 会话承载执行。
- 周期会话沉淀重复工作。
- `.agents/atree/` 保存 atree 目录事实源。

最终形态更像一个“模拟经营自己所有数据”的工作区：用户不是直接管理所有文件细节，而是在关键目录里安排会话长期工作。

## 核心对象

第一版只保留两个核心对象：

```text
目录 Directory
会话 Session
```

### 目录

目录是上下文作用域。

目录本身不需要复杂状态。目录只是文件系统里的一个位置，是用户资料、外部挂载、会话历史和局部技能的容器。

一个目录是否被 atree 初始化，只看它是否存在：

```text
.agents/atree/meta.yaml
```

当前 UI 可以浏览根目录下的普通目录；有会话或自动化的目录会作为关键节点优先展示。

### 会话

会话是目录里的 AI 对话，也是 atree 中 Agent 的唯一表现形式。

不单独创建 Agent 对象，不让用户在表单里配置“设计师 Agent”“运营 Agent”之类的角色。用户只是在目录里开启会话；当某个会话被长期复用、设置周期，或者持续承担某类工作时，它自然表现为一个常驻 Agent。

```text
Session = Agent
```

区别只在会话属性：

- 普通会话：一次或少量使用的临时对话。
- 自动化会话：带 `at` 或 `cron` 自动化消息，会按时间自动唤醒并继续执行。

自动化消息不是独立 Agent 对象，它只是会话里的一条未来会自动发送的用户消息。

MVP 暂不实现 interface session。

## 工作目录和执行权限

每个会话都有一个当前工作目录，即它所属的 atree 目录。

创建新会话时，系统提示词应注入当前工作目录。默认情况下，会话就在这个目录内工作。

MVP 阶段不做模型执行权限限制：

- 不限制会话只能读取当前工作目录。
- 用户明确要求时，会话可以访问当前工作目录以外的路径。
- 暂不实现目录沙箱、读写 ACL、跨目录访问拦截。

后续如果需要权限控制，再单独设计。第一版优先保持底层 Agent runtime 的原生执行模型；当前 spike 复用 OpenCode core，长期方向是切到 Pi core。

## 工作方式

用户的自然工作路径是：

```text
在目录里手动工作
  -> 多次用会话指挥 AI 做类似工作
  -> 让 AI 从历史中总结 pattern
  -> 把会话设置为周期会话
  -> 周期会话按固定节奏继续执行
```

自动化不是用户预先配置出来的，而是从重复会话里长出来的。

这是 atree 和传统自动化工具的重要差异。用户不需要一开始就理解触发器、动作、参数和状态机，只需要先在目录里自然地工作。

## 存储边界

`.agents/` 是通用 Agent 目录，不是 atree 的私有目录。atree 只控制 `.agents/atree/`。

```text
some-directory/
  .agents/
    skills/        # 通用 Agent Skill
    atree/         # atree 专属事实源
      meta.yaml
      sessions/
        <session-id>/
          meta.yaml
          session.jsonl
          assets/
          schedule.json
          todo.json
```

`README.md` 不属于 atree 协议。用户是否使用 README、如何组织普通文件、是否建立 facts/assets/refs 等目录，都由用户自己决定。

### `.agents/atree/meta.yaml`

表示当前目录被 atree 管理，并保存目录级轻量元数据。

它不应该长期承担完整会话索引。会话列表应通过扫描 `sessions/*/meta.yaml` 得到。

```yaml
version: 1
title: 我的目录
createdAt: 1781462400000
updatedAt: 1781462400000
```

### `sessions/<session-id>/`

每个会话是一个自包含目录。

```text
.agents/atree/sessions/<session-id>/
  meta.yaml
  session.jsonl
  assets/
  schedule.json
  todo.json
```

`meta.yaml` 保存标题、emoji、归档状态、更新时间等会话元数据。

`session.jsonl` 保存会话原始事件流。Agent 相关事件、消息结构和会话语义长期以 Pi 为核心，不再另行抽象一套 atree Agent runtime。

- 会话历史是 JSONL。
- 用户消息、助手消息、工具调用、工具结果、调度唤醒都追加到同一个会话文件。
- 周期会话不会为每次执行创建新 run 文件，而是继续向原会话追加事件。

`schedule.json`、`todo.json` 是当前 OpenCode spike 的过渡文件，用于先把工具状态放回会话目录；长期可以折叠进 `meta.yaml` 或 `session.jsonl`。

### `assets/`

聊天过程里的图片、截图、音频、PDF 等二进制内容不写入 JSONL。

JSONL 只保存引用，文件落到：

```text
.agents/atree/sessions/<session-id>/assets/
```

如果某个附件后来成为用户要长期管理的业务材料，可以由用户或 AI 移动到普通目录里，例如目录自己的 `assets/`、`refs/`、`facts/`。会话目录内的 `assets/` 只表示“这个会话的附件和多媒体材料”。

这和 Pi Coding Agent 当前默认做法不完全一样。Pi 的会话格式支持把图片以 base64 `ImageContent` 直接嵌入 JSONL。atree 第一版有意采用“JSONL 引用 + 附件文件落盘”，因为 atree 的核心是目录结构，图片和多媒体作为文件存在更符合长期管理、复制和迁移。

### `.agents/skills/`

`.agents/skills/` 用来兼容 Agent Skill 标准。

MVP 先按目录级技能处理：当前目录下的会话默认可以参考这些技能。会话级技能绑定可以以后再加。

## UI 原则

第一版 UI 参考 Codex App 的主体验，但左侧只保留纯目录树。

```text
左侧：目录树
右侧：会话区
```

左侧不放“新会话、搜索、插件、自动化”等全局功能入口。atree 的入口就是目录。

右侧包括：

- 顶部：当前会话标题。
- 顶部附近：当前目录的会话 icon 组。
- 中间：聊天流。
- 底部：输入框。

UI 参考：

- `docs/assets/codex-ui-reference.png`

参考 Codex App 的右侧聊天体验和整体克制风格，但左侧只保留纯目录树，不保留新对话、搜索、插件、自动化等全局入口。

### 左侧目录树

左侧展示根目录下的目录树。

有会话或自动化的目录是关键节点，默认优先展示；普通目录可以通过展开父节点临时显示。第一版不把左侧做成完整文件浏览器，也不在左侧处理文件预览。

### 顶部会话 tab 与目录外露 icon

icon 属于会话，不属于目录。

一个目录上可能有多个会话工作，因此右侧顶部使用 tab 展示当前目录的会话组。左侧目录节点只外露有自动化的即将执行会话 emoji，作为关键状态提示。

```text
当前目录 tab：🦊 🐳 ◌
左侧目录节点：目录名 🦊
```

展示规则：

- 有自动化的会话排在前面，按下次触发时间从早到晚排序。
- 非自动化会话按最后交互时间从新到旧排序。
- 归档会话只出现在归档菜单，不和 tab 重复。
- 新会话 tab 是草稿入口，不发消息不落盘。
- hover tab 显示会话标题和时间信息。

不引入“重要会话”概念，不做手动排序。MVP 里也不做 pin。

## 全局技能注入

所有会话都应该自动获得一组 atree 全局技能，告诉 AI 如何操作当前目录的 atree 协议文件。

第一版全局技能至少覆盖：

- 初始化当前目录为 atree 节点。
- 创建新会话。
- 修改会话标题。
- 修改会话 icon。
- 设置或取消 `at` / `cron` 自动化消息。
- 读取当前目录会话列表。

用户不需要通过 UI 表单做这些事，而是直接在会话里给 AI 下指令。

例如：

```text
把这个目录加入 atree。
把这个会话的 icon 改成 🦊。
每天早上 9 点运行这个会话。
```

## 运行形态

`atree` 应该是本地服务，而不是 Electron 应用。

预期形态：

- 在用户电脑或服务器上长期运行。
- 提供 HTTP GUI。
- 用户可以从外部机器或手机访问。
- 本地文件系统是主要状态来源。

技术方向：

- 全 Bun + TypeScript。
- 前端 React。
- 当前 spike 复用 OpenCode 的 HTTP 服务、聊天流、工具执行和文件交互基础。
- atree 正在把外层产品模型和事实源改成目录工作区。
- 长期需要支持 Pi Coding Agent 的事件和扩展生态，但 Pi core 替换是下一阶段。
- 不在 Pi 之上再抽象另一套 Agent runtime。

## 暂不做

以下内容不进入 MVP 主干：

- interface session。
- 自治目录访问拦截。
- 父子目录权限边界。
- 完整文件浏览器。
- 文件预览。
- 图结构。
- 多设备同步。
- 预算系统。
- 复杂 Agent 创建表单。
- 手动插件/自动化管理页面。
- Electron 桌面壳。
- 模拟经营式图形化界面。

## 参考材料

核心思想来源：

- `/Users/zexi/workspace/wangzexi/space/知识库的下一步/README.md`

支撑材料：

- `/Users/zexi/workspace/wangzexi/space/知识库的事实与视角解耦/README.md`
- `/Users/zexi/workspace/wangzexi/space/循环工程/README.md`
- `/Users/zexi/workspace/wangzexi/atree/README.md`
- `/Users/zexi/workspace/refs/pi-mono/packages/coding-agent`
- `/Users/zexi/workspace/refs/pi-mono/packages/web-ui`
- `/Users/zexi/workspace/refs/pi-mono/packages/mom`
- `/Users/zexi/workspace/refs/opencode`

参考要点：

- Pi Coding Agent：JSONL 会话、`AgentSession`、事件订阅、图片输入、Skill/Extension 生态。
- pi-mono web-ui：可参考 ChatPanel/AgentInterface 的交互和事件模型，但不要照搬 IndexedDB 存储。
- opencode：只作为本地 HTTP GUI 启动和服务形态参考；Agent 事件格式不参考 opencode。
