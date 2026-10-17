# 36: 两种新敌人 AI——冲锋型与吐弹型

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 25–27）

**What to build:** 冲锋型：chase 后加 windup（0.6s 明显前摇，配合票 27 前摇提示）→ charge（直线高速，路径命中判定一次）→ recovery 硬直（走位躲开后可白打）；冲锋被硬碰撞挡停。吐弹型：ranged-kite（保持攻击距离，玩家接近则后撤），投射物为逻辑层实体（位置/速度/命中在 GameSession，表现层只渲染）。敌人模板 schema 扩展 aiProfile 字段（chaser/windup-charge/ranged-kite）。两种敌人独立外形贴图（Gemini，色板卡管线顺路）。死亡轻惩罚顺路落地：复活回村出生点 + 扣 10% 金币（向上取整，无金币则免）。

**Blocked by:** 27（前摇提示/事件地基）
**Status:** done（2026-10-17，分支 worktree-agent-afafb16dc7d3ee753）

L1 12 项（`src/logic/game-session-enemy-ai.test.ts`）+ L2 5 项（`validate.test.ts` 新增组）全绿；全仓 309 项 vitest 通过，`content:lint` 16 文件通过，`npm run build` 通过。L4 冒烟报告 `reports/ticket36-l4-enemy-ai.json`，截图 `artifacts/p2-enemy-ai-*.png` + 贴图留档 `artifacts/enemies/`。

- [x] L1：冲锋状态机序列（windup→charge→命中/挡停→recovery）+ 走位躲避可行（vitest）
- [x] L1：吐弹 kiting 行为 + 投射物命中判定 + 玩家受击事件
- [x] L2：aiProfile schema 正负向
- [x] 两种敌人独立贴图落 assets/（artifacts/ 留档）——注意：这一版是 `tools/pipeline/build-enemy-textures.mjs` 的程序化色板卡精灵，不是 Gemini 生成图（生成管线不在仓库内）；换成 Gemini 产物只需覆盖 assets/enemies/ 两张 PNG
- [x] 死亡惩罚：回村复活 + 金币扣除 + 快照往返（L1）
- [x] L4：两种敌人实战冒烟（躲冲锋/被迫接近吐弹怪）（reports/ + artifacts/）

## 落点

- 逻辑层：新模块 `src/logic/enemy-ai.ts`（档案解释、直线冲锋位移、kiting 决策、投射物步进、金币罚则，全部纯函数）；`GameSession` 接进状态机（`EnemyAiState` 新增 `windup-charge`/`charge`/`recovery`/`kite`），新增 `setWorldObstacles()`（硬碰撞来自票 28 `buildPropColliders`，navmesh 同源）与 `projectileSnapshots()`。
- 事件（`src/logic/game-events.ts`）：`attack-windup-started` 复用（冲锋前摇 `heavy: true`）、新增 `charge-blocked`/`projectile-spawned`/`projectile-removed`/`item-lost`/`player-death-penalty`。
- 内容：`content/enemy-templates/{charger,spitter}.json`（带 `aiProfile`）+ `content/enemies/{charger_meadow,spitter_pond}.json`；`region.player.startingItems` 给玩家 25 枚金币（死亡惩罚的扣币对象）。schema 扩 `common.aiProfile`、`enemyTemplate.aiProfile`、`region.player.startingItems`。
- 表现层：`src/render/presentation/enemy-textures.ts`（抠白精灵贴图）+ `createSpriteEnemy()` billboard；p1-world 每帧从 `projectileSnapshots()` 同步投射物球；新增 `P1WorldDebug.getEnemyAiEvidence()`。
- 快照：**未改结构**（仍是 v3）。扣币走背包物品、投射物与冲锋链路是瞬态（同前摇，读档后重新起手）。
