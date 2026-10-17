# P0 灰盒原型验证 · 最终报告

- 日期：2026-10-17
- 基线：`p0-integration` @ `0d96302`（ticket 10–17 已合并）
- 环境：Apple M5 MacBook Air / 16GB / macOS 26.7.1；ego-browser Chromium 154；WebGL2（ANGLE Metal Renderer: Apple M5）；DPR 2；视口 1450×826 CSS（渲染 2900×1652）；冒烟期间用 `caffeinate -dimsu` 防止 macOS 休眠节流 rAF。
- 证据：`reports/p0-smoke.json`、`reports/p0-characters-1080p.json`、`reports/p0-*.json`、`artifacts/*`
- 关联规格：`.scratch/browser-isometric-rpg/specs/p0-prototype-validation.md`；预算草案：`.scratch/browser-isometric-rpg/issues/07-platform-budget-license.md`

## 0. 结论摘要

**建议进入 P1**，但 P1 规格前必须完成 4 项技术债和 2 项用户手做（见第 6 节）。P0 的 18 项验证全部有结论：15 项通过或边界通过，2 项部分通过（KTX2 Safari 待实测、真实 VRoid 链路待用户手做），1 项 blocked（Blender 未安装，headless 可重复性待测）。另有 Safari、移动端、生产构建首屏 3 项因环境限制未完整实测，已在预算修正中标记为 P1 必补。

三个预注册降级预案均未触发：

- Editor git 友好，**不触发 LDtk 降级**。
- inkjs 可用（Continue 均值 0.044ms/步），**不触发自研对话 DSL**。
- KTX2 在 Chromium WebGL2/WebGPU 通过；Safari 未实测，**PNG 回退保留**。

最大风险不是“某项功能不可行”，而是 **300 角色 60fps 没有余量**：平均帧率能到 60，但 `fpsMin` 在 26.6–51.3 之间波动，帧时间阈值还会导致报告状态抖动。P1 预算必须改成“分辨率 + 画质档位 + 帧时间分位数”的联动口径。

---

## 1. L4 冒烟结果（ego-browser，9 个 scenario × 2 轮）

所有场景均能加载、执行并产出 `MeasurementReport` JSON（页面 `#report-output` 非空，Harness 内部 `assertValidMeasurementReport` 通过）。

| Scenario | 第 1 轮 | 第 2 轮 | 场景内耗时（轮 1 / 轮 2） | 关键读数 | 稳定性 |
|---|---|---|---|---|---|
| `hello` | passed | passed | 1ms / 1ms | 正交相机、74 meshes、报告 1106 字符 | 稳定 |
| `characters-300` | report failed（阈值抖动） | passed | 14069ms / 13086ms | 60.0 / 60.1fps，fpsMin 51.3 / 43.3，draw 300，4.79 / 4.68MP | 执行稳定；状态因 `frameTimeMsAverage=16.7 > 16.6667` 抖动 |
| `crowd-nav` | passed | passed | 6149ms / 5166ms | 60fps；200×200 navmesh 热路径 25.1 / 22.9ms | 稳定 |
| `crowd-hot-swap` | passed | passed | 7182ms / 6185ms | 切换帧 16.1 / 15.7ms；spikeRatio 0.91 / 0.89；0 位置突变 | 稳定 |
| `occlusion-outline` | passed | passed | 17233ms / 17197ms | 24/30 描边；60fps；Highlight 0.629 / 0.544ms/帧 | 稳定 |
| `region-loading` | passed | passed | 2881ms / 2381ms | preload 46.1 / 24.5ms；masked warmup 499 / 151.9ms；reveal max 19.4 / 18.0ms | 稳定 |
| `region-gate` | passed | passed | 5981ms / 5530ms | swap 1.5 / 0.5ms；最大帧 19.4 / 18.6ms；退出后 mesh 数复原 | 稳定 |
| `anime-pipeline` | passed | passed | 647ms / 632ms | 62.1 / 62.3fps；toon/描边/分级均启用 | 稳定 |
| `asset-pipeline` | passed（修复前置后） | passed（修复前置后） | 709ms / 681ms | meshopt/draco/KTX2/LOD 全部产出指标 | 首次 4 次超时是环境缺失，非 flaky；补 `assets:vendor` 后 2/2 稳定 |

**冒烟总耗时**：首轮约 54s（含 characters 14s + occlusion 17s），第二轮约 49s。作为每 PR 的 L4 冒烟可接受。

### 1.1 冒烟发现的两个操作性问题

