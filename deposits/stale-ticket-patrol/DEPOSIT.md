---
{
  "id": "ticket.stale-patrol",
  "version": 1,
  "kind": "standing-order",
  "trust": "public",
  "cases": "cases/",
  "stage": "observe",
  "enforce": false,
  "actionClass": "observe",
  "trigger": {
    "signal": "ticket.stale",
    "match": { "status": "working" }
  },
  "action": {
    "name": "ticket.remind",
    "params": { "reason": "stale-ticket-patrol", "channel": "secretary" }
  },
  "mandate": {
    "strength": "explicit",
    "scope": "workspace:*",
    "ceiling": "read",
    "isolation": "I1",
    "policyVersion": "v1"
  },
  "cooldownMs": 300000,
  "requires": ["ticketId", "idleExceeded", "ticketOpen"],
  "params": {
    "max_idle_minutes": { "type": "number", "default": 30, "min": 5, "max": 1440 }
  },
  "rule": {
    "kind": "workflow_sop",
    "signal": "ticket.stale",
    "action": { "name": "ticket.remind", "params": { "reason": "stale-ticket-patrol" } },
    "checklistField": "completedSteps",
    "steps": [
      { "id": "verify-heartbeat-timeout", "mustBeTrueField": "idleExceeded", "message": "工单静默时间未超过阈值" },
      { "id": "confirm-open-ticket", "requiredField": "ticketId", "mustBeTrueField": "ticketOpen", "message": "工单非开放状态，终止催办" }
    ]
  }
}
---

## 意图
作为受治理常驻命令（standing-order），仅在工单长期静默且全部前提（信号匹配、冷却窗口已过、隔离档允许、工单仍开放）均通过零代码 SOP 清单核对后，发出温和 `ticket.remind` 提醒。

## 判据
1. 必须绑定受治理信号 `ticket.stale` 与 `payload.status === "working"`；
2. 冷却期（`cooldownMs: 300000`）未满或隔离档超出授权上限（`ceiling: "read"`）时返回 `deny`；
3. 零代码 `workflow_sop` 步骤 `verify-heartbeat-timeout` 与 `confirm-open-ticket` 均已完成且字段为 `true` 时返回 `allow`；缺少必要上下文字段则返回 `unmeasured(missing-input)`。

## 正反例
见 `cases/cases.json`：包含满足条件放行提醒、静默未超时拒绝、冷却期未满拒绝与缺状态字段 `unmeasured` 用例。

## 例外
当工单已进入终态（`ticketOpen: false`）或仍在冷却期内，即使收到 `ticket.stale` 信号也不重复打扰。

## 修复指引
若因冷却或静默未超阈被拒，请等待下次巡检窗口；若为 `missing-input`，请补全工单巡检快照中的 `ticketId`、`idleExceeded` 与 `completedSteps`。
