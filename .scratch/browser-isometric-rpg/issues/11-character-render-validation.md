# 11: 角色渲染验证（300 骨骼动画角色同屏）

**What to build:** 在 Harness 中新增角色场景：程序化生成或加载 300 个骨骼动画角色（占位模型），正交等距相机，渲染路径可切换（WebGL2 / WebGPU），采集帧率、draw calls、内存（SceneInstrumentation）。对应 spec user story 2/3。

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** ready-for-agent

- [ ] 300 骨骼动画角色同屏场景可运行
- [ ] WebGL2 路径帧率/draw calls/内存数字进报告
- [ ] WebGPU 路径（Chrome）同项数字进报告，二者可对比
- [ ] 结论：是否达到 07 预算（60fps 桌面）；不达标时记录瓶颈层（CPU 骨骼更新/GPU/内存）
