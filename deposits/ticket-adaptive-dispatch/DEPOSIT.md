---
id: ticket.adaptive-dispatch
version: 1
kind: gate
point: ticket.adaptive-dispatch
trust: public
cases: cases/
stage: enforce
enforce: true
placement:
  timing: pre
  enforce: true
actionClass: block
params:
  solo_max_files:
    type: number
    default: 6
    min: 1
    max: 30
  max_capsule_bytes:
    type: number
    default: 16000
    min: 2000
    max: 100000
  default_thinking:
    type: enum
    values: [low, medium, high]
    default: low
  escalate_after_fails:
    type: number
    default: 2
    min: 1
    max: 5
---

## 意图
根据 1-Hop 上下文切片的客观读数与历史连续失败次数，通过可调参数确定派发执行模式（solo 或 team）与默认思考档位，避免硬编码阈值。

## 判据
输入 `SliceMetrics`、`retryCount` 与绑定 `params`：
1. 若 `metrics` 或 `retryCount` 缺失，返回 `unmeasured(missing-input)`；
2. 若参数越出 `[min, max]` 或 `default_thinking` 非法，或读数为负，返回 `deny`；
3. 若 `targetFiles <= solo_max_files`、`totalBytes <= max_capsule_bytes` 且 `retryCount < escalate_after_fails`，返回 `allow` 并产出 `{ executionMode: "solo", thinkingTier: params.default_thinking }`；
4. 若任一指标超阈或达失败阈值：允许 team 时返回 `allow` 并产出 `{ executionMode: "team", thinkingTier: "high", escalateReason }`；若工单锁定 `allowTeam: false`，返回 `deny`。

## 正反例
见 `cases/cases.json`：包含预算内 solo 放行、超字节/超重试升档放行、锁定 solo 时超限拦截、以及缺读数 `unmeasured` 用例。

## 例外
当工作流处于纯规划且显式传入合意参数放宽（如极速流派 `solo_max_files: 12`、`max_capsule_bytes: 32000`）时，按绑定参数执行，不视作例外绕过。

## 修复指引
若因 `allowTeam: false` 被拦，请拆分任务缩小切片范围至 `solo_max_files` / `max_capsule_bytes` 内，或解除 team 限制；若因参数越界被拦，请调回 `[min, max]` 合法区间；若为 `missing-input`，请先运行 `sliceWorkspaceContext` 补齐 `metrics`。
