# 13: 遮挡描边验证（HighlightLayer 多角色开销）

**What to build:** 复用 11 的角色场景，新增建筑遮挡布局（若干遮挡物阻挡视线），启用 HighlightLayer 描边被遮挡角色，测量多角色同时描边的开销；对照不开描边的基线帧率。对应 spec user story 6。

**Blocked by:** 11 (角色渲染验证)

**Status:** resolved (381a63f 合并至 p0-integration)

- [x] 有/无 HighlightLayer 两组帧率数字进报告（两组均 60.0fps @ 3.73MP）
- [x] 多角色（≥10）同时被遮挡描边可演示，视觉正确（24/30 描边，6 人开阔地正确不描边）
- [x] 结论：**描边方案可用**——HighlightLayer 0.65ms/帧、draw calls +40、射线检测 0.019ms/帧（零分配 OBB 法，避开 scene.pick 的 GC 长帧）；半透明备选无需启用


## Answer 摘要（2026-10-17，WebGL2 @ 3.73MP）

24 角色同时描边稳定 60fps（判定阈值 ≥57 通过），成本随描边 mesh 数线性——50–100 人规模需复测 + 关注低端 GPU 全屏模糊填充（呼应 11 号填充率瓶颈）。实现要点：自建射线-OBB（slab 法零分配）替代 scene.pick（后者 34 个 GC 长帧）。
