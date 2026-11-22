# 事件日志 Schema v0

> 日期：2026-11-22。依据：PRD_phase1-mvp §2.1 / §5、02-DSH-EXTENSION-MAP-rc5、dsh-plugin-dev SKILL。
> 源码口径：deepseek-harness tag dsh-v0.2.2-rc.5（本机 /tmp/dsh-ref/deepseek-harness），下文 `R/` 指该 checkout 根目录。
> 本文只覆盖第一阶段用到的 kind。`newpoint-event-spine.md` 是设计储备，其中 per-stream seq、水位线、对账协议、分级保留、resume 句柄登记等一律不进 v0。

## 1. 定位与硬约束

- 事件日志是**跨会话 occurrence truth**，与 DSH 各 session log 同属「日志族」；系统仍只有两类真相：注册表管定义，日志管发生过什么。
- 追加式 JSONL，单写者；已落事件不改不删，更正靠新事件引用旧事件 id。
- 前端和所有读数只从日志投影，永不回写；派生态可整表删除后从日志重建（PRD §5 验证行）。
- payload 禁入凭据与秘密；大原文（diff 全文、prompt 全文、消息全文）不进日志，只留摘要或指针。指向会话内事件用 `(sessionId, seq)` 二元组，不复制其内容。

## 2. 统一信封

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | string | 是 | schema 版本，v0 固定 `"0"`；破坏性变更才升版 |
| `id` | string | 是 | 事件唯一 id，见 §2.1 |
| `ts` | string | 是 | RFC 3339 墙钟时间，只用于展示与粗排序，不作因果依据 |
| `kind` | string | 是 | 事件种类，见 §3 目录 |
| `sessionId` | string | 是 | 主体会话；跨会话事件（dispatch）写发起方（秘书）会话 id |
| `workspaceId` | string \| null | 是 | 所属工作区；秘书会话等无工作区归属的事件写 `null`。第一阶段只有一个工作区 |
| `source` | string | 是 | `"dsh"`（原生事件归一化）或 `"plugin"`（gate、秘书工具、派发、老板裁决） |
| `causedBy` | string \| null | 是 | 上游事件 id，用于回溯因果链；无上游写 `null`。因果只走此字段，不走 ts |
| `payload` | object | 是 | 按 kind 的字段表，见 §3 |

### 2.1 id 生成与幂等

- `source: "dsh"`：id = `"dsh:" + sessionId + ":" + seq`。`seq` 在同一会话内单调连续（R/packages/core/session/src/types.ts:506-513），故该 id 天然唯一。归一化器重跑、重启补扫时按 id 去重，重复事件直接丢弃，不重复落盘。
- `source: "plugin"`：id = `"plugin:" + uuid`（`crypto.randomUUID()`）。**先分配 id、再执行副作用、落盘成功后才算生效**；重试同一动作复用同一 id，写者按 id 去重。派发另有业务幂等键 `dispatchKey`（§3.10），两者分工：id 防日志重复，dispatchKey 防重复投递。
- 日志为 at-least-once 语义，消费者一律按幂等设计；不承诺 exactly-once。

## 3. kind 目录与 payload

原生字段的源码出处在各表「来源」行；归一化只取第一阶段所需字段，未列出的原生字段不复制。

### 3.1 `dsh.session` — 会话事件归一化

来源：Cordis `session/event(session, event)`（R/packages/core/session/src/index.ts:79），事件本体 `{type, seq, time, data, ignorable?}`（types.ts:506-528）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | number | 原事件会话内序号 |
| `sessionType` | string | 原事件 `type`，如 `turn/start`、`turn/end`、`user/message`、`assistant/message`、`tool/call`、`tool/result` 等（全集 types.ts:287-436） |
| `summary` | string \| null | 一句话摘要（如 tool/call 的工具名）；原文不进日志 |
| `dataRef` | object \| null | 需要回看原文时的指针 `{sessionId, seq}` |

v0 只归一化 turn 边界与消息/工具事件；`assistant/attempt`、`request/*`、`session/end-seed` 等内部事件不落本日志（留在 DSH session log）。

```json
{"v":"0","id":"dsh:s-ws1:42","ts":"2026-11-22T10:00:01Z","kind":"dsh.session","sessionId":"s-ws1","workspaceId":"ws1","source":"dsh","causedBy":null,"payload":{"seq":42,"sessionType":"turn/end","summary":"turn 1 结束: completed","dataRef":null}}
```

### 3.2 `dsh.tool` — 工具执行结果

