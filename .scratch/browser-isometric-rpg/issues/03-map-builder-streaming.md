# 地图构建器、模块化场景与区域流式加载架构

Type: research
Status: resolved
Blocked by: 01

## 问题

如何构建与编辑大地图：用引擎内置编辑器、外部关卡工具（Tiled / LDtk / Blender）、还是自研 Web 构建器？区域切换/流式加载怎么做才能支撑「多地区、长期扩展」？

## 调研范围

- 各引擎的场景序列化格式与外部工具兼容性。
- 世界分块（chunk/streaming）方案：内存预算、切换体验（加载门 vs 无缝流式）的成本差异。
- 模块化 tileset / kitbash 工作流在 glTF 管线下的可行性。

## 产出

- 编辑器路线推荐（含成本估算）
- 流式加载架构草案 + 需实测的假设

---

## Answer（研究结果，2026-10-17，引擎 = Babylon.js）

### 已确认事实（官方文档/仓库，2026-10-17）

**场景序列化与加载**
- `SceneSerializer.Serialize(scene)` → JSON → `.babylon` 格式，官方一等特性（`featuresDeepDive/Exporters/Save_Babylon/`）。
- **增量加载系统**：`.babylon` 可转 `.incremental.babylon` + 网格/纹理数据文件，运行时按可见性即时加载 mesh 与纹理（官方 Importers 章节）。工具是 .NET Core 程序（MakeIncremental）。
- **AssetContainer**：资产池原语——加载进容器（不进场景）、`addAllToScene/removeAllFromScene`、可作模板复制模型而无需重新加载。→ **区域流式加载的官方原语就是这个**：区域=glTF/babylon 文件 → AssetContainer 预载 → 进入时 addAllToScene，离开时 removeAllFromScene。
- glTF 2.0 loader 官方一等支持（`@babylonjs/loaders`），支持 KTX2 等 extension。

**编辑器路线**
- **Babylon.js Editor v5**（github.com/BabylonJS/Editor）：社区维护的官方生态可视化编辑器，Apache-2.0，2026-09 发 v5.5.2，活跃。支持场景搭建、材质、粒子、脚本挂载、项目导出。风险：社区维护（非核心团队），1.1k stars，适合中量级使用。
- **Node Geometry Editor**：官方程序化几何节点系统（灵感来自 Blender Geometry Nodes），支持序列化/从文件加载，可运行时生成无限变体 → 适合地形/植被变体，减小下载量。
- 外部关卡工具：**LDtk**（MIT，4.3k stars，2026-10 活跃，Dead Cells 制作者出品）输出 2D 网格 JSON——可作为「关卡布局数据源」，由我们写的导入脚本转成 Babylon 场景。**Tiled**（GPL-2.0，12.9k stars）同类但 license 对工具链集成更麻烦。
- PlayCanvas 式的"云端可视化大编辑器"在 Babylon 生态没有等价物；Babylon Editor 是本地桌面应用。

**大世界**
- 官方 Large World Rendering / Floating Origin（见 02 号 ticket）解决了大坐标精度问题 → 多地区不需要自研坐标分块。

### 方案对比（编辑器路线）

| 路线 | 优点 | 代价 |
|---|---|---|
| **A. Babylon.js Editor 为主**（推荐） | 官方生态、直接产出 .babylon/项目文件、所见即所得 | 社区维护；复杂交互逻辑仍需代码；团队需熟悉 |
| B. LDtk 布局 + 自研导入脚本 | 布局数据可 diff/版本控制友好、程序化扩展性强 | 需自写转换层；3D 物件摆放表达能力弱（本质是 2D 网格） |
| C. 全代码程序化（Node Geometry + 脚本） | 零工具依赖、AI Agent 可直接生产 | 缺乏可视化调整；非程序美术人员无法参与 |
| D. 自研 Web 构建器 | 完全贴合需求 | 成本极高，早期不应做 |

**推荐：A 为主 + C 补充**（地形/植被用 Node Geometry 程序化，房间/城市布局用 Editor 手工摆）。B 作为备选保留——若后续需要"AI Agent 批量生产关卡数据"，LDtk JSON 是很好的中间格式（这条留给 06 号 ticket 联动评估）。

### 流式加载架构草案

```
区域 = 一个 glTF/babylon 文件 + 一个区域元数据 JSON（锚点、navmesh、触发器）
进入区域边缘（触发体积）→ 后台 fetch 文件 → AssetContainer 加载（不进场景）
实际进入 → container.addAllToScene() + navmesh 热替换
离开并过缓冲 → removeAllFromScene() + 释放
```

- 切换体验：**加载门（门/电梯/过场）实现最简单**，无缝流式需要边框区域预加载——原型从加载门起步。
- 增量加载系统可作为大文件（单区域过大）时的补充。

### 待原型验证的假设

1. Babylon Editor v5.5 的项目文件与 git diff 友好度（二进制 or JSON）。
2. AssetContainer 加载一个中型区域（50MB glTF）的耗时与内存峰值。
3. navmesh 热替换（跨区域 crowd 迁移）的平滑性。
4. Node Geometry 运行时生成的实际开销。

### 需要人工决策

- 编辑器路线确认 A+C？（可后续按原型结果调整）
- 区域切换从「加载门」起步是否接受？

## 决策（2026-10-17，用户确认）

- **编辑器路线：Babylon.js Editor v5（手摆布局）+ Node Geometry（程序化地形/植被）**。布局数据保持「场景文件 + 可重建代码/数据层」双轨以降低 Editor 停滞风险；若原型发现 Editor 项目文件 git 友好度差，降级到 LDtk 中间格式。
- **区域切换：从加载门起步**（AssetContainer 预载/卸载机制与无缝流式共用，后续只改触发方式）。
