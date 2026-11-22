# dsh-secretary 全局地图

## 边界

本仓只实现阶段 1 插件骨架：秘书 preset、说话/派发/查状态工具、单工作区、事件日志与只读面板。
不包含 gate、待裁队列、多工作区、记忆和像素渲染；不调用真实模型。

## 运行关系

```text
cordis.patch.yml
  ├─ 注册 secretary preset（persona 行：!!js 读取包内 prompts/secretary.md）
  └─ 加载 dist/index.js
       ├─ host.ts：订阅原生事件、按 preset 装配工具、注册只读 GET
       ├─ dispatch.ts：单工作区 sessionId 持久映射、幂等派发与日志状态投影
       ├─ events.ts：唯一 LogWriter → <解析的 DSH home>/.../events.jsonl
       └─ selftest.ts：仅隔离配置下，以固定流驱动真实 Agent Loop

prompts/secretary.md → preset persona.prefix → 会话 system/message
dist/client.js → main keyed 插槽 → GET /api/dsh-secretary.events → 最近 20 条
```

## 源码成员

- `src/index.ts`：Host 入口、按宿主规则解析 home、自检目录检查、唯一写者创建。
- `src/host.ts`：Agent 过滤、工具清单约束、事件订阅和只读接口。
- `src/contracts.ts`：从 rc.5 源码核对的最小宿主结构，仅编译期使用。
- `src/host-types.ts`：宿主契约的统一类型出口。
- `src/constants.ts`：工具名、action、kind、mood 与面板常量。
- `src/say.ts`：`secretary_say` 的校验和事件副作用。
- `src/dispatch.ts`：`secretary_dispatch`、`secretary_status`，工作区映射存 storageDomain。
- `src/normalize.ts`：`session/event`、`tools/result`、`agent/status` 归一化。
- `src/events.ts`：v0 信封、串行幂等写入、失败 outbox、最近事件读取。
- `src/selftest.ts`：隔离自检；固定适配器不访问网络、不读取凭据，并断言 persona 提示词已进入 system/message。
- `src/client.ts`：默认主面板，队首待裁表单与只读事件投影。
- `prompts/secretary.md`：秘书人设系统提示词，由 patch 的 persona 行读取。

## 构建与验收

- `scripts/build.mjs`：清空 `dist` 后转译 TS；不留下未打包裸导入。
- `tests/say.test.mjs`：40 字红例、合法绿例、完整信封。
- `tests/dispatch.test.mjs`：缺验收标准、未配置工作区、因果链与 requestId、幂等、重启复用、单工作区与只读状态。
- `scripts/replay.sh`：隔离 `DSH_HOME` 全链路，以及临时 `HOME`、无 `DSH_HOME` 的默认路径启动。
- `scripts/browser-check.mjs`：Playwright 实测 client 200、零页面错误和只读投影。

证据默认位于 `.local/home/evidence/`；该目录与打包产物均不提交。
规范见 `docs/STANDARDS.md`，事件契约见 `docs/EVENT-LOG-v0.md`。