来源：Cordis `tools/result(exec, result)`（R/packages/core/tools/src/events.ts:49）。`exec` 含 `callId/rootCallId/name/arguments/agent`（contracts.ts:175-225）；`result` 为 `{isError, content, error?, meta?, additionalContexts?, concludesTurn?}`，**`value` 只在内存、不进持久事件**（contracts.ts:339-364）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `callId` | string | exec.callId，与同会话 `tool/call` 配对 |
| `name` | string | 工具名 |
| `isError` | boolean | result.isError |
| `error` | object \| null | 失败时 `{name, code, reason?}`（contracts.ts:271-276），成功为 null |
| `diffPaths` | string[] | 从 `result.meta.diffs[].path` 提取的路径清单（见下） |
| `unmeasured` | boolean | 出现 shell 写入或 `str_replace_editor` 时置 true：bash/pwsh 写文件无 diffs（02 号地图 §1 dispatch 行）；`str_replace_editor` 无 `presentationMeta`（R/packages/fs/tool-str-replace-editor/src/index.ts:473-476 只有 schema+render，对比 tool-fs/src/write.ts:103-110），故其变更不可测 |

`meta.diffs` 形态为 `{path, oldText, newText}[]`（R/packages/fs/tool-fs/src/diff.ts:22），由 `presentationMeta` 投影进 result.meta（R/packages/core/tools/src/pipeline.ts:558-565）。**日志只存 diffPaths，不存 diff 全文**；diffs 为空数组不等于无修改，以 unmeasured 判定为准。

```json
{"v":"0","id":"plugin:7c9e…","ts":"2026-11-22T10:00:02Z","kind":"dsh.tool","sessionId":"s-ws1","workspaceId":"ws1","source":"dsh","causedBy":"dsh:s-ws1:41","payload":{"callId":"call-01","name":"write","isError":false,"error":null,"diffPaths":["/repo/a.ts"],"unmeasured":false}}
```

### 3.3 `dsh.team-task` — team 任务板变更

来源：会话事件 `team/task`，data = `{version: 2, teamId, task}`（R/packages/team/agent-team/src/types.ts:181），追加于 journal（src/journal.ts:63），仅存在于 Lead 会话。

| 字段 | 类型 | 说明 |
|---|---|---|
| `teamId` | string | 团队 id（=根会话 id） |
| `taskId` | string | task.id |
| `revision` | number | task.revision，每次变更递增，CAS 依据 |
| `subject` | string | task.subject |
| `status` | string | `pending/in_progress/completed/deleted`（types.ts:61） |
| `ownerId` | string \| null | task.ownerId |
| `ownerName` | string \| null | task.ownerName |
| `blockedBy` | string[] | task.blockedBy |
| `seq` | number | 原事件 seq，用于定位 |

task 快照其余字段（description/writeScopes）不复制，需要时按 seq 回查（types.ts:64-75）。

```json
{"v":"0","id":"dsh:s-ws1:57","ts":"2026-11-22T10:01:00Z","kind":"dsh.team-task","sessionId":"s-ws1","workspaceId":"ws1","source":"dsh","causedBy":null,"payload":{"teamId":"s-ws1","taskId":"t-3","revision":2,"subject":"修复登录回归","status":"in_progress","ownerId":"s-child-1","ownerName":"worker-1","blockedBy":[],"seq":57}}
```

### 3.4 `dsh.agent-status` — agent 状态翻转

来源：Cordis `agent/status({agent, status})`（R/packages/core/agent/src/runtime-types.ts:310），`status` 仅 `idle | running`（runtime-types.ts:136）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `agentId` | string | agent.id（即会话 id） |
| `status` | string | `idle` 或 `running`，为迁移后的目标状态 |

注意：「卡住 / 待裁」不是原生状态，由投影层合成（§5）。

```json
{"v":"0","id":"plugin:2a1f…","ts":"2026-11-22T10:01:05Z","kind":"dsh.agent-status","sessionId":"s-child-1","workspaceId":"ws1","source":"dsh","causedBy":null,"payload":{"agentId":"s-child-1","status":"idle"}}
```

### 3.5 `dsh.subagent-start` / 3.6 `dsh.subagent-end` — 子 agent 生灭

