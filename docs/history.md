# atree-ng 历史文档与版本记录

这个分支作为 atree-ng 主分支，历史设计文档统一放在 `docs/` 下，按用途如下：

- `docs/design.md`：核心产品设计（目录、会话、周期任务、数据边界、运行形态）
- `docs/mvp.md`：当前 MVP 任务书（功能边界、流程、验收说明）
- `docs/future.md`：未定稿的想法池（后续扩展、实验项）
- `docs/atree-opencode-pruning.md`：基于 OpenCode 的裁剪策略
- `docs/acceptance/atree-mvp-bdd.md`：MVP 行为验收（Given/When/Then）
- `docs/assets/codex-ui-reference.png`：参考 UI 示例图

## 里程碑（本分支主线）

- `a910e74`：引入 atree automation schedule 相关体验
- `bc06f04`：增加定时会话模型基础能力
- `d9d163c`：节点切换与激活体验改进
- `7dd418f`：会话标签与归档交互优化
- `dae8b55` 起：工作区导航与树结构梳理
- `2136864` 之后：统一 schedule API 与解析链路，完善会话与节点展示排序、归档恢复一致性

## 分支留痕

本分支已定为 atree-ng 主线分支（`main`）。历史主分支快照已保留为：

- `legacy-main-main-snapshot`
- `legacy-main-before-atree-ng`
- `legacy-main-origin-atree-ng`
- `legacy-main-atree-ng`
- `legacy-main-before-opencode-spike`
- `main-previous-backup`（当前主线提升前的旧主分支备份）
- `main-legacy-backup`（本次主分支晋级时的旧主分支快照）
- `main-before-2026-06-14-legacy`（本次分支晋级同步到远端的历史主线镜像）
- `main-legacy-before-atree-mainline`（由旧主分支 `main` 重命名并保留）

当主线需求需要回滚或对照时，优先从上述分支读取历史实现。
