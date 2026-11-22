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
- [~] 0.7 正式安装链路（打包→plugin add→激活），在隔离 DSH_HOME 验证；真实桌面安装等首个可用版本

## 阶段 1：架构与开发规范 + 骨架
- [~] 1.1 开发规范 docs/STANDARDS.md
- [~] 1.2 子代理协作规范 docs/AGENTS-WORKFLOW.md
- [~] 1.3 事件日志 schema v0 docs/EVENT-LOG-v0.md
- [ ] 1.4 全局地图 docs/MAP.md（随骨架落地）
- [ ] 1.5 插件骨架：preset、工具注册、事件归一化落盘

## 当前工作
正在做：1.1–1.3 规范起草（子代理并行）+ 0.7 隔离安装验证
下一步：1.4/1.5 骨架
