# 15: 资产管线验证（Blender 导出 / 压缩 / LOD / KTX2 / lint）

**What to build:** 搭建 05 号方案的最小可运行管线：headless Blender 导出脚本（一个含动画与 shape keys 的测试资产，验证可重复性）；glTF-Transform 管道对比 meshopt vs draco（解码速度/压缩率/加载耗时，Web 环境实测）；自动简化 LOD 质量检查（角色资产）；KTX2 转码并验证 Safari/WebGPU 兼容；lint 规则（命名/三角数/贴图尺寸）跑通。对应 spec user story 9–12。

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** ready-for-agent

- [ ] headless 导出脚本两次运行产物字节一致（可重复性）
- [ ] meshopt vs draco 对比数字进报告，方案锁定
- [ ] 自动 LOD 质量结论（可接受/需手动）
- [ ] KTX2 在 Safari 与 WebGPU 路径的兼容结论；失败则 PNG 回退预案记录
- [ ] lint 规则对测试资产运行通过；AI 输出加固规则（非流形）就位
