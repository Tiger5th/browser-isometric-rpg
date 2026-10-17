# 31: 存档系统 2.0 + 快照 v3 + 等级入档

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 1–6, 18–20 的入档部分）

**What to build:** 快照 v2→v3（与票 27 合流，一次升版装下重击冷却 + playerLevel/cumulativeXp + worldState 通用容器 `Record<string, JsonValue>`）；迁移链补 v2→v3（新字段默认值，老档可读）；IndexedDB 单槽扩为 `auto` + `slot-1..3` 四槽（SaveStorage 适配器接口不变）；自动存档——区域切换/任务状态变化/获得重要物品写 auto 槽 + `beforeunload` 兜底；槽位元数据（存档时间/游戏时长/等级）存槽位侧；选槽 UI（列表 + 元数据 + 读/写/删除，容器由票 32 提供，先行挂 HUD 演进）。

**Blocked by:** 无（27 先落则消费其 v3；27 后落则 27 消费本票 v3）
**Status:** done（2026-10-17）

- [x] L1：快照 v3 往返（含重击冷却/等级/worldState 透传）+ 迁移链 v2→v3 + 老档 v2 可读（vitest，先例 game-session-save.test.ts）
- [x] L1：自动存档触发条件（区域切换/任务变化/重要物品）+ beforeunload 兜底的单测
- [x] 四槽读写删 + 元数据（时间/时长/等级）正确
- [x] L4：选槽界面读/写/删冒烟 + 刷新后自动档恢复（reports/ + artifacts/）
- [x] L2：如内容数据有变（等级曲线引用）则 lint 过
- [x] 存档 UI 显示槽位元数据
