# 16: 逻辑层验证（inkjs / 修饰器 schema / vitest 边界）

**What to build:** 在 src/logic 实现：inkjs 封装（加载一个几百节点的测试对话树，测性能与 variablesState 存档快照往返）；修饰器模型（EntityId + 修饰器列表）原型装备/buff/任务奖励三场景，vitest 按 L1 标准全覆盖；存档迁移链雏形（v1→v2 模拟迁移）。确认 vitest 直测 Babylon 逻辑类的边界。对应 spec user story 13/14/16。**本票结论是修饰器 schema 冻结的前置。**

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** resolved (0b16d8a 合并至 p0-integration，测试 35/35)

- [x] 几百节点对话树性能数字 + 快照往返正确性测试绿
- [x] 修饰器模型三场景 vitest 全绿（只测外部行为）
- [x] 存档迁移链 v1→v2 模拟测试绿
- [x] 结论：修饰器 schema 表达力确认，可冻结；inkjs 不可用时记录「自研极简对话 DSL」预案


## Answer 摘要（2026-10-17）

- 修饰器 schema 表达力确认，**可冻结**（冻结边界：条件型修饰器按条件增删列表项；百分比加性聚合；无 clamp；绝对游戏时间；叠层上限在 buff 定义层）。后续变更走迁移链 + 新 ADR。
- inkjs 2.4.0 可用（300 节点树：Continue 均值 0.044ms、快照往返正确），**无需自研对话 DSL**。
- vitest 边界：深层子路径导入可行（barrel 慢 661ms）；NullEngine 可做无渲染场景图测试；真实渲染仍需浏览器。
