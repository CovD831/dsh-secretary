---
id: verify.changed-paths
version: 1
kind: gate
point: verify.changed-paths
trust: public
cases: cases/
stage: enforce
enforce: true
placement:
  timing: pre
  enforce: true
actionClass: block
params:
  strict_untracked:
    type: boolean
    default: true
  require_both_surfaces:
    type: boolean
    default: false
---

## 意图
防止实现方越界修改未授权文件或以自报路径遮掩真实写入，同时绝不将 shell / 无 diff 编辑工具的盲区洗白为放行。

## 判据
1. 若会话出现无 diff 记录的 `bash/sh/pwsh` 写操作或 `str_replace_editor`（`sawShellWrite` / `sawUnmeasuredTool` / `unmeasuredTools` / 无 diff 的 `toolCalls`），立即返回 `unmeasured(shell-blind)`；
2. 若 `sessionDiffs` 与 `gitDirtyPaths` 均不可观测（`null`），或 `require_both_surfaces=true` 时缺任一面，返回 `unmeasured(no-evidence)`；
3. 若 `allowedPaths` 含绝对路径、`~` 或 `..`，返回 `deny`；
4. 取 `sessionDiffs ∪ gitDirtyPaths`（`strict_untracked=true` 时并入 `untrackedPaths`），若存在未落在 `allowedPaths` 内的路径，返回 `deny(blockers)`；否则返回 `allow`。

## 正反例
见 `cases/cases.json`：包含范围内放行、越界写入拦截、`bash`/`str_replace_editor` 盲区返回 `shell-blind`、双面缺失返回 `no-evidence`。

## 例外
仅当 `params.strict_untracked=false` 时，未进入 `sessionDiffs` 与已追踪修改的未追踪新文件（`untrackedPaths`）不计入越界拦截。

## 修复指引
若遇 `deny` 越界，请回退未授权文件的修改或向总控申请扩大 `allowedPaths`；若遇 `shell-blind`，请改用带结构化 diff 记录的文件编辑工具重新执行或在隔离验证树重新落盘。
