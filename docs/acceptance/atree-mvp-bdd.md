# atree-ng MVP 行为验收（BDD）

本文件用于行为回归，不绑定具体 UI DOM 选择器。

## 术语

- 节点（Node）：含 `.agents/atree.yaml` 的目录。
- 会话（Session）：挂在节点下的 `.agents/sessions/*.jsonl` 对应项。
- 自动化（Schedule）：会话的 crontab 或一次性 `at` 执行项。

## 1. 根目录与目录树

### Scenario: 初始化只显示 atree 节点
- Given 用户启动应用并传入有效根目录
- When 目录树构建完成
- Then 仅展示包含 `.agents/atree.yaml` 的目录节点
- And 非 atree 目录不作为节点卡片显示

### Scenario: 切换目录后会话分组刷新
- Given 根目录下存在 A、B 两个 atree 节点
- And 当前已开启一个 A 节点下的会话
- When 用户点击 B 节点
- Then 右侧 tab 只展示 B 下会话分组
- And A 节点的 tab 会在会话切回 A 时恢复

### Scenario: 非关键目录和关键目录的可见性
- Given 某节点下不存在自动化会话且无最近激活会话
- When 渲染左侧树列表
- Then 该节点可显示为“可展开但折叠前置提示”的形式
- And 仅在父节点打开展开态时展示其子目录

## 2. 会话生命周期

### Scenario: 新会话创建
- Given 用户在某节点打开会话视图
- When 用户新建会话
- Then 创建一个 JSONL 文件到 `.agents/sessions/<session-id>.jsonl`
- And `.agents/atree.yaml` 的 sessions 列表追加该 session 元数据
- And 会话默认使用该节点路径作为工作目录

### Scenario: 会话切换
- Given 节点有多个已打开会话（历史活跃 + 归档之外）
- When 用户点击会话标签
- Then 该会话变为当前活跃，会话消息流和输入框聚焦到活动会话
- And 仅显示该节点所属的会话，不混入其他节点会话

### Scenario: 归档与恢复
- Given 一个会话处于归档状态
- When 用户在归档菜单中选中它
- Then 该会话从归档区回到当前节点 tab 组
- And 归档列表移除该会话

### Scenario: 关闭前确认
- Given 会话存在自动化任务
- When 用户第一次点击关闭会话按钮
- Then 显示“再次确认归档并取消自动化”的状态
- And 同时按钮文案变更
- When 用户再次确认关闭
- Then 该会话归档成功且其自动化任务被清理

## 3. 自动化（Schedule）

### Scenario: 调度输入兼容性
- Given 调用调度创建接口时同时出现新旧字段
- When 传入 `type`（或兼容的 `kind`/`expression`）和时间参数
- Then 服务端将其统一成 `cron`/`at` 两种内部语义之一
- And 仅允许合法字段生效（例如 `at` 优先取可解析时间字符串，其次取 `runAt`）

### Scenario: 设置周期自动化（cron）
- Given 当前为一个普通会话
- When 用户通过会话命令设置一次 `type=cron` 且包含 5 字段 cron 与消息
- Then 会话生成单条自动化记录
- And 会展示为 `atree` 节点图标提示（若该节点有自动化会话）
- And 同节点内自动化会话按执行时间排序前置

### Scenario: 设置一次性自动化（at）
- Given 当前为一个普通会话
- When 用户通过会话命令设置 `type=at` 且时间在未来
- Then 会话生成一条单次自动化任务
- And 到点后仅触发一次，执行完成后不再继续调度

### Scenario: 同会话只能有一条自动化
- Given 会话已有自动化任务
- When 用户尝试再次创建新的自动化
- Then 返回“请先取消原自动化再创建新自动化”的错误语义
- And 不创建第二条记录

### Scenario: 归档会清理自动化
- Given 一个有自动化的会话
- When 用户选择归档该会话
- Then 会话归档后自动化从该会话分组下移除
- And 不再触发该会话的定时发送

### Scenario: 自动化时间显示
- Given 自动化会话在 12 小时内即将执行
- Then 会显示相对时间
- When 超过 12 小时
- Then 切换为绝对时间展示

## 4. 运行与恢复

### Scenario: 自动化触发追加到同一会话
- Given 会话有 pending 的自动化任务
- When 调度到达执行时间
- Then 会话会以消息方式注入自动化内容
- And 回复消息追加到同一 JSONL 文件，不创建新会话

### Scenario: 重启后恢复
- Given 已有历史会话与未归档会话
- When 重启服务并重新打开该根目录
- Then 会话列表从 `.agents` 元数据恢复
- And 自动化状态/最近更新时间可用于排序展示

## 5. 非核心 UI 细节忽略规则（MVP 兼容）

- 不要求固定每个像素级样式对齐一致
- 不要求图标细节在视觉层面完全不变
- 不要求悬浮动画一致
- 允许对不稳定交互进行手工调整，只要行为状态与状态转移正确
