# 29: 对话与 NPC 体验——两段式对话 + 立绘 + 角色色板卡

**Spec:** specs/p2-gameplay.md（user stories 22–31）

**What to build:** 两段式对话交互——点击 NPC = 寻路走到对话距离（约 1.5m）不弹框 → NPC 头顶气泡按钮（「对话」，有可接任务时「！」）→ 点击气泡 → 双方互转面对面 → 开对话；距离内点击直接出气泡；对话中玩家移动意图 = 结束对话。galgame 式全屏立绘（屏幕左右两侧，说话方亮/听话方微暗）+ 二次元对话框（半透明深底、角色主色边、名字牌主色）；对话镜头推近 + 背景压暗（仅表现层）。NPC 独立建模贴图（敌人维持占位统一贴图）；**角色色板卡**管线（主色/辅色/点缀色 + 发色服装关键词，3D 贴图与立绘同卡生成，agent 用 ego-browser 走 Gemini 生图）。

**Blocked by:** 无（立绘呈现如复用 27 的 HUD 改动则尾部合流）

**Status:** ready-for-agent

- [x] 两段式交互全流程：远处点击→寻路→气泡→点击→面对面→对话；移动打断对话
- [x] 气泡按钮任务状态区分（无任务「对话」/可接「！」）
- [x] 全屏立绘 + 说话方高亮 + 对话框风格 + 名牌主色
- [x] 对话镜头推近/压暗，结束恢复
- [x] NPC 独立贴图 + 色板卡文档落 content/（每角色一张卡）
- [x] 立绘与 3D 贴图同源同色板（截图对比留档 artifacts/）
- [x] L2：内容 schema 扩展（立绘引用/色板卡字段）lint + 负向测试
- [x] L4：ego-browser 冒烟——两段式对话、立绘切换、移动打断、存读档不回归

## Answer（2026-10-17）

**结论：票 29 完成。两段式对话全流程 + galgame 立绘 + 角色色板卡管线落地，L1 220 测试 / L2 lint 全绿，L4 ego-browser 冒烟 9 个阶段全部通过（含真实指针点击）。**

### 结构

- **逻辑层（L1 可测）**：`src/logic/interaction.ts` 两段式交互状态机（idle→approaching→ready→talking，气泡 talk/quest 区分，移动意图打断，走出范围结束）；`GameSession` 新增 `approachNpc` / `faceNpc` / `endDialogue`，`moveTo` 对玩家提交时结束对话。
- **表现层**：`src/render/ui/portrait-layout.ts` 立绘布局纯计算（NPC 左/玩家右、说话方 brightness 1、听话方 0.55、镜头 span 30→22、压暗 0.35）；`src/render/ui/dialogue-portrait.ts` DOM 呈现（气泡按钮 + 全屏立绘 + 半透明深底主色边对话框 + 主色名牌 + 背景压暗层）；`src/render/presentation/character-palettes.ts` 色板卡运行时桥接（3D tint / 立绘 URL / 名牌描边同源）。
- **内容（L2 合同）**：新增 `content/character-palettes/` 类别（3 张卡：马婆婆/林斥候/旅人），`npc.schema.json` 扩展 `paletteId` 与 `portrait`，`common.schema.json` 新增 `characterPaletteId` 与 `hexColor`（#rrggbb）定义；`validate.ts` / `tools/content/lint.mjs` 接入新类别与 `npc.paletteId` 引用校验。

### 生图（ego-browser → Gemini）

按色板卡关键词生成 3 张全屏立绘，落 `assets/portraits/`（572–687×1024 竖图），`.gitignore` 增加 `!assets/portraits/*.png` 例外。色板卡 `status` 已置 `generated`。

### 测试

- **L1**：220 通过（新增 `interaction.test.ts` 16 项、`game-session-interaction.test.ts` 6 项、`portrait-layout.test.ts` 8 项、`validate.test.ts` 色板卡 9 项）。
- **L2**：`npm run content:lint` 通过（15 文件）；新增 `npm run content:lint:negative`（4 个负向用例全部拦截，报告 `reports/content-lint-negative-test.json`）。
- **L4**：`reports/p29-acceptance-smoke.json`（status passed）：远处点击只靠近（无气泡）→ 到达出「！」气泡（距离 1.46m）→ 点击气泡双方面面对面（yaw ±π/2）+ 立绘（NPC 左亮 1.0 / 玩家右暗 0.55）+ 推近压暗（span 22.0 / dim 0.35）→ 选项接任务后自然结束并复位 → 真实画布点击打断 → 对话中存档刷新后 ink 状态/立绘/推近全部恢复。真实指针点击 DOM 气泡与画布地面均验证通过。

### 截图

`artifacts/p29-dialogue-portraits.png`（立绘 + 对话框）、`p29-dialogue-restored.png`（读档恢复）、`p29-dialogue-real-click.png`（真实点击后）、`p29-portrait-*.png`（3 张色板卡同源立绘）。

### 遗留

- Harness 面板默认仍常驻（规格 36「`?harness=1` 才显示」应随票 27 落地但未实现）——不属票 29 范围，记录待办。
- 表情差分立绘按规格推 P2 主体；3D 贴图按色板卡重新生图属票 30（真实角色接入）范围。
