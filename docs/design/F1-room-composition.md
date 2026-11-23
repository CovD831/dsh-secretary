# F1 房间组合 · 元素拆分 / 深度排序 / 开源参照

> 2026-11-23 · 范围：本文件只覆盖调研卡第 1 项（游戏通用做法）与第 2 项（开源核实）。
> 素材生产方案、自定义形象管线由另一线负责，本文不重复。
> 标记：**F** = 已核实事实（源码/官方文档/仓库元数据）；**I** = 本文推断，需实机验证。

## 1. 结论先行：房间该怎么拆

**四层结构（F：与 Tiled 的分层模型、pixel-agents 的渲染分层一致）**

| 层 | 内容 | 渲染方式 | 深度 |
|---|---|---|---|
| L0 地面 | 地砖、地毯、门槛条 | 一个 tile layer，整层一个深度 | 最先画 |
| L1 墙 | 后墙立片、左墙、右墙残段、压顶、踢脚、门窗 | 一个 tile/对象层，整体画在地面之上 | 第二个画 |
| L2 实体 | 家具、角色、绿植、纸篓 | **独立 sprite，统一进一个 y 排序域** | 逐件按脚底 y |
| L3 覆盖 | 屏幕光、状态光晕、徽记、对话框 | 顺序固定，不进排序域 | 最后画 |

- **家具必须是 sprite，不能是地砖**（F：Tiled 的 tile layer 每格只能存一个 gid 与翻转位，放不下 footprint/锚点/镜像；家具在 Tiled 里应放对象层的 tile object）。这一点与旧仓现状一致，但旧仓 tmj 只带像素宽高，缺"几格"这一层语义。
- **墙挂件（窗/画/挂钟）单独走"墙面参数"**：只有 `at`（沿墙格位）和 `h`（离基线高度）两个自由度，按 L1 层顺序画、不进 y 排序域（F：旧仓 §69/§72 已按此实现并有读数；本项目沿用即可）。
- **剖面做法**：只画后墙 + 左墙，右墙仅留 16 原生高踢脚，墙永远画在人物之下 ⇒ 不存在"人走到墙后被挡"的问题；遮挡只发生在 L2 内部（F：等距 2:1 剖面的常规做法，Excalibur 文档的 iso 排序只对实体内生效）。
- **深度键**：`depth = 锚点脚底 y`（屏幕像素，整数），次键用对象 id（稳定，避免同 y 抖动）。不要只按 `u+v` 排（格子粗，桌子与椅子会整格同深）；也不要用包围盒中心（会漏掉"上沿遮挡"）。pixel-agents 的实测写法是 `zY = y + TILE/2` 升序，并给角色加一个小常量使其站在椅前、桌后（F：其 renderer.ts 源码注释与实现）。
- **多格家具**：每件带 `footprint {fw,fh}`、`anchor`、`backgroundRows`（只画不占格的行）、`surface`（能否放桌面物）、`mirror`、`rotationGroup`。占用集 = footprint 减 backgroundRows；桌面物依附父件而不是占地面格（F：pixel-agents furnitureCatalog 字段原名 footprintW/H、backgroundTiles、canPlaceOnSurfaces、canPlaceOnWalls、rotationScheme、mirrorSide，源码已核对）。

**需要改 F1 规格的项（3 条，均需老板点头）**
1. §4 资产清单给每件补元数据：`footprint / anchor / mirror / surface / backgroundRows / rotationGroup`。这是 ①房型生成 ②家具预设 ③自定义摆放 三件事共用的唯一真值表；**没有这张表，后三件事全部无从谈起**（F：pixel-agents 的整组随动、旋转换帧都依赖它，旧仓调研 §M1 已判它为地基）。
2. §3/§4 写明深度规则：L2 内 `depth=footY`，同值用 id 决胜；墙挂件不入排序域。
3. 家具原生粒度：若沿用 32×16 地砖，家具只能按 1 格出图；建议家具按"2× 网格 = 64×32 一格"出图，与素材线的原生尺寸一并裁决（**I**：这是唯一能让多格家具与 2× 显示同时成立的做法，但尺寸数值归素材线定）。

## 2. 游戏通用做法摘要

