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

### Scenario: 目录切换不混入子会话
- Given A 为当前节点，B 为其子目录，会各自拥有会话
- When 用户从 A 切换到 B
- Then A 的标签集合从 tab 区域移除
- And 仅显示 B 的 root 会话（不自动补充 A 或更深层子树中的会话）
- When 用户再次返回 A
- Then 恢复 A 在会话切换前活跃的会话分组状态

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

### Scenario: 自动化列表变化可见性
- Given 会话已有自动化任务并打开了聊天页
- When 工具调用 `schedule create` 或 `schedule delete` 后服务返回成功
- Then 自动化 header 在当前会话中即时反映变更
- And 不需要刷新页面

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

### Scenario: 归档前二次确认且清理自动化
- Given 当前会话存在自动化任务
- And 用户对该会话执行关闭操作
- When 第一次点击关闭
- Then 显示二次确认状态（提示将同时取消自动化）
- And 未立即关闭该会话
- When 用户再次确认关闭
- Then 该会话归档成功
- And 该会话的自动化被清理
- And 列表中不再显示该会话的自动化 Header

### Scenario: 自动化事件立即反映到会话头
- Given 会话已有一个自动化任务
- When 调用 `schedule create`/`schedule delete` 并返回成功
- Then 会话输入区头部立即更新（无需刷新）
- And UI 按照“时间+最近执行文本”重新渲染

### Scenario: 每会话最多一条自动化
- Given 一个会话已有一条已存在调度
- When 再次提交一个新的调度配置
- Then 系统拒绝新建并返回“先取消旧调度再创建”提示
- And 只保留原有单条调度记录

### Scenario: 会话头显示节点下自动化优先级
- Given 节点下有多个会话，其中部分带自动化
- When 左侧节点状态计算
- Then 带自动化的会话排在普通会话前
- And 按下一次执行时间从近到远排序

### Scenario: 切换节点时会话分组隔离
- Given 根目录 A 下有会话组 A1/A2，B 下有 B1/B2
- When 当前处于 A 并打开多个 A 会话后切换到 B
- Then 右侧只显示 B 的会话 tab，A 的会话不再可见
- And 切回 A 时恢复 A 会话组和之前激活会话

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

## 6. 简化与稳定性验收（MVP 迭代后）

### Scenario: 自动化事件监听不重复处理非自动化事件
- Given event bus 在收到会话 SSE 回调
- When 事件类型不是 `schedule.created`、`schedule.deleted`、`schedule.ran`
- Then 不应该触发 schedule 相关列表刷新

### Scenario: 自动化列表排序规则单点稳定
- Given 某会话存在多条自动化任务
- When 读取其自动化清单并展示
- Then 按 `nextRunAt` 升序展示（无 `nextRunAt` 的项排在后面）

### Scenario: 自动化清单归一化不丢字段
- Given 后端返回的 schedule payload 含 `runAt`、`nextRun` 和 `nextRun` 字段字符串/数值混合
- When 前端标准化为会话内存模型
- Then `runAt`/`nextRun`/`nextRunAt` 始终是数字或 `null`
- And `kind` 统一为 `once|recurring`

### Scenario: 归档前置确认后不会误关闭
- Given 会话有活跃自动化
- When 第一次点击关闭
- Then 会话仍保持在 tab 列表中
- And 要求明确二次确认才移除
- And 自动化在关闭前不会被误删

### Scenario: 左侧会话树与标签组隔离（回归）
- Given 在节点 A 下打开会话并手动触发 schedule/消息更新
- When 切到节点 B 再切回节点 A
- Then 节点 A 的会话标签会按历史会话组恢复，节点 B 不混入 A 的会话标签

### Scenario: 单会话节点图标优先策略
- Given 某目录下存在会话且无自动化会话
- When 该目录被渲染
- Then 目录行只显示当前会话图标，不展示“更多”占位项
- Given 同目录有 3 个以上会话
- Then 目录行显示第一个会话图标，其余会话收缩在右侧次级区域

## 7. 手工回归（BDD 风格）

以下每一条都建议独立执行，并在每轮记录“结果/耗时/发现”：

### 回归轮 1：首次启动与根目录初始化
- Given 用户首次启动应用
- When 只配置一个根目录
- Then 左侧只展示该树的 atree 节点（`.agents/atree.yaml` 为基准）
- And 右侧进入「选择会话/新会话」入口（无默认会话污染）

### 回归轮 2：同目录重复切换
- Given 当前在节点 A 且有多个会话
- When 连续点击 A 节点三次
- Then 右侧 tab 组不抖动、不会重复创建 session group（只刷新内容）
- And 默认焦点始终回到输入框

### 回归轮 3：跨节点切换隔离
- Given 根目录有节点 A/B，且 A、B 都有各自会话
- When 从 A 切换到 B 再切回 A
- Then 右侧仅显示 A 的会话，再切换到 B 仅显示 B 的会话
- And A 切回后恢复为离开前激活的会话，不串入 B 的会话

### 回归轮 4：子目录展开与可见性
- Given 某节点有已读节点和无会话节点的子目录
- When 先后展开不同层级目录
- Then 有会话目录始终高亮展示，纯叶子空目录不阻塞树结构
- And 非关键（无会话）分支仅在父节点展开时可见

### 回归轮 5：新建会话与草稿行为
- Given 当前在节点 A
- When 点击新建入口并发送第一条消息
- Then 创建新会话并附着到 A 的 `.agents/sessions`
- And 会话立即可继续发送，不需要刷新页面
- And 这条会话出现在 A 的节点会话区域

### 回归轮 6：会话归档二次确认
- Given 一个有自动化任务的会话
- When 第一次点击关闭（归档）按钮
- Then 展示“再次确认”状态，列表与当前聊天仍保留
- When 再次确认关闭
- Then 该会话进入归档列表并从当前会话 tab 中移除
- And 该会话的 schedule 也被移除

### 回归轮 7：归档恢复
- Given 会话处于归档状态
- When 在归档菜单恢复该会话
- Then 它立刻回到当前目录 tab 组
- And 不再重复出现在归档列表

### 回归轮 8：自动化创建与约束
- Given 一个会话无自动化
- When 通过自然语言创建一次性 schedule（at）且时间有效
- Then 会话出现自动化头并显示预估触发时间
- And 第二次再次创建自动化前先提示“请先取消旧任务”
- When 新任务已存在时触发「同会话仅允许一条」规则
- Then 拒绝创建并保留旧任务

### 回归轮 9：自动化触发实时同步
- Given 一个会话有一次性或周期自动化
- When SSE 到达 `schedule.created` / `schedule.deleted` / `schedule.ran`
- Then 会话头即时同步，不需要刷新页面
- And 节点排序与显示优先级（有自动化优先，按 nextRun 排序）即时更新

### 回归轮 10：消息即时展示与滚动体验
- Given 用户发送消息后无待处理流
- When 接口返回流式 chunk 时
- Then 用户消息应立即出现在输入区域下方可见
- And 会话滚动条行为稳定，不出现被容器遮挡/重叠

### 回归轮 11：无效根目录保护
- Given 根目录下有未配置 atree 的目录混入树
- When 渲染左侧
- Then 非 atree 节点不形成常驻会话入口
- And 切换时不会错误加载非 atree 会话上下文

### 回归轮 12：重启恢复
- Given 有历史会话和已归档会话
- When 重启后回到同一根目录
- Then 会话列表与排序来自元数据可恢复
- And 自动化相关头与归档列表状态一致
