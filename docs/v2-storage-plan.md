# atree 第二版存储计划

第二版的核心判断：会话记录必须成为当前目录数据的一部分。

atree 不是一个把目录树显示在左边的聊天工具。atree 的核心是：目录本身就是信息上下文，Agent 在目录里发生过的工作也属于这个目录的数据。

```text
目录 = 信息上下文
会话 = 在该上下文中发生的工作
会话记录 = 目录数据的一部分
```

## 目录事实源

atree 第二版不应把会话、自动化和执行历史的唯一事实源放到全局数据库。

允许存在全局数据：

- 本机配置
- API Key 或密钥引用
- 最近打开记录
- 可重建缓存
- 可重建索引

这些全局数据丢失后，不应该导致目录里的会话、自动化消息或工作历史丢失。

## `.agents/` 边界

`.agents/` 是通用 Agent 生态目录，不是 atree 私有目录。

```text
some-directory/
  .agents/
    skills/        # 通用 Agent Skill
    atree/         # atree 私有事实源
```

边界原则：

- 通用 Agent 能力放在 `.agents/` 根下，例如 `.agents/skills/`。
- atree 专属协议、索引、会话、自动化和资产事实源全部放进 `.agents/atree/`。
- 不在 `.agents/` 根目录散放 atree 私有文件。
- runtime 启动 Pi 会话时，必须把 `~/.agents/skills`、当前目录和祖先目录的 `.agents/skills` 显式传给 Pi resource loader，确保目录技能真正进入 Agent 上下文。
- Pi extension 仍走 Pi 原生 `.pi/extensions` / `~/.pi/agent/extensions` / settings 扩展机制；runtime 创建 Pi 会话后必须显式绑定 `AgentSession.bindExtensions({})`，不要在 atree 上层重做一套扩展生命周期。

## 会话目录结构

每个会话是一个自包含目录：

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

### `.agents/atree/meta.yaml`

目录级信息，只描述当前目录：

```yaml
version: 1
title: 内容生产
```

不在这里维护完整会话列表，避免双写一致性。目录下有哪些会话，应通过扫描得到：

```text
.agents/atree/sessions/*/meta.yaml
```

### `sessions/<session-id>/meta.yaml`

保存会话当前状态：

```yaml
version: 1
id: ses_xxx
title: 每日整理
icon: 🦊
created_at: 2026-06-15T10:00:00+08:00
updated_at: 2026-06-15T10:30:00+08:00
archived_at: null

schedule:
  id: sch_xxx
  kind: at
  run_at: 2026-06-15T12:00:00+08:00
  message: 整理今天新增内容
  last_ran_at: null
  last_run_status: null
```

原则：

- 标题、emoji、归档状态、自动化消息放这里。
- 一个会话最多一个自动化消息。
- 自动化支持 `at` 和 `cron` 两种。
- `at` 发送后从 `meta.yaml` 中移除，因为它不再是待执行消息。
- `cron` 发送后保留在 `meta.yaml` 中，并更新 `last_ran_at` / `last_run_status`；下一次执行时间由表达式和 `last_ran_at` 之后的第一个命中点计算。
- 归档有自动化消息的会话时，应清除自动化消息。

MVP 阶段的周期边界语义：

- runtime 停机期间错过的多轮 cron 不追赶补跑，恢复后只执行当前扫描到的一轮到期任务。
- 执行失败记录 `last_run_status: skipped`，不立即重试。
- 同一会话内的普通消息和自动化消息必须串行写入同一个 `session.jsonl`。

周期自动化示例：

```yaml
schedule:
  id: sch_xxx
  kind: cron
  expression: 0 9 * * *
  message: 生成今日摘要
  created_at: 2026-06-15T10:00:00+08:00
  last_ran_at: 2026-06-16T09:00:01+08:00
  last_run_status: ran
```

### `session.jsonl`

保存会话原始记录。

它是 append-only JSONL，适合任何 AI 工具、脚本和编辑器读取。

第二版应尽量使用 Pi session 格式：

```json
{"type":"session","version":3,"id":"ses_xxx","timestamp":"2026-06-15T10:00:00.000Z","cwd":"/path/to/dir"}
{"type":"message","id":"...","parentId":null,"timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"..."}],"timestamp":...}}
```

当整个业务目录复制，或单个会话目录移动到另一个业务目录后，runtime 打开该会话时应修复第一行 session header 的 `cwd`，让它指向当前业务目录。后续消息记录保持不变。

自动化消息也写入同一个 `session.jsonl`。区别不是另建日志，而是在消息里保留来源：

```json
{"type":"message","id":"...","parentId":"...","timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"整理今天新增内容"}],"timestamp":...,"source":{"type":"schedule","scheduleID":"sch_xxx","scheduleKind":"at","runAt":1781496000000}}}
```

这样会话原始记录仍然是唯一事实源，UI 可以稳定识别自动化消息，不需要从文本内容推断。

### `assets/`

保存会话资产，不叫 `attachments`。

原因：

- `attachments` 更像聊天软件里的临时附件。
- `assets` 更像会话工作现场中的长期材料。
- 它可以覆盖图片、音频、PDF、截图、工具产物、导出文件等。

`session.jsonl` 中只应引用会话内相对路径：

```json
{"type":"message","id":"...","parentId":"...","timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"看这张图"},{"type":"file","path":"assets/image-001.png","mime":"image/png","filename":"image.png"}],"timestamp":...}}
```

当前 runtime 已支持文件 part 落盘：

- 请求中的 `data:<mime>;base64,...` 会写入当前会话 `assets/`。
- 请求中的本地 `file://...` 或本地路径引用会复制到当前会话 `assets/`。
- `session.jsonl` 只保存 `assets/<filename>` 相对路径，不保留原始 data URL 或 base64 payload。
- API 读取消息时会把该记录还原成前端可展示的 `file` part。

## 推荐路线

当前 OpenCode 版本保留为 UI 和交互 spike。

第二版推荐路线：

```text
atree UI
  -> OpenCode-compatible API facade
  -> atree runtime
  -> Pi AgentSession / SessionManager
  -> 当前目录/.agents/atree/sessions/<session-id>/session.jsonl
```

短期可以保留 OpenCode SDK 形状作为转接层，因为当前 UI 已经依赖这些 HTTP/SSE 事件结构。

长期应该逐步移除 OpenCode SDK 形状，变成：

```text
atree UI
  -> atree native SDK
  -> Pi
  -> .agents/atree
```

## 验收标准

第二版完成时，应该满足：

- 复制一个业务目录后，会话记录和资产一起复制。
- 删除全局缓存后，目录里的会话仍然可以恢复。
- UI 的 tab、归档列表和自动化排序都能从 `.agents/atree/` 重建。
- `session.jsonl` 可以被普通文本工具和 AI 工具直接读取。
- `assets/` 中的文件都通过相对路径被引用。
- 一个会话目录可以被整体移动、压缩、归档或备份。
- 单个 `.agents/atree/sessions/<session-id>/` 目录移动到另一个业务目录时，目标目录可以恢复该会话的标题、emoji、自动化消息、消息历史和 `assets/`。
- 复制或移动后，`session.jsonl` 第一行 Pi session header 的 `cwd` 会对齐到新的业务目录。
