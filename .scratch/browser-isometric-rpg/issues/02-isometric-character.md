# 等距视角下的角色控制 / 寻路 / 碰撞 / 遮挡 / 场景管理

Type: research
Status: resolved
Blocked by: 01

## 问题

在所选引擎上，等距视角 RPG 的角色控制层如何搭建：点击移动 vs 键盘控制、NavMesh 寻路方案、碰撞体策略、角色被建筑遮挡时的处理（描边/透明/调序）、大量可交互实体的场景组织。

## 调研范围

- 寻路库（如 recast-navigation 的 WASM 移植、navigasjons / three-mesh-bvh 类方案）在所选引擎中的成熟度与 license。
- 等距遮挡的经典解法（Y 排序、深度贴图、轮廓高亮）在 3D 引擎语境下的对应做法。
- 实体规模基准：同屏 50–500 实体时各类方案的实测或可信基准数据。

## 产出

- 各子问题方案对比 + 推荐
- 待原型验证假设清单

---

## Answer（研究结果，2026-10-17，引擎 = Babylon.js）

### 已确认事实（官方文档，Babylon.js 9.x）

**寻路 / 人群**
- 官方 Crowd Navigation System 分 V1/V2 两代：**V1 基于老旧 JS 包，官方明确「正在弃用」**；**V2 基于 `recast-navigation-js`（Isaac Mason，MIT，活跃维护），完全兼容 ES6/bundler**。V2 在 addons 包中，需异步初始化（`createNavMeshAsync`）。→ **直接采用 V2，忽略 V1**。
- Crowd 模型：crowd（maxAgents, maxAgentRadius）→ `addAgent(position, params, transform)`，代理间自动避让、支持 teleport / 到达回调（`onReachTargetObservable`）。敌人 AI 的移动层可直接建在其上。
- 障碍物支持运行时增删（官方 Obstacles 章节）。
- recast-navigation-js 仓库健康度：MIT，432 stars，2026-07 仍在提交。

**控制**
- 点击移动：`scene.pick`（可配 octree 加速）命中地面 → `crowd.agentGoto()`。键盘控制：直接设置 transform + 物理或手动位移，crowd 仅用于 NPC。
- 等距相机 = FreeCamera/TargetCamera 的 orthographic 模式（`mode = ORTHOGRAPHIC_CAMERA`），固定角度锁死。

**碰撞**
- Babylon 官方两种路径：物理引擎（Havok，官方推荐）或 collision system（`moveWithCollisions`）。RPG 角色 vs 静态场景用 `moveWithCollisions` 更轻；需要推开、投掷等才上 Havok。

**遮挡（等距经典问题）**
- 官方 HighlightLayer / GlowLayer 可做「角色被建筑遮挡时轮廓高亮」的方案；另有 `mesh.setEnabled`/透明度调整（`visibility`）。经典解法在 3D 引擎里退化为「遮挡物半透明 or 角色描边」，两者都是官方一等特性。

**场景管理 / 性能（同屏 50–500 实体）**
- 官方优化文档（`featuresDeepDive/scene/optimize_your_scene`）的要点：TransformNode 替代空 mesh、freezeActiveMeshes、减少 draw call（instances/thin instances）、octree 剔除与拾取、Scene Optimizer。
- **thin instances**（v4.2+）适合同 mesh 海量复制（植被、碎块）；角色因骨骼动画不同需 regular instances 或独立 mesh。
- **Large World Rendering / Floating Origin**（当前版本官方特性）：大世界坐标 float32 抖动问题官方已内置方案（`useLargeWorldRendering` + floatingOriginMode + Havok 多区域支持）。→ 多地区 RPG 的世界坐标上限问题已有官方答案，不需要自研分块坐标。
- Occlusion Queries（官方）可做遮挡剔除。

### 方案对比（等距遮挡处理）

| 方案 | 优点 | 代价 |
|---|---|---|
| 角色描边（HighlightLayer） | 视觉清晰、玩家友好 | 每 mesh 一个描边成本；多个角色同屏需注意 |
| 遮挡物半透明 | 一览无遗 | 需按像素检测遮挡物（`scene.pick` 从相机发射线），射线管理有成本 |
| Y 排序/深度修正 | 经典 2D 做法 | 3D 引擎下不需要——深度缓冲自动处理 |

推荐：**HighlightLayer 描边为主 + 被遮挡时才启用**（射线检测命中遮挡物再描边），成本可控。

### 待原型验证的假设

1. 正交相机 + 300 骨骼动画角色同屏帧率（WebGL2 vs WebGPU）。
2. Crowd V2 navmesh 在 200×200 区域上的生成时间与内存。
3. HighlightLayer 在多角色同时被遮挡时的开销。
4. `moveWithCollisions` vs Havok 在斜坡/台阶上的手感差异。

### 需要人工决策

- **移动输入**：纯点击移动（Diablo 系）还是 WASD+点击混合？→ 影响控制层设计，**待你选择**。
- **物理引擎**：默认不用物理（`moveWithCollisions`），等有需求再引入 Havok——默认假设，可否决。

## 决策（2026-10-17，用户确认）

- **移动输入：纯点击移动**（Diablo 系）。点击地面 → navmesh 寻路 → crowd/agent 移动。
- 物理引擎默认不启用（`moveWithCollisions`），未被否决。
