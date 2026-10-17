# 32: 主界面与开屏演出

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 7–11）

**What to build:** 标题画面 DOM/CSS 层（复用 loadingGate 黑场基建）：logo（Gemini 生图，风格锚定同源，游戏名暂用工作代号占位图）+ 氛围背景 + 版本号；「继续游戏」（有档时；多槽时先选槽）/「新游戏」（有档时二次确认）入口；logo 演出（标题字淡入 + 雾气/粒子 CSS 动画，2–3s 可跳过）；进入游戏黑场过场衔接。设置页不做；静音按钮已在票 27 HUD。

**Blocked by:** 31（读槽位）
**Status:** ready-for-agent

- [x] 打开游戏先见标题画面，继续/新游戏入口逻辑正确（有档/无档分支）
- [x] 新游戏在存在存档时二次确认，不误覆盖
- [x] logo 演出动画 + 可跳过；进入游戏黑场衔接流畅
- [x] logo 生图落 artifacts/ 风格锚定同源（agent ego-browser 生成，附用户审美确认截图）
- [x] L4：标题→继续→读档→游玩→重开标题→新游戏确认 全流程冒烟（reports/）
- [x] 无档首启不显示「继续游戏」不报错

- L4 报告：`reports/ticket32-l4-title-screen.json`，截图 `artifacts/ticket-32-title-screen/`
- 逻辑层判定：`src/logic/title-menu.ts`（L1）；DOM 层：`src/render/ui/title-screen.ts`；装配：`src/render/ui/title-flow.ts`
