# 37: 探索回报 + 相机自由化

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 28–33）

**What to build:** 宝箱：世界实体新类型（content 定义 position/loot 表），交互开启 → loot 入包 + worldState 记开启状态，一次性，3–5 个散落（含区域 2）；收集品萤光草 = 现有 item 系统定义（拾取即计数）+ HUD 计数条目（0/8）+ 全收集自动入包一件饰品（修饰器）；相机自由化：滚轮缩放（有限范围）+ 拖拽旋转 + 出厂等距预设 + 欣赏模式一键复位（平滑插值回预设，快捷键 + HUD 按钮），预设结构支持将来多预设位。

**Blocked by:** 35（区域 2 宝箱位）、27（交互/反馈基建）
**Status:** ready-for-agent

- [ ] L1：宝箱开启→loot→worldState 状态→快照往返不重开（vitest）
- [ ] L1：收集计数聚合 + 全收集奖励入包（worldState 驱动）
- [ ] L2：宝箱/收集品 content schema 正负向
- [ ] L4：开箱/拾草/计数 HUD/全收集奖励/读档不回退 冒烟（reports/ + artifacts/）
- [ ] L4：相机缩放旋转流畅 + 一键复位回出厂等距预设（断言 alpha/beta/radius 回预设值）
- [ ] L5：预算复测绿
