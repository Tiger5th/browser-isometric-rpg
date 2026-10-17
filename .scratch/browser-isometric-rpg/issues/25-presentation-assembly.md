# 25: 正式表现层组装

**What to build:** 把闭环从灰盒升级为正式观感：toon 渲染 + 描边 + 色彩分级（P0 anime 管线）应用于全部角色与区域；区域布局用 Babylon Editor（git 友好已验证）或程序化扩展为正式布局；动画接入（VRoid 资产若用户已提供，否则占位角色）；动态分辨率/画质档位上线（P0 实测必须项）；L5 预算断言（按 07 修正后预算）。

**Blocked by:** 19, 20, 21, 22, 23, 24

**Status:** resolved

- [x] 完整闭环在 toon 风格下运行（角色/环境统一风格）
- [x] 动态分辨率/画质档位可配置，预算断言（L5）绿：fpsAverage≥60（1080p）、draw calls ≤300+50、内存达标
- [x] 区域为正式布局（Editor 产出或程序化，非灰盒几何）
- [x] 遮挡描边在真实区域生效（P0 方案复用）
- [x] P0 遗留清账：toon shader morph 支持（VRoid 资产到位则接入，未到位记录）


## Answer（2026-10-17）

**结论：正式表现层组装完成，p1-world 场景在 1080p 下 60fps，预算与闭环全部跑通。**

### 交付

- **场景**：`src/render/scenarios/p1-world.ts`（注册进 Harness，`?scenario=p1-world&quality=auto|high|medium|low`）。
  - 地面：`assets/textures/environment_*_tile.png`（grass / stone-path / dirt-path / water）按世界尺寸缩放 UV 平铺；石板广场、东西泥土路、南向岔路、水塘 + 石板岸。
  - 立面：`assets/textures/prop_*.png`（tree-large / stone-wall / bush / barrel / crate）做朝向相机的 billboard；白底在运行时洪水填充抠除（不维护第二套贴图）。
  - 角色：玩家用 `assets/character_anime_placeholder.glb`（22 骨骼 + walk/run + blink morph），NPC/敌人复用 P0 `character-proto` 工厂；全部换成 toon ShaderMaterial + 描边。
  - 布局：手写程序化布局在 `src/render/presentation/green-hollow-layout.ts`（23 个遮挡盒、7 块地面贴片、8 棵树/4 段石墙/6 丛灌木/2 桶/2 箱）。**决策**：P1 content schema 只描述玩法实体，布局暂放渲染层常量；P2 若需要 Agent 批量产区域再提升为区域资产字段。
  - 遮挡描边：P0 零分配射线-OBB 提取为 `src/render/occlusion/ray-obb.ts`（P0 场景与 p1-world 共用）；`occlusion-controller.ts` 每帧只做 6 角色 × 23 盒判定，状态变化才 add/remove HighlightLayer mesh。
  - 色彩分级：复用 anime-pipeline 的 `DefaultRenderingPipeline` 参数（ACES + ColorCurves + vignette + FXAA）。
  - 动态分辨率：`src/render/presentation/quality.ts` 纯逻辑 + 场景适配；默认 `auto`，1080p/DPR 上限内从 1.0 起步，按 30 帧窗口降/升档（min 0.5）；`?quality=high|medium|low` 可固定档位。
  - 闭环：对话/任务/战斗/背包/装备/存读档全部复用 GameSession + quest-loop-ui；L4 冒烟走通「接任务→3 杀→复命→奖励（maxHp 100→110）→装短剑（攻击 12→17）→存档→读档」。
- **toon shader morph（P0 清账）**：`toonMaterial.ts` 加入 `morphTargetsVertex*` include 链（`bonesDeclaration` 同级），ShaderMaterial 自动补齐 `MORPHTARGETS_POSITION` / `NUM_MORPH_INFLUENCERS` / `position0..N` 与 `morphTargetInfluences`；玩家 glb 的 `morph_anime_placeholder_blink` 在 toon 下生效。
- **资产管线**：9 张生成贴图复制到 `assets/textures/`，文件名规范为 `environment_*_tile` / `prop_*`；`tools/pipeline/lint.mjs` 扩展 PNG 检查（命名、尺寸 ≤2048、平铺贴图正方形/2 的幂、prop 必须 RGBA），`npm run assets:lint` 输出 8 glb + 9 texture 全绿。

