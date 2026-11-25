---
id: intake.bug-quadruple
version: 1
kind: gate
point: intake.bug-quadruple
trust: public
cases: cases/
stage: observe
enforce: false
placement:
  timing: pre
  enforce: true
actionClass: block
requires: [issueType, body]
params:
  dedup_similarity_threshold:
    type: number
    default: 0.85
    min: 0.5
    max: 0.99
  require_error_text:
    type: boolean
    default: true
---

## 意图
落地开源维护工作流一（Intake 流水线）：检查 bug 四元组（版本/平台/步骤/报错原文）完备性、向 `needs-info` 回显已识别字段清单防盲发模板惹恼报告者，并将去重严格封顶在 T1 提议对照表。

## 判据
1. 若 `issueType` 或 `body` 缺失（`null`/`undefined`/空类型），返回 `unmeasured(missing-input)`；
2. 去重 T1 天花板硬卡：若 `proposedAction === "auto-close-duplicate"`，一律返回 `deny`；
3. 仅过滤出 `similarity >= dedup_similarity_threshold` 的候选列入 `dedupProposals`；
4. 若为 `bug` 且四元组缺项（`require_error_text=false` 时不强制 `errorText`）：试图 `proposedAction === "triage"` 直接推进复现返回 `deny`；否则放行并在 `produced` 输出 `{ nextStep: "needs-info", recognizedFields, missingFields, dedupProposals }`。

## 正反例
见 `cases/cases.json`：覆盖四元组齐全放行、缺项走 `needs-info` 带已识别字段放行、缺项强行 `triage` 拦截、试图 `auto-close-duplicate` 拦截及缺 `issueType` 返回 `missing-input`。

## 例外
当 `issueType` 为 `enhancement`、`question`、`docs` 或 `security` 时，不强制要求 bug 四元组；当 `params.require_error_text=false` 时，允许缺 `errorText` 推进 triage。

## 修复指引
若因 `auto-close-duplicate` 被拦，请改为生成 T1 候选对照表交维护者人工确认；若因四元组缺项试图直进 `triage` 被拦，请先向报告者发送附带 `recognizedFields` 的 `needs-info` 模板索取缺失字段。
