# 前端 3D 引擎选型：Babylon.js vs Three.js vs PlayCanvas

Type: research
Status: resolved
Blocked by: —

## 问题

哪个引擎最适合作为浏览器优先、等距视角、长期扩展的大型 RPG 的基础？需要可比较的方案对比与明确推荐。

## 调研范围

- Babylon.js、Three.js、PlayCanvas 三者的：许可证、社区规模与治理、官方文档质量、编辑器/工具链、渲染特性（遮挡剔除、LOD、贴花、骨架动画）、TypeScript 支持程度。
- 等距/固定视角下的适配：相机方案、剔除优化、与 2D UI 层的整合。
- 长期维护风险：单一维护者 vs 组织背书、版本稳定性、大作先例（有方法可验证的案例，而非宣传页）。
- 潜在补充选项是否应纳入对比（如 Godot 导出 Web、自研薄封装），以及排除它们的理由。

## 产出

- 三方案对比表（事实 + 来源 + 版本号）
- 明确推荐 + 理由 + 主要代价
- 需要原型验证的假设清单

---

## Answer（研究结果，2026-10-17）

### 已确认事实（含来源）

| 维度 | Babylon.js | Three.js | PlayCanvas |
|---|---|---|---|
| License | Apache-2.0 | MIT | MIT（engine）；editor 仓库也是 MIT，但 Editor 托管服务收费 |
| GitHub stars | 26.2k | 116.5k | 17.1k |
| 贡献者页数（30/页） | 298 页 ≈ 8900+ | 365 页 ≈ 11000+ | 148 页 ≈ 4400+ |
| 发版节奏 | 极快（9.x 每周发版，2026-09~10 有 9.23→9.30） | 慢（r186 2026-09；r185 2026-07） | 快（v2.22–2.23 密集发版） |
| npm 月下载 | @babylonjs/core 176 万 | three 8570 万 | playcanvas 44 万 |
| WebGPU | 5.0（2022-05）起支持，2024 年核心 shader 全部改写为原生 WGSL（官方 docs `/setup/support/webGPU`） | WebGPURenderer 已进入正式 docs；成熟度需实测 | 支持（官方标注 **Beta**），WebGPU→WebGL 自动回退（官方 docs `/user-manual/graphics/`） |
| 内置寻路/人群 | **官方 Crowd Navigation System**（navmesh 生成 + crowd agents + obstacles），文档一级 feature | 无内置，依赖第三方（recast-wasm 等） | 无内置 |
| 遮挡剔除 | 内置 Occlusion Queries（v3.1+，官方 docs） | 无内置 occlusion query（需 frustum culling + 自己做） | 有剔除体系（官方 Optimization 章节） |
| 纹理压缩 | 支持 KTX2/Basis | 官方 KTX2Loader | Editor 集成 Basis 压缩，运行时转码 ASTC/DXT/ETC2 等（官方 docs） |
| 编辑器 | 无官方场景编辑器（有 Playground、Node Material Editor）；外部方案 | 仅基础 three.js/editor（非产品级） | **云端可视化 Editor**（核心卖点；引擎免费，Editor 私有项目 $15/月起） |
| TS 支持 | 好（官方 TS） | 好（官方 types） | 好 |

数据采集时间 2026-10-17，来源：GitHub API、npm API、各引擎官方文档站。

### 方案对比

**Babylon.js —— 推荐。** 理由：RPG 所需的高层能力（官方 crowd nav、occlusion queries、GUI 系统、物理、音频、场景序列化 `.babylon` 格式）开箱即用，等于自带一个"游戏引擎层"；Apache-2.0；单一包治理、文档统一。代价：npm 生态比 three 小一个量级；发版极快意味着 API 变动频繁、第三方教程容易过时；引擎重（包体大于 three 的按需组合）。

**Three.js —— 可行但自建成本高。** 生态最大、最灵活、社区答案最多，但 navmesh、crowd、遮挡、GUI、序列化全部要自己选型拼装（每个都是一次小选型），长期 RPG 项目里"自建引擎层"的风险与工作量显著。适合团队想完全掌控渲染管线的情况。

**PlayCanvas —— 引擎好但绑定 Editor 生态需谨慎。** 引擎 MIT 免费、Editor 是其核心工作流优势（可视化搭场景正是本项目 03 号 ticket 的需求）、Basis 压缩管线一体化。代价：工作流深度绑定其云端 Editor（私有项目 $15/月起）；社区与 npm 生态最小；WebGPU 仍标 Beta。

### 明确推荐

**Babylon.js**。对"浏览器优先 + 等距 RPG + 长期扩展 + AI Agent 协作"这组约束，官方内置的 crowd navigation、occlusion、GUI、完整序列化格式最直接命中 02/03/04 号 ticket 的需求，减少自建层。等距相机（OrthographicCamera 类似物）、纹理压缩、WebGPU 均有官方一等支持。

### 需要原型验证的假设（未确认）

1. Babylon 等距正交相机 + 大量实例化实体的同屏性能（目标 50–500 实体）——需 02 号 ticket 原型实测。
2. Crowd Navigation v2 在小地图（单区域）与分块地图上的行为差异——03 号 ticket。
3. 9.x 每周发版对 API 稳定性的实际影响（锁版本策略是否足够）——升级到一个版本后观察。
4. WGSL/WebGPU 路径下与 WebGL2 路径的渲染一致性。

### 需要人工决策

- **确认采用 Babylon.js？**（替代项的代价已列于上表）
- 锁版本策略建议：锁定小版本、按季度评估升级——待确认。

## 决策（2026-10-17，用户确认）

**采用 Babylon.js。** 补充研究（第二轮）确认其余选项不优：Godot 4 Web 导出有硬伤（C# 不可用、单线程妥协、WASM 加载慢）；Unity Web 非重点且有许可条款风险；Unreal 需 Pixel Streaming 串流，成本不可行；Phaser 等纯 2D 引擎放弃 3D 渲染路线；Bevy wasm 生态不成熟。

版本策略（默认假设，未被否决）：锁定小版本，按季度评估升级。

**决策记录**：引擎 = Babylon.js（9.x，锁版本）；ADR 待建立于 `docs/adr/0001-babylonjs-engine.md`。
