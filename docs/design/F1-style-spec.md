# F1 风格规格 · 等距像素办公室

> 冻结版 v1（2026-11-23）。依据：PRD §2.2 / §4 前端支线 F1；旧仓需求 §32、§33；PIXEL-ROOM-ENTRY-SPEC。改动需老板点头。

## 1. 风格定义

**一句话：一间暖木色的等距 2:1 像素剖面办公室——环境低饱和、1px 深描边、原生像素；只有屏幕光与状态徽记使用高饱和自发光色。**

语义约束：房间=一个工作区；团队拉起=worker 从门口走进并坐到工位，解散=起身走出门口；首版只有这一间房。完成类事件只改屏幕光与坐姿，不弹对话；待裁与卡住才进对话框。

| 参考 | 借什么 | 不借什么 |
|---|---|---|
| Stardew Valley（2016，ConcernedApe） | 木作与墙面的材质分层、生活化密度、小场景暖色 | 角色、地图、具体家具造型与布局 |
| Graveyard Keeper（2018，Lazy Bear Games） | 等距斜俯视下人物/家具比例、深色描边、剖面墙可读性 | 哥特题材、角色、美术 |
| Habbo Hotel（2000，Sulake） | 房间=界面、瓦片吸附、立绘与房间分层 | 扁平画风、房间布局、角色 |

> 三张只作方法参照，不复刻任何具体游戏的角色、美术或布局。素材只允许一个来源：同一 AI 模型 + 同一提示前缀 → 冻结色板量化 → 规格检查；禁混用 CC0、手绘或程序绘制素材。

## 2. 冻结色板（46 色）

唯一真值；新增色只能替换，总数保持 46。

- 墙 6：`#3A2E28` `#5A463A` `#7A6150` `#9C8069` `#BFA48C` `#D9C4A8`
- 木作 4：`#4A3428` `#6B4A32` `#8A6242` `#A87A52`
- 地面 4：`#3B2A22` `#5E4130` `#7C5A3E` `#96704C`
- 描边 2：`#1A1412` `#2C211B`
- 家具 6：`#2E2A2A` `#4A4440` `#6E665E` `#8C8478` `#3E4A44` `#6B3A32`
- 皮肤/头发 6：`#D8C0A8` `#C09070` `#8F6046` `#2A2220` `#7A5438` `#C9C0B4`
- 衣物 5：`#3F5A78` `#7A3A3A` `#4A6A50` `#D8D0C0` `#6B7F96`
- UI 5：`#201A18` `#302722` `#4A3C34` `#E8DCCB` `#C9A46A`
- 状态 8：工作中 `#2FA8E0`/`#17688F`，卡住 `#F2A93B`/`#A86A17`，待裁 `#E8544E`/`#9E2F2C`，完成 `#3FCB6B`/`#247A42`

| 状态 | 亮部 S / L | 暗部 S / L |
|---|---|---|
| 工作中 | 74.1% / 53.1% | 72.3% / 32.5% |
| 卡住 | 87.6% / 59.0% | 75.9% / 37.5% |
| 待裁 | 77.0% / 60.8% | 56.4% / 39.6% |
| 完成 | 57.4% / 52.2% | 54.4% / 31.0% |

非状态材质 31 色（墙/木/地/家具/皮肤/衣物）的饱和度 4.5%–39.2%（中位 29%），状态色 S 54.4%–87.6%，下限比环境上限高 15.2 个百分点；状态亮部明度集中 52.2%–60.8%。

状态色只用于自发光像素（屏幕、指示灯、徽记、2px 光晕）和 UI 状态点，永不作材质填充；环境材质不用与四态同相的高饱和蓝/绿。四态另配形状副编码：工作=稳亮横条、卡住=断条慢闪、待裁=三角叹号、完成=对勾常亮，保证红绿色觉异常也可分辨。

## 3. 尺寸与布局

原生画布 720×450，显示 2× = 1440×900。所有坐标均为 **1440×900 显示像素**。

