# gate「completion.verify-rerun」源码走查与判据提案

> 2026-11-23 · DSH 0.2.2-rc.5（`R/` = `/tmp/dsh-ref/deepseek-harness`）· 〔事实〕有源码指路，〔推断〕是设计判断。

## 1. 「宣布完成」的形态与可拦面

〔事实〕官方 team 里，成员完成只能走 `team_task_update`；
参数只有 `task_id / expected_revision / action`，`edit` 另带 subject/description/blocked_by/write_scopes/owner，**没有验证命令或证据字段**（`R/packages/team/tool-agent-team/src/index.ts:201-237`）。

| 形态 | 触发 | 能否带验证命令/证据 | 源码 |
|---|---|---|---|
| team 任务完成 | `team_task_update(action=complete)`；要求调用者是 owner 且任务当前 `in_progress` | 不能。`complete` 只把 status 置 completed | `R/packages/team/agent-team/src/task-board.ts:178-182` |
| 建 team 任务 | `team_task_create`；`description` 必填，描述写「Complete task details and acceptance criteria」 | 只能塞进自由文本；持久于 task 快照，上限 16384 字 | 同上 `:117-141`；`types.ts:64-77`；`task-board.ts:169` |
| team 成员结束 | `subagent/end` 的 `stopReason=completed` + 给父的完成通知 | 不是工具调用；pre-execute 拦不到 | `R/docs/subsystems/core.zh.md`（subagent 事件） |
| solo 工作区结束 | `turn/end {reason:{kind:'completed'}}` | 不是工具调用；只有 `agent/turn-stopping` 串行广播（可 steer 建议或抛错终止），不是 deny | `R/packages/core/agent-loop/src/agent.ts:401-405,425-431`；`R/packages/core/session/src/types.ts:206-235`；`R/packages/core/agent/src/runtime-types.ts:418` |
| 交付声明 | `present`（标准预设已装）；成功后 append `deliverables/presented` | 无验证字段；只声明已有文件 | `R/packages/deliverables/tool-present/src/index.ts:38-109`；`R/packages/bundle/web-app/presets/standard.patch.yml:128-129` |
| goal 完成 | `update_goal(action=complete)`（需已有 goal） | 只有 objective，无命令/证据 | `R/docs/tool-catalog.zh.md:1616-1670` |

〔事实〕`team_task_update` 的完整语义可被 gate 同步读到：`ctx.agentTeams.getTask(caller, id)` 是同步调用（`R/packages/team/agent-team/src/index.ts:138`）。
〔推断〕**gate 应匹配的工具清单**：`team_task_update(action=complete)`、`present`（solo 交付）、`update_goal(action=complete)`（若启用 goal）。
〔事实〕solo 没有工具级「完成」；`turn/end` 只有在 `agent/turn-stopping` 里 steer，属建议、可能循环（02 地图 delivery 行）。〔推断〕这不是硬闸，solo 的完成声明必须落到某个工具调用（present 或自建完成工具）。

〔事实〕现有 runner 只把**注册的工作区根会话 id** 当管辖面（`src/gates/runner.ts:34` → `src/workspace.ts`）。teammate 的 `team_task_update(complete)` 因此不会触发；建议用 `ctx.subagents.rootOf(exec.agent).id` 与注册根会话比对（`R/packages/subagent/subagent/src/index.ts:300`）。

## 2. 验证命令从哪来

| 候选 | 现状 | 可靠性 | 源码 |
|---|---|---|---|
| 派发 acceptance | 只拼进 prompt 文本 `验收标准：${acceptance}`；**不落 dispatch 事件 payload**（payload 只有 summary），上限 1000 字 | 中：只存在于目标会话 `user/message`（`R/packages/core/session/src/types.ts:315`），需解析；派发记录本身查不到 | `src/dispatch.ts:90-100,107-113`；`src/dispatch-config.ts:6` |
| team 任务 description | 建任务时持久，complete 时按 task_id 同步读取 | 中高：持久且有 revision，但仍是自由文本 | 见 §1 |
| complete 参数 | 不存在 | 不可用 | 同上 |
| 成员自报 exitCode | DSH team/present 均无此字段 | 不可用（也不应采信） | 同上 |

