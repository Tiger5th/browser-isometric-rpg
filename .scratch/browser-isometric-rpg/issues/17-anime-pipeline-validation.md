# 17: 二次元链路验证（VRoid → glTF → toon 渲染）

**What to build:** 走通 09 号方案的完整链路（范围严格限定：一个角色 + 一段动画 + toon 开关）：VRoid Studio 捏一个角色 → Mixamo 绑骨取一段走/跑动画 → Blender 导出 glTF（按 05 规范）→ 过 15 的管线 lint → 在 Harness 场景中加载播放，并做 Babylon toon 渲染（描边 + 色彩分级）开/关对比截图。对应 spec user story 18。

**Blocked by:** 10 (项目骨架), 15 (资产管线验证)

**Status:** ready-for-agent

- [ ] 一个 VRoid 角色在灰盒场景中播放 Mixamo 动画
- [ ] toon 渲染开/关对比截图进 artifacts/
- [ ] 链路各环节的坑记录（骨骼导入/morph/贴图格式）
- [ ] 结论：二次元管线可行性；发现的问题写回 09 号 ticket
