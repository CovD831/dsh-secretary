---
id: verify.change-test-coverage
version: 1
kind: gate
point: verify.change-test-coverage
trust: public
cases: cases/
stage: observe
enforce: false
placement:
  timing: pre
  enforce: true
actionClass: observe
requires: [codeChangedPaths, testChangedPaths]
params:
  min_changed_code_lines:
    type: number
    default: 30
    min: 1
    max: 500
  exempt_task_types:
    type: string
    default: "docs"
---

## 意图
填补 `feature`/`refactor` 任务不跑 `verify.rerun` 红绿探针时的测试覆盖盲区：当非文档/非测试实质代码变动达到阈值却未同步新增或修改任何测试文件时记录警告/拦截。

## 判据
1. 若 `codeChangedPaths` 或 `testChangedPaths` 缺失（`null`/`undefined`），返回 `unmeasured(missing-input)`；
2. 若 `codeChangedPaths` 为空，或 `taskType` 命中 `exempt_task_types`（默认 `docs`），或 `testChangedPaths` 非空，直接返回 `allow`；
3. 若 `changedCodeLines` 缺失或非有限非负数，返回 `unmeasured(no-evidence)`；
4. 若 `changedCodeLines >= min_changed_code_lines`（默认 `30`），返回 `deny`；否则放行。

## 正反例
见 `cases/cases.json`：包含带测试放行、小改动（<30 行）放行、文档豁免放行、大改动零测试拦截，以及缺统计/缺路径返回 `unmeasured`。

## 例外
纯文档改动、小于 `min_changed_code_lines` 的微调，或参数 `exempt_task_types` 中声明豁免的任务类型直接放行。

## 修复指引
请为本次主要逻辑改动补充或更新对应单元测试/回归测试文件，并在 `declared_paths` 中如实申报新增测试路径。
