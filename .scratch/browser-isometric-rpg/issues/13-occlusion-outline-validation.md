# 13: 遮挡描边验证（HighlightLayer 多角色开销）

**What to build:** 复用 11 的角色场景，新增建筑遮挡布局（若干遮挡物阻挡视线），启用 HighlightLayer 描边被遮挡角色，测量多角色同时描边的开销；对照不开描边的基线帧率。对应 spec user story 6。

**Blocked by:** 11 (角色渲染验证)

**Status:** ready-for-agent

- [ ] 有/无 HighlightLayer 两组帧率数字进报告
- [ ] 多角色（≥10）同时被遮挡描边可演示，视觉正确
- [ ] 结论：描边方案是否可用；开销不可接受时的备选（遮挡物半透明）记录