〔推断〕建议约定：acceptance 与 team 任务 description 各含一个 ```` ```verify ```` 块，块内每行一条可执行命令；缺块、空块、无法解析一律 `unmeasured`。同时把 acceptance（或解析后的命令表）写入派发事件 payload，避免靠会话文本反解析（`src/dispatch.ts` 一处增量改动，需队长批准）。

## 3. 「独立方重跑」怎么实现

〔事实〕`tools/pre-execute` 是 waterfall，`prepare()` 直接 `await` 监听器，**没有超时**（`R/packages/core/tools/src/pipeline.ts:198-234`）。
〔事实〕`timeoutMs` 只由 `tools/execute` 包装器执行（`R/packages/guard/timeout-policy/src/index.ts:59-88`；`R/packages/core/tools/src/contracts.ts:64-70`），**覆盖不到 pre-execute**。
〔事实〕调用方取消会 abort `exec.signal`；registry 在监听器 settle 后复查取消，但**从不放弃监听器的 promise**（`R/packages/core/tools/src/events.ts:18-22`）。〔推断〕因此可以 await 长操作，但必须自己设截止时间，否则会挂住该工具调用。

- **方案 A（推荐）**：pre-execute 内用 `ctx.shell` 直接跑。`resolve({command, workdir, timeoutMs, onExpiry:'kill', stdoutMaxBytes, signal, sandboxPolicy})` → `execute(spec)` → `await execution.result()`，取 `exitCode/timedOut/aborted/stdout/stderr`（`R/packages/shell/shell/src/index.ts:84,93`；`types.ts:56-72,141-160,226-237`）。
  bash 执行器默认 120s、**上限 600s**（`R/packages/shell/bash-local/src/index.ts:100-110`），超时即 kill，属于有界等待。沙箱需显式传 `ctx.sandboxPolicy.resolve({session: exec.agent.session})`，否则回落到部署默认根（`R/packages/sandbox/sandbox-policy/src/index.ts:199-228`；`R/packages/shell/bash-sandbox/src/index.ts:85-87`）。
  「独立」= 读数来自工作区内的 OS 退出码，不是成员自报；不需要另起进程。
- **方案 B（不推荐 MVP）**：`ctx.subagents.startActivation({delivery:'caller', cwd, prompt, signal})` 后 `await activation.result`（`R/packages/subagent/subagent/src/index.ts:267-292`；`types.ts:260-286`）。pre-execute 理论上能等，但这是 LLM 驱动、不确定、成本高，还要用 outputSchema 才拿到退出码，且会放大取消/递归问题。

〔推断〕推荐 A：确定性、低延迟、证据可复核；B 只留给「必须由另一个 agent 判断」的后续版本。

## 4. 结果写入 gate.verdict 与 unmeasured 判据

`gate.verdict.evidence` 是开放对象（`docs/EVENT-LOG-v0.md` §3.8），建议每条判定写：
`{source:'team.description'|'dispatch.acceptance', ref:{taskId,revision}|{dispatchKey,sessionId,seq}, cwd, rerun:[{command, exitCode, durationMs, timedOut, aborted, stdoutSha256, stdoutTail, stderrTail}]}`。
只存摘要/哈希，不存全文（日志规范 §2）。

〔推断〕`unmeasured`（runner 会转成 deny）至少覆盖：无来源、无 verify 块、块内为空、cwd 不存在（`workingDirectory.ensure` 抛错，`R/packages/session/working-directory/src/index.ts:154-170`）、`ctx.shell` 未注入、spawn 失败、`timedOut`/`aborted`、`exitCode` 为 null 或非整数、输出解析失败、判据自身异常（`src/gates/runner.ts:15-29`）。
`deny` = 任一命令 exitCode ≠ 0（理由点名命令与退出码）；`allow` = 全部为 0，并附 rerun 证据。

## 5. 安全

〔推断〕风险：执行 acceptance 里的任意文本（等价于宿主权限命令）、绕过沙箱、把 cwd 指到工作区外、输出泄密、长跑拖死轮次。
最小防护：① 命令只认**派发/建任务时已固定**的 verify 块，complete 时不接受新命令；② 只走 `ctx.shell`，不用 `child_process`；③ `workdir` 固定为 `session.header.cwd`（`R/packages/core/session/src/types.ts:105-106`），并传 session 解析的 sandboxPolicy；④ 自有总截止（默认 60s，硬上限 300s）+ stdout 上限；⑤ 只落哈希与尾部；⑥ 每任务命令条数上限（如 5）；⑦ 禁止后台执行（bundle 的 `run_in_background` 与我们无关）。
〔事实〕Windows 上 bash-sandbox 被禁用、改用 pwsh（`R/packages/bundle/base/cordis.patch.yml:249-257`）。〔推断〕verify 块需按平台选 shell，或声明仅 POSIX。

## 判据提案（伪规则）

```
id=completion.verify-rerun point=completion version=0.1
matches: team_task_update && action==='complete' && rootOf(agent).id==workspaceRoot
       | present && workspace 无 team
