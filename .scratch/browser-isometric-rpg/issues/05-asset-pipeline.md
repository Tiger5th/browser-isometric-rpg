# Blender / glTF / 纹理压缩 / LOD 资产导入管线

Type: research
Status: resolved
Blocked by: 01

## 问题

从 Blender 到运行时的资产管线如何搭建：导出设置、glTF/GLB 约定、纹理压缩（KTX2/BasisU）方案、LOD 生成、命名/单位/轴约定、批量校验。

## 调研范围

- Blender glTF 导出器的已知限制（版本号 + 来源）。
- KTX2/basisu 压缩在所选引擎中的支持现状与移动端兼容性。
- 自动化校验（脚本化 lint 资产）的已有工具。
- 每类资产（角色/环境/道具）的单文件与总包体预算建议。

## 产出

- 管线流程图 + 工具清单
- 资产规范草案（命名、轴、单位、压缩、LOD）

---

## Answer（研究结果，2026-10-17，引擎 = Babylon.js）

### 已确认事实（官方文档/仓库，2026-10-17）

**Blender → glTF**
- Blender 自带 glTF 2.0 导出插件（底层是 KhronosGroup/glTF-Blender-IO，Apache-2.0，独立仓库 1.7k stars，2026-10 活跃）。支持：Principled BSDF（metal/rough PBR）、贴图、相机、灯光、关键帧/形变/骨骼动画、自定义属性、GPU 实例（EXT_mesh_gpu_instancing）。
- 已知限制（官方手册明示）：quad/n-gon 自动转三角面；UV 断开和硬边会使 glTF 顶点数比 Blender 侧偏多；曲线等非 mesh 数据不保留，须先转 mesh；GPU 实例不支持材质变化。
- 坐标系：glTF 右手 Y-up；导出器负责 Blender→glTF 转换，**不要自己再加翻转**（Babylon 官方 DCC 指南强调的常见错误）。
- .glb（单文件含贴图）vs .glTF（JSON+外部文件）：运行时用 .glb；需要单独替换贴图/调试时用 .glTF。

**Babylon 侧**
- 官方 glTF 2.0 loader（`@babylonjs/loaders`）一等支持，含 KTX2 等 extension。
- 官方 KTX2 压缩支持（`featuresDeepDive/materials/using/ktx2Compression`）：GPU 常驻压缩纹理，运行时按设备能力选择（ASTC/DXT/ETC2/PVR/ATC 顺序）。Babylon Editor 也内置纹理压缩功能。
- Babylon Editor 文档有专页 compressing-textures。

**工具链（资产优化/lint）**
- **glTF-Transform**（donmccurdy，MIT，2k stars，活跃）：JS/TS 的 glTF 2.0 SDK + CLI，可做压缩（Draco/meshopt/KTX2）、去重、验证、自定义 transform——**管线自动化校验的核心工具**。
- **meshoptimizer**（zeux，MIT，8.6k stars，活跃）：顶点缓存优化、简化，gltfpack 是其 CLI 形态。

### 管线方案（草案）

```
Blender (.blend 源文件, git-lfs)
  │  命名/轴/单位约定见下方规范
  ▼
glTF 导出（headless: blender --background --python export.py，逐资产可重复）
  │
  ▼
glTF-Transform CLI 管道（draco/meshopt 几何压缩 + KTX2 纹理转码 + 校验/lint）
  │
  ▼
dist/assets/*.glb（版本化目录，按需 hash 命名）
  │
  ▼
Babylon loader（KTX2 运行时转码）→ AssetContainer（区域打包，见 03）
```

**LOD**：Blender 侧手工出 2–3 级 or glTF-Transform simplification 自动生成；Babylon 内置 mesh.addLODLevel。原型阶段：角色 3 级（近/中/远景），环境物件 2 级 + 距离剔除。**自动 LOD 质量需原型验证**。

### 资产规范草案（待 07 性能预算后定数值）

- **命名**：`<类别>_<名称>_<变体>`，小写蛇形；骨骼命名前缀 `b_`；LOD 后缀 `_lod0/1/2`。
- **轴/单位**：Blender 场景单位=米，Y-up 由导出器处理；缩放系数 1.0，不要在引擎侧补偿。
- **纹理**：PBR metal/rough 流程（baseColor/normal/metallicRoughness/AO/emissive）；源图 4K 精修、分发 1K–2K KTX2；普通贴图 tangent-space +Y。
- **压缩**：几何 draco or meshopt（原型对比后定，倾向 meshopt——解码更快）；纹理 KTX2 全覆盖。
- **每类资产预算**（初值，待 07 修正）：角色 ≤ 15k 三角 + 1×2K KTX2；环境模块 ≤ 5k 三角；道具 ≤ 3k 三角；单区域总包体 ≤ 50MB（03 的验证数字）。
- **自动化校验**：glTF-Transform 自定义 lint（命名、三角数、贴图尺寸、材质数），CI 中对每个 .glb 运行——直接服务 06 号 ticket。

### 许可证备注（07 号 ticket 的输入）

Blender(GPL，导出文件不受影响)、glTF-Blender-IO(Apache-2.0)、glTF-Transform(MIT)、meshoptimizer(MIT)、KTX2/basisu(Apache-2.0)——管线全链路无许可风险。

### 待原型验证的假设

1. headless Blender 导出脚本的可重复性（动画采样、shape keys）。
2. draco vs meshopt 解码速度/压缩率对比（Web 环境实测）。
3. 自动简化 LOD 的视觉质量是否可接受（角色尤其）。
4. KTX2 在 Safari/移动端 WebGPU 下的转码兼容性。

### 需要人工决策

- 几何压缩倾向 meshopt（解码快），纹理 KTX2——如无异议按此原型。
