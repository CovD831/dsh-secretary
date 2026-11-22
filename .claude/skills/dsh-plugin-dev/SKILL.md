---
name: dsh-plugin-dev
description: 在 DeepSeek Harness 0.2.2-rc.5 中编写、调试或审查 Host 工具、会话服务、Remote API、调度存储或 Web Client 插件时使用。
---

# DSH 插件开发（rc.5）

## 0. 先钉版本，再查定义

- 唯一 API 真源是 `/tmp/dsh-ref/deepseek-harness`，固定 tag `dsh-v0.2.2-rc.5`；本机 `dsh --version` 同为 `0.2.2-rc.5`。不得凭记忆或其他版本文档写调用。
- 写每个 API 前，在上述 checkout 中 grep 到声明、参数与返回类型；随后查 [references/doc-index.md](references/doc-index.md) 的对应文档。未找到定义或本机行为未验证时，在代码旁明确写「待实测」，不得猜参数。
- 示例只保留最小片段；精确契约回看路径中的源码。`R` 下文均指 `/tmp/dsh-ref/deepseek-harness`。
- 先读项目地图 `/Users/abab/dsh-agent-teams-package/02-DSH-EXTENSION-MAP-rc5.md`。路径与类型冲突时，以 rc.5 源码为准并报告冲突。
- 插件代码是可信进程内代码，版本检查、配置校验和 `dsh.client` 都不是安全沙箱。

## 1. 最小骨架

### 1.1 Host 函数插件

```ts
import type { Context } from '@deepseek-ai/cordis'
export const name = 'hello'
export function apply(ctx: Context) { console.log('hello') }
```

出处：`R/docs/cordis-tutorial/01-first-plugin.zh.md`。函数插件使用命名导出 `name` / `inject` / `Config` / `apply`；不要同时 default export service，否则 Loader 会丢弃函数插件 namespace。出处：`R/packages/AGENTS.md`。

```ts
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => console.log('tick'), 200)
    return () => clearInterval(timer)
  })
}
```

`inject` 是持续跟踪的硬依赖：缺提供方时 fiber 保持 PENDING，服务消失会卸载消费方；不是“按 YAML 顺序启动”。出处：`R/docs/cordis-tutorial/03-services.zh.md`。Cordis 注册本身带 effect 生命周期；timer、watcher、连接等框架外资源才另用 `ctx.effect` 返回 disposer。出处：`R/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md`。可选服务用 `ctx.get('name')`，不要用拓扑敏感的 `ctx.name` 猜它是否存在。出处：`R/packages/AGENTS.md`。

### 1.2 npm 组合包 manifest

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "dsh": "0.2.2-rc.5" },
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

最小 Host 包及对应 `insert` patch 出处：`R/packages/preset/agent-preset/skills/dsh-doc/references/host-plugin.md`。`engines.dsh` 的精确值是本项目的钉版选择，不是官方强制写法；规则见第 4 节。`dsh.bundle.patch` 是组合包/持久分发声明，不是直接 `--patch` 加载单个 JS 模块的必需条件。

UI 包还需：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

出处：`R/packages/preset/agent-preset/skills/dsh-doc/templates/decoration/package.json` 与 `R/docs/subsystems/client-modules.zh.md`。`dsh.client.inject` 填包名依赖边，不是 Host 的服务名 `inject`。浏览器产物是 `window.__ModuleLoader__.load({ id, factory(require) { ... } })` lazy CommonJS factory，不是普通 `export apply` 文件；最小完整例：`R/packages/preset/agent-preset/skills/dsh-doc/templates/decoration/client.js`。

## 2. 不安装的本地 overlay

依据 `R/apps/cli/src/profile-boot.ts`、`R/apps/cli/src/args.ts`、`R/apps/cli/tests/dump-config-schema.expected.e2e.ts` 与 `R/packages/boot/app-boot/README.zh.md` 整理。树外 ESM 函数式插件可经 `--patch <overlay.yml>` 挂进独立 profile 并真实激活（证据 `/Users/abab/Desktop/dsh-spike-phase0/spike-01/`）。树外 `.mjs` 里 bare import `@deepseek-ai/*`（如 `@deepseek-ai/dsh-tools`）会 `ERR_MODULE_NOT_FOUND`；避免 bare import，改用 `ctx` 上的服务或自带依赖。

