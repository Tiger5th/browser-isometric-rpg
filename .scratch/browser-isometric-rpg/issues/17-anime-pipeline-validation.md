# 17: 二次元链路验证（VRoid → glTF → toon 渲染）

**What to build:** 走通 09 号方案的完整链路（范围严格限定：一个角色 + 一段动画 + toon 开关）：VRoid Studio 捏一个角色 → Mixamo 绑骨取一段走/跑动画 → Blender 导出 glTF（按 05 规范）→ 过 15 的管线 lint → 在 Harness 场景中加载播放，并做 Babylon toon 渲染（描边 + 色彩分级）开/关对比截图。对应 spec user story 18。

**Blocked by:** 10 (项目骨架), 15 (资产管线验证)

**Status:** resolved (98d7866 合并至 p0-integration；VRoid 真人链路 blocked 待用户手做)

- [ ] 一个 VRoid 角色在灰盒场景中播放 Mixamo 动画——**blocked**：本机无 Blender/VRoid/Adobe 登录态；已交付程序化二次元占位角色（11k 三角/22 骨骼/walk+run）+ VRM→GLB 转换工具（自测通过），场景会自动优先加载真实 VRoid 资产 —— **blocked**：本机无 VRoid Studio / Blender / Adobe 登录态；已用程序化二次元占位角色 + 内嵌 walk/run 骨骼动画完成渲染验证（详见下方 Comments）
- [x] toon 渲染开/关对比截图进 artifacts/
- [x] 链路各环节的坑记录（骨骼导入/morph/贴图格式）
- [x] 结论：二次元管线可行性；发现的问题写回 09 号 ticket

## Comments

### 2026-10-17 · 实现结果（降级路线 A）

**环境探测**
- `which blender` → 未找到；`/Applications` 无 VRoid Studio、无 Mixamo 客户端。
- ego-browser 打开 `https://www.mixamo.com/` → 页面显示 `Log in / Sign up`，无 Adobe 登录态 → Mixamo blocked。
- 因此真实链路（VRoid 捏人 → Mixamo 绑骨 → Blender 导出/烘焙）无法在本机执行，按票面授权走降级路线 A。

**完成（✅）**
- 程序化二次元占位角色 `assets/character_anime_placeholder.glb`：11236 三角 / 5664 顶点 / 22 骨骼（`b_` 前缀）/ 1 个 blink morph / 1 张 512² PNG / 顶点色分区 / walk + run 两段骨骼动画。
- 资产通过 15 号 lint：`npm run assets:lint` → 本资产 **passed · 0 errors / 0 warnings**；全仓 8/8 passed。
- Harness 新场景 `anime-pipeline`：加载角色、播放 walk/run、灰盒场景内近景相机、交互式保留。
- 自定义 toon 渲染：三阶色阶 ShaderMaterial（蒙皮）+ `Mesh.renderOutline` 描边 + `DefaultRenderingPipeline` 色彩分级（ACES / contrast / exposure / ColorCurves / vignette / FXAA）。Babylon **9.31.0 的 `@babylonjs/core` 与 `@babylonjs/materials` 均未导出 ToonMaterial**（旧版 `Materials/toon` 路径不存在），故用 ShaderMaterial 等价实现。
- 渲染报告：`reports/p0-anime-pipeline.json`（status passed，WebGL2，60fps 级）。
- 管线/阻塞/手做指引汇总：`reports/anime-pipeline.json`。
- VRM→glTF 兜底工具 `tools/pipeline/vrm-to-glb.mjs`：GLB 块级剥离 `VRM` / `VRMC_*`（含 MToon / SpringBone / node constraint），自测通过；真实 VRM 仍需用户导出后复跑。

**截图（artifacts/anime-pipeline/）**
- `toon-on.png`：toon 开（色阶 + 描边 + 分级）
- `toon-off.png`：toon 关（StandardMaterial + 无描边 + 无分级）
- `toon-on-run.png`：toon 开 + run 动作
- `toon-on-closeup.png` / `toon-off-closeup.png`：同机位近景对比

**Blocked（⛔）**
- 真实 VRoid 角色 + Mixamo 动画：缺 VRoid Studio、Blender、Adobe 登录态；无法自动化捏人/绑骨/FBX 烘焙。
- 真实 VRM 资产端到端加载：无 .vrm 样本；已完成容器级转换自测，非真实 VRoid 资产。

**需用户手做（约 15 分钟）**
1. （5 min）安装 [VRoid Studio](https://vroid.com/studio)（免费），默认模板捏人，File → Export → VRM 导出。
2. （3 min）`node tools/pipeline/vrm-to-glb.mjs ~/Downloads/character.vrm assets/character_vroid_lod0.glb`。场景 `anime-pipeline` 会自动优先加载这个文件；即使没有动画，也会用程序化骨骼循环兜底。
3. （5 min，可选 Mixamo）安装 Blender + VRM Add-on：VRM → FBX → Mixamo 自动绑骨/选走跑动作 → 下载 FBX → Blender 烘焙回 VRoid 骨架 → 按 05 规范导出 glTF。若只验证 toon 观感，第 2 步即可。
4. （1 min）`npm run assets:lint -- assets/character_vroid_lod0.glb`。VRoid 角色常超 15k 三角，超标时记录数字并在 Blender 做 Decimate/LOD（已知的生成资产问题，不阻塞渲染验证）。
5. （1 min）`npm run dev` 打开 `?scenario=anime-pipeline`；控制台 `window.__animePipeline.setToonEnabled(false/true)` 可重截对比图。

**坑（详见 reports/anime-pipeline.json → pitfalls）**
- 坐标系：glTF 右手系 → Babylon 左手系，loader 翻转 Z；首次相机拍到了背面，需按实际朝向调 alpha。
- morph：blink morph 能加载（morphTargetCount=1），但自定义 toon ShaderMaterial 未包含 morph include，不会驱动表情；真实 VRoid 表情需 NodeMaterial/StandardMaterial 或扩展 shader。
- 骨骼命名：VRM `J_Bip_*`、Mixamo `mixamorig:*` 差异大，Mixamo 动作必须 Blender 重定向/烘焙，不能只靠名字匹配。
- 贴图：baseColor sRGB 未在自定义 shader 内显式转线性（本次近白贴图影响小）；KTX2 需先 `npm run assets:vendor`。
- 描边：`renderOutline` 对蒙皮可用，但宽度为世界单位，多层 VRoid 头发/面部可能叠加，P1 建议评估 13 号的屏幕空间描边。

**结论**：二次元**渲染**链路已完整验证（蒙皮角色 + toon 色阶 + 描边 + 统一分级，60fps 级）；真实 VRoid/Mixamo **资产获取**链路 blocked。VRM 容器转换已就绪，用户按上述指引产出真实资产后可复用同一场景，无需改代码。

### 2026-10-17 · 用户决策：完整版手做 + morph 挂票 25

- 用户选择**完整版**手做（VRoid 捏人 + Blender + Mixamo 绑骨烘焙），一次覆盖票 15 的 Blender 遗留。
- toon shader 的 morph/表情支持作为代码工作挂入票 25 验收标准。
- 手做与 19 号票开工并行，不阻塞 19–24。