1. **fresh checkout 必须先 `npm run assets:vendor`**。`public/vendor/` 被 `.gitignore` 忽略；缺失时 `asset-pipeline` 在加载 `character_test_meshopt.glb` 时抛：
   `RuntimeError: Unable to load from file:character_test_meshopt.glb: [object Event]`
   生成 14 个解码器文件后场景恢复正常。建议把 `npm ci && npm run assets:vendor` 写进 L4/CI 的固定前置步骤。
2. **`frameTimeMsAverage` 阈值 16.6667ms 过严**。60fps 对应的平均帧时间四舍五入就是 16.7ms，导致同一 60fps 读数在 passed/failed 之间抖动。建议改为 `fpsAverage >= 59.5` 作为主判据，帧时间用 p95/p99，不用平均值卡 16.6667。

---

## 2. 18 项验证总表（实测 vs 阈值 vs 结论）

说明：07 预算只覆盖帧率、draw calls、包体、单区域资产、内存、首屏；其余项 07 未定义阈值，采用票面验收目标或 ADR 约束，并在第 4 节建议补入预算。

| # | 验证项 | 实测数字 | 07 预算 / 票面阈值 | 结论 |
|---|---|---|---|---|
| 1 | 300 骨骼动画角色同屏（WebGL2） | 平均 60.0 / 60.1fps @4.79 / 4.68MP；fpsMin 51.3 / 43.3；帧时间 16.7 / 16.6ms；draw calls 300；JS heap 76.5 / 99.3MB；CPU 骨骼 0.19–0.32ms、`scene.render()` 1.58–3.72ms | 60fps 桌面；draw calls ≤300；内存 ≤1.5GB | **边界通过**：均值达标、draw/内存达标；但无余量，帧率对电源/热/后台负载敏感 |
| 2 | WebGPU 路径对比（ticket 11） | 39.4fps @4.79MP；fpsMin 1；帧时间 25.4ms；`scene.render()` 4.86ms；内存 75.7MB | 07 未定义（WebGPU 仅增强路径） | **通过（结论：本场景无收益）**：保持 WebGL2 基线 |
| 3 | Crowd navmesh 200×200（ticket 12） | 冷启动 143.1ms / 45KB / JS heap +0.8MB；300×300 冷 277.7ms。ticket 18 热路径 200×200 25.1 / 22.9ms、300×300 48.8 / 47.2ms | 07 未定义；建议新增 ≤150ms（冷） | **通过**：200×200 可主线程同步生成；>200 需 Worker/预烘焙 |
| 4 | 跨区 navmesh 热替换（ticket 12） | 切换同步工作 2.9ms（冷）/ 1.1–1.9ms（热）；切换帧 32.0ms（冷、40fps 负载下）/ 16.1 / 15.7ms（热）；spikeRatio 0.92 / 0.89–0.91；50 agents 全部迁移；maxPositionSnap 0 | 07 未定义；票面：无断点/卡顿 | **通过**：无位置突变，切换帧不超过切换前 p95 |
| 5 | 遮挡描边 24 角色（ticket 13） | 24/30 被遮挡并描边；基线 60.1fps vs 描边 60.0fps；Highlight 0.652ms/帧（ticket 18：0.629 / 0.544）；draw calls +40；射线检测 0.019ms/帧（ticket 18：0.013–0.021）；0 长帧 | 07 未定义；票面：≥10 角色、≥57fps | **通过**：HighlightLayer 方案可用，成本线性、可控 |
| 6 | 50MB 区域加载（ticket 14） | 49.314MB；preload 55.3ms（冷）/ 24.5–46.1ms（热）；addAllToScene 0.4ms；remove 0.3ms；dispose 2.1–6ms；JS heap 峰值增量 251.0MB（ticket 18：266.9–286.5MB）；masked warmup 1140.6ms（冷）/ 151.9–499ms（热）；warmup 后 reveal max 36ms，未 warmup 时 203–233ms | 单区域 ≤50MB；内存 ≤1.5GB；首屏 ≤5s | **通过（资产/内存）**；首帧预热必须计入加载门预算，首屏预算另需生产构建实测 |
| 7 | Editor git 友好度（ticket 14） | 对象为 UUID JSON；no-op save 0 文件变化；移动一个对象仅 1 行文本 diff；首保存 11 文件/309 insertions/204 deletions（版本升级一次性）；唯一二进制噪声 `preview.png` | 07 未定义；票面：文本可 review / 不触发 LDtk | **通过**：`gitFriendly=true`，`ldktDowngradeTriggered=false` |
| 8 | meshopt vs draco（ticket 15） | 基线 592,736B；meshopt 200,660B（33.9%）、几何 67,001B；draco 298,924B（50.4%）、几何 167,438B；meshopt 几何体积为 draco 的 40.0%；解码器中位 5.8ms vs 4.7ms（5 轮中位）；解码器体积约小 30 倍 | 07 未定义；票面：锁定压缩方案 | **通过，锁定 meshopt** |
| 9 | 自动 LOD 质量（ticket 15） | LOD0/1/2 = 11,488 / 5,744 / 2,296 三角；近景 PSNR 48.017 / 37.576dB；远景 64.949 / 53.643dB；通过阈值 40 / 32 / 40dB | 07 未定义；票面：可接受/需手动 | **通过**：3 级 LOD，LOD2 仅远景/小屏 |
| 10 | KTX2 兼容性（ticket 15） | PNG 127,967B → KTX2 59,853B（46.8%）；生产组合 132,620B；Chromium WebGL2 ETC2 通过（冷 147.9ms / 热中位 6.6ms）；Chromium WebGPU 通过但转码为 RGBA8（冷 165.3ms / 热 25.7–29.5ms）；Safari 未实测 | 07 未定义；票面：Safari/WebGPU 兼容 | **部分通过**：Chromium 通过；Safari 待测，PNG 回退保留 |
| 11 | headless Blender 可重复性（ticket 15） | `blender` 未安装，导出未实测；替代验证：glTF-Transform 管线两次构建 7 个 GLB 字节一致；程序化构建两次 SHA256 一致（592,736B） | 票面：两次产物字节一致 | **blocked**：脚本与复现命令已就绪，待装 Blender |
| 12 | lint 规则 + 负向自测（ticket 15） | 8/8 资产 passed、0 errors / 0 warnings；负向 fixture 正确捕获 1 条 non-manifold error + 1 条 boundary-edge warning；自测 `assertNonManifoldCaught=true` | 票面：规则跑通、负向可捕获 | **通过** |
| 13 | inkjs 对话性能（ticket 16） | 300 节点树 Continue 均值 0.044ms/步；variablesState 快照往返正确；无需自研 DSL | 票面：几百节点可用、快照正确 | **通过** |
| 14 | 修饰器 schema（ticket 16） | 装备/buff/任务奖励三场景 vitest 全绿；冻结边界已定义（条件型修饰器按条件增删列表项；百分比加性聚合；无 clamp；绝对游戏时间；叠层上限在 buff 定义层） | 票面：表达力确认后可冻结 | **通过，可冻结** |
| 15 | 存档迁移链（ticket 16） | v1→v2 模拟迁移测试绿；快照可序列化；当前全仓 43/43 测试通过 | 票面：迁移链雏形绿 | **通过（雏形）** |
| 16 | vitest 逻辑/表现边界（ticket 16） | 深层子路径导入可行；barrel 导入 661ms（慢）；NullEngine 可测无渲染场景图；真实渲染仍需浏览器 | ADR-0005：逻辑/表现分离 | **通过**：边界明确，L1 可直测 `src/logic` |
| 17 | ego-browser L4 冒烟（ticket 18） | 9/9 scenario 执行并产出报告；8/9 两轮状态稳定；characters 状态抖动来自帧时间阈值而非崩溃；asset-pipeline 需 `assets:vendor` 前置；总耗时首轮约 54s | ADR-0005：L4 可重试、不阻塞 | **通过（L4 可行）**；补前置步骤并修正阈值 |
| 18 | VRoid → glTF → toon（ticket 17） | 程序化占位角色 11,236 三角 / 22 骨骼 / 2 动画 / 1 morph；lint 0/0；toon 开/关 5 张截图；62.1–62.3fps；VRM→GLB 转换器自测通过。真实 VRoid/Mixamo 未执行（无 VRoid Studio / Blender / Adobe 登录态） | 票面：一个 VRoid 角色 + Mixamo 动画 + toon 开关 | **部分通过**：渲染链路通过；真实资产链路待用户手做（约 15 分钟） |

