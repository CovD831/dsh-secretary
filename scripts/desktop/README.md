# desktop 安装脚本

把 `dsh-secretary` 正式装进真实 Desktop profile，并可精确回滚。所有命令都在**完全退出客户端**后执行；脚本会先检查。

## 两步用法

```sh
# 1. 安装（默认 profile 是 desktop；workspace 默认 dogfood）
scripts/desktop/install.sh desktop
# 2. 卸载并核对
scripts/desktop/uninstall.sh desktop
```

## 注意事项

- 必须让 `DSH_HOME` 生效：缺省为 `~/.dsh`，演练时显式指向隔离目录（脚本与宿主同一解析规则，空值回退默认）。
- 安装前会把 profile 的 `package.json`、`cordis.patch.yml`、锁文件复制到 `.local/desktop-backup/<时间戳>-<profile>/`；绝不复制凭据或密钥。
- workspace 配置写在 profile 的 `cordis.patch.yml`，按行 id `dsh-secretary` 定位。宿主语义是**整段替换 config、不做深合并**；若该行原有其他 config 字段，需在脚本的受管块中一并重述。
- `desktop` 是 CLI 保留 profile：`dsh --profile desktop --dump-config` 会被拒绝，脚本用同内容临时镜像 profile 做 dump 验证；真实启动仍由 Desktop 完成。
- 安装脚本在 `npm run build` 后会跑 `npm run typecheck`：`build` 只做转译，语法损坏也可能“成功”打包。
- 卸载只移除标记块与插件项，再与备份比对；宿主自行写入的默认项（如空 `dependencies`）会作为差异报告，不强行覆盖。
- 卸载后若 `cordis.patch.yml` 已无其他有效内容，会恢复为备份原文或 `[]`（空文件会导致宿主启动失败）。
- 隔离演练可设 `DSH_SECRETARY_KEEP_VERIFY=1`：安装脚本保留可启动的 `desktop-verify-*` 镜像 profile，卸载时删除。
