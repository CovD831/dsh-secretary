---
id: verify.diff-review
version: 1
kind: gate
point: verify.diff-review
trust: public
cases: cases/
stage: observe
enforce: false
placement:
  timing: pre
  enforce: true
actionClass: block
requires: [workflowRiskTier, codeChangedPaths]
params:
  max_review_rounds:
    type: number
    default: 2
    min: 1
    max: 10
  block_severities:
    type: string
    default: "critical,high"
---

## 意图
为高风险或跨模块代码改动建立宿主发起的独立对抗 diff 复核门：在确定性验证（路径/命令契约/测试重跑）全部通过后运行，专门捕捉“测试没测到但逻辑已坏或引入安全越界”的问题，同时防幻觉误拦与无限重审刷烧。

## 判据
1. `workflowRiskTier === 'fast'` 或 `codeChangedPaths` 为空时直接 `allow`（零 LLM 开销）；
2. 已获老板针对当前 `revision` 的人工豁免（`waived: true`）时直接 `allow`；
3. 若连续拒绝轮次 `rejectedRounds >= max_review_rounds`，直接 `deny` 并提示升级老板裁决，禁止自动放行绕过；
4. 仅当复核意见同时满足：命中 `block_severities`（默认 `critical,high`）、`file` 命中本工单真实改动文件集合、`issue` 与 `evidence` 均非空时才返回 `deny`；`medium/low` 或无文件锚点的幻觉挑刺自动降级为告警并放行；
5. 复核服务不可用/超时/解析失败严格返回对应 `unmeasured`（不洗白为 `allow`）。

## 正反例
见 `cases/cases.json`：覆盖 `fast` 跳过、有实质锚点 `high` 漏洞拦截、`medium`/未改动文件过滤放行、达最大轮次阻断升级、老板豁免放行及三态 `unmeasured` 用例。

## 例外
普通 `fast` 工单及纯文档/无业务代码改动的工单自动豁免；对顽固分歧可经老板审批豁免当前精确 `revision`。

## 修复指引
按独立复核指出的真实文件与问题证据修复代码缺陷后重交验收；若连续达轮次上限，请调 `orchestrator_report(state='blocked')` 等待老板裁决或人工豁免。