```yaml
# /absolute/work/overlay.yml；./index.js 相对此文件解析
- insert:
    - id: my-spike
      name: ./index.js
      config: {}
```

后续实测使用全新、显式的 `DSH_HOME`，避免碰用户现有 home：

```sh
export DSH_HOME=/absolute/new-empty-dsh-home
# 警告：会创建或替换 $DSH_HOME/profiles/spike；不要对已有同名 profile 执行
dsh --profile spike --from-default-profile headless --dump-config
# 仅组合预览：能看到行不等于 import、版本准入或 fiber 激活成功
dsh --profile spike --patch /absolute/work/overlay.yml --dump-config
# launcher flags 放在内层 app 参数前；运行继承的 headless app 单任务
dsh --profile spike --patch /absolute/work/overlay.yml "完成一个最小验证任务"
```

单任务形式出处：`R/docs/cli-help.zh.md`。`--patch` 可重复，按 argv 顺序叠加，位于 profile/home patch 之后；dump 与 app args 不能同用。`--dump-config` 出现行不等于激活，仍需真实启动确认。

Web 复跑：`dsh --profile <p> --patch … --host 127.0.0.1 --port <n> --no-open`；显式 `--profile` 后不要再加位置参数 `web`（报 too many arguments）。可用独立 `DSH_HOME=<目录>` 完全隔离用户环境（`/Users/abab/Desktop/dsh-spike-phase0/spike-03/replay.sh`）。

注意：每次启动某 profile（含 `--dump-config`/`--help` 启动路径）都会重新生成该 profile 的 `cordis.yml`（组合产物）；用户层是 `cordis.patch.yml`。实验时用独立 profile 或独立 `DSH_HOME`，避免触碰用户 profile 的生成文件。

## 3. 常用能力速查

