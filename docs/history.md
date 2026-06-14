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

本次分支晋级约定：
当前分支（`main`）作为 atree-ng 主线。若原主线有未迁移内容，统一放到旧主分支备份中，不再回写到新主线。

本分支已定为 atree-ng 主线分支（`main`）。历史主分支快照已保留为：

- `legacy-main-main-snapshot`
- `legacy-main-before-atree-ng`
- `legacy-main-origin-atree-ng`
- `legacy-main-atree-ng`
- `legacy-main-before-opencode-spike`
- `legacy-main-before-atree-ng-mainline`（本次主干升级时将旧主分支另存）
- `legacy-main-before-atree-ng-mainline-switch`（当前会话执行主干接管时的旧主线保底分支）
- `legacy-main-before-atree-mainline-final`（本次会话最后一次确认后将旧主分支归档）
- `main-before-atree-ng-promote-save`（本次晋级前保留的主分支快照，便于回滚与对照）
- `main-previous-backup`（当前主线提升前的旧主分支备份）
- `main-legacy-backup`（本次主分支晋级时的旧主分支快照）
- `main-before-2026-06-14-legacy`（本次分支晋级同步到远端的历史主线镜像）
- `main-before-atree-ng-promote`（当前主干接管前的主线镜像，保留 `origin/main` 的旧主线内容）
- `main-legacy-before-atree-mainline`（由旧主分支 `main` 重命名并保留）
- `main-before-atree-docs-backup`（当前文档交接前的 `main` 快照，便于回溯）
- `legacy-main-before-atree-ng-current`（当前主分支一次快照点，防止回归对比）
- `main-legacy-before-atree-ng-final`（本次对话执行前的主线快照，作为主干接管前备份）
- `legacy-main-archive-2026-06-14`（当前会话执行前的最后一次旧主线归档点，便于回退）
- `legacy-main-pre-atree-ng-main`（新主线接管前的主分支镜像，作为最小历史对照）
- `legacy-main-2026-06-14-pre-atree-ng-main`（本会话开始时的主干镜像，避免主干切换时历史丢失）

当主线需求需要回滚或对照时，优先从上述分支读取历史实现。

## 主分支交接说明（当前会话后执行）

- 本地开发分支当前仍为 `main`，可直接作为默认主分支使用。
- 历史主线内容已固化到上述 `legacy-*` / `main-*` 备份分支，不再在 `main` 继续叠加。
- 相关历史设计与需求沉淀全部集中放在：
  - `docs/design.md`
  - `docs/mvp.md`
  - `docs/acceptance/atree-mvp-bdd.md`
  - `docs/future.md`
  - `docs/history.md`
