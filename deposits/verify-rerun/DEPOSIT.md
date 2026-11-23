---
id: verify.rerun
version: 1
kind: gate
point: verify.rerun
trust: public
cases: cases/
stage: enforce
enforce: true
placement:
  timing: pre
  enforce: true
actionClass: block
params:
  require_red_green:
    type: boolean
    default: true
  require_independent_verifier:
    type: boolean
    default: true
---

## 意图
落实反自报完成纪律：实现工蜂声称完成时必须经过独立验证方重跑通过，且缺陷修复类任务须附撤去修复时的红灯证据。

## 判据
当 `claimedDone=true` 时：
1. 必须存在 `rerun` 记录且未超时/中止，否则返回 `unmeasured(no-evidence | timeout)`；
2. 当 `require_independent_verifier=true` 时，`rerun.verifierRole` 不得等于 `builderRole`，否则返回 `deny`（严禁自报自验）；
3. `rerun.exitCode` 必须为 `0`，否则返回 `deny`；
4. 当 `taskType === "fix"` 且 `require_red_green=true` 时，必须提供独立验证方的 `redGreen` 记录（缺少则 `unmeasured(no-evidence)`），且 `exitCodeWithoutFix !== 0`、 `exitCodeWithFix === 0`，否则返回 `deny`。

## 正反例
见 `cases/cases.json`：包含独立重跑通过、fix 红绿双证通过、自报自验拦截、重跑失败拦截、fix 无红灯拦截及缺证据 `unmeasured` 用例。

## 例外
当 `claimedDone=false`（任务尚在进行中未申报完成）时直接放行；非 `fix` 类任务不强制 `redGreen` 撤修复红灯记录。

## 修复指引
请指派独立验证方在隔离工作区重跑验收命令并回填 `rerun`（若为 `fix` 任务，需先构造无修复必败、合入必过的红绿对照记录 `redGreen`）。