来源：Cordis `subagent/start(info)`（R/packages/subagent/subagent/src/index.ts:158）与 `subagent/end(info)`（index.ts:166）。`SubagentRunInfo = {runId, provider, parentSessionId, id, local}`（types.ts:95-109）；end 另带 `stopReason` 与可选 `lastAssistantMessage`（types.ts:115-124）。stopReason 已知值：`completed/aborted/error/max-tokens/refusal`，后端可扩展（types.ts:241-255）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` | string | 同一次驻留的 start/end 配对键 |
| `childSessionId` | string | info.id，子 agent 会话 id |
| `parentSessionId` | string | info.parentSessionId，直接创建者 |
| `provider` | string | info.provider，如 `inproc` |
| `local` | boolean | info.local |
| `stopReason` | string | 仅 end：终止原因 |
| `summary` | string \| null | 仅 end：lastAssistantMessage 的一句话摘要，原文不进日志 |

start 无 stopReason/summary 字段（payload 中省略）。人员进出房间的投影只认这两个事件。

```json
{"v":"0","id":"plugin:9b3c…","ts":"2026-11-22T10:02:00Z","kind":"dsh.subagent-start","sessionId":"s-child-2","workspaceId":"ws1","source":"dsh","causedBy":null,"payload":{"runId":"run-7","childSessionId":"s-child-2","parentSessionId":"s-ws1","provider":"inproc","local":true}}
{"v":"0","id":"plugin:9b3d…","ts":"2026-11-22T10:09:00Z","kind":"dsh.subagent-end","sessionId":"s-child-2","workspaceId":"ws1","source":"dsh","causedBy":"plugin:9b3c…","payload":{"runId":"run-7","childSessionId":"s-child-2","parentSessionId":"s-ws1","provider":"inproc","local":true,"stopReason":"completed","summary":"已完成修复并通过验证"}}
```

### 3.7 `dsh.approval` — 权限审批（待裁队列第三类来源）

来源：插件挂 `approval/request` waterfall（R/packages/interaction/user-approval/src/types.ts:87-91），req = `{agent, toolName, callId?, reason?, displayReason?, signal?}`（types.ts:63-76）；outcome 闭集 `allowed-once/rejected/cancelled/unavailable`（types.ts:32）。宿主另在会话内写 `approval/asked`/`approval/decided` 审计对，以 `id: ApprovalRequestId` 配对（types.ts:44-58；index.ts:251-259）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `phase` | string | `pending`（收到请求、挂起 resolver）或 `answered`（已应答） |
| `toolName` | string | req.toolName |
| `callId` | string \| null | req.callId |
| `reason` | string \| null | req.reason |
| `outcome` | string \| null | 仅 answered：上述四值之一 |
| `approvalId` | string \| null | 宿主审计 id（approval/asked 的 id），用于回查；**待核**：waterfall req 不携带该 id，需经会话事件流按 `(sessionId, callId)` 就近配对，实测确认 |

应答语义对齐 spike-02 实测样例（spike-02/approval-queue.jsonl 的 pending/answered 两行结构）。pending 事件落盘后待裁队列即显示此件；answered 后由 resolver 放行/拒绝原调用。

```json
{"v":"0","id":"plugin:aa01…","ts":"2026-11-22T10:03:00Z","kind":"dsh.approval","sessionId":"s-ws1","workspaceId":"ws1","source":"plugin","causedBy":null,"payload":{"phase":"pending","toolName":"bash","callId":"call-09","reason":"需要执行 npm test","outcome":null,"approvalId":null}}
```

### 3.8 `gate.verdict` — 判局层判定

来源：插件 `tools/pre-execute`（prepend）与 `tools.guard()` 同步兜底（R/packages/core/tools/src/events.ts:18；contracts.ts:375-379 的 deny 形态）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `gateId` | string | 注册表条目 id，如 `completion.verify-rerun` |
| `gateVersion` | string | 注册表条目版本；只引 id+版本，不内嵌判据定义 |
| `verdict` | string | `allow / deny / unmeasured`。unmeasured = 没测到，绝不冒充 ok（PRD §6） |
| `reason` | string | 判定理由；deny 时必须写明修法（会以 `Error: <reason>` 回模型，02 号地图 §1） |
| `toolName` | string | 被拦截的工具名 |
| `callId` | string \| null | 对应工具调用 id |
| `phase` | string | 插入点：`admission/contract/dispatch/completion/delivery/runtime` 之一 |
| `evidence` | object \| null | 证据指针，如 `{sessionId, seq}` 或 diff 哈希；deny/unmeasured 必填 |

```json
{"v":"0","id":"plugin:g001…","ts":"2026-11-22T10:04:00Z","kind":"gate.verdict","sessionId":"s-ws1","workspaceId":"ws1","source":"plugin","causedBy":"dsh:s-ws1:60","payload":{"gateId":"dispatch.changed-paths","gateVersion":"0.1","verdict":"unmeasured","reason":"会话中出现 shell 写入，变更面不可测，不放行","toolName":"team_task_update","callId":"call-12","phase":"dispatch","evidence":{"sessionId":"s-ws1","seq":60}}}
```

### 3.9 秘书说话三类：`secretary.say` / `secretary.ask` / `secretary.handover`

来源：秘书三个结构化说话工具的 execute 内（插件工具，PRD §2.1）。秘书对老板的输出 100% 经此三类；自由文本只留在原生会话（L3），不进本日志。

| kind | 字段 | 说明 |
|---|---|---|
| `say` | `text`, `mood` | 一句话（约 40 字内，超限工具拒绝）+ 表情标签（供确定性映射表） |
| `ask` | `text`, `options`, `allowNote` | 问题一句话；options ≤3 项，每项 `{id, label, consequence, recommended: boolean}`；allowNote 标识附言 UI 形态（附言永远可用） |
| `handover` | `title`, `conclusion`, `rationale`, `impact`, `evidenceRefs` | 递文件三段（结论/理由/影响）+ 证据链接（事件 id 或会话指针） |

ask 进入待裁队列；handover 进入文件浮层。

```json
{"v":"0","id":"plugin:say1…","ts":"2026-11-22T10:05:00Z","kind":"secretary.say","sessionId":"s-secretary","workspaceId":null,"source":"plugin","causedBy":null,"payload":{"text":"工作区在跑验证，预计还要两分钟。","mood":"working"}}
{"v":"0","id":"plugin:ask1…","ts":"2026-11-22T10:06:00Z","kind":"secretary.ask","sessionId":"s-secretary","workspaceId":"ws1","source":"plugin","causedBy":"plugin:g001…","payload":{"text":"这次变更面测不准，要继续吗？","options":[{"id":"retry","label":"让工作区改用可测的编辑工具重做","consequence":"多花一轮，但 gate 能放行","recommended":true},{"id":"accept","label":"我人工看过，放行","consequence":"绕过 changed-paths，记入台账","recommended":false}],"allowNote":true}}
{"v":"0","id":"plugin:hd01…","ts":"2026-11-22T10:07:00Z","kind":"secretary.handover","sessionId":"s-secretary","workspaceId":"ws1","source":"plugin","causedBy":null,"payload":{"title":"登录回归修复交付","conclusion":"已修复，验证命令独立重跑通过。","rationale":"根因是会话过期未刷新 token。","impact":"改动 2 个文件，无 schema 变更。","evidenceRefs":["dsh:s-ws1:71"]}}
```

### 3.10 `boss.decision` — 老板裁决

来源：老板在对话框对某个 ask（secretary.ask 或 dsh.approval）作出选择，插件记录。causedBy 指向被裁决的 ask/approval 事件 id。

| 字段 | 类型 | 说明 |
|---|---|---|
| `targetKind` | string | `secretary.ask` 或 `dsh.approval` |
| `choiceId` | string \| null | 选中的选项 id；纯附言时为 null |
| `note` | string \| null | 附言原文（老板的纠正/偏好/否决是记忆阶段的输入） |
| `approvalOutcome` | string \| null | 仅裁决 dsh.approval 时：映射后的 outcome（allowed-once/rejected） |

```json
{"v":"0","id":"plugin:bd01…","ts":"2026-11-22T10:08:00Z","kind":"boss.decision","sessionId":"s-secretary","workspaceId":"ws1","source":"plugin","causedBy":"plugin:ask1…","payload":{"targetKind":"secretary.ask","choiceId":"retry","note":"以后遇到这种情况先重做，不用问我。","approvalOutcome":null}}
```

### 3.11 `dispatch` — 秘书 → 工作区投递

来源：秘书派发工具，经 `ctx.sessionController.create({cwd, agentPreset})` + `prompt({requestId, sessionId, mode, content})`（R/packages/api/session-controller/src/types.ts:269-276；SKILL §3）。**先落本事件（phase=prepared）、再投递、回执后补 phase=accepted**，与「先落库再投递」纪律一致。

| 字段 | 类型 | 说明 |
|---|---|---|
| `dispatchKey` | string | 业务幂等键；同 key 重投不重复派发，直接返回首次结果 |
| `phase` | string | `prepared`（落盘待投）/ `accepted`（prompt 回执入队）/ `failed`（投递失败，更正事件） |
| `targetSessionId` | string | 工作区根会话 id |
| `requestId` | string \| null | prompt 的 requestId（SessionRequestId），accepted 时必填 |
| `summary` | string | 任务一句话摘要，prompt 全文不进日志 |

注意：accepted 仅表示入队，不表示模型完成（SKILL §3 实测注记）。v0 不设 outcome=unknown 状态，投递结果不确定时如实记 failed 并附原因，由秘书查状态收敛。

```json
{"v":"0","id":"plugin:dp01…","ts":"2026-11-22T10:00:00Z","kind":"dispatch","sessionId":"s-secretary","workspaceId":"ws1","source":"plugin","causedBy":"plugin:bd00…","payload":{"dispatchKey":"dk-2026-001","phase":"accepted","targetSessionId":"s-ws1","requestId":"req-88","summary":"修复登录回归并独立重跑验证"}}
```

## 4. 落盘

- 位置：`$DSH_HOME/plugins/dsh-secretary/event-log/events.jsonl`，每行一个完整信封 JSON，UTF-8，`\n` 结尾。
- 轮转（v0 从简）：单文件超过 32 MiB 时轮转为 `events-<UTC 日期>-<序号>.jsonl`，新事件写新的 `events.jsonl`；投影重建时按文件名序读完所有分片。不做压缩、不做冷存、不做分级保留。
- **单写者**：只有插件内的 log writer 模块触碰文件。所有来源（原生事件归一化器、gate、秘书工具、裁决回调）把信封交给 writer，writer 串行追加、按 id 去重，`append` 落盘后才返回 ack。进程级锁即可，v0 不考虑多进程。
- 写入失败：**不得静默丢**。① 动作类事件（派发、gate deny、approval 应答）落盘失败则该动作视为未发生：不投递、不放行、不应答，错误返回调用方；② 观察类事件（dsh.* 归一化）写入失败记入内存 outbox 并重试，同时在秘书界面明示「事件日志写入失败，读数可能不完整」，恢复后按 id 幂等补写；③ outbox 积压超 1000 条时停止接受新动作，先修日志。

## 5. 投影约束与「从日志重建」

前端和一切读数只从日志投影；投影可整表删除重建；投影永不回写（PRD §5/§6）。重建算法（按分片顺序全量回放，幂等，乱序事件按 `(sessionId, seq)` 或 causedBy 链归位）：

- **房间状态**：`dsh.subagent-start/end` 决定工位人员进出；每个 agent 最新一条 `dsh.agent-status` 给出 idle/running 底态。四态合成规则：有待裁件（见下）且属于该会话 → **待裁**；最新 `gate.verdict` 为 deny/unmeasured 且其后无新 turn → **卡住**；`dsh.team-task` 该 owner 全部 completed 且 agent idle → **完成**；否则 running/idle 映射 **工作中/空闲**。合成态是投影产物，不落日志。
- **待裁队列**：收集三类未决件——`secretary.ask` 无对应 `boss.decision`（causedBy 匹配）；`dsh.approval` phase=pending 无对应 answered；同一 gate 连续 deny 达 N 次的升级件（由 gate.verdict 序列算出）。被 `boss.decision` 或 answered 事件关闭的件出队。队列一次只呈现一件，排序按落盘顺序。
- **秘书工作台**：最新 `secretary.say` 是对话框当前句；`secretary.handover` 列表是文件浮层；`dispatch` 的 prepared/accepted/failed 序列给出每次派发的当前状态。
- 重建验证（PRD §5）：删掉全部派生状态后重放日志，房间、队列、对话框必须与删除前一致；这是阶段 1 的验收题。

## 6. v0 不做什么

- 不做 per-stream seq、全局序号、snapshot 水位线、`events_lost` 对账协议；不做 resume 句柄登记、outcome=unknown 回执语义、跨工作区分片（均为事件脊储备，用到再取）。
- 不做分级保留、compaction、冷存归档；只做 32 MiB 简单轮转。
- 不复制会话内原文（消息全文、diff 全文、prompt 全文）；一律指针回查 DSH session log。
- 不收 `assistant/attempt`、`request/*`、jobs、schedule、成本、记忆写入等第一阶段之外的 kind。
- 不做 schema 注册中心与兼容性 CI；版本只有一个字段 `v`，破坏性变更整体升版。
- 不做多写者、多进程锁、远程写入接口。

## 7. 待核清单

1. `dsh.approval` 的 `approvalId`：`approval/request` waterfall 的 req 不含宿主审计 id（types.ts:63-76），需经会话事件 `approval/asked` 按 `(sessionId, callId)` 就近配对，待 spike 实测确认配对可靠性。
2. `dsh.session` 的 `summary` 生成规则：各 sessionType 的摘要取法（尤其 assistant/message 的截断长度）待实现时定，不进 schema 冻结面。
3. `dispatch` 的 `requestId` 在 prepared 阶段尚不存在（prompt 调用后才分配），accepted 以 causedBy 关联 prepared 的写法待 spike-02 复跑确认。