| 能力 | rc.5 最小契约与用法 | 真源 |
|---|---|---|
| 注册工具 | `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`；`execute` 返回规范 JSON 值，`schema` 校验，`render(args, value)` 生成模型内容；持久卡片数据另放 `presentationMeta` | `R/docs/cookbook/adding-a-tool.zh.md`；`R/packages/core/tools/src/index.ts` |
| 工具事前拒绝 | `ctx.on('tools/pre-execute', async (exec, next) => denied ? { kind: 'deny', reason } : next())`；decision 仅 `allow/deny/cancel/ask`，不能改参 | `R/docs/cookbook/extension-cookbook.zh.md`；`R/packages/core/tools/src/contracts.ts` |
| `tools.guard` | `ctx.tools.guard(exec => stringOrDenialOrUndefined)` 返回 disposer；在 pre-execute 后、工具体前同步检查，首个 denial 生效，适合硬不变量兜底 | `R/packages/core/tools/src/index.ts`；`R/packages/core/tools/src/pipeline.ts` |
| `tools.restrict` | 仅在 agent scoped context 调 `ctx.tools.restrict({ allow, deny })`，过滤继承的全局工具；当前 scope 自己注册的工具不受限，非 scoped 调用会抛错。**不能把 scoped 自定义工具写进 allow**，会被判 unknown global tool | `R/packages/core/tools/src/index.ts:179-183` |
| 零工具 agent | 在 `agent/created` 中先 `agent.ctx.tools.register(自定义工具)`，再 `agent.ctx.tools.restrict({ allow: [] })`：自注册工具保留，继承的全局工具全部隐藏。实测可见清单仅剩自定义工具（`/Users/abab/Desktop/dsh-spike-phase0/spike-01/tools-view.json`） | 同上 |
| 工具审批 | `tools/pre-execute` 返回 ask → `ctx.approval.request` → `approval/request` waterfall；插件可挂该 waterfall、存 pending resolver、异步返回 `allowed-once`/`rejected`（另有 cancelled/unavailable）。会话策略 `approval/policy: 'never'` 在 waterfall 前直接拒绝，不可绕过；审批请求必须在开放轮次内。宿主 UI 只是同一 waterfall 的一个应答者 | `R/packages/interaction/user-approval/src/index.ts:242-332`；`R/packages/core/tools/src/pipeline.ts:428-478`；`spike-02/approval-queue.jsonl` |
| 结果与持久事件 | `tools/result(exec, result)` 观察冻结最终结果；`session/event` 观察 Session 仅追加事实流。二者用途不同，不拿展示内容替代持久事件 | `R/packages/core/tools/src/events.ts`；`R/docs/event-producer-consumer.zh.md` |
| 创建会话 / 跨会话 | `ctx.sessionController.create({ cwd })`、`list`、`prompt`、`observeEvent` 实测可用；创建时 `cwd` 与 `workspaceId` 互斥，可另给 `sessionId`/`agentPreset`。注意是 `ctx.sessionController.prompt`，不是 Session 对象方法；`prompt` 回执 accepted 仅表示入队（`/Users/abab/Desktop/dsh-spike-phase0/spike-02/session-cross.json`） | `R/packages/api/session-controller/src/types.ts`；`src/index.ts` |
| 投递 prompt | `prompt({ requestId, sessionId, mode: 'queue' \| 'steer', content, clientTimeZone? }, signal)`；`requestId` 是 branded `SessionRequestId` | 同上；调用例 `R/packages/api/session-controller/tests/remote-access.host.spec.ts` |
| 观察会话 | `observeEvent({ address }, signal)` 与 `observeProjections({ address }, signal)` 返回 `AsyncIterable`；首帧是 ready，不含全量 snapshot；不是传 `{ sessionId }` | `R/packages/api/session-controller/src/types.ts`；`src/index.ts` |
| agent preset | patch 中声明 `agent-preset-registry` 与 `@deepseek-ai/dsh-agent-preset`，后者 config 必填 `id`、`plugins: []`；只影响之后创建的 Agent | `R/packages/preset/agent-preset/README.zh.md`；`R/packages/preset/agent-preset-registry/README.zh.md` |
| headless 限制 | headless 不组合 preset roster（`R/packages/bundle/headless/src/index.ts:367-370`），CLI 无 `--agent-preset`；headless 默认无 sessionController，单靠 inject 不会激活，需在 overlay 中临时组合 `@deepseek-ai/dsh-api-session-controller` 并提供 workspaceRegistry/fileUploads 最小适配（`/Users/abab/Desktop/dsh-spike-phase0/spike-02/session-deps.mjs`）。桌面/Web profile 不受此限 | 同上 |
| schedule | `ctx.schedule.create(request, actorSessionId?, signal?)`；timing 支持 `after/at/every/daily/weekly/cron/rrule`，target 为 `session/new_once/new`，可带 `cwd/agentPreset`；回执不等于模型完成 | `R/packages/schedule/schedule/src/index.ts`；`src/types.ts`；`R/docs/subsystems/schedule.zh.md` |
| jobs | `ctx.jobs.start(spec): JobId`；`spec` 为 `kind/label/owner?/toolCall?/outputLimitBytes?/output?/run(job)`；`owner?: SessionId`。用 `ctx.jobs.events.subscribe(filter, listener)` 订阅 | `R/packages/jobs/jobs/src/types.ts`；`src/index.ts` |
| 持久 KV | `const domain = await ctx.storageDomain.open(spec)`；`spec` 含 `name/version/layout?/compatibleVersions?/global?/tables`；调用方在自己的 effect disposer 中 `await domain.close()` | `R/packages/storage/storage-domain/src/index.ts`；`src/spec.ts`；`R/docs/subsystems/storage.zh.md` |
| Remote stream | Host owner 继承 `TypertRemoteService`；方法用 `@Remote({ mode: 'stream' }) async *method(..., signal)`，yield 状态流 | `R/packages/experimental/client-ui-forge/src/index.ts`；`R/docs/cookbook/adding-a-remote-api.zh.md` |
| Web 主区域 | `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ actions: ctx.layout }), ... }, Page))`；用新 key，再 `ctx.layout.selectPanel(PANEL_ID)`。启动默认面板须在同一 effect 内**先 register 再 `selectPanel(id)`**；切回原生用 `selectPanel(null)`（不是 `'conversation'`）；从原生返回需另注册 `sidebar.panellist` 入口；侧栏开关用 `ctx.layout.toggleSidebar()` | `R/packages/client/ui-schedule/src/client/index.ts`；`R/packages/client/ui-plugin-manager/src/client/index.ts`；`R/packages/client/ui-layout/src/client/index.ts` |
| 树外 Client 包 | 带最近 `package.json` 的树外 path/file 包可直接经 `--patch` 提供 `dsh.client`，无需 npm 安装（`R/packages/client/modules/src/index.ts:931-991`；`/Users/abab/Desktop/dsh-spike-phase0/spike-03/`） | 同上 |
| 版本准入 | 有 `engines.dsh` 时只检查它并忽略 peerDeps；否则检查所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer ranges；两者皆无则不约束 | `R/packages/boot/app-boot/README.zh.md` |

