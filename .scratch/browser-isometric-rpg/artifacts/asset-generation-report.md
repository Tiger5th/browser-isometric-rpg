# P2 美术资产预生成报告（票 32/35/36/37 + 27 核对）

日期：2026-10-17。生成器：Gemini（ego-browser 登录驱动；同一会话内首条消息上传 anchor-v1.png 风格锚定图，后续全部生成沿用该上下文 + 风格前缀提示词，沿用 P1 第一批环境贴图固化的流程）。全部 22 张候选零失败，md5 去重校验通过（无重复图）。

## 许可证

- 所有图片为本项目工作会话内 Gemini 生成，自用（不商用），无第三方版权素材。
- 音效（票 27）由 27 号票 agent 完成：8 个 CC0 wav 落在其 worktree（agent-a3094c12c8fa7de48）的 assets/audio/，含 SOURCES.md（freesound.org CC0，逐条来源 URL）。本次未重复生成，合并时随票 27 分支入主仓。

## 风格锚定一致性说明

锚定图 anchor-v1.png 定调：清新暖绿草地 + 灰石围墙 + 木质半木结构小屋 + 圆润卡通树 + 柔和饱和配色、45° 等距。每个资产生成时提示词均声明「严格沿用参考图风格」，并按资产类型约束视角（地面瓦片正俯视可平铺 / 立面件 45° 等距白底单件居中）。抽查（logo/背景/巢穴地面/晶簇/茧/冲锋怪/吐弹怪/宝箱/萤光草）观感与锚定一致；巢穴系资产按票 35 要求整体调暗（暗绿苔藓+暗紫灰），与区域 1 拉开氛围但保持同源笔触。

## 清单（候选均落 artifacts/ 供用户挑选；「最佳」为 agent 初选，最终以用户确认为准）

### 票 32 标题画面（artifacts/title-screen/）

| 资产 | 候选数 | 最佳候选 | md5 前 8 位 | 说明 |
|---|---|---|---|---|
| 游戏 logo（Green Hollow/绿洼地） | 2 | logo-c1.png | 4ecfceb2 | 绿木双色+藤蔓+中文小字最完整；c2 为绿渐变+浅金描边变体。1024×572 白底，接入时抠白。正式名定稿后换图 |
| 氛围背景（黄昏村庄 16:9） | 2 | background-c1.png | 4f24afac | 等距黄昏村庄、下方留白干净；c2 为广场灯笼+城堡剪影变体 |

### 票 35 区域 2「史莱姆巢穴」（artifacts/region2/）

| 资产 | 候选数 | 最佳候选 | md5 前 8 位 | 说明 |
|---|---|---|---|---|
| 巢穴地面瓦片 | 2 | ground-c1.png | d599dc4b | 1024² 正俯视可平铺，暗绿苔藓+黏液斑，与 green_hollow 草地同规格同风格 |
| 晶簇 | 2 | crystal-c1.png | 18b4e247 | 淡青蓝/紫罗兰发光晶体+苔藓岩石底座 |
| 黏液茧 | 2 | cocoon-c1.png | 32a3af9c | 半透明暗绿黏液茧挂岩石 |
| 史莱姆蛋 | 2 | eggs-c1.png | fc23b27a | 半透明卵窝 |

正式落位：票 35 实施时挑选后复制进 assets/textures/（命名 environment_*/prop_ 蛇形），并过 assets:lint（瓦片须正方形 2 的幂；prop_ 须 RGBA 白底可抠）。

### 票 36 新敌人（artifacts/enemies/）

| 资产 | 候选数 | 最佳候选 | md5 前 8 位 | 说明 |
|---|---|---|---|---|
| 冲锋型史莱姆（红/黑尖刺） | 2 | charger-c1.png | 31012bf5 | 1024×765 白底 45° 等距，与现有敌人 billboard 同规格 |
| 吐弹型史莱姆（紫/绿大口） | 2 | spitter-c1.png | 3bf7af9d | 同上 |

注：artifacts/enemies/ 下另有 enemy_charger.png / enemy_spitter.png（票 36 实施 agent 并行产出），本批候选（charger-*/spitter-*）与其并存供挑选，不冲突。

### 票 37 探索件（artifacts/exploration/）

| 资产 | 候选数 | 最佳候选 | md5 前 8 位 | 说明 |
|---|---|---|---|---|
| 宝箱关闭 | 2 | chest-closed-c1.png | d2d43398 | 暖棕木+深色金属包边 |
| 宝箱打开 | 2 | chest-open-c1.png | e601b099 | 与关闭态同款开盖+金币宝石金光 |
| 萤光草 | 2 | glowgrass-c1.png | ec665338 | 青绿荧光小草，billboard 用 |

### 票 27 音效（核对结果）

已由 27 号票 agent 完成：assets/audio/ 8 个 wav（attack_hit/hurt/enemy_die/item_pickup/level_up/ui_click/heavy_attack/wind_up）+ SOURCES.md，全部 CC0 1.0（freesound.org，来源逐条见该文件）。本次不重复。

## 已知限制 / 待重抽情形

- 出图为 Gemini 默认 1024 宽，比例随提示词（16:9 背景为 1024×572）；如引擎侧需更高分辨率需重生成或超分。
- AI 平铺贴图的实际无缝性需进引擎 tiling 后目测；若有接缝，重抽该瓦片或后处理修补。
- logo/道具/敌人/探索件均为白底，billboard 接入沿用现有运行时白底抠图管线（keyOutNearWhiteBackground），无需预先抠图。