---

## 3. 关键分项结论

### 3.1 300 角色：能到 60fps，但没有余量

同一场景的三组读数：

| 条件 | 平均 fps | fpsMin | 平均帧时间 | 渲染像素 | draw calls |
|---|---:|---:|---:|---:|---:|
| ticket 11 提交报告（4.79MP） | 40.4 | 20.0 | 24.8ms | 4.79MP | 300 |
| ticket 18 干净重跑 轮 1（4.79MP） | 60.0 | 51.3 | 16.7ms | 4.79MP | 300 |
| ticket 18 干净重跑 轮 2（4.68MP） | 60.1 | 43.3 | 16.6ms | 4.68MP | 300 |
| ticket 18 补充 1080p 轮 1（2.07MP） | 60.0 | 51.0 | 16.7ms | 2.07MP | 300 |
| ticket 18 补充 1080p 轮 2（2.07MP） | 59.7 | 26.6 | 16.8ms | 2.07MP | 300 |
| ticket 11 低分辨率诊断（0.29MP） | 60.1 | 47.6 | 16.7ms | 0.29MP | 300 |

解释与结论：

- ticket 11 的 40.4fps 与 ticket 18 的 60fps 差异，最可能是测量时的电源/热/后台负载状态不同（前票与其他 agent worktree 共享机器；本次用 `caffeinate` 且无并发负载）。这正说明该场景**对机器状态高度敏感**。
- CPU 侧不是瓶颈：骨骼更新 0.19–0.37ms/帧，`scene.render()` JS 1.58–4.37ms，`renderSubmit` 0.7–2.21ms，均远小于 16.67ms。瓶颈在 GPU 填充/提交；低分辨率诊断曾稳定 60.1fps，证实填充率敏感。
- 在 2.07MP 与 4.7–4.8MP 两种分辨率下平均都能到 60fps，但 `fpsMin` 分别为 26.6–51.0 与 43.3–51.3，说明存在掉帧。**“平均 60fps”不能当作通过标准**。
- 预算结论：300 角色 @ 原生高分辨率不保证稳定 60fps；要么降到约 200 角色，要么引入动态分辨率/画质档位。P1 用 `fpsAverage >= 60` + `p95 帧时间 <= 17ms` + `fpsMin >= 50` 三条件判定。

