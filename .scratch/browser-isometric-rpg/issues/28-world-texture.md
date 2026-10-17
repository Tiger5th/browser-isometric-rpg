# 28: 世界质感——网格化碰撞 + 边界景观 + 光照氛围

**Spec:** specs/p2-gameplay.md（user stories 15–21）

**What to build:** 树/石墙/木桶/木箱 4 类 billboard → 程序化几何拼装真网格（Babylon 内置几何 + 现有 Gemini 贴图，CC0 低模包为后备）+ 硬碰撞 collider（不可穿模）；灌木保留 billboard 可穿，角色进入时轻微遮挡/半透明（草丛机制视觉预留）；地图边界外低细节景观环带 + 渐暗雾（消除黑色虚无，风格进锚定图，agent 用 ego-browser 出「远景/天际线」样本）；全场唯一主光左上 45°、暗部紫灰、ImageProcessing 明亮暖色分级；NPC 待机行为（呼吸摆动/偶尔踱步）。

**Blocked by:** 无

**Status:** resolved

- [x] 4 类环境件为真网格 + 硬碰撞，玩家/敌人均不可穿；灌木可穿且有进入视觉反馈
- [x] 边界外景观环带 + 雾，四个方向无黑色虚无（截图 artifacts/ 四方向）
- [x] 统一主光与色调分级生效，与锚定图观感一致
- [x] NPC 待机行为，无站桩
- [x] L1：布局/碰撞常量纯逻辑测试（先例 green-hollow-layout.test.ts）
- [x] L4：ego-browser 冒烟——撞树被挡、灌木可走、移动不被误挡死
- [x] L5：预算复测绿（fps ≥59.5、drawCalls ≤350、heap 达标），超支则逐件 LOD
- [ ] 远景风格样本图进风格锚定（artifacts/，含用户确认留档）——**见 Answer 第 7 条，待用户确认**

## Answer（实现记录，2026-10-17）

### 1. 网格化 + 硬碰撞（user stories 15/16）

- **配方驱动**：`src/render/presentation/prop-mesh-recipe.ts`（纯数据，L1 直测）定义 4 类件的
  零件清单（基元/尺寸/偏移/贴图 UV 窗口）+ 三角预算。树 = 树干圆柱 + 三团树冠球；
  石墙 = 单块长方体；木桶 = 桶身 + 顶盖 + 两道铁箍；木箱 = 箱体 + 盖板。
  单类 ≤ 120 三角、总计 ≤ 210（LOD 预算内，未触发逐件 LOD）。
- **贴图复用**：`prop-mesh-builder.ts` 把 Gemini 立绘（1024×765）按 UV 窗口直接写进顶点
  数据（`VertexBuffer.UVKind`），桶口用贴图顶部椭圆、侧面用桶身木纹、墙面用整幅石墙——
  同一批贴图文件，零新增资产。灌木维持票 25 的 billboard + 白底抠图。
- **碰撞单一数据源**：`world-physics.buildPropColliders()` 推导硬碰撞体（树/桶/箱为圆柱、
  墙为盒，含最小厚度防侧漏），navmesh 障碍（`colliderObstacleSpecs`）与渲染层逐帧求解
  **共用同一份清单**，避免「寻路绕开但能穿模」漂移。
- **不可穿的三层保障**：navmesh 排除（寻路层）→ 逻辑层直线推进 → 渲染层每帧
  `resolveMoveWithColliders` 逐轴求解 + 贴面推挤（`world-physics.ts`，纯函数可测）。
  敌人同样被求解兜底（敌人 AI 是逻辑层直线推进，render 层保证视觉不可穿）。

### 2. 灌木可穿 + 进入视觉反馈（user stories 16/17）

- 根因修复：navmesh 原先把**所有** PROPS 当障碍，玩家点灌木中心被吸附到灌木外，
  进入反馈永远不触发。票 28 起 navmesh 障碍只来自硬碰撞体（灌木除外）。
- `bushOcclusionAt`（纯函数）按距灌木中心线性衰减算遮挡强度，`bushAlphaForOcclusion`
  映射到角色不透明度，下限 0.55（藏进灌木仍可辨认）。ego-browser 实测：
  玩家走到 `prop.bush.south-west` 中心 → `occlusion 1` / `playerAlpha 0.55`。

### 3. 边界景观环带 + 渐暗雾（user story 18）

- `landscape-ring.ts`：环带地面（±76/±72）+ 8 座低模山丘 + 20 棵远景树（树干 + 圆锥冠），
  共 49 个网格；全部 `disableLighting` 自发光 + 不参与碰撞/寻路。
- 线性雾 `FOG_START 22 / FOG_END 48`，雾色取锚定图天空的灰蓝紫（`FOG_COLOR`）。
  L1 锁定不变量：`FOG_END < landscapeEdgeMinDistance()`（环带外缘离相机最近 54m），
  保证雾在外缘前饱和，屏幕边缘永远看到雾色而非环带边界。
