# DSH 插件扩展面地图（rc.5 源码实读，2026-11-22）

> 来源：deepseek-ai/deepseek-harness tag dsh-v0.2.2-rc.5（对比 rc.3：以下涉及的包仅 package.json 版本行不同，结论两版一致）。
> 关键条目已由 Claude Code 抽查源码复核（标 ✔）；其余为子代理源码阅读结论，行号以 rc.5 为准。

## 1. 判局层挂载（六插入点）

官方 team 任务板**无专用钩子/中间件**，只有提交后的 `team/task` 会话事件与 `agentTeam` 投影。模型侧所有变更收敛到 4 个工具：`team_task_create/get/list/update`（update 的 action：claim/release/edit/set_dependencies/complete/reopen/reassign/delete ✔ `packages/team/tool-agent-team/src/index.ts:209`）。

**唯一稳定的事前否决口子＝`tools/pre-execute` waterfall** ✔ `packages/core/tools/src/events.ts:18`：返回 `{kind:'deny', reason}`，reason 以 `Error: <reason>` 回给模型 ✔ `pipeline.ts:214-226`。**不能改写参数** ✔ `contracts.ts:365-378`。`tools/post-execute` 的 block 发生在任务快照已追加之后，**撤不回**——硬闸一律放 pre-execute。

| 插入点 | 挂法 | 观察/拦截 | 风险 |
|---|---|---|---|
| admission | pre-execute 拦 `subagent`/`subagent_fork`、`team_task_update(claim)`；`agent/created`(serial) 抛错可拒建但无模型可见理由 | 拦截 | team 开关 `setEnabled` 走 Web/Remote，工具闸拦不到 |
| contract | pre-execute 拦 `team_task_create`、update 的 edit/set_dependencies | 拦截（只能拒、不能补） | pre-execute 看到的是未校验原始参数 |
| dispatch | pre-execute 拦 claim/reassign/release；`tools/result`、`session/event` 的 `meta.diffs` 记账 ✔ `packages/fs/tool-fs/src/write.ts:103-110` | 半拦半观 | **盲区：bash/pwsh 写文件无 diffs；`str_replace_editor` 无 presentationMeta**；`workspace-changes` 排除子 agent 会话；勿挂 `fs/*-intent`（单槽 waterfall，会饿死官方策略） |
| completion | pre-execute deny `complete`；`tools.guard()` 做同步不变量兜底 | 拦截 | 任务 revision 是 CAS，闸内读值可能过期 |
| delivery | 无交付事件；pre-execute 拦 `present`；`agent/turn-stopping` steer 顶回 | 半拦截（steer 仅建议） | steer 可能循环 |
| runtime | `agent/status`、`agent/error`、`session/event`、`subagent/start|end` + 自建定时器；`steer()` / `cancel({kind:'hook'})` / `subagents.interrupt` | 观察 + 事中干预 | 无内建看门狗；插件卸载须 dispose |

总体方案：函数式 Cordis 插件挂 profile 级（patch insert 一行，不改官方行），`inject:['tools']`。仅当必须覆盖非工具调用者时，才 disable 官方 `agent-team` 行换子类（与私有实现耦合，不推荐首期）。

## 2. 秘书 / 多工作区 / 前端

- **零执行秘书**：可行，需双保险。专用 agent preset 只装配自研工具行；再在 agent 作用域 `ctx.tools.restrict({allow:[...]})` 兜底 ✔（`core/tools/src/index.ts:162`，只能在 agent.ctx 调用）。权限预设只管 sandbox/approval、不管工具集，**preset 不是沙箱**；宿主全局工具（mcp-resources、tool-agent-team）不随预设消失，须白名单兜底；宿主升级后须重审。
- **多工作区**：每工作区一个根会话。`sessionController.create({cwd | workspaceId, agentPreset})` ✔（`packages/api/session-controller/src/types.ts:269-276`）；`session.prompt` 可向任意 sessionId 投递并唤醒；`list/observeProjections/observeEvent` 流式取状态。进程内插件调用不受远程访问策略拦截。
  - 跨根会话派活/回报**无现成模型工具**，须自写秘书工具包调 `session.prompt`。
  - 子 agent 的 sendMessage 限同一根树；**模型侧委派工具不能给 teammate 指定 cwd**，worktree 只能移动当前会话 ⇒ 「官方 teammate 能否指定 worktree cwd」spike 的答案基本是否（模型路径），宿主 `SubagentStartRequest.cwd` 可指定。
- **调度与存储**：`ctx.schedule`（target 可 session/new，带 cwd/agentPreset，持久化）、`ctx.jobs`；持久化 `ctx.storageDomain`（json/sqlite）。
- **主区域前端**：`main` 是 keyed root 插槽 ✔（`packages/client/ui-layout/src/client/index.ts:75`），`ctx.slots.inject('main', …)` + `ctx.layout.selectPanel(id)`；侧栏入口 `sidebar.panellist`。客户端经 `dsh.client` + `./client` 导出打包，Phaser 打进自家包（不列 external）。数据：自研 `@Remote({mode:'stream'})`；宿主→前端事件转发是白名单、不可扩展，需自建流。
- **版本闸门**：`engines.dsh`/peerDeps 不满足即禁用该行 ✔（`plugin-compatibility.ts:87-104`）。**桌面端 rc.3 装 rc.5 构建会被禁用**——须按 rc.3 构建、或升级桌面端、或走 allow-version 豁免。

## 3. 对设计的直接影响

1. 所有硬闸统一形态＝pre-execute 判定器（拒+理由），契约类 gate 只能「拒并说明怎么改」，不能自动补齐。
2. changed-paths 的观察面必须是「会话 diffs ∪ git 脏路径」，且会话里出现 shell 写或 str_replace_editor 时判 `unmeasured` 而非放行。
3. 事件脊的原料＝DSH 的 `session/event`、`tools/result`、`team/task`、`agent/status`、`subagent/*`；脊是对这些的归一化，不另造采集。
4. 工作区＝独立根会话（自带 cwd）；teammate 级目录隔离不能靠官方模型工具，需宿主侧或后置。