### 3.2 Crowd 寻路与热替换

- 200×200 navmesh：冷启动 143.1ms、45KB、JS heap +0.8MB；热路径 25.1 / 22.9ms。300×300 冷 277.7ms、热 47–49ms。
- 50 agents：0 重叠对、最小间距 0.8 units；crowd 更新 0.22–0.39ms/帧，不是瓶颈；5s 采样内 28/50 到达目标（受目标分布与避让影响，非卡死）。
- 热替换：同步工作 1.1–2.9ms；切换帧 15.7–16.1ms（热）/ 32.0ms（冷、40fps 负载下）；spikeRatio 0.89–0.92（小于切换前 p95 34.6ms）；50 agents 全部迁移；`maxPositionSnap=0`。
- 规模上限建议：**200×200 是主线程同步生成 + 加载门的推荐上限**；300×300 冷启动 278ms 已超过单帧可接受范围，只应走 Worker/离线预烘焙 + tiled navmesh。

### 3.3 遮挡描边

- 24/30 角色被遮挡并描边，6 人开阔地正确不描边；基线 60.1fps vs 描边 60.0fps，`fpsDelta=-0.1`。
- HighlightLayer 0.544–0.652ms/帧，draw calls +40（36 → 76），射线检测 0.013–0.021ms/帧，0 长帧。
- 关键实现坑：`scene.pick` 产生 34 个 GC 长帧；改用自建零分配射线-OBB（slab 法）后消失。该坑应写入 ADR-0002 代价节。
- 低端 GPU 上全屏模糊填充仍是风险；50–100 人规模需复测，必要时评估屏幕空间描边。

### 3.4 区域加载与 Editor

- 49.314MB（47.03MiB）区域：AssetContainer preload 55.3ms（冷）/ 24.5–46.1ms（热），`addAllToScene` 0.4ms，remove 0.3ms，dispose 2.1–6ms。
- JS heap：峰值增量 251.0MB（冷）/ 266.9–286.5MB（热）；heap 采样是 `performance.memory` 代理，不含 GPU 显存与进程 RSS。
- 首帧真实成本：`addAllToScene` 本身 <1ms，但首帧 GPU 上传/shader 编译会卡 203–233ms。黑场预热 1.14s（冷）后 reveal max 降到 36ms；ticket 18 热缓存下 warmup 152–499ms、reveal max 18–19.4ms。**加载门必须盖住 addAllToScene 后的第一帧**，否则预热成本会暴露成可见卡顿。
- 预载时 GLB 已是内存 Blob，preload 不含网络下载；真实 50MB 下载必须另计。
- Editor v5.5.2：对象按 UUID 存 JSON，no-op save 0 diff，移动对象 1 行 diff；`preview.png` 是唯一每次保存都变的二进制噪声。结论 `gitFriendly=true`，不触发 LDtk。

### 3.5 资产管线、逻辑层与二次元链路

