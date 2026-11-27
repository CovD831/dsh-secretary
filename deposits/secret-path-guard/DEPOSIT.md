---
{
  "id": "verify.secret-path-guard",
  "version": 1,
  "kind": "gate",
  "point": "verify.secret-path-guard",
  "trust": "public",
  "cases": "cases/",
  "stage": "enforce",
  "enforce": true,
  "side": "hard",
  "placement": { "timing": "pre", "enforce": true },
  "actionClass": "block",
  "requires": ["changedPaths"],
  "params": {
    "max_changed_files": { "type": "number", "default": 30, "min": 1, "max": 200 }
  },
  "rule": {
    "kind": "path_rules",
    "inputField": "changedPaths",
    "forbiddenGlobs": [
      ".env",
      ".env.*",
      ".envrc",
      "**/.env",
      "**/.env.*",
      "**/.envrc",
      "**/secrets/**",
      "**/*.pem",
      "**/*.key",
      "**/*id_rsa*",
      "**/.dsh/**",
      ".dsh/**"
    ],
    "maxChangedFilesParam": "max_changed_files",
    "rejectTraversal": true
  }
}
---

## 意图
使用零代码 `path_rules` 积木阻止工作区改动触及凭据文件（`.env`、私钥证书、`.dsh` 生产目录）或通过绝对/`..` 越界访问，保护项目红线不被越权绕过。

## 判据
1. 缺少 `changedPaths` 输入时诚实返回 `unmeasured(missing-input)`；
2. 路径命中禁写 glob（`.env*`、`**/secrets/**`、`*.pem`、`*.key`、`*id_rsa*`、`.dsh/**`）、出现 `..`/绝对/`~` 越界或文件数超过 `max_changed_files` 时返回 `deny`；
3. 所有路径均安全且在数量预算内时返回 `allow`。

## 正反例
见 `cases/cases.json`：包含合法源码改动放行、修改 `.env.local` 拦截、私钥文件拦截、`..` 路径穿越拦截，以及缺输入 `unmeasured` 用例。

## 例外
仅可通过调大绑定参数 `max_changed_files` 放宽文件数预算；敏感凭据路径与 `..` 路径穿越不设例外。

## 修复指引
请撤销对敏感文件或越界路径的改动，切勿读取或写入 `.env` 与 `~/.dsh` 生产目录。
