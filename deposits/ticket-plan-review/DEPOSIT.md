---
id: ticket.plan-review
version: 1
kind: gate
point: ticket.plan-review
trust: public
cases: cases/
stage: observe
enforce: false
placement:
  timing: pre
  enforce: true
actionClass: block
requires: [workflowRiskTier]
params:
  require_on_elevated:
    type: boolean
    default: true
  max_blockers_to_show:
    type: number
    default: 5
    min: 1
    max: 20
---

## 意图
为高风险或跨模块工单提供开箱即用的计划阶段独立对抗审视：在工人动手前由宿主发起隔离单轮 LLM 审视，找出最硬反例、隐含契约破坏与必测边界，避免带着错误假设开工。

## 判据
1. `workflowRiskTier === 'fast'` 时直接 `allow(skipped: 'fast-tier')`，零额外 LLM 开销；
2. `workflowRiskTier === 'elevated'` 时检验宿主 `review` 结果：
   - `unavailable` → `unmeasured(no-evidence)`；
   - `timeout` → `unmeasured(timeout)`；
   - `parse-failed` 或缺少有效反例的空 `revise` → `unmeasured(parse-failed)`；
   - `verdict: 'revise'` 且带具体风险/反例 → 返回 `deny`；
   - `verdict: 'proceed'` → 返回 `allow` 并记录风险/待验条目统计。

## 正反例
见 `cases/cases.json`：覆盖 `fast` 跳过、`elevated` 放行、具体风险反例拦截，以及 `unavailable`/`timeout`/`parse-failed`/缺输入下的三态诚实处理。

## 例外
普通单模块小工单（`fast` 通道）全部豁免，不触发 LLM 审视；也可将参数 `require_on_elevated` 设为 `false` 关闭高危计划审视。

## 修复指引
请逐项回应对抗审视给出的高危缺陷与反例，缩小改动范围、补清边界用例或回滚路径后重新派发。
