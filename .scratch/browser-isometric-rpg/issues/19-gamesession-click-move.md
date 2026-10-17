# 19: GameSession 骨架 + 点击移动

**What to build:** 游戏逻辑核心 GameSession（src/logic，零渲染依赖）：持有 Entity 集合与游戏时钟，暴露 snapshot()（可序列化）与 intent 接口（moveTo 起）。玩家角色实体进入 GameSession；渲染层消费快照 + 提交移动意图，经 Crowd V2 在灰盒区域移动。玩家点击地面，角色走过去。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 页面中点击地面，玩家角色（P0 角色工厂）经 Crowd V2 走到目标点
- [ ] GameSession 可在 node/vitest 中纯逻辑驱动（时间步进手动推进，无引擎依赖）
- [ ] L1：移动意图 → 位置变化 → 快照可序列化，测试全绿
- [ ] 渲染层只读快照 + 提交意图，不直接改逻辑状态（代码结构可审查）
- [ ] P0 Harness 保持可用（不回归）