- **修过的坑**：暗角（vignette 1.1）会把屏幕角落的自发光剪影压成近黑，形成 V 形黑块——
  正是票面要消除的「黑色虚无」。解法：环带材质改为全自发光（亮色）+ 雾提前饱和 +
  暗角降到 0.35。实测四方向角落亮度 0.42–0.77（阈值 0.2）。
- 截图：`artifacts/p1-world-28-landscape-{north,east,south,west}.png` + `p1-world-28-beauty.png`。

### 4. 统一主光 + 暗部紫灰（user story 19）

- `installUnifiedKeyLight`：关闭 main.ts 的默认双光源，全场只留 `light.key.world`，
  方向 `KEY_LIGHT_DIRECTION`（归一后仰角 37.7°、水平方位 -135° = 等距画面左上），
  暖白主光 + 紫灰环境色（`AMBIENT_COLOR`）由 toon shader 的 `ambientColor` 承载。
- 「左上 45°」是**屏幕空间**约定（锚定图里树在左上、墙影朝右下），L1 用
  `validateKeyLight` 锁定方位角落在画面左上象限（-90°..-180°）。
- 色调分级沿用 DefaultRenderingPipeline（ACES + 暖高光/紫蓝阴影曲线），仅暗角减重。
- 场景 setup 增加两道自检：`validateLandscape()` / `validateKeyLight()` 失败直接抛错，
  避免「黑色虚无/错误方向」这类只能靠截图发现的问题流入 L4。

### 5. NPC 待机行为（user story 20）

- 纯逻辑 `sampleNpcIdle`（呼吸正弦摆动 + 偶尔踱步，mulberry32 确定性随机，踱步目标
  钳回区域边界）+ 表现层 `NpcIdleController`（只改视觉节点 transform，不写逻辑快照）。
- L1 断言：摆动有界且周期性、踱步目标在半径内且不越界、同随机源可复现。
- ego-browser 实测：400 帧内 2 个 NPC 都出现过踱步状态，位置发生小位移。

### 6. 测试与预算

- **L1**：`world-physics.test.ts` 42 例 + `prop-mesh-recipe.test.ts` 12 例（新增 54 例），
  全量 vitest **235/235 绿**（基线 181）。
- **L4**：`reports/ticket28-l4-smoke.json` 9/9 断言通过
  （网格化 4 类 / 撞树被挡 / 灌木可穿+半透明 / 移动不被挡死 / NPC 待机 / 雾开 /
  唯一主光 / 四方向无黑色虚无 / 预算达标）。冒烟脚本
  `.scratch/browser-isometric-rpg/smoke/round-02-world-texture.mjs` 可重跑。
- **L5**：`p1-world` measure **passed**：fpsAverage 60 / drawCallsMax 257 (≤350) /
  jsHeap 148MB (≤1500) / longFrames 0 / renderScale 0.68（动态分辨率 auto）。
  drawCalls 从 P1 的 38 升到 257，主因是环带可见面积变大，仍在预算内、无需逐件 LOD。
- build / content:lint / assets:lint 全绿。

### 7. 遗留：远景风格样本图（待用户确认）

- 按票面要求用 ego-browser 走 Gemini 生成「远景/天际线」样本：已确认 Gemini 登录态可用、
  提示词发送成功，但图像生成未能在会话内产出（Gemini 的 shadow-DOM 会话状态跨脚本轮次
  丢失，轮询 150s 无 blob 产出）。
- **当前落地方案 = 程序化配色**（票面预留的备用路线）：环带/山丘/远景树/雾色直接取自
  `anchor-v1.png` 的观感（清新暖绿草地、灰蓝紫远空、暗部紫灰），常量集中在
  `world-physics.ts` 的 `LANDSCAPE_*` / `FOG_COLOR`，改配色只动这一处。
- **待用户确认**：是否认可程序化配色作为远景锚定，或由用户/后续票重新走 Gemini 出图。
  确认结果请回写本条。

### 决策与偏离说明

- 「moveWithCollisions」按 Babylon 内置碰撞引擎实现为**纯逻辑逐轴求解 + 贴面推挤**
  （`resolveMoveWithColliders`）：位置权威在逻辑层（GameSession），逻辑层不接受
  引擎侧位置回写，因此用可 L1 直测的纯函数等价实现同一行为（不可穿 + 可滑行）。
  mesh 上仍保留 `checkCollisions` 供未来系统使用。
- 遮挡描边的 OBB 尺寸沿用票 25 的「树干/墙体窄盒」而非新网格的视觉包围盒：
  用树冠全宽会让描边在离树干很远处触发，观感发散；硬碰撞尺寸与遮挡尺寸从此分离
  （前者管「不可穿」，后者管「被挡住时的描边」）。