source: team → agentTeams.getTask(agent, task_id).description
        solo → 该工作区最近一次 dispatch 的 acceptance（建议落事件）
parse: 仅取 ```verify 块的非空行；无块/空块→unmeasured
cwd: session.header.cwd；不存在→unmeasured
for cmd: shell.execute(resolve({cmd, workdir:cwd, timeoutMs:min(60s,cap), signal:exec.signal, sandboxPolicy:resolve({session})}))
  spawn 失败 | timedOut | aborted | exitCode 非整数 → unmeasured
  任一 exitCode != 0 → deny（点名命令+退出码）
allow + evidence.rerun
```

## fixture 清单建议

红（应拦）：① team complete，description 无 verify 块 → unmeasured/deny；② verify 为 `exit 1`，成员自报通过 → deny 且理由含命令与退出码；③ solo present，acceptance 无 verify 块 → unmeasured/deny；④ verify `sleep 120`，预算 60s → timedOut/unmeasured；⑤ 工作区 cwd 被删 → unmeasured；⑥ `ctx.shell` 未注入或 spawn 失败 → unmeasured。
绿（应放）：① verify `exit 0` → allow 且 evidence 有 exitCode=0；② 两条命令均 0 → allow；③ present + acceptance `true` → allow；④ `team_task_update(claim/edit)` → matches=false，不判；⑤ 普通 `bash` 调用 → 不判；⑥ 成员自报失败但独立重跑为 0 → allow（不采信自报）。
变异：删掉「verify 块必需」或「exitCode 比对」，对应红 ①/② 必须变绿并让用例失败。

## 未决问题（需队长裁决）

1. solo 的完成声明：只拦 `present` 够不够？是否必须新增一个「工作区完成」工具并由预设强制调用（否则文本收尾绕过硬闸）？
2. 是否覆盖 teammate 的 complete（改 `rootOf` 口径）？若只覆盖根会话，team 路径的闸形同虚设。
3. acceptance 是否改为结构化落库（改 `src/dispatch.ts` 的 payload/参数）？`MAX_ACCEPTANCE_LENGTH=1000` 是否够放 verify 块？
4. 超时预算、Windows/pwsh 的 verify 语法、以及「同一任务 revision 只重跑一次」的幂等策略。
5. 桌面端 `process.cwd()` 可能不是工作区：统一以 `session.header.cwd` 为准，是否所有执行路径都改为显式传 session policy？
## 队长裁定（2026-11-23）
1. 完成声明：工作区完成只认两条路——`team_task_update(complete)` 与插件新增的工作区工具 `workspace_report_done`（只注入工作区会话树）。纯文本收尾不算完成，秘书查状态时显示「未验收」；不用 steer。
2. 管辖面：按 `subagents.rootOf` 覆盖整个工作区会话树（已追加给卡 3.0）。
3. acceptance 结构化：约定 ```verify 代码块；dispatch 事件 payload 落 acceptance 原文与解析出的 verify 命令；缺块/空块 → unmeasured。1000 字上限暂不变。
4. 重跑：pre-execute 内用 ctx.shell 有界执行，默认 120s、上限 600s，cwd=工作区会话 cwd，沿用会话沙箱策略；同一 (taskId|dispatchId, revision, 命令哈希) 已有 allow 判定则复用，不重复跑。Windows/pwsh 后置（首期单用户 macOS）。
