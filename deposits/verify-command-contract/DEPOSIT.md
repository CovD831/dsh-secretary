---
id: verify.command-contract
version: 1
kind: gate
point: verify.command-contract
trust: public
cases: cases/
stage: observe
enforce: false
placement:
  timing: pre
  enforce: true
actionClass: block
requires: [codeChangedPaths, verifyCommands]
params:
  require_non_empty_for_code:
    type: boolean
    default: true
  forbid_noop_commands:
    type: boolean
    default: true
playbook:
  summary: 高风险/跨模块工单必检：动代码前先列反例与最小边界，完工必须跑通真实可证伪验收命令。
  when:
    riskTiers: [elevated]
  steps:
    - 动代码前写出 1 个最硬反例、影响模块边界与清晰回滚方式
    - 只做服务本工单的最小外科手术修改，不顺手改无关大文件
    - 确认 verifyCommands 含真实测试/类型检查（禁 || true、true、echo 占位）
    - 完工汇报逐项列清真实命令退出码与任何未验证部分
---

## 意图
作为开箱即用默认工作流的验收底线：改动实质代码时必须配备非空且可真实失败/证伪的 `verifyCommands`，防止“空命令”或 `|| true` / `echo` 占位命令让后续重跑门失效。

## 判据
1. 若 `codeChangedPaths` 或 `verifyCommands` 缺失（`null`/`undefined`），返回 `unmeasured(missing-input)`；
2. 若 `codeChangedPaths` 为空（纯文档/无代码改动），返回 `allow(not-applicable)`；
3. 若改动了代码文件但 `verifyCommands` 为空，返回 `unmeasured(no-evidence)`；
4. 若 `verifyCommands` 存在全部由空操作组成（如 `true`、`echo`、`node -e "process.exit(0)"`）或尾部吞掉退出码（`|| true`、`; exit 0`）的命令，返回 `deny`（允许 `echo "..." && pnpm test` 等前置提示复合命令）。

## 正反例
见 `cases/cases.json`：覆盖真实命令放行、复合前缀放行、无代码改动放行、`true`/`|| true`/`process.exit(0)` 拦截，以及空命令返回 `no-evidence`、缺输入返回 `missing-input`。

## 例外
纯文档或非代码文件改动（`codeChangedPaths: []`）直接放行；可通过参数 `require_non_empty_for_code: false` 或 `forbid_noop_commands: false` 放宽对应检查。

## 修复指引
请为当前工作区或派单补充真实可失败的测试/类型检查命令（如 `pnpm typecheck`、`pnpm test`、`node --test`），移除末尾 `|| true` 或纯 `true`/`echo` 占位命令。
