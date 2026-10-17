# 24: HUD + 背包最小 UI

**What to build:** HP/经验/任务 HUD 完整；背包界面：查看物品、使用消耗品、穿装备且属性即时变化（修饰器生效可感知）。最小可用即可，不做全量 UI。

**Blocked by:** 22, 23

**Status:** resolved

- [x] HUD：HP 条、经验条、任务追踪实时反映 GameSession 快照
- [x] 背包：格子列表、使用消耗品生效、装备穿戴后属性面板数字变化
- [x] L4：ego-browser 断言 HUD 与背包状态
- [x] UI 状态全部来自快照（无逻辑泄漏进 UI 层）

## Answer（2026-10-17）

**结论：HUD 与背包/装备 UI 最小可用版本打通，属性变化立即可感知。**

- **逻辑意图**：`GameSession` 新增 `useItem` / `equip` / `unequip`：
  - `useItem(entityId, instanceId)` 按内容 `consumable.effects` 结算（P1 支持 `restore:hp`，
    夹在修饰器后的 maxHp 内），数量减一、归零后实例移除；非消耗品/未知实例/倒下实体显式报错。
  - `equip` 校验 `equipment` 定义，同槽位自动替换（先卸下旧装备），以
    `source = { kind: "equipment", id: instanceId }` 挂修饰器；重复装备幂等。
  - `unequip` 清 `equipped` 标记并按 source id 移除该实例的全部修饰器；两处都做当前生命夹取。
  - 物品定义表由 `loadRegion()` 从 content 完整注册（此前只存 maxStack），供效果/槽位结算。
- **HUD（`src/render/ui/quest-loop-ui.ts` 扩展）**：常驻显示 HP 数值 + HP 条、经验数值 + 经验条
  （阈值来自内容属性 `xpToNext`，`content/regions/green_hollow.json` 新增 100）、攻击/防御
  有效属性、任务名称/状态/击杀进度；`data-testid` 覆盖 `hud-hp` / `hud-hp-fill` / `hud-xp` /
  `hud-xp-fill` / `hud-attack` / `hud-defense` / `quest-hud`。
- **背包**：HUD「背包 (I)」按钮或键盘 I/Esc 开关；装备栏三槽位（武器/护甲/饰品）、物品行显示
  名称/数量/类型/描述，消耗品有「使用」、装备有「装备/卸下」按钮；存档/读档按钮保留。
- **架构边界**：UI 只读 `snapshot()`，所有写操作经 `useItem`/`equip`/`unequip` 意图；UI 自身只
  保存面板开关（纯展示状态），物品静态信息（名称/类型/槽位/修饰器）来自 content bundle。
- **验证**：L1 126/126 绿（新增 `game-session-items.test.ts` 10 例：治疗/数量耗尽/拒绝非消耗品/
  装备属性即时变化/同槽替换/幂等/maxHp 夹取/非法装备/快照往返）；`npm run build`、
  `npm run content:lint` 通过。L4 ego-browser：接任务 → 真实战斗 3 杀 → 受伤 → 复命拿装备 →
  开背包 → 用疗伤草（HP 51→81）→ 装备短剑（攻击 12→17、武器槽显示）→ 卸下（→12）→ 再装备 →
  I 键开关，全部断言通过；报告 `reports/p1-hud-inventory-smoke.json`，截图
  `artifacts/p1-hud-inventory.png`。