| 项 | 原生尺寸 | 显示尺寸 | 规则 |
|---|---|---|---|
| 地砖 | 32×16 | 64×32 | 严格 2:1；房间 16×12 格 |
| 房间地面 | 448×224 | 896×448 | 地面中心 (720,380)，下沿 y=604 |
| 墙 | 后墙高 64 / 左墙 48 / 厚 16 / 压顶 8 | 128 / 96 / 32 / 16 | 留后墙+左墙；右墙只留 16 原生高踢脚 |
| 人物 | cell 32×48，内容 24×36，脚底锚点 (16,44) | 64×96 | 坐姿同 cell 底部对齐 |
| 立绘 | 192×240 | 384×480 | 左下 (40,404)，下沿 884 |
| 对话框 | 720×140 | 1440×280，y=620 | 内边距 24，硬角 4px |

- 文本区 x=440 y=640 w=960 h=88，字号 28/行高 40，最多 2 行（40 字）。
- 选项区 x=440 y=744 h=72，3 列 ×312，间距 8；标签 20px、后果 14px。
- 底行 y=836 h=36：附言 440..920，剩余待办 944..1120，历史回看 1140..1400。
- 立绘压住房间左下角；z 高于房间、低于模态。面板 2px `#4A3C34` 外框、1px `#C9A46A` 内金线，无模糊阴影。
- 只允许整数 2×/3×/4×；禁止 1.25/1.5/1.75 与 CSS 小数缩放。位图 `image-rendering: pixelated`，Canvas 关 `imageSmoothingEnabled`，相机 zoom 只取整数。
- 生成物先整数倍降采样到原生尺寸再入库；非整数尺寸直接判废。F1 只保证 ≥1440×900，更小窗口不缩像素。

## 4. 资产清单（v1 一间房）

摆位：双开门在左墙近前景端；前台贴门内侧、秘书朝右；主位在后墙中线偏右；3 个工位沿右墙与前景左列；主通道留 2 格宽。

| 类 | 内容 | 数量 |
|---|---|---|
| 地形 | 木地板底版+3 变体、2 种边缘压条、2×2 地毯、门槛条 | 8 |
| 墙/门 | 后墙、左墙、右墙残段、压顶、踢脚、窗、挂钟、软木板、双开玻璃门 | 9 |
| 前台 | 3×2 桌、椅、电话、文件盘、黄铜台灯 | 5 |
| 主位 | 4×2 桌、皮椅、双显示器、台灯、散落图纸 | 5 |
| 工位 ×3 | 每套：2×2 桌、任务椅、显示器、键盘、马克杯、绿植；同款复用 | 6/套 |
| 共享 | 书架、落地绿植、饮水机、纸篓 | 4 |
| 屏幕光 | 熄灭底板 + 四态覆盖 ×2 帧 | 9 |
| 角色 ×3 | 共用 24 格帧表：站 4 向、走 4 向×4、坐 2 向、打字 2；秘书/Lead/worker 只换衣物色、发型与肤色 | 3 套 |
| 立绘 | neutral / working / happy / concerned 各 1（对应 `src/constants.ts` 的 `MOODS`） | 4 |
| 动效 | 门 4 帧、gate 扫描 3 帧、纸页 2 帧、椅转身 2 帧 | 11 |
| UI | 九宫格面板、按钮 3 态、选项片、附言框、计数徽章、历史图标 | 7 |

| 屏幕态 | 颜色 | 图案 | 副编码 |
|---|---|---|---|
| 工作中 | `#2FA8E0`/`#17688F` | 稳亮横条 + 1px 扫描 | 常亮 |
| 卡住 | `#F2A93B`/`#A86A17` | 断条 + 警告点 | 1.2s 慢闪 |
| 待裁 | `#E8544E`/`#9E2F2C` | 三角叹号 | 0.6s 双闪 |
| 完成 | `#3FCB6B`/`#247A42` | 对勾 | 常亮 2s 后降到 40% |
| 熄灭 | `#201A18` | 无 | — |

> mood 到立绘是确定性查表：`neutral→portrait_neutral.png` 等四个固定文件，不做实时表情合成。gate 拦截动效固定为：被拦对象头顶红色警示框 2 帧 + 脚下扫描线 3 帧 + 停步后退半步 + 屏幕切待裁色，秘书切 concerned。所有小人动作由「事件类型→动作」表驱动，不做随机游走。

## 5. 生图提示词模板

通用前缀（英文，附色板图一起送入）：

```text
isometric 2:1 pixel art, cozy cutaway office, warm walnut and cream palette,
native-resolution pixel clusters, 1px dark outline at final 1x, low-saturation environment,
no anti-aliasing, no gradients, no text, transparent background, single asset centered,
4x render with 4px square blocks; palette limited to the attached 46 swatches.
```