- **meshopt 锁定**：总字节 33.9% vs 基线、50.4% vs draco；几何字节为 draco 的 40%；解码器中位耗时相当（5.8ms vs 4.7ms），解码器体积小约 30 倍。
- **LOD 可接受**：LOD1 近景 48.017dB、LOD2 近景 37.576dB、LOD2 远景 53.643dB；建议 3 级，LOD2 只用于远景/小屏。
- **KTX2**：Chromium WebGL2 走 ETC2 GPU 压缩；WebGPU 当前转码为 RGBA8，显存收益未确认；Safari 未实测，PNG 回退保留。
- **lint**：8/8 资产通过；负向自测正确捕获非流形与边界边。
- **inkjs**：0.044ms/步，快照往返正确；无需自研 DSL。
- **修饰器 schema**：可冻结，冻结边界见第 2 节第 14 项；后续变更走迁移链 + 新 ADR。
- **Blender**：未安装，headless 可重复性 blocked；补测命令：
  - `npm run assets:blender`（导出测试资产）
  - `npm run assets:blender:repro`（两次运行字节比对）
- **二次元**：程序化占位角色 + 自定义三阶色阶 ShaderMaterial + `renderOutline` + `DefaultRenderingPipeline` 已在 62.1–62.3fps 下验证；Babylon 9.31.0 未导出 `ToonMaterial`，P1 需决定继续用自定义 ShaderMaterial 还是 NodeMaterial。真实 VRoid/Mixamo 链路待用户手做。

---

## 4. 07 预算修正建议（草案数值 → 实测数值）

### 4.1 原预算项修正

| 预算项 | 07 草案 | P0 实测 | 建议修正 |
|---|---|---|---|
| 帧率 | 60fps 桌面 / 30fps 中端移动 | 300 角色：40.4–60.1fps @4.7–4.8MP；60.0/59.7fps @2.07MP；fpsMin 26.6–51.3；0.29MP 时 60.1fps | 改为**分辨率联动的画质档位**：目标档 1920×1080（2.07MP）@60fps；retina/4K（≥4.7MP）@45–60fps + 动态分辨率；移动端 30fps @≤1MP。判定用 `fpsAverage >= 60`、`p95 帧时间 <= 17ms`、`fpsMin >= 50`，不再只用平均值 |
| 单帧 draw calls | ≤300（WebGL2） | 300 角色峰值 300；描边场景 36 → 76（+40） | 保留 **基础场景 ≤300**；叠加层单列 **描边/VFX ≤50**，总量 ≤350 |
| 初始包体 | ≤8MB gzip（引擎+框架+首场景） | 生产构建：全部 JS gzip 1.48MB；主 chunk 609.86kB gzip；`dist` 总计 9.19MB（含 wasm/资产） | 保留 ≤8MB gzip，但明确口径为“**首屏加载的 JS+wasm gzip**”；当前 1.48MB 全部 JS 已通过。资产不计入包体预算 |
| 单区域资产 | ≤50MB（含 KTX2） | 49.314MB；preload 55.3ms；add/remove <1ms；heap 增量 251–286MB | 保留 ≤50MB，并拆成：**preload 解析 ≤100ms；add/remove ≤1ms；dispose ≤10ms；JS heap 增量 ≤300MB/区域；masked warmup ≤1.5s 冷；warmup 后首帧 ≤50ms** |
| 内存 | ≤1.5GB 桌面 / ≤800MB 移动 | 角色 68–99MB JS heap；区域峰值 323.8–373.0MB JS heap（增量 251–286MB） | **按区域增量校准**：每 50MB 区域 JS heap 增量 ≤300MB；桌面绝对上限 1.5GB 暂保留为进程级目标，但需在 P1 用进程 RSS + GPU 显存实测。移动端 800MB 未验证 |
| 首屏可交互 | ≤5s 桌面 / ≤12s 中端移动 | 未测生产构建；dev server 页面加载 + hello 为 295–575ms（不可作为预算） | **P0 未验证，不能宣称通过**。P1 用 production build + Lighthouse（含网络节流）实测；区域进入时间另算，加载门预热计入 |
| navmesh（新增） | 07 无 | 200×200 冷 143.1ms；热 22.9–25.1ms；300×300 冷 277.7ms | 新增：**200×200 主线程生成 ≤150ms（冷）**；>200 必须 Worker/预烘焙；热路径 ≤30ms |
| Crowd 更新/切换（新增） | 07 无 | 更新 0.22–0.39ms/帧；开关同步 1.1–2.9ms；spikeRatio 0.89–0.92 | 新增：**crowd 更新 ≤1ms/帧；切换同步工作 ≤5ms；spikeRatio ≤1.0；位置突变 = 0** |
| 描边（新增） | 07 无 | 24 角色 0.544–0.652ms/帧；draw +40；检测 0.013–0.021ms/帧 | 新增：**24 角色 HighlightLayer ≤1ms/帧；draw calls +≤40；检测 ≤0.05ms/帧**；50+ 角色复测 |
| 压缩（新增） | 07 无 | meshopt 几何为 draco 的 40%，生产组合为基线 22.4%；KTX2 为 PNG 46.8% | 新增：**几何必须 meshopt；生产组合 ≤25% 基线；KTX2 贴图 ≤50% PNG** |
| LOD（新增） | 07 无 | LOD1/2 近景 48.017/37.576dB；远景 64.949/53.643dB | 新增：**3 级 LOD；LOD1 近景 PSNR ≥40dB；LOD2 近景 ≥32dB、远景 ≥40dB** |
| 对话（新增） | 07 无 | inkjs Continue 0.044ms/步 | 新增：**单步 Continue ≤1ms（P95）**；几百节点树无卡顿 |
| 编译预热（新增） | 07 无 | 无 warmup 首帧 203–233ms；warmup 后 18–36ms | 新增：**加载门覆盖首帧预热；masked warmup ≤1.5s 冷；预热后 reveal 最大帧 ≤50ms** |