1. **地面走网格、家具走对象**：tile layer 只存"哪一格是什么地形"，对象层存"哪件家具、在哪个像素、多大"；这是 Tiled 分层的原始设计（F：doc.mapeditor.org《Working with Layers》《Working with Objects》）。
2. **等距坐标换算**：`screenX=(u-v)*tw/2`，`screenY=(u+v)*th/2`；2:1 只是 `th=tw/2` 代入（F：Clint Bellanger《Isometric Tiles Math》同一公式，Tiled 采用此法）。反算拾取用同一对公式求逆，误差随整数取整累积，需在格中心判定。
3. **深度 = 脚底 y 升序**：先画靠后的，后画靠前的；同 y 用稳定次键（F：pixel-agents、Excalibur IsometricEntityComponent 均由 transform 生成 z-index）。
4. **锚点是资产的一部分**：家具锚在 footprint 的底边中点，角色锚在脚底中心；渲染时 `x - w*0.5, y - anchorY`（F：pixel-agents 用底中锚并取整；iso-room-pixi 预设 `(0.5, 0.875)`）。
5. **旋转 = 换帧，不是转位图**：2:1 等距里素材只有 4 个斜向，旋转只能是"换朝向帧"或"水平镜像"；镜像对无文字的家具安全（F：pixel-agents `rotateFurniture` 换 type；旧仓 §70 已按镜像落地）。
6. **墙挂物是墙面参数，不是地面格**：`at` 沿墙、`h` 离基线；拖拽反解只用水平分量，别用垂线投影（F：旧仓 §69 实测，垂线投影在 140px 抓高处偏 0.875 格）。
7. **剖面切墙**：背墙+左墙+右墙残段三者独立，压顶单独一片；墙不参与 y 排序（I：这是 2:1 剖面在像素游戏里的通行取舍，代价是"不能表现多层/门厅"，我们也不需要）。
8. **整组随动**：桌 + 桌上物是一个原子，拖/转/复制/撤销都按整组算；整组放不下就整体不动（F：pixel-agents 的 `groupFits` + 17 条 e2e 标题，源码与用例均已读到）。
9. **占位不是单点**：多格件占 footprint 的全部格，背景行（如墙挂件上半、地毯）不占（F：同上 `getPlacementBlockedTiles`）。
10. **撤销粒度 = 一次手势**：拖 5 格只产生 1 条撤销（F：同上 `undoSession`）。这条直接影响"自定义摆放"的手感，建议直接借。

## 3. 开源项目（全部经 GitHub 页面/API 核实存在、许可、最近活跃）

| 项目 | ★ | 许可 | 最近活跃 | 做什么 / 可借鉴 |
|---|---:|---|---|---|
| pixel-agents-hq/pixel-agents | 10,333 | MIT | 2026-11-20 | TS+Canvas2D 的"agent=像素小人"办公室（**正交 16px，非等距**）。借它的家具元数据表、整组随动、旋转换帧、手势级撤销；渲染与坐标不借 |
| GeorgeQLe/iso-room-pixi | 0 | MIT | 2026-08-04 | PixiJS 8 的真等距房间引擎 + 命令历史 + 校验 + React 编辑器。借命令即撤销的 schema、2:1 预设参数与 `(0.5,0.875)` 锚点约定（星少，只作读本） |
| open-hotel/open-hotel-client | 117 | MIT | 2023-04-04 | PixiJS+Vue 的 Habbo 式等距客户端。借 `cartToIso(x,y,z)` 的 z 参与换算与 ZIndexUtils；**家具摆放未实现**，久未更新 |
| excaliburjs/Excalibur | 2,380 | BSD-2 | 2026-11-19 | TS 2D 引擎，`IsometricMap` + `IsometricEntityComponent` 由 transform 自动生成 z-index。借"实体自带排序组件"的接口形状，不引入引擎 |
| workadventure/workadventure | 5,949 | AGPL-3 + Commons Clause | 2026-11-21 | 虚拟办公室（Tiled 地图，starter 图分层 floor/walls/furniture/aboveFurniture/abovePlayer）；**许可不可抄代码**，只借它的"above*"分层命名与 16-bit 办公室信息架构 |
| mapeditor/tiled | 13,085 | 应用 GPL / libtiled BSD-2 | 2026-11-21 | 地图编辑器与 TMJ/JSON 格式：`orientation=isometric`、对象层 `draworder`、tile object。我们沿用其 JSON 作为房型与摆放的交换格式；不嵌编辑器，只做格式兼容 |
| phaserjs/phaser · pixijs/pixijs | 40,768 · 48,881 | MIT · MIT | 2026-08-21 · 2026-11-20 | 渲染底座。Pixi 无内置 Tiled 解析，Phaser 有 Tiled loader；**I**：我们已有自绘渲染，不建议此时换底座 |

> 已排除：`ringhyacinth/Star-Office-UI`（代码 MIT、美术仅限非商业学习，图不能进仓）；`victorqribeiro/isocity`（MIT，4.7KB 最小等距读本，无编辑器，仅作公式参照）。

## 4. 需老板拍板（≤3）

1. 家具元数据表是否作为"房型生成 / 家具预设 / 自定义摆放"三者共用的唯一真值（推荐：是，先立表再谈生成算法）。
2. 家具原生粒度用 1 格（32×16）还是 2× 网格（64×32 一格）出图 —— 与素材线合并裁决。
3. 是否沿用 Tiled JSON 作为房型/摆放存档格式（推荐：沿用，旧仓编辑器已按 tmj 消费）。