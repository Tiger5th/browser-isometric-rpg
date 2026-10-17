# 24: HUD + 背包最小 UI

**What to build:** HP/经验/任务 HUD 完整；背包界面：查看物品、使用消耗品、穿装备且属性即时变化（修饰器生效可感知）。最小可用即可，不做全量 UI。

**Blocked by:** 22, 23

**Status:** ready-for-agent

- [ ] HUD：HP 条、经验条、任务追踪实时反映 GameSession 快照
- [ ] 背包：格子列表、使用消耗品生效、装备穿戴后属性面板数字变化
- [ ] L4：ego-browser 断言 HUD 与背包状态
- [ ] UI 状态全部来自快照（无逻辑泄漏进 UI 层）
