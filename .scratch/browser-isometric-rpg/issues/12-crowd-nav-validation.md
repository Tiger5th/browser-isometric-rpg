# 12: Crowd 寻路验证（navmesh 生成 + 跨区热替换）

**What to build:** 在 Harness 中新增寻路场景：200×200 灰盒地面 + Crowd Navigation V2，点击移动若干 agent，采集 navmesh 生成时间与内存；再构造两个相邻区域验证跨区域 navmesh 热替换的平滑性（加载门切换时 crowd 状态迁移）。对应 spec user story 4/5。

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** ready-for-agent

- [ ] 200×200 区域 navmesh 生成时间/内存数字进报告
- [ ] agent 点击移动 + 避让可演示
- [ ] 跨区域热替换场景可演示，平滑性有结论（断帧/卡顿记录）
- [ ] 结论：区域规模上限建议（navmesh 参数与区域尺寸的关系）
