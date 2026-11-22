# dsh-secretary

DeepSeek Harness（DSH）插件：永不执行的秘书 + 可插拔判局层（gate）+ 最简记忆。以官方 agent-team 为骨架。

- 目标与范围：docs/PRD_phase1-mvp.md（冲突时以 docs/design/NEW-REPO-BRIEF.md 已裁事项为准）
- 进度：docs/PROGRESS.md
- 规范：docs/STANDARDS.md、docs/AGENTS-WORKFLOW.md
- DSH 插件开发知识：.claude/skills/dsh-plugin-dev/
- 宿主版本钉死 0.2.2-rc.5；源码参考 /tmp/dsh-ref/deepseek-harness

硬约束：不改用户 ~/.dsh 下 desktop/web/headless 的 profile、设置与已装插件；不读不打印凭据；测试一律用独立 DSH_HOME。所有文档、注释、日志用中文。