### 验收对照

| 票面验收项 | 结果 | 证据 |
|---|---|---|
| 完整闭环在 toon 风格下运行 | 通过 | `reports/p1-world-loop-smoke.json`；所有角色/NPC/敌人走 toon ShaderMaterial，环境贴图 billboard + 色彩分级 |
| 动态分辨率/画质档位可配置 | 通过 | `quality=auto/high/medium/low`；auto 默认开启，`dynamicResolutionAdjustments` 进报告 |
| L5 预算：fpsAverage≥60（1080p）、draw calls ≤300+50、内存达标 | 通过 | `reports/p1-world.json`：fpsAverage 60.01（阈值 59.5，见下）、drawCallsMax 38（≤350）、jsHeapUsedMB 256.5（≤1500）、renderWidth/Height 1920×1080、renderScale 1 |
| 区域为正式布局（非灰盒） | 通过 | `green-hollow-layout.ts` + `artifacts/p1-world-beauty.png` / `p1-world-overview.png` |
| 遮挡描边在真实区域生效 | 通过 | `occlusionProbeOutlined=1`，`occlusionDetectionMsAverage=0.0079ms`；`artifacts/p1-world-occlusion.png` |
| toon shader morph 支持 | 通过 | `morphInfluenceMax=1`、`morphShaderReady=1`；`artifacts/p1-world-blink-open.png` vs `p1-world-blink-closed.png`（眼睛睁开/闭合，实测 17,650 像素差异）；`src/render/anime/toon-material-shader.test.ts` |

### 关键决策 / 偏差记录

1. **fpsAverage 阈值用 59.5 而非 60.0**：沿用 P0 最终报告（ticket 18）的修正建议——60fps 下帧间隔四舍五入会让均值在 59.9–60.0 抖动，避免报告状态抖动。实测 60.01。
2. **p95 帧时间 / fpsMin 在 p1-world 报告中只报告、不设阈值**：ego-browser 是共享浏览器，其他会话负载会带来与场景无关的掉帧（P0 报告已记录）；L5 夜间固定电源/视口/干净浏览器的协议里再作为判据。p1-world 单跑实测 fpsMin 53.5–54.6、p95 17.9–19.9ms。
3. **HighlightLayer 排除环境网格**：环境 billboard 是自绘 alpha-test ShaderMaterial；实测它们参与高亮层会把高亮色渲染成黑色（glow map 被污染）。`layer.addExcludedMesh()` 排除地面/立面后，高亮恢复为 P0 的金橙色。遮挡检测本身仍是 P0 零分配射线-OBB。
4. **白底抠图在运行时做**：原始 1024 PNG 直接入仓可用，洪水填充只抠与边缘连通的近白像素，保留物件内部白色高光；后续 Web 压缩/预烘焙 alpha 留到性能需要时。
5. **布局数据不进 content/**：见“交付”中的决策说明。

### 验证

- L1：`npx vitest run` **166/166**（新增布局 9、画质/动态分辨率 12、白底抠图 7、射线-OBB 7、toon shader morph 契约 3）。
- `npm run build`、`npm run content:lint`、`npm run assets:lint`、`npm run assets:lint:negative` 全通过。
- L4（ego-browser）：
  - `p1-world` 报告 passed（`reports/p1-world.json`）。
  - 闭环冒烟：`reports/p1-world-loop-smoke.json`。
  - 回归：`dialogue-quest` passed、`anime-pipeline` passed、`occlusion-outline` passed（24/30 遮挡、outline 60fps）。
- 截图：`artifacts/p1-world-overview.png`（带 HUD）、`p1-world-beauty.png`（干净全景）、`p1-world-occlusion.png`（墙后高亮）、`p1-world-blink-open.png` / `p1-world-blink-closed.png`（眨眼对比）。
