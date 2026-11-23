# gate `dispatch.changed-paths` 判据提案

> 探索卡 3.a 产出，供评审。fixture 见 `fixtures/changed-paths/{red,green}/`。依据：旧仓 `src/gates/dispatch/changed-paths.ts`、`src/harness-compat.ts`、466 条 friction 台账。

## 1. 旧判据（12 行说清）

1. 只在 `kind ∈ {implementation, repair}` 且 `changedPaths` 为非空数组时开口；否则「跳过」，注册表在该位置报全跳过。
2. 声明面 = `changedPaths`，`normalizeWorkspacePath`：trim、`\`→`/`、去 `./` 与重复斜杠；绝对路径、`~`、盘符、含 `..` ⇒ 非法。
3. 非法声明路径逐条成 blocker，不静默丢弃 ⇒ 拒绝。
4. 观察面 A = 本成员会话 `tool/result.meta.diffs[].path` 并集（`observedChangedPaths`）。
5. A 为 `undefined`（读不到事件）⇒ 整条 `unmeasured`；A 为 `[]` ⇒ 当作「确实零写入」。
6. 观察面 B = `git status --porcelain` 脏路径并集：主工作区 + `.agent-teams/worktrees/*` 每棵可读树；剥 `--show-prefix`，剥前/剥后两种拼法都留。
7. B 为 `undefined` ⇒ 该面不参与判定（退回只看 A），**不**产生 `unmeasured`。
8. `fabricated` = 声明 ∉ A 且（B 缺席 或 声明 ∉ B）⇒ blocker。
9. `concealed` = A ∉ 声明 ⇒ blocker（漏报/隐瞒）。
10. 容差：**零**。无生成物清单、无目录通配、无大小写/Unicode 归一、无重命名语义、无归属校验；B 只到「某棵树里脏了」，注释自认不知道是谁改的。
11. 三态：`ok`（交回 A∪B）/ `blocked`（两类合并）/ `unmeasured`（仅 A 缺席）；B 缺席永不导致 `unmeasured`。
12. `appliesTo` 只看 kind 与声明，**不看 `update.status`**：任意一次带 `changedPaths` 的 `update_task` 都触发。没有 shell / `str_replace_editor` 概念。

**不合理**：① 触发点错位（第 12 行），57 条拦截全在 `claimed/in_progress`，`t63` 九分钟被拦三次——死锁不是把关；② 单面为空即判虚报（第 7、11 行），把「读不到」读成「没发生」；③ B 不回答归属（第 10 行），别人改脏能替伪造作证，成员 worktree 写入又常读不到，两边都错；④ 零容差（第 10 行），强制逐条申报 `lib/` 产物与 `.d.ts`，负担直接变成漏报；⑤ shell/`str_replace_editor` 盲区未建模（02 号地图 §1 明说无 diffs），实现里无一条路径因此 `unmeasured`；⑥ 26/57 条 `changedPaths` 与 `inScope` 逐字相同，判据分不清「真改动」与「抄写域」。

## 2. 新判据提案（纯数据变换，输入即 fixture 六字段）

**输入**：`declaredPaths`、`sessionDiffPaths`、`gitDirtyPaths`（三者 `string[] | null`，`null` = 未能观察，与 `[]` 不同形）、`sawShellWrite`、`sawUnmeasuredTool`。

**判定顺序**（首条命中即返回）：
1. `sawShellWrite || sawUnmeasuredTool` ⇒ `unmeasured`（写明是哪种工具，修法「改用可观测的编辑工具重做」）。优先于一切：会话写入历史不完整时，任何面都不能证明归属。
2. kind 不属于 `implementation|repair`，或 `declaredPaths === null` ⇒ 不开口（注册表 skip，不产 `unmeasured`，避免 review 类被噪音淹没）。
3. 声明含非法路径 ⇒ `deny`（附可审计修法）。
4. 声明为空数组且 `union(观测面) ≠ ∅` ⇒ `deny`（列未声明路径）。
5. `sessionDiffPaths === null` 且 `gitDirtyPaths === null` ⇒ `unmeasured`。
6. 任一声明路径在 `sessionDiffPaths ∪ gitDirtyPaths`（**过滤清单前**）中都没有 ⇒ `deny`（说清看了哪几个面）。
7. `union(观测面)` 去忽略清单后有任意一条不在声明 ⇒ `deny`（逐条列出）。
8. 其余 ⇒ `allow`，交回 `verifiedPaths = union(观测面) ∩ 声明面`。

**规范化**：trim → `\`→`/` → 折叠重复斜杠与 `.` 段 → 拒 `~`/盘符/绝对路径/任何 `..`（⇒ deny）→ 不做大小写折叠（POSIX）→ 不解析符号链接（原始拼法留在拒绝信息里）。git 面先剥 `--show-prefix`，两种拼法都参与比较（沿用旧实现）。目录形式（尾斜杠）不参与比较，声明目录 ⇒ 非法。

**容差（忽略清单，只作用于第 7 条「观测面多出」，不放宽第 6 条）**：

| 清单 | 理由 |
|---|---|
| `dist/ build/ out/ lib/`（若为编译产物目录） | 由构建从源派生，成员无法逐条手写申报；纳入比对只制造漏报 |
| `node_modules/`、`.pnpm-store/` | 依赖安装产物 |
| `*.tsbuildinfo`、`coverage/`、`.local/` | 构建/测试缓存与运行档案 |
| `.DS_Store`、`*.log` | 系统与进程噪音 |
| 项目在 `package.json` / gate 配置显式声明的 build-output 目录 | 同上，但必须可审计 |

不进清单：手写源文件、测试、文档、fixture、`package.json`、锁文件。反向保护：**声明了生成物也必须被观察到**（第 6 条不看清单），避免用清单洗白伪造。

**与旧的差异**：触发点收紧到完成态申报；缺一面不再单面定罪；新增 shell/不可测工具的 `unmeasured` 优先臂；新增可解释容差；拒绝理由必须写明看了几个面、每条缺在哪面、修法是什么。

## 3. 样本统计（466 条 friction，判断均为我的标注）

| 分类 | 条数 | 抽样判断 | 误拦率估计 |
|---|---|---|---|
| 提及 `changed-paths`（任意位置） | 279 | — | — |
| ├ 带 `dispatch.changed-paths` 字样 | 205 | — | — |
| │ ├ 本 gate 有裁决记录 | 177 | — | — |
| │ │ ├ **拦截（blocked）** | **57** | 抽 12 条：12 条在拦截后 ≤48h 出现真实提交（39 条 ≤30 分钟） | **90%（85–95%）** |
| │ │ │ ├ 旧版「两面都无」措辞 | 9 | 抽 6 条全为 worktree 误拦 | 90% |
| │ │ │ └ 新版「N 棵树都无」措辞 | 48 | 抽 6 条全为 worktree/换会话误拦 | 90% |
| │ │ ├ 漏报（concealed）/ 非法路径 | 0 / 0 | 无样本 | 无法判断 |
| │ │ └ `unmeasured` | 0 | 语料中本 gate 从未产出 | 无法判断 |
| │ └ 跳过（skipped） | 120 | 94 条是「全跳过→空理由拒绝」，另一缺陷 | 不适用 |
| ├ 有 gates 状态但本 gate 未入 ran | 25 | 其他判据拒绝 | 不适用 |
| └ 无 gates 状态 | 3 | — | 无法判断 |

**事实**：466 条里 0 次 `allow`、0 次 `unmeasured`、0 次 concealed、0 次非法路径；唯一产出是 57 次拦截，43 个任务，8 个重复被拦（`t18` 5 次、`t63` 3 次），全在 `claimed/in_progress`，无一在 `completed`。**判据在真实语料上恒红，且红得不分真假。**

**共同形状**：成员在 worktree 或另一会话真改了文件并如实申报；A 因换会话/并入而为空，B 因读队长树或 worktree 已回收而看不到；声明路径几分钟后被 captain 提交进主树——判据「工作区里也没有」当场是假话。

## 4. 未决问题

1. **归属怎么补**：dispatch 时给每棵树记 baseline（sha + 工作树哈希），completion 用 `git diff baseline..now` 作「本任务改动面」。能把 B 面从「不知道谁改的」变成「本任务之后变了什么」；baseline 成本与 worktree 回收窗口是否接受？
2. **忽略清单治理**：写死、`package.json`、还是 gate 配置？谁可改？改后要不要重跑 fixture？
3. **「声明生成物」**：第 6 条要求声明的构建产物也要被观察到，但产物常在提交前被 rebase 掉；需不需要单独容差臂？
4. **删除/重命名**：声明删除的路径，观察面怎么表示（git `D`/`R`、`meta.diffs.newText: null`）？当前未区分。
5. **无 git 仓库的工作区**（fixture、临时目录）：只剩会话面，是否一律 `unmeasured`？
6. **连续 deny N 次转待裁**（PRD §7）：N 与冷却时间未定；57 条里 8 个任务重复被拦，说明「理由写明修法」不够。
7. **规范化边界**：Unicode NFC/NFD、大小写不敏感文件系统（macOS 默认）下同名文件，是否再加一臂 fixture。
8. **空理由拒绝**：94 条 `update_task rejected: `（后空白）来自「全跳过」，与本 gate 无关但同一插入点；注册表层是否禁止「ok:false 且理由为空」。