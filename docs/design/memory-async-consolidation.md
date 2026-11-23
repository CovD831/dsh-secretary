# 异步记忆整理：调研与第一阶段预留

> 2026-11-22；范围：机制调研，不是一期功能提案。外部资料均于当日读取；未安装运行相关系统。下文的「事实」指来源明载，「推断」是本文判断。

## 1. 资料摘要

### Anthropic：The components of agent memory

链接：https://www.anthropic.com/engineering/components-of-agent-memory （发布：**2026-11-06**）。

- 组件由下至上：可搜索的 **transcripts 事件日志**、Claude 写的 memory notes、wiki 等 memory representations、每次会话加载的小块 injected context。compaction 不算跨会话记忆。
- Dreaming 是借用 sleep-time compute：「use idle time between interactions to reorganize their existing context」，回看日志纠错，生成笔记或表示，再维护链接、索引及注入层。
- 何时触发：只明确「交互间空闲」；文章也把「何时创建记忆」列为开放问题，**没有固定 cron/自动触发规范**。示例是显式在记忆目录运行 dreaming，以及建 wiki 后再跑一轮。
- 防写坏：用原 transcript 当 ground truth 校验笔记；第二轮修断链/缺索引；小注入层降低错误扩散；按文档拆页避免并发覆盖；维护/剪枝防 wiki 比原始语料还大。文章未描述写前审批、不可变日志或自动回滚。
- 有收益但不是普遍收益：跨文档综合的 wiki+搜索在其内部实验优于纯搜索；单文档可直接检索的问题收益不明显。不要把文章实验分数外推为我们的产品收益。

### EverOS：确认是 EverMind-AI/EverOS

