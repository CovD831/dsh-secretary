---
{
  "id": "friction.seen-three",
  "version": 1,
  "kind": "counter-rule",
  "point": "deposit.friction",
  "trust": "public",
  "cases": "cases/",
  "stage": "observe",
  "enforce": false,
  "placement": { "timing": "pre", "enforce": false },
  "actionClass": "observe",
  "action": { "name": "proposal.create", "params": { "category": "workflow-friction" } },
  "requires": ["seenCount", "distinctWorkspaces"],
  "params": {
    "min_seen": { "type": "number", "default": 3, "min": 2, "max": 10 },
    "min_workspaces": { "type": "number", "default": 2, "min": 1, "max": 5 }
  },
  "rule": {
    "kind": "predicates",
    "mode": "any",
    "clauses": [
      { "path": "seenCount", "op": "lt", "param": "min_seen", "message": "相同摩擦跨工作区累计达到触发阈值，生成 proposal.create 改进提案" },
      { "path": "distinctWorkspaces", "op": "lt", "param": "min_workspaces", "message": "受影响工作区数不足，继续观察而不提案" }
    ]
  }
}
---

## 意图
遵守宪法裁决 D5（九级梯 Rung 1 非阻塞提案权）：当同类工作流摩擦在多个独立工作区重复出现达到阈值（默认 `seenCount >= 3` 且 `distinctWorkspaces >= 2`）时，在 `observe` 阶段触发 `proposal.create` 提案信号，而绝不自动阻塞执行或静默改写规则。

## 判据
1. `seenCount` 或 `distinctWorkspaces` 缺失或非有限数值时返回 `unmeasured(missing-input)`；
2. 任一条件尚未越阈（`seenCount < params.min_seen` 或 `distinctWorkspaces < params.min_workspaces`）时返回 `allow`；
3. 当 `seenCount >= params.min_seen` 且 `distinctWorkspaces >= params.min_workspaces` 时返回非强制观测结论 `deny`（记入 `observed` 并触发 `action: { name: "proposal.create" }`），永不阻断 `verdict`。

## 正反例
见 `cases/cases.json`：包含单区高频不提案正例、跨区未达次正例、跨区满 3 次触发提案反例，以及缺字段 `unmeasured` 用例。

## 例外
支持通过绑定参数调整 `min_seen` 与 `min_workspaces`；但任何实例均受宪法 D5 约束，严禁升至 `enforce: true` 或绕过老板批准直接改写生产规则。

## 修复指引
该条目触发仅表示需要汇总摩擦样本并提交 `proposal.create` 待审提案，不会阻止工单继续推进；请秘书将对应 M0 `source_ref` 记入 M6 待决队列。
