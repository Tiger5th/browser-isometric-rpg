# 22: 对话 + 任务闭环

**What to build:** 点击 NPC 开始 ink 对话（复用 P0 inkjs 封装），选项推进；对话标签触发任务接取；杀敌目标计数推进（接 21 的战斗事件）；交任务发奖励（物品 + 修饰器，走 20 的数据）。HUD 显示任务目标与进度。

**Blocked by:** 19, 20

**Status:** resolved（分支 worktree-agent-aa910623c14a0d8dc: 4ba7d2d，合并 781a8c8 已含 p1-integration；测试 100/100，build 与 content:lint 通过）

- [x] 点击 NPC → 对话框 → 选项推进 → 对话结束
- [x] 对话标签触发任务接取；杀敌计数推进；交任务发奖励（物品入背包 + 修饰器生效）
- [x] HUD 显示当前任务目标与进度
- [x] L1：任务状态机（可接/进行中/可交/完成）全规则测试绿
- [x] L2：示例任务的对话/敌人/奖励引用完整性通过

## Comments

- **实现位置**：`src/logic/quest.ts`（状态机）、`src/logic/game-session.ts`（对话/事件/奖励集成）、`src/logic/game-events.ts`（事件形状）、`src/render/scenarios/dialogue-quest.ts` + `src/render/ui/quest-loop-ui.ts`（HUD/对话 UI）。
- **对话编译**：`vite.config.ts` 的 `ink-compile` 插件把 `*.ink?ink` 在构建/测试期编译为 JSON 字符串；运行时仍只加载 JSON，不打包 ink 编译器。
- **对话感知任务状态**：ink 必须声明 `EXTERNAL questStatus(questId)`；GameSession 绑定只读查询，供对话按状态分支。状态转移仍只由 `# quest:offer|turnin:<questId>` 标签触发。
- **与票 21 的接口（已合流）**：会话内战斗在 `handleDeath` 里调用 `onEnemyKilled(enemyId, enemyTemplateId, killerId)`，与外部 `session.emitCombatEvent({ type: "enemy-killed", enemyId, enemyTemplateId })` 走同一处理路径；任务目标只按敌人模板计数。票 21 的 `drainEvents()`（attack/death/xp/loot/respawn）保持独立，不受影响。
- **快照版本**：`GAME_SESSION_SNAPSHOT_VERSION` 升至 2（实体增加 baseAttributes/attributes/modifiers/combat/container/claimedRewardIds，顶层增加 `dialogue` 与 `quests`）。
- **浏览器冒烟**：ego-browser 驱动 dialogue-quest 场景完成「接取 → 用真实战斗击杀 3 只史莱姆 → 复命」，HUD 显示 3/3/已完成，背包出现旅人短剑 ×1、疗伤草 ×2，maxHp 100 → 110。
