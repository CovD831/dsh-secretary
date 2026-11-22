# dsh-secretary 进度追踪

> 目标锚点：docs/PRD_phase1-mvp.md。设计储备：docs/design/（只读参考，来自 ~/dsh-agent-teams-package）。
> Phase 0 spike 产物与回放脚本：~/Desktop/dsh-spike-phase0/spike-0{1,2,3}/。

## 阶段 0：验证 spike
- [x] 0.0 宿主 rc.5 就位（桌面端已升级）
- [x] 0.1 最小插件加载（--patch overlay）
- [~] 0.2 pre-execute deny 回理由给模型 — 管线级确证，端到端待模型凭据
- [~] 0.3 零工具秘书 — tools.view 实测清单为空，端到端待模型凭据
- [x] 0.4 sessionController 跨会话派活
- [x] 0.5 前端：main 插槽默认面板 + 侧栏控制 + 往返原生
- [x] 0.6 权限审批截获入自建队列
- [x] 0.7 正式安装链路（npm pack → `dsh plugin --profile X add <绝对tgz>` → 真实启动激活；版本闸门拒装并回滚；remove 复原）— 隔离 DSH_HOME 确证，见 spike-04/RESULT.md。遗留：已安装包的 client 资产 URL 404，浏览器端加载未验，并入 1.5 与 F1

## 阶段 1：架构与开发规范 + 骨架
- [x] 1.1 开发规范 docs/STANDARDS.md
- [x] 1.2 子代理协作规范 docs/AGENTS-WORKFLOW.md
- [x] 1.3 事件日志 schema v0 docs/EVENT-LOG-v0.md — 待核 3 项见其 §7
- [x] 1.4 全局地图 docs/MAP.md（随骨架落地）
- [x] 1.5 插件骨架：preset、工具注册、事件归一化落盘 — 隔离正式安装、固定流原生轮次、client 与卸载已通过 scripts/replay.sh

## 当前工作
正在做：阶段 2 拆卡（秘书与派发）
下一步：阶段 2 首张卡
