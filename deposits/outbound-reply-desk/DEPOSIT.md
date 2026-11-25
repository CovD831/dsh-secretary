---
id: outward.reply-desk
version: 1
kind: gate
point: outward.reply-desk
trust: public
cases: cases/
stage: enforce
enforce: true
placement:
  timing: pre
  enforce: true
actionClass: block
requires: [repoAiPolicy, threadClosedOrResolved, writesLastMinute, writesLastHour]
params:
  max_writes_per_min:
    type: number
    default: 60
    min: 1
    max: 80
  max_writes_per_hour:
    type: number
    default: 400
    min: 1
    max: 500
---

## 意图
落地开源维护工作流三（Reply Desk 对外合规门）：在对外发声前强制核验目标仓 AI 政策、线程实时状态、GitHub 二级内容生成限额及 T1/T2 自由文本人批边界，严禁盲发与社区越线。

## 判据
1. 若 `repoAiPolicy`、`threadClosedOrResolved`、`writesLastMinute`、`writesLastHour` 任一为 `null`/`undefined`，返回 `unmeasured(missing-input)`；
2. Ghostty 政策红线：`repoAiPolicy === "forbid_ai_comments"` 一律 `deny`；`require_disclosure` 且 `!hasAiDisclosure` 返回 `deny`；
3. 防过期回复：若 `threadClosedOrResolved === true`，返回 `deny`；
4. 限额熔断：若 `writesLastMinute >= max_writes_per_min` 或 `writesLastHour >= max_writes_per_hour`，返回 `deny`；
5. T1/T2 上限：若 `messageKind === "freeform_reply"` 且 `humanApproved !== true`，返回 `deny`。

## 正反例
见 `cases/cases.json`：包含合规披露模板放行、人批自由文本放行、Ghostty 禁 AI 评论拦截、缺披露拦截、已关闭线程拦截、写限额熔断、未人批自由文本拦截及缺观测返回 `missing-input`。

## 例外
仅封闭模板（`template_ack` / `template_needs_info`）在目标仓允许且满足披露、线程开启、未触限额的前提下可免人批自动发送。

## 修复指引
若因 `forbid_ai_comments` 被拦，请由维护者本人手写回复并勿以 AI 代理账号发言；若因缺披露或未审批被拦，请补充 AI 工具披露行或将自由文本送入 Reply Desk 待批卡片；若触限额请停批等待窗口恢复，禁止重试风暴。
