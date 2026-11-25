---
id: verify.repro-evidence
version: 1
kind: gate
point: verify.repro-evidence
trust: public
cases: cases/
stage: observe
enforce: false
placement:
  timing: pre
  enforce: true
actionClass: block
requires: [terminalState]
params:
  require_script_for_reproduced:
    type: boolean
    default: true
  min_red_output_chars:
    type: number
    default: 10
    min: 1
    max: 500
---

## 意图
落地开源维护工作流二（复现—修复—自验链）：将复现结果严格约束为四合法终态，强制 `reproduced` 附落盘脚本与红灯输出，并禁止 `not-reproduced` 假阴性单独触发关单。

## 判据
1. 若 `terminalState` 缺失（`null`/`undefined`/空串），返回 `unmeasured(missing-input)`；
2. 若 `terminalState` 不属于 `{reproduced, not-reproduced, blocked-needs-info, blocked-needs-env}`，返回 `deny`；
3. `not-reproduced` 禁关铁律：若 `proposedAction === "close-issue"` 且 `humanConfirmedClose !== true`，或缺少非空 `matrixTried` 环境范围声明，返回 `deny`；
4. `reproduced` 终态：若 `require_script_for_reproduced=true` 且缺 `reproScriptPath`，或 `redOutput` 长度不足 `min_red_output_chars`，返回 `deny`；
5. 若 `proposedAction === "open-fix-pr"` 但 `terminalState !== "reproduced"`，返回 `deny`。

## 正反例
见 `cases/cases.json`：包含合法 `reproduced` 开修 PR、`not-reproduced` 仅落标带矩阵放行、`not-reproduced` 擅自关单拦截、`reproduced` 缺脚本或红输出拦截、非法终态拦截及缺 `terminalState` 返回 `missing-input`。

## 例外
当 `params.require_script_for_reproduced=false` 时允许不附独立复现脚本路径（仍需满足 `min_red_output_chars` 红灯输出）；当 `humanConfirmedClose=true` 且已附非空 `matrixTried` 时允许人工确认后关单。

## 修复指引
若因 `not-reproduced` 试图关单被拦，请改为仅贴标签并记录 `matrixTried`，如需关单须经维护者显式确认；若因 `reproduced` 缺证据被拦，请落盘可重跑复现脚本并截取完整红灯错误输出。
