# 12: Crowd 寻路验证（navmesh 生成 + 跨区热替换）

**What to build:** 在 Harness 中新增寻路场景：200×200 灰盒地面 + Crowd Navigation V2，点击移动若干 agent，采集 navmesh 生成时间与内存；再构造两个相邻区域验证跨区域 navmesh 热替换的平滑性（加载门切换时 crowd 状态迁移）。对应 spec user story 4/5。

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** resolved (72f82bb 合并至 p0-integration)

- [ ] 200×200 区域 navmesh 生成时间/内存数字进报告
- [x] agent 点击移动 + 避让可演示
- [x] 跨区域热替换场景可演示，平滑性有结论（断帧/卡顿记录）
- [x] 结论：区域规模上限建议（navmesh 参数与区域尺寸的关系）


## Answer 摘要（2026-10-17）

- 200×200 navmesh（cs=0.5）：**生成 143ms / 45KB / heap +0.8MB**——主线程+加载门内可接受；300×300 亦仅 278ms。内存不是瓶颈，同步生成时间才是。
- 50 agents 避让正常（0 重叠对），crowd 更新 0.35ms/帧，不是瓶颈。
- **跨区热替换平滑**：切换同步工作 2.9ms，切换帧 32.0ms vs 切换前 p95 34.6ms（spikeRatio 0.92），无卡顿尖峰。
- **规模上限建议**：200×200 = 主线程生成 + 加载门的推荐上限；无缝流式需 tiled navmesh + Worker/离线预烘焙。
