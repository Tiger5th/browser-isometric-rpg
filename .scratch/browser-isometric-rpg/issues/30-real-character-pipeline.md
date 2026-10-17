# 30: 真实角色接入——VRM + Blender + Mixamo（agent 全程）

**Spec:** specs/p2-gameplay.md（user stories 32–35）

**What to build:** 玩家角色从占位 glb 升级为真实 VRM：agent 挑选并下载 Booth 高精度免费 VRM（许可证确认仅自用）→ 安装 Blender 并脚本化处理（换贴图/绑骨，顺路完成 P0 遗留的 headless 导出补测 `npm run assets:blender:repro`）→ Mixamo 重定向 walk/run/attack → 既有 VRM→GLB 工具链 → toon 渲染 + 描边 + morph 眨眼在真实资产上验证。角色贴图按票 29 色板卡生成/替换（依赖其生图工作流）。

**Blocked by:** 29（色板卡与生图工作流）

**Status:** ready-for-agent

- [ ] Blender 安装并 headless 可运行，`assets:blender:repro` 补测通过（P0 遗留清账）
- [ ] Booth VRM 挑选下载，许可证记录（仅自用），用户审美确认（附候选截图）
- [ ] Mixamo 动作 walk/run/attack 重定向成功，无滑步穿帮
- [ ] toon 渲染 + 描边 + morph 眨眼在真实 VRM 上正常（多材质 morph 回归）
- [ ] L4：p1-world 用真实角色跑通完整闭环冒烟
- [ ] L5：真实角色资产下预算复测绿（对比票 28 后的基线）