链接：[仓库](https://github.com/EverMind-AI/EverOS)、[Reflection 官方文档](https://github.com/EverMind-AI/EverOS/blob/main/docs/reflection.md)（读取版本 blob `f780f64`）。仓库创建 **2025-10-28**；Reflection 文档可查首次提交 **2026-06-24**、最新提交 **2026-11-04**，不是统一“发布日期”。官网标注 **2026-11-20** 页面发布时间。

- 当前项目名是 **EverOS**，归属 EverMind-AI；不是另找一个同名 EverMemOS。用户侧 episodes/profile、agent 侧 cases/skills 分开；Markdown 是真相，SQLite 保存聚类/审计等结构状态，向量/BM25 是可重建索引。
- Reflection 默认关闭；开启后默认每周一 02:00，最多处理 10 个 cluster。线上持续把会话抽成 Episode、按语义和时间邻近聚类；离线走 **Select → Merge → Re-extract → Deprecate**。
- 输入是同簇、按时间排列的 Episodes；产出一条按时间组织的合并叙事，重抽原子事实，再以 `deprecated_by` 软归档原 Episode/事实并写审计。事实重抽失败则旧条目不归档，避免换成无事实支撑的叙事。
- 防护边界：原文留 Markdown、索引可重建、失败保留旧版、审计可查；但官方也明确合并有损、相似聚类可能混题、**尚无一键回滚**。它建议每周至多一次，因为反复有损合并可能更差。
- **未找到依据**：当前 README、官网、Reflection 文档都没有海马体—新皮层快慢双存储、脑科学式睡眠分期或独立遗忘/衰减函数。`deprecated_by` 是被取代后的软归档，不应冒充衰减机制。

### 对照：Letta sleep-time compute

链接：https://www.letta.com/blog/sleep-time-compute （发布：**2025-04-21**）。
空闲或按配置频率运行 sleep-time agent，把原始对话/代码库/文档变成 learned context；主 agent 没有编辑 core memory 的工具，睡眠 agent 异步维护主 agent 的记忆，主 agent 可随时读取。它解决前台记忆操作抢任务与上下文散乱；博客未说明逐条出处、写前校验、冲突人裁或回滚，且频率越高 token 越多。

### 对照：Cindy nightly（我方已读资料，不重复展开）

本地设计包 `memory-personal-agents.md` §5 所引第三方源码审计：夜间读新增主人消息，创建候选须 quote 在所引消息中逐字命中；CAS 防覆盖、before/after 快照可 undo。其 update/delete 没有同等证据门，且物理删除无 tombstone，是应避开的反例。该项证据为二手源码审计，本次未复核源码、未找到公开发布日期。

## 2. 共性模型与做法对比

共同骨架不是“睡觉时总结全文”，而是**原文采集 → 分批/分簇巩固 → 形成离散抽象 → 降低旧材料的默认可见性 → 校验或裁决冲突**。后三步可以合并，但原始证据不能因此被替换。

| 步骤 | Anthropic | EverOS Reflection | Letta | 我方提案 |
|---|---|---|---|---|
| 采集 | transcript + notes/wiki | 会话→Episode→cluster | 原始对话/文档/代码 | M0 原文，记忆提议带 `source_ref` |
| 巩固 | 空闲时显式/离线运行 | 周 cron，选有 ≥2 成员的簇 | 空闲或配置频率 | 闲时/夜间；提议制，非另一写者 |
| 抽象 | 笔记、wiki、索引、注入层 | 合并叙事 + 重抽事实 | learned/core context | M1–M3 patch，M4 只产候选 |
| 遗忘/衰减 | 维护剪枝；未给自动函数 | `deprecated_by` 软归档 | 整理 core memory；未给衰减函数 | tombstone、时效、派生复核；非时间到即忘 |
| 冲突裁决 | 回 transcript 校验 | 同簇取最新状态 | 博客未述 | 用户直述优先；同级冲突进 M6 待裁 |
| 防写坏 | 原文核对、二次整理、小注入层 | 重抽成功才归档、留原文/审计 | 主/睡眠工具分工 | 唯一写入者、证据门、失败保旧、git |

## 3. 与我方设计对照

**已有，不需另起架构：**
- 原文与分层：`memory-architecture-proposal.md` §1（M0–M6）；PRD §2.1 的事件日志即 M0 雏形。
- 出生证、冲突与取代：提案 §2.1–2.2（`source_ref`、时效、tombstone、取代链、同级冲突人裁）。
- 写边界：提案 §3.1–3.4，尤其 §3.4 已明确巩固器是异步**提议者**，低风险与语义产出分级；§8 已列巩固器规格、遗忘演练、金标。
- 证据与评估：提案 §4 的快照回放、人裁金标、抽检回源；`01-ORIGIN-AND-EVOLUTION.md` §4.8 已把假记忆容忍度定为零，并立三项真实感指标。

**新增或需收紧：**
- 一期若只存 `source_ref` 还不够：必须能回放到**当时事件原文**；后续巩固须有幂等游标与所读版本，不能只读“最新记忆”。
- 巩固的最小输出应是**可拒的逐条 patch + 证据 + 预期版本**，而非 wiki/整页重写；索引、wiki、画像、技能自演化都不是一期前置条件。
- EverOS 的“重抽成功才替换”“每周上限”是可借的防损措施；Cindy 的逐字 quote 是便宜准入校验，但引用真实存在不等于结论为真。

**硬约束下的不兼容/改造：**
- 单写者：Letta 的睡眠 agent 直改主记忆、Anthropic 的 dreaming 直接维护目录，均须改为向唯一写入者 `propose_patch`；后台不是第二写者。
- 只有两类真相：不新增“梦日记/巩固库”作第三类真相。游标、提议、驳回状态放既有日志族；记忆页只存接受后的事实。
- 出处必带：拒绝无证据 wiki、整段无来源画像；`deprecated_by` 不能代替完整取代理由与来源。
- 假记忆零容忍：EverOS“同簇冲突取最新”不得用于同级来源；时间新不等于权限高或更可信。冲突不能由 LLM 静默抹平。
- 派生态不回写：聚类/审计 SQLite 若只作派生，可重建但不能反向改 canonical；一期不上这些索引。

## 4. 建议（以下除特别注明均为推断）

### 一期：要预留，但不运行做梦

一期 PRD §2.1 的「Markdown 实体页 + git、唯一写入者、只记纠正/偏好/否决、带出处、新会话注入」**保留，不增加异步 worker、定时器、embedding、wiki、聚类或自动遗忘**。只预留四件最小事项：

1. **数据结构**：记忆条目至少含稳定 `id`、`source_ref[]`、状态（active/superseded/tombstoned）、`supersedes/invalidated_by`；写入校验 `expected_revision`。一期只有用户直接纠正/偏好/否决，不开放 inference 入长期层。
2. **事件**：在既有 M0 追加 `memory.proposed/accepted/rejected`（proposal id、记忆 id、source refs、base revision、结果/理由）；已有说话/人裁事件可复用，不为做梦新建事件总线。
3. **游标**：M0 追加事件天然有 id/序号；后续巩固按 `[after_event, through_event]` 读取，避免重复处理。若 v0 无稳定序号，只补这一项，不建第二游标库。
4. **接口**：内部沿用唯一入口 `propose_patch(proposal)`；proposal 含 `operation/id/source_refs/base_revision`。前台与以后 consolidator 共用，不在一期实现调度器或公开 API。

不建议一期额外存 embedding、重要度、访问频率、衰减分、dream 状态机：当前需求可由原文和明确否决覆盖，且这些字段没有已证明收益。

### 后续放置与最小形态

- 放在**一期阶段 5 一周真实狗粮之后**；先数清重复条目、过期注入、假回忆和重复提问，再由真实摩擦决定是否立项。M2–M6 与派生索引仍各自按 PRD 解禁，不捆绑交付。
- 最小实验：离线只读一批冻结 M0 + 记忆 git 快照；仅对重复的同义偏好提合并 patch，或根据已有用户新直述提旧条目 tombstone；全部逐条人批，初期零自动语义写入。
- 安全线：原文不删；每条 patch 必须回源且 CAS；同级冲突只提议待裁；失败不换旧版；整批可重放/拒绝；批频率与数量设上限，防“整理的整理”。

### 如何证明有收敛收益

- 采用同一冻结事件段与记忆快照做**无巩固 vs 有巩固**回放；随后真实使用影子/A-B，训练样本与留出样本分开，至少覆盖改口、否决、冲突、无材料四类。
- 硬门槛：假回忆事件数不增加（目标为 0）、接受的 patch 100% 可回源、tombstone 不复活、冲突不被自动选边、可随时撤销该批变更。
- 收益指标：重复提问率、被纠正记忆条数/周、注入 token/有效事实、重复/陈旧条目数；同时记人工审阅分钟、模型 token/费用。预先约定样本窗与“收益不抵成本即撤”的阈值，避免只看主观“更聪明”。
- **推断**：若一期三类记忆仍很少，人工审查或简单确定性去重可能已够；异步 LLM 巩固应靠上述对照赢得存在，而不是因为行业都有 Dreaming。