### 4.2 建议写回 07 Answer 的替换段

> **P0 实测修正（2026-10-17，ticket 18）**
>
> - 帧率预算改为分辨率联动：1080p 目标 60fps；retina/4K 目标 45–60fps + 动态分辨率；判定同时看 `fpsAverage`、`p95 帧时间`、`fpsMin`。300 角色在 4.7–4.8MP 下平均可达 60fps 但 `fpsMin` 低至 43.3；1080p 下 `fpsMin` 低至 26.6，不能视为稳定通过。
> - draw calls 保留 ≤300 基础场景，描边/VFX 另加 ≤50。
> - 单区域 ≤50MB 保留；新增 preload ≤100ms、add/remove ≤1ms、dispose ≤10ms、JS heap 增量 ≤300MB、masked warmup ≤1.5s、预热后首帧 ≤50ms。
> - 内存按区域增量校准为 ≤300MB/50MB 区域；1.5GB 仅作进程级暂定上限，P1 需补进程 RSS 与 GPU 显存。
> - 首屏 ≤5s 未在 P0 验证，P1 用生产构建实测。
> - 新增 navmesh、crowd、描边、压缩、LOD、对话、编译预热的预算行（见 ticket 18 报告第 4.1 节）。

---

## 5. ADR 更新建议（只列建议，不直接改 ADR）

### ADR-0002（纯点击移动 + Crowd Navigation V2 + 描边）

- **描边方案确认可用**：24/30 角色同时描边、60fps、HighlightLayer 0.544–0.652ms/帧、draw calls +40。
- **补充实现坑**：`scene.pick` 在本场景产生 34 个 GC 长帧；改用零分配射线-OBB（slab 法）后消失。建议把“遮挡检测禁止每帧 `scene.pick`”写入代价/实现约束。
- **Crowd 数字**：200×200 navmesh 冷 143.1ms / 热 22.9–25.1ms；300×300 冷 277.7ms；热替换同步 1.1–2.9ms、spikeRatio 0.89–0.92、0 位置突变。建议把“200×200 为同步生成上限，>200 走 Worker/预烘焙”写入代价节。
- **低端 GPU 风险**：HighlightLayer 是全屏模糊填充，50–100 人规模需复测；必要时评估屏幕空间描边。

### ADR-0003（区域 = AssetContainer + 加载门）

- **加载门必须覆盖 `addAllToScene` 后的第一帧**：首帧 GPU 上传/shader 编译 203–233ms；黑场预热 1.14s（冷）后 reveal max 36ms。建议把这条写成决策约束，而不只是“加载门是体验妥协”。
- **加载门预算**：masked warmup ≤1.5s 冷；预热后首帧 ≤50ms；add/remove <1ms；dispose ≤10ms。
- **Editor 结论**：git 友好、no-op save 幂等、移动对象 1 行 diff；**双轨策略确认，不触发 LDtk 降级**。建议在代价节补：`preview.png` 加入 gitignore，`.babylonbinarymeshdata`/`.env` 用 Git LFS 或导出步骤管理；避免同一分支混用 Editor 版本。
- **网络下载未计入**：P0 的 50MB 是内存 Blob 解析，不是网络传输；P1 需把真实下载时间计入加载门预算。

### ADR-0004（Ink + EntityId + 修饰器）

- **修饰器 schema 确认可冻结**，建议在 ADR 中记录冻结边界：条件型修饰器按条件增删列表项；百分比加性聚合；无 clamp；绝对游戏时间；叠层上限在 buff 定义层。后续变更走迁移链 + 新 ADR。
- **inkjs 风险降级**：300 节点树 Continue 0.044ms/步，快照往返正确，无需自研极简 DSL。建议把代价节中的“inkjs 为个人维护移植”风险从“待验证”改为“可用，持续关注维护状态”。
- **存档迁移**：v1→v2 模拟迁移测试绿；建议明确“所有 schema 变更必须附带迁移函数 + 往返测试”。

