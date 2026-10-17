# 15: 资产管线验证（Blender 导出 / 压缩 / LOD / KTX2 / lint）

**What to build:** 搭建 05 号方案的最小可运行管线：headless Blender 导出脚本（一个含动画与 shape keys 的测试资产，验证可重复性）；glTF-Transform 管道对比 meshopt vs draco（解码速度/压缩率/加载耗时，Web 环境实测）；自动简化 LOD 质量检查（角色资产）；KTX2 转码并验证 Safari/WebGPU 兼容；lint 规则（命名/三角数/贴图尺寸）跑通。对应 spec user story 9–12。

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** resolved (8693d36 合并至 p0-integration；Blender 项 blocked 待装)

- [x] headless 导出脚本两次运行产物字节一致（可重复性）——**脚本就绪但 Blender 未安装，blocked**；替代验证：glTF-Transform 管线两次构建 7 个 GLB 字节一致
- [x] meshopt vs draco 对比数字进报告，方案锁定——**锁定 meshopt**（总 33.9% vs 50.4%，解码器小 30 倍，解码速度相当）
- [x] 自动 LOD 质量结论（可接受/需手动）——**可接受**（近景 LOD1 48dB/LOD2 37.6dB；建议 3 级）
- [x] KTX2 兼容——Chromium WebGL2 ✅（ETC2 转码）/ WebGPU ✅（但转码为 RGBA8，显存收益未确认）/ **Safari 未实测**，PNG 回退预案保留
- [x] lint 规则 7/7 GLB 通过；非流形负向自测正确捕获

### 2026-10-17 · 用户决策

用户将安装 Blender（Homebrew），随后补测 `npm run assets:blender:repro`；与票 17 完整版手做合并进行。
