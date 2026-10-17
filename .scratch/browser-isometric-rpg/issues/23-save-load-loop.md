# 23: 存读档闭环

**What to build:** GameSession.snapshot() → IndexedDB 持久化（接 P0 迁移链雏形，接正式版本号策略）；读档 = 快照恢复 + 渲染层重建。手动存档点 + 读档后实体/任务进度/对话位置/背包全部还原。

**Blocked by:** 19, 20, 21, 22

**Status:** resolved

- [x] 存档 → 刷新页面 → 读档：实体位置/属性/背包/任务进度/经验全部还原
- [x] 对话中存档读档后对话状态恢复（或按设计回到对话开始，决策记录）
- [x] 迁移链接入正式存档版本号；模拟一次 v1→v2 迁移演练
- [x] L1：快照往返测试绿；L4：ego-browser 刷新读档验证

## Answer（2026-10-17）

**结论：存读档闭环打通。** 存档 = `{ version: 2, sections: { session: GameSessionSnapshot } }`，
写 IndexedDB 槽位 `browser-isometric-rpg/saves/slot-1`；读档 = 迁移链 → 校验 → 快照恢复 → 渲染层重建。

- **快照恢复**：`GameSession.restoreSnapshot()` 完整还原实体位置/朝向/标签/基础属性/修饰器/背包/
  已领奖励账本、移动意图、战斗运行时（生命/存活/AI 状态/目标/冷却）、游戏时钟、重生计时、
  物品实例序号、ink 对话执行状态（文本与选项与存档点一致，可继续选择）与全部任务进度。
  恢复不广播事件；快照实体必须已存在，会话多出的内容实体保持默认（兼容旧存档只含玩家）。
- **快照 v2 字段补充**：顶层新增 `regionId` / `nextItemInstanceId` / `respawnAtMs`。
- **持久化边界**：逻辑层只定义 `SaveStorage` 适配器接口 + `GameSaveService`；IndexedDB 实现在
  `src/render/persistence/indexed-db-save-storage.ts`，`src/logic` 保持零浏览器依赖。
- **迁移**：`SAVE_VERSION = GAME_SESSION_SNAPSHOT_VERSION = 2`，P0 迁移链复用；v1（world/player/
  quests，物品 `{id, qty}`）→ v2（完整 session 快照）有正向演练 + 缺 player/非法背包/非法 quests
  负向测试。未来版本存档拒绝加载。
- **手动入口**：dialogue-quest HUD 增加「存档 / 读档 / 删除存档」按钮与状态行
  （`data-testid="save-status"`）；刷新页面后场景 setup 自动读档、重建网格与 HUD。
- **对话存档决策**：对话中存档按“精确恢复”处理（不是回到对话开始）——ink 状态已经在
  `dialogue.story.inkState`，L1 与 L4 均断言文本/选项一致且可继续推进。
- **验证**：L1 116/116 绿（新增 7 例存档往返 + 21 例存档编解码/迁移/服务）；`npm run build`、
  `npm run content:lint` 通过。L4 ego-browser：存档→刷新→自动读档 17/17 断言通过，
  报告 `reports/p1-save-load-smoke.json`，截图 `artifacts/p1-save-load-after-reload.png`。