### ADR-0005（五层测试 + ego-browser）

- **L4 冒烟实测可行**：9 个 scenario × 2 轮，全部执行并产出统一 JSON；总耗时约 50–55s/轮。建议把“fresh checkout 先 `npm ci && npm run assets:vendor`”写进 L4/CI 约定。
- **L4 与 L5 分工**：L4 只验加载/执行/报告产出，不判定性能阈值；性能判定放 L5 夜间，并要求 `caffeinate`/固定电源状态、固定视口/DPR、干净浏览器、预热缓存、多次运行取 p95/fpsMin。
- **阈值修正**：`frameTimeMsAverage <= 16.6667` 会导致 60fps 读数抖动为 failed；建议主判据改为 `fpsAverage`，帧时间用 p95。
- **报告 schema 复用**：`MeasurementReport` 已验证可序列化、可 assert，可直接作为 L5 夜测的输入格式。

---

## 6. 进入 P1 的建议

### 6.1 决策

**建议进入 P1 规格**。P0 已验证引擎、渲染、寻路、加载、资产、逻辑、测试七条主线均可行；没有触发任何降级预案。进入 P1 的前提是把下列项排进 P1 规格，而不是继续留在“以后再说”。

### 6.2 P1 规格前必须补的项

**用户手做（阻塞真实资产链路）：**

1. **VRoid 角色（约 15 分钟）**：安装 VRoid Studio → 默认模板捏人 → 导出 VRM → 运行
   `node tools/pipeline/vrm-to-glb.mjs ~/Downloads/character.vrm assets/character_vroid_lod0.glb`
   → `npm run assets:lint` → 打开 `?scenario=anime-pipeline` 验证。场景会自动优先加载真实资产。
2. **安装 Blender（可选 Mixamo）**：用于 headless 导出可重复性复测和 Mixamo FBX 烘焙。补测命令：
   `npm run assets:blender`、`npm run assets:blender:repro`。若只验证 toon 观感，第 1 步足够。

**技术债（P1 规格必须设计）：**

1. **动态分辨率/画质档位**：把帧率预算改为分辨率联动；决定“300 角色 + 动态分辨率”还是“200 角色 + 原生分辨率”。P1 验收需覆盖 1080p 与 retina 两档。
2. **L5 性能测量协议**：固定电源状态（caffeinate/插电）、固定视口与 DPR、干净浏览器、预热缓存、多次运行；指标用 `fpsAverage + p95 + fpsMin + long frames`，并补进程 RSS / GPU 显存。
3. **首屏与包体实测**：production build + Lighthouse（含网络节流）；当前 P0 只测了 dev server，首屏 ≤5s 不能宣称通过。补测初始 JS/wasm gzip 与首屏可交互。
4. **区域加载预算落地**：把 masked warmup、网络下载、首帧预热写进加载门实现；若 P1 需要无缝流式，升级为 tiled navmesh + Worker/预烘焙。
5. **Safari KTX2**：P1 在真实 Safari/iOS 上复测；未通过则启用 PNG 回退。WebGPU 路径的 KTX2 目前转码为 RGBA8，显存收益需单独确认。
6. **阈值与 UI**：修正 `frameTimeMsAverage` 阈值抖动；Harness 增加“报告通过但性能边界”的提示，避免 L4 误判。

### 6.3 降级预案状态

| 预案 | 触发条件 | P0 结果 | P1 行动 |
|---|---|---|---|
| Editor git 不友好 → LDtk | 项目文件不可 review / 每次保存大量 diff | 未触发：gitFriendly=true，no-op save 0 diff | 保持双轨；preview.png gitignore，二进制走 LFS |
| inkjs 不可用 → 自研 DSL | 性能不足或快照不可用 | 未触发：0.044ms/步、快照往返正确 | 保持 inkjs，持续关注维护状态 |
| KTX2 Safari 失败 → PNG | Safari/iOS 加载失败或纹理未就绪 | 未触发（Safari 未测） | P1 补测；PNG 回退管线已就绪 |
| Blender 不可用 | headless 导出不可重复 | blocked（未安装） | 用户安装后复测；替代管线已字节一致 |
| VRoid/Mixamo 不可得 | 无 VRoid Studio / Adobe 登录态 | blocked（用户手做） | 用户导出 VRM 后复用现有场景 |

