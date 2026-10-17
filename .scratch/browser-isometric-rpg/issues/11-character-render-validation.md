# 11: 角色渲染验证（300 骨骼动画角色同屏）

**What to build:** 在 Harness 中新增角色场景：程序化生成或加载 300 个骨骼动画角色（占位模型），正交等距相机，渲染路径可切换（WebGL2 / WebGPU），采集帧率、draw calls、内存（SceneInstrumentation）。对应 spec user story 2/3。

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** resolved (c924ba9 合并至 p0-integration)

- [x] 300 骨骼动画角色同屏场景可运行
- [x] WebGL2 路径帧率/draw calls/内存数字进报告
- [x] WebGPU 路径（Chrome）同项数字进报告，二者可对比
- [x] 结论：未达到 07 预算（60fps 桌面）；不达标时记录瓶颈层（CPU 骨骼更新/GPU/内存）


## Answer 摘要（2026-10-17，Apple M5 / Chrome 154 / 渲染 4.79MP）

- **未达 60fps 预算**：WebGL2 平均 40.4fps、WebGPU 39.4fps（多次运行区间 37–45）。draw calls=300 达标，内存 76–87MB 远低预算。
- **瓶颈 = GPU 填充率**：CPU 骨骼求值 0.3ms、scene.render() JS 仅 2.4–4.9ms，远小于 25ms 帧时间；降分辨率至 0.29MP 后 60.1fps，证实填充率瓶颈。WebGPU 本场景无收益。
- **P0 报告建议**：角色同屏预算按分辨率联动调整（画质档位/动态分辨率），或角色预算降至 ~200 同帧 60fps；待 18 号汇总定案。