完整工具链：`tool/call`（执行前已记录）→ `tools/pre-execute` → 单调 guards → `tools/execute` → 工具体 → `tools/post-execute` → `finalizeContent` → `tools/result` → 持久 `tool/result`。出处：`R/docs/tool-execution-pipeline.zh.md` 与 `R/packages/core/tools/src/pipeline.ts`。

`jobs` 的 cookbook 示例写 `owner: exec.agent`，但 rc.5 类型要求 `SessionId`；正确投影与可运行调用**待实测/待复核**，不得照抄。树外 Remote 包需要 `./typert`、`./remote` 产物，但树外生成命令和布局**待实测**；不要直接照搬仓库内构建脚本。出处：`R/docs/cookbook/adding-a-remote-api.zh.md`。

## 4. 坑清单（先查扩展面地图）

- `tools/pre-execute` 看到未校验原始参数，只能 allow/deny/cancel/ask；拒绝理由以 `Error: <reason>` 回模型，不能自动补参。
- `tools/post-execute` 的 block 只把已执行结果改错，**撤不回副作用**；硬闸放 pre-execute，同步不变量可再加 guard。
- `tools/execute` around dispatch 只能替换 `exec.signal`，不是通用改参口。出处：`R/packages/core/tools/src/events.ts`。
- `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent` 是 single-slot decision waterfall；普通插件不要挂，避免抢官方策略槽。出处：`R/packages/fs/fs/src/index.ts`。
- shell/pwsh 写文件不保证逐工具 `meta.diffs`；`str_replace_editor` 没有 `presentationMeta`。出现这些写入时变更测量应标 `unmeasured`，不能当作无修改。出处：扩展面地图、`R/packages/fs/tool-str-replace-editor/src/index.ts`。
- `workspace-changes` 排除 `origin === 'subagent'` 或 `delegationDepth > 0`，不能拿它汇总 teammate 全量改动。出处：`R/packages/deliverables/workspace-changes/src/index.ts`。
- agent preset 是 Cordis 子插件组合，不是权限沙箱；permission preset 只管 sandbox/approval。限制继承工具须在 agent scope 用 `tools.restrict`。出处：`R/docs/subsystems/permission-presets.zh.md`。
- 权限预设的 `ask` 只写会话策略，不直接产生工具审批请求；审批实际由 `ctx.approval.request` 触发。见第 3 节审批行。
- preset 提供方与消费方须共享同一 `cordis:group` isolate realm；声明修改不 retroactive。出处：`R/packages/preset/agent-preset-registry/README.zh.md`。
- Host→Client 普通 Cordis 通知走固定 allowlist，任意插件事件不会自动转发且不 replay；自定义可靠业务状态用自有 Remote stream + baseline/cursor。出处：`R/packages/api/remotes/src/remote-events.ts`、`R/docs/subsystems/web-client.zh.md`。
- `main` 是 root keyed slot；新增 panel 用新 key，不覆盖 `conversation`。浏览器 factory 内不直接留副作用，资源放进 `apply` 的 effect。
- schedule 需要 Host 存活；jobs 的 `job/settled` 可能晚于 `turn/end`，不能用轮次结束推断后台任务全完。出处：`R/docs/subsystems/schedule.zh.md`、`R/docs/subsystems/jobs.zh.md`。
- team task `revision` 是 CAS，pre-execute 内读到的值到提交时可能过期；`agent/turn-stopping` steer 只是续跑建议，可能循环。出处：`R/docs/subsystems/agent-team.zh.md` 与扩展面地图。
- 版本不满足的普通行会变 `disabled: true`，但 `--dump-config` 仍可能显示它；精确豁免属于 profile `compatibility.json`，键为 `package@version`，值是精确 runtime 版本列表，不跨升级继承。
- `--dump-config-schema` 会 import 插件读取 Config，只对可信插件运行。按 id 的 patch 替换整个 `config`，不做深合并；已有行中的 `name` 是断言，不是重命名。出处：`R/packages/boot/app-boot/README.zh.md`、`R/packages/preset/agent-preset/skills/dsh-doc/references/composition-reference.md`。
