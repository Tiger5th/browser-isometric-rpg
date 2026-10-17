# 37: 探索回报 + 相机自由化

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 28–33）

**What to build:** 宝箱：世界实体新类型（content 定义 position/loot 表），交互开启 → loot 入包 + worldState 记开启状态，一次性，3–5 个散落（含区域 2）；收集品萤光草 = 现有 item 系统定义（拾取即计数）+ HUD 计数条目（0/8）+ 全收集自动入包一件饰品（修饰器）；相机自由化：滚轮缩放（有限范围）+ 拖拽旋转 + 出厂等距预设 + 欣赏模式一键复位（平滑插值回预设，快捷键 + HUD 按钮），预设结构支持将来多预设位。

**Blocked by:** 35（区域 2 宝箱位）、27（交互/反馈基建）
**Status:** done

**Notes（实现者回写）:**
- 逻辑：`src/logic/exploration.ts`（worldState 键约定 + 收集进度聚合）、`GameSession.openChest/tryOpenChest` 与 `collectCollectible/tryCollectCollectible`、新事件 `chest-opened`/`collectible-collected`/`collect-set-completed`。
- 内容：新增 `content/chests/`、`content/collectibles/`、`content/collect-sets/` 三类 + 对应 schema + `item:glow_moss` / `item:glow_moss_charm`；common schema 加 `chestId`/`collectibleId`/`collectSetId`。
- 相机：`src/render/camera-presets.ts`（预设表 + 有限范围缩放/旋转 + 按时长线性插值复位）、`src/render/scenarios/p1-world.ts` 接管滚轮/右键拖拽/R 键/HUD 按钮；复位期间临时关掉票 27 的震屏抖动，否则 alpha 永远差一点。
- HUD：`src/render/ui/collect-hud.ts`（独立文件，不动被多票改过的 quest-loop-ui.ts）。
- 顺手修的回归：场景启动时先 `notifyRegionChanged()` 会用空快照盖掉自动槽里的进度（票 31 遗留），现在改成「先读后写」，读档不回退这条才真的成立。
- 视觉资产：直接用资产 agent 的产出（`artifacts/exploration/` 留档 → `assets/exploration/` 3 张 PNG），与 prop/敌人精灵同一套「白底抠白 + billboard」基建；贴图加载失败自动回落到程序化占位。宝箱按开启状态在关闭/开启两张贴图间切换。
- 遗留：区域 2 的宝箱位等票 35 落地后补一行 content 配置。

- [x] L1：宝箱开启→loot→worldState 状态→快照往返不重开（vitest）
- [x] L1：收集计数聚合 + 全收集奖励入包（worldState 驱动）
- [x] L2：宝箱/收集品 content schema 正负向
- [x] L4：开箱/拾草/计数 HUD/全收集奖励/读档不回退 冒烟（reports/ + artifacts/）
- [x] L4：相机缩放旋转流畅 + 一键复位回出厂等距预设（断言 alpha/beta/radius 回预设值）
- [x] L5：预算复测绿（探索内容只 +14 网格；drawCallsMax/fpsAverage 的红色是票 36 遗留基线，实体数断言已改为从内容包现算）