- 地砖：`seamless 2:1 isometric wood plank floor tile, 32x16 native, warm walnut boards with subtle grain and two-tone ordered dithering, 1px #1A1412 edge outline, transparent background, flat lighting.`
- 墙：`cutaway office back wall segment, 64px tall, cream plaster #BFA48C over walnut baseboard #4A3428, 8px top cap, 1px dark outline, straight front elevation, transparent background.`
- 门：`double glass entry door in dark walnut frame, brass handle, 64x64 native, 2-tile wide, 1px outline, transparent background.`
- 前台：`3x2 tile reception desk, walnut body, cream inset top, brass desk lamp, phone, paper tray, 80x40 native, isometric 2:1, transparent background.`
- 主位桌：`4x2 tile executive desk, darker walnut, leather chair, dual monitors, desk lamp, loose papers, 96x48 native, isometric 2:1, transparent background.`
- 工位：`2x2 tile compact workstation, walnut desk, task chair, monitor, keyboard, mug, small plant, 64x32 native, isometric 2:1, transparent background.`
- 屏幕四态：`one 16x12 monitor silhouette, five variants off/blue/amber/red/green, status glow only on screen and 2px halo, identical geometry, transparent background.`
- 角色表：`isometric character sprite sheet, 6x4 grid of 32x48 cells, content 24x36, facings NE/NW/SE/SW, idle 4 frames, 4-frame walk, seated and typing poses, feet anchor bottom center, 1px outline, transparent background.`
- 立绘：`bust portrait of a warm attentive secretary, 3/4 view, navy blouse #3F5A78 and cream collar #D8D0C0, 192x240 native, expressions neutral/working/happy/concerned on separate files, 1px outline, transparent background.`

后处理规格检查（全过才入库）：

- 透明：alpha 仅 0/255，角像素 0；不用品红键，不留半透明灰边。
- 色板：逐像素量化到 46 色（Oklab 最近色），越界像素 = 0；输出直方图。
- 尺寸：裁到内容 bbox，按整数倍缩到原生，补透明到 cell；写锚点 JSON。
- 描边：外轮廓 1px `#1A1412` 闭合，内部结构线 `#2C211B`；发光边缘用状态暗部色，不用纯黑。
- 网格：地砖菱形严格 32×16，家具脚落整数格，人物脚底 (16,44) 不漂浮。
- 清晰度：2×/4× 最近邻复查无灰边；半透明像素 0、非色板像素 0。
- 一致性：同一模型、同一前缀批量生成；任一资产与冻结样张并排有色相/描边差异即整批退回。

## 6. 样张验收标准

老板只看下面 7 条；全过才进 F2，任一不过只改样张、不扩产。

1. 3 秒读房：门口前台、主位 Lead、3 个工位一眼可分，不靠文字标签。
2. 像素：素材 1× 与页面 2× 都硬边、无模糊、无小数缩放；放大不出现灰边。
3. 色板：房间与立绘区域颜色数 ≤46（UI 文本抗锯齿除外），环境低饱和，除四态外没有抢眼高饱和色。
4. 四态：工作中/卡住/待裁/完成在 2px 光晕下仍可区分；场景亮三盏，第四态在灯带胶片给出；副编码形状成立。
5. 人物：坐姿臀线贴桌沿、脚踩地；三人只靠衣物/发型区分，不靠体型；与家具比例一致。
6. 立绘：四表情在同一张脸上可读，眼/眉/嘴差异明确；与房间画风无断层。
7. 对话与 gate：40 字不溢出、3 选项和后果同屏、附言/计数/历史可见；gate 拦截在 0.6s 内读出「被挡住」且秘书切 concerned。

## 7. 待老板拍板

1. **地砖档位**：32×16 原生 + 2× 显示（推荐，资产量与可读性平衡）／16×8 原生 + 3× 显示（更细，资产量约 ×1.6–2）。
2. **立绘位置**：384×480 压住房间左下角（推荐，表情可读）／收进对话框缩到 240×300（房间更完整，表情变弱）。
3. **待裁色**：`#E8544E` 正红（推荐，打断感强）／`#D63C8C` 品红（与「错误」区分，但更刺眼）；同时确认四态形状副编码。
## 老板裁定（2026-11-23）
- 地砖 32×16 原生、2× 显示；立绘 384×480 压房间左下角；待裁色正红 #E8544E（冻结色板不变）。
