---
{
  "id": "replay.ci-evaluator",
  "version": 1,
  "kind": "evaluator",
  "measures": "replay.ci-holdout-generalization",
  "trust": "public",
  "cases": "cases/",
  "stage": "observe",
  "enforce": false,
  "actionClass": "observe",
  "requires": ["totalCases", "generalizationRatio", "falseBlocks"],
  "params": {
    "min_generalization_ratio": { "type": "number", "default": 0.75, "min": 0.1, "max": 1 },
    "max_false_blocks": { "type": "number", "default": 0, "min": 0, "max": 10 },
    "min_total_cases": { "type": "number", "default": 2, "min": 1, "max": 1000 }
  },
  "rule": {
    "kind": "predicates",
    "mode": "all",
    "clauses": [
      { "path": "totalCases", "op": "gte", "param": "min_total_cases", "message": "回放与 holdout 总样本不足" },
      { "path": "generalizationRatio", "op": "gte", "param": "min_generalization_ratio", "message": "holdout 泛化比未达阈值" },
      { "path": "falseBlocks", "op": "lte", "param": "max_false_blocks", "message": "历史回放存在误拦 (falseBlocks 超限)" }
    ]
  }
}
---

## 意图
使用零代码 `predicates` 积木评估候选规则或 CI 回放套件的 holdout 泛化比与零误拦质量，防止仅在局部样本过拟合却在留出集失效的规则晋升。

## 判据
1. 若 `totalCases` 缺失或 `<= 0`，或缺少 `generalizationRatio` / `falseBlocks`，返回 `unmeasured`；
2. 必须同时满足 `totalCases >= min_total_cases`、`generalizationRatio >= min_generalization_ratio` 且 `falseBlocks <= max_false_blocks` 时判为有效（`effective`）；否则判为无效（`ineffective`）。

## 正反例
见 `cases/cases.json`：包含高泛化零误拦通过、低泛化且误拦失败、以及零样本/缺指标 `unmeasured` 用例。

## 例外
特定探索期指标可通过调整 `min_generalization_ratio` 与 `min_total_cases` 绑定参数放宽阈值；样本数为 0 时绝不允许猜概率。

## 修复指引
请扩充跨工作区 holdout 样本并修正导致误拦的判据条件后再重新提交回放评估。
