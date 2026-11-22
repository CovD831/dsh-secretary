# DSH rc.5 文档索引

以下路径均相对 `/tmp/dsh-ref/deepseek-harness`；先读对应中文 `.zh.md`，精确签名仍以同 tag 的 `.ts` 源码为准。项目结论先查 `/Users/abab/dsh-agent-teams-package/02-DSH-EXTENSION-MAP-rc5.md`。

## 总入口与组合

| 路径 | 一句话讲什么 | 何时查 |
|---|---|---|
| `packages/preset/agent-preset/skills/dsh-doc/SKILL.md` | 官方开发资料导航与证据查询顺序 | 不知道应读哪份官方资料时 |
| `packages/AGENTS.md` | 包内开发约束、函数插件导出和可选服务规则 | 写导出、依赖或 effect 前 |
| `docs/architecture.zh.md` | Host、Agent、Client 与主要子系统总图 | 判断功能属于哪一层 |
| `docs/capability-seams.zh.md` | 各能力的稳定扩展缝与所属包 | 选择扩展点而非私有实现时 |
| `docs/cordis-primer.zh.md` | Cordis Loader、配置、include/group 基础 | 读 patch 或排查组合语义时 |
| `docs/cordis-tutorial/01-first-plugin.zh.md` | 最小函数式插件 | 新建 Host 插件时 |
| `docs/cordis-tutorial/02-lifecycle-and-effects.zh.md` | fiber、注册和 disposer 生命周期 | timer/watcher/连接清理时 |
| `docs/cordis-tutorial/03-services.zh.md` | `inject`、服务提供与 PENDING | 缺服务或服务重挂时 |
| `docs/cordis-tutorial/07-into-the-harness.zh.md` | 工具注册与 `tools/result` 端到端小例 | 第一次把插件接入 harness 时 |
| `docs/development.zh.md` | 官方源码工作区开发方式 | 修改官方仓库时；树外插件不要照搬 |
| `docs/cookbook/adding-a-package.zh.md` | npm 包结构、manifest 与展示元信息 | 组织可分发组合包时 |
| `packages/boot/app-boot/README.zh.md` | profile、overlay、版本准入、dump 和启动失败语义 | 本地加载、兼容性或启动诊断时 |
| `apps/cli/src/profile-boot.ts` | profile 准备、overlay 应用及 dump 写盘行为 | 判断 CLI 是否写 `$DSH_HOME` 时 |
| `apps/cli/src/args.ts` | launcher/app 参数分界与 flag 约束 | `--patch`、dump、headless 参数报错时 |
| `apps/cli/tests/dump-config-schema.expected.e2e.ts` | 相对文件 overlay 和多 patch 顺序的官方测试 | 设计不安装的本地加载时 |
| `docs/cli-help.zh.md` | profile、headless 单任务和输出格式 | 写 CLI 验证命令时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/host-plugin.md` | Host-only 最小包和持久安装方式 | 区分组合包与直接 overlay 时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/composition-reference.md` | patch 行、insert、group、整体 config 替换 | 编写或审查 YAML patch 时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/compositions.md` | profile 与 preset 的组合修改方式 | 需要持久组合而非临时 overlay 时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/plugin-development.md` | 持久 bundle 安装、验证和 profile 事实 | 从临时 spike 转为安装插件时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/upgrading.md` | 按实际起止版本查升级影响 | DSH 或插件升级前 |

## 工具、事件与 Agent

| 路径 | 一句话讲什么 | 何时查 |
|---|---|---|
| `docs/cookbook/adding-a-tool.zh.md` | `defineTool`、输出 schema/render 和卡片元数据 | 注册模型工具时 |
| `docs/tool-execution-pipeline.zh.md` | 工具调用从记录到持久结果的完整顺序 | 选择事前/事后钩子或排查顺序时 |
| `docs/cookbook/extension-cookbook.zh.md` | pre-execute、session/event 等扩展示例 | 写工具策略或事件观察器时 |
| `packages/core/tools/src/contracts.ts` | Tool、Pre/Post decision、guard 的精确类型 | 写任何工具策略参数前 |
| `packages/core/tools/src/events.ts` | pre/execute/post/result 的事件签名与模式 | 注册工具事件监听器前 |
| `packages/core/tools/src/index.ts` | register、guard、restrict、execute 服务契约 | 工具注册和 scope 限制时 |
| `packages/core/tools/src/pipeline.ts` | guard、denial、post block 与结果冻结实现 | 需要裁决副作用和通知顺序时 |
| `docs/event-producer-consumer.zh.md` | Cordis 事件生产消费、serial/waterfall 等语义 | 不确定能否拦截或改写时 |
| `docs/subsystems/session.zh.md` | Session 仅追加事件日志与投影真源 | 读取模型历史、工具和轮次事实时 |
| `docs/subsystems/persistence.zh.md` | Session 持久化、恢复与刷盘边界 | 判断事件何时可持久查询时 |
| `packages/api/session-controller/src/types.ts` | create/prompt/observe 的请求响应类型 | 写跨会话控制代码前 |
| `packages/api/session-controller/src/index.ts` | 进程内 SessionController 与 Remote 方法签名 | 确认 signal、stream 和 address 参数时 |
| `packages/preset/agent-preset/README.zh.md` | preset YAML 与声明字段 | 创建专用 Agent 组合时 |
| `packages/preset/agent-preset-registry/README.zh.md` | 注册表、isolate realm 与非沙箱边界 | preset 不生效或做权限设计时 |
| `docs/subsystems/permission-presets.zh.md` | sandbox mode 与 approval policy 组合 | 区分权限预设和工具白名单时 |
| `docs/subsystems/subagent.zh.md` | 子代理 activation、cwd、preset 与结果投递 | 宿主侧创建子代理时 |
| `docs/subsystems/agent-team.zh.md` | Team 任务 DAG、revision CAS 与 Web 投影 | 做团队任务闸或任务板时 |
| `packages/team/tool-agent-team/src/index.ts` | Team 模型工具及 update action 真源 | pre-execute 匹配 Team 工具前 |
| `docs/subsystems/tools.zh.md` | 工具目录、Native/PTC 执行和相关服务地图 | 查找某工具或执行后端归属时 |
| `docs/tool-catalog.zh.md` | 随附工具名称与能力目录 | 写工具名过滤、allow/deny 前 |
| `docs/subsystems/approval.zh.md` | 工具审批链路：pre-execute ask → approval/request waterfall → 应答 | 挂审批 waterfall 或设计审批 UI 时 |
| `packages/interaction/user-approval/src/index.ts` | ApprovalService 与 `approval/request` waterfall 真源 | 写审批请求、pending resolver 前 |

## 调度、任务与存储

| 路径 | 一句话讲什么 | 何时查 |
|---|---|---|
| `docs/subsystems/schedule.zh.md` | Host 持久调度、投递与生命周期限制 | 定时或跨会话提醒时 |
| `packages/schedule/schedule/src/types.ts` | timing、target、create request 精确类型 | 写 `schedule.create` 前 |
| `packages/schedule/schedule/src/index.ts` | ScheduleService 方法与可选参数 | 核对 actorSessionId/signal 时 |
| `docs/subsystems/jobs.zh.md` | 后台任务注册、输出环、终止和事件语义 | 长任务或后台输出时 |
| `packages/jobs/jobs/src/types.ts` | JobSpec、JobHandle、JobEvents 精确类型 | 写 `jobs.start` 或订阅前 |
| `packages/jobs/jobs/src/index.ts` | JobRegistry 的 owner 访问和生命周期契约 | owner、读取、清理语义不清时 |
| `docs/subsystems/storage.zh.md` | storage backend 与领域持久化入口 | 选择插件持久化方案时 |
| `packages/storage/storage-domain/src/index.ts` | `storageDomain.open`、挂载和 close 生命周期 | 开关 Domain 时 |
| `packages/storage/storage-domain/src/spec.ts` | DomainSpec、table、schema 和句柄类型 | 定义类型化 KV 前 |

## Remote 与 Web Client

| 路径 | 一句话讲什么 | 何时查 |
|---|---|---|
| `docs/cookbook/adding-a-remote-api.zh.md` | TypertRemoteService、Remote owner 和 Client 消费方式 | 新增 Host→Client API 时 |
| `packages/experimental/client-ui-forge/src/index.ts` | `@Remote({mode:'stream'})` async generator 实例 | 写自研状态流前 |
| `packages/api/remotes/src/remote-events.ts` | Host→Client 普通事件固定转发白名单 | 假设自定义事件会到浏览器前 |
| `docs/subsystems/web-client.zh.md` | Web 启动、通知不 replay 与恢复要求 | 设计可靠浏览器状态时 |
| `docs/subsystems/client-modules.zh.md` | `dsh.client`、`./client`、包名依赖图 | 配置浏览器 bundle manifest 时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/ui-plugin.md` | UI 包与 lazy factory 的官方约束 | 新建 Client 模块时 |
| `packages/preset/agent-preset/skills/dsh-doc/templates/decoration/package.json` | Host+UI 最小完整 manifest 模板 | 写 UI exports/client 字段时 |
| `packages/preset/agent-preset/skills/dsh-doc/templates/decoration/client.js` | 浏览器 lazy CommonJS factory 最小例 | 写 `./client` 产物时 |
| `docs/subsystems/slots.zh.md` | list/keyed slot、inject 和注册生命周期 | 选择或贡献 UI 插槽时 |
| `packages/client/ui-layout/src/client/index.ts` | `main` root keyed slot 与 layout 服务定义 | 新增主面板前 |
| `packages/client/ui-schedule/src/client/index.ts` | `main` 新 key 与侧栏入口的正式用法 | 写面板注册时 |
| `packages/client/ui-plugin-manager/src/client/index.ts` | `ctx.layout.selectPanel` 实际导航例 | 从入口打开面板时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/practices.md` | 有状态 UI、Host 数据与交互实践 | 超出静态装饰的 UI 前 |
| `packages/preset/agent-preset/skills/dsh-doc/references/user-actions.md` | 插件 UI 用户动作的服务调用方式 | 按钮要修改 Host 状态时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/verification.md` | 安装后 UI/UX 验证边界 | 验证面板真实可见和可交互时 |

## 文件观测与分发

| 路径 | 一句话讲什么 | 何时查 |
|---|---|---|
| `packages/fs/fs/src/index.ts` | `fs/*-intent` single-slot 决策签名 | 考虑文件写入策略前 |
| `packages/fs/tool-fs/src/write.ts` | 官方写工具 `presentationMeta.diffs` 产生处 | 依赖逐文件 diff 时 |
| `packages/fs/tool-str-replace-editor/src/index.ts` | 编辑器 output 无 `presentationMeta` 的证据 | 评估变更观测盲区时 |
| `packages/deliverables/workspace-changes/src/index.ts` | git 快照、file-tool capture 与 subagent 排除 | 汇总工作区变更时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/locate-docs.md` | 安装树内定位包文档与源码的方法 | 路径随部署变化时 |
| `packages/preset/agent-preset/skills/dsh-doc/references/packages.md` | 包目录与能力定位 | 只知道功能名、不知道包名时 |
| `docs/user/develop/basic/publish.zh.md` | 插件发布与分发流程 | 对外发布组合包前 |