### 6.4 P1 垂直切片的建议验收基线

- 1080p（2.07MP）@60fps，`fpsMin >= 50`，p95 帧时间 ≤17ms；retina 档允许动态分辨率。
- 单区域 ≤50MB，进入加载门 ≤2s（含网络下载与预热，缓存命中时 ≤1s），预热后首帧 ≤50ms。
- 200×200 navmesh 冷生成 ≤150ms；50 agents 更新 ≤1ms/帧；切换无位置突变。
- 24 角色描边 ≤1ms/帧；draw calls 基础 ≤300、叠加 ≤50。
- 真实 VRoid 角色（用户提供）通过 lint 并在 toon 场景播放 Mixamo 动画。
- L1 逻辑测试全绿；L3 资产 lint 8/8 起；L4 9 个 scenario 冒烟全绿（允许重试）。

---

## 7. 测量方法与风险说明

1. **性能读数对方差敏感**：300 角色在 ticket 11 为 40.4fps，ticket 18 干净重跑为 60.0/60.1fps；1080p 补充测试为 60.0/59.7fps 且 `fpsMin` 26.6。差异来自电源/热/后台负载/共享浏览器。预算应采用保守值 + 分位数，而不是单次平均值。
2. **`performance.memory` 只是 JS heap**：不是进程 RSS，也不含 GPU 显存；256MB 增量不能等同于整机内存占用。
3. **区域 50MB 是内存 Blob**：preload 不含网络下载；真实网络传输必须另计。
4. **灰盒资产不是生产资产**：程序化几何/占位贴图与真实 VRoid、KTX2、蒙皮、动画的成本不同；P1 需用真实资产复测。
5. **Safari/移动端未实测**：KTX2、WebGPU、iOS 内存均无本机数据；只能按预注册预案保留回退。
6. **Dev server 不是生产构建**：冒烟与资产加载耗时包含 Vite 冷编译/热更新开销；生产包体与首屏需 P1 单独测。
7. **共享浏览器**：ego-browser 是共享环境，其他会话可能带来负载；本次已用 `caffeinate` 并取干净读数，但 L5 仍需固定协议。

---

## 8. 证据索引

**新增报告：**

- `reports/p0-smoke.json`：9 个 scenario × 2 轮的完整 Harness 报告，含每轮 wall time、场景耗时、报告文本长度。
- `reports/p0-characters-1080p.json`：300 角色在 1080p（2.07MP、DPR 1）下的两轮补充读数。

**既有报告：**

- `reports/p0-hello.json`
- `reports/p0-characters-300-webgl2.json`、`reports/p0-characters-300-webgpu.json`、`reports/p0-characters-300-webgl2-lowres-diagnostic.json`
- `reports/p0-crowd-nav.json`、`reports/p0-crowd-hot-swap.json`
- `reports/p0-occlusion-outline-webgl2.json`
- `reports/region-loading.json`、`reports/region-loading-notes.json`、`reports/region-gate.json`
- `reports/editor-git-friendliness.json`
- `reports/p0-asset-pipeline.json`、`reports/asset-pipeline-browser-runs.json`、`reports/ktx2-compatibility.json`、`reports/webgpu-ktx2.json`、`reports/lod-visual-comparison.json`、`reports/lint-negative-test.json`、`reports/pipeline-lint.json`、`reports/procedural-determinism.json`、`reports/blender-determinism.json`
- `reports/p0-anime-pipeline.json`、`reports/anime-pipeline.json`

**截图：**

- `artifacts/p0-harness.png`、`artifacts/p0-characters-300-webgl2.png`、`artifacts/p0-characters-300-webgpu.png`
- `artifacts/p0-crowd-nav.png`、`artifacts/p0-crowd-hot-swap.png`
- `artifacts/p0-occlusion-outline.png`、`artifacts/p0-occlusion-outline-baseline.png`
- `artifacts/region-gate-a.png`、`artifacts/region-gate-b.png`、`artifacts/region-gate-masked.png`
- `artifacts/anime-pipeline/toon-on.png`、`toon-off.png`、`toon-on-run.png`、`toon-on-closeup.png`、`toon-off-closeup.png`

**当前 worktree 校验：**

- `npm test`：7 个测试文件，43/43 通过。
- `npm run assets:lint`：8/8 资产通过，0 errors / 0 warnings。
- `npm run assets:lint:negative`：正确捕获 non-manifold + boundary-edge，`assertNonManifoldCaught=true`。
- `npm run build`：`tsc --noEmit` + Vite 生产构建通过；全部 JS gzip 1.48MB，主 chunk 609.86kB gzip。
- `which blender`：未找到（headless Blender 项 blocked）。
