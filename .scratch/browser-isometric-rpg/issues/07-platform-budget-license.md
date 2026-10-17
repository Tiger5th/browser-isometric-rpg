# 浏览器兼容性 / 性能预算 / 开发成本 / 许可证风险

Type: research
Status: resolved
Blocked by: 01（部分可先行：预算与许可证审计不依赖引擎）

## 问题

- 支持哪些浏览器/设备基线（WebGL2 vs WebGPU、移动端是否一等公民）？
- 帧率、内存、包体的具体性能预算怎么定？
- 全部依赖（引擎、库、字体、美术工具）的许可证审计。
- 开发成本估算的基础假设。

## 产出

- 兼容性基线建议（需人工确认）
- 性能预算草案（数字 + 测量方法）
- 许可证清单

---

## Answer（研究结果，2026-10-17，引擎 = Babylon.js）

### 已确认事实

**浏览器兼容性基线（caniuse 数据，2026-10-17）**
- **WebGL2**：全主流浏览器全面支持（Chrome 56+、Firefox 51+、Safari 15+、Edge 79+、iOS 15+）。→ **这是本项目可靠的渲染基线**。
- **WebGPU**：Chrome 113+（2023-04）及其系生浏览器（Edge 113+、Android Chrome 154+、Samsung Internet 24+）已默认启用；**iOS/Safari（WebKit）26.0 起**支持（新版本号方案）；**Firefox 桌面版/Android 版至今未默认启用**（caniuse 无全支持记录）。
- 结论：WebGPU 可作**增强路径**（Babylon 自动回退 WebGL2），**不能作为基线**。默认渲染路径 = WebGL2，WebGPU 白名单渐进启用。

**SharedArrayBuffer / 跨域隔离**（未来若引入多线程 worker）
- 需要响应头 COOP/COEP；影响广告与第三方嵌入（Godot 文档确认的行业性约束，非引擎专属）。本项目当前架构（Babylon 主线程渲染 + 可选 worker）不强制要求，记录为部署注意事项。

### 性能预算草案（数字 + 测量方法）

| 预算项 | 初值 | 测量方法 |
|---|---|---|
| 帧率 | 60fps 桌面 / 30fps 中端移动（可接受底线） | Babylon SceneInstrumentation + Stats.js，记录 draw calls / frame time |
| 单帧 draw calls | ≤ 300（WebGL2 路径） | SceneInstrumentation.drawCallsCounter |
| 初始包体（引擎+框架+首场景） | ≤ 8MB gzip（tree-shaking 后实测修正） | webpack-bundle-analyzer + 产物 gzip |
| 单区域资产 | ≤ 50MB（含 KTX2 纹理） | 构建产物统计 + 网络面板实测 |
| 内存 | ≤ 1.5GB 桌面 / ≤ 800MB 移动 | performance.memory（Chrome）+ Babylon 内存面板 |
| 首屏可交互 | ≤ 5s 桌面 / ≤ 12s 中端移动 | Lighthouse CI |

- 这些是**假设值**，以 02 号 ticket 的原型实测为准修正（300 角色、50MB 区域两项实验直接产出真实数字）。
- 最低支持目标：**近 5 年主流桌面 + iOS Safari 15+/Android Chrome（WebGL2 即可）**。WebGPU 用户获得更佳性能/画质，非功能差异。

### 许可证清单（截至 2026-10-17）

| 组件 | 许可证 | 商用风险 |
|---|---|---|
| Babylon.js 9.x | Apache-2.0 | 无 |
| recast-navigation-js（Crowd V2 依赖） | MIT | 无 |
| Blender（工具，GPL 传染仅及 Blender 自身/插件，**导出文件不受影响**） | GPL-3.0 | 无（导出产物归我们） |
| glTF-Blender-IO | Apache-2.0 | 无 |
| glTF-Transform / meshoptimizer | MIT | 无 |
| KTX2 / basisu 转码器 | Apache-2.0 | 无 |
| glTF 规范本身 | Khronos 免版税 | 无 |
- **需持续关注**：未来引入的美术资产若外包/购买，需逐份确认授权范围（尤其“可在商业游戏中使用”条款）；字体许可（后续选 UI 字体时确认）。已记录进 05 号 ticket 备注。

### 开发成本估算基础假设

- 假设开发主力 = AI Agent 协作 + 人工做决策/验收（本项目模式）。成本主要由原型验证的迭代轮次和内容生产（美术资产量）主导，人力编码成本占比较小。
- 具体成本估算推迟到 08 号 ticket（路线图）统一产出——它依赖 04/06 的结论。

### 需要人工决策

- 兼容性基线确认：**WebGL2 为基线、WebGPU 渐进增强、iOS Safari 15+**——待确认。

## 决策（2026-10-17，用户确认）

兼容性基线：**WebGL2 为渲染基线，WebGPU 渐进增强（Babylon 自动回退），最低目标 iOS Safari 15+ / 近 5 年主流桌面浏览器。**

## P0 实测后的预算修正（ticket 18，2026-10-17）

来源：`artifacts/p0-final-report.md`、`reports/p0-smoke.json`、ticket 11–17 的 Answer 节。以下为对上方「性能预算草案」的修正，原草案数字保留作对照。

| 预算项 | 原草案 | P0 实测 | 修正值 |
|---|---|---|---|
| 帧率 | 60fps 桌面 / 30fps 中端移动 | 300 角色 40.4–60.1fps @4.7–4.8MP；1080p 60.0/59.7fps；fpsMin 26.6–51.3；0.29MP 时 60.1fps | 分辨率联动：1920×1080（2.07MP）目标 60fps；retina/4K（≥4.7MP）目标 45–60fps + 动态分辨率；移动端 30fps @≤1MP。判据：`fpsAverage ≥ 60`、`p95 帧时间 ≤ 17ms`、`fpsMin ≥ 50` |
| 单帧 draw calls | ≤300（WebGL2） | 300 角色峰值 300；描边场景 36→76（+40） | 基础场景 ≤300；描边/VFX 另加 ≤50；总量 ≤350 |
| 初始包体 | ≤8MB gzip（引擎+框架+首场景） | 全部 JS gzip 1.48MB；主 chunk 609.86kB gzip；`dist` 总计 9.19MB（含 wasm/资产） | 保留 ≤8MB gzip，明确口径为「初始 JS+wasm gzip」；资产不计入 |
| 单区域资产 | ≤50MB（含 KTX2） | 49.314MB；preload 24.5–55.3ms；add/remove <1ms；dispose 2.1–6ms；JS heap 增量 251.0–286.5MB；masked warmup 152–1140.6ms | ≤50MB，并拆为：preload ≤100ms、add/remove ≤1ms、dispose ≤10ms、JS heap 增量 ≤300MB/区域、masked warmup ≤1.5s（冷）、预热后首帧 ≤50ms |
| 内存 | ≤1.5GB 桌面 / ≤800MB 移动 | 角色 68–99MB JS heap；区域峰值 323.8–373.0MB JS heap（增量 251–286MB） | 按区域增量校准：每 50MB 区域 JS heap 增量 ≤300MB；1.5GB 仅作进程级暂定上限；P1 补进程 RSS + GPU 显存；移动端 800MB 未验证 |
| 首屏可交互 | ≤5s 桌面 / ≤12s 中端移动 | P0 未测生产构建；dev server 295–575ms 不可作为预算 | P1 用 production build + Lighthouse（含网络节流）实测；区域进入时间另算，加载门预热计入 |
| navmesh（新增） | 无 | 200×200 冷 143.1ms / 热 22.9–25.1ms；300×300 冷 277.7ms | 200×200 主线程生成 ≤150ms（冷）；>200 必须 Worker/预烘焙；热路径 ≤30ms |
| Crowd 更新/切换（新增） | 无 | 更新 0.22–0.39ms/帧；同步 1.1–2.9ms；spikeRatio 0.89–0.92 | 更新 ≤1ms/帧；切换同步 ≤5ms；spikeRatio ≤1.0；位置突变 = 0 |
| 描边（新增） | 无 | 24 角色 0.544–0.652ms/帧；draw +40；检测 0.013–0.021ms/帧 | 24 角色 HighlightLayer ≤1ms/帧；draw +≤40；检测 ≤0.05ms/帧；50+ 角色复测 |
| 压缩（新增） | 无 | meshopt 几何为 draco 的 40%；生产组合为基线 22.4%；KTX2 为 PNG 46.8% | 几何必须 meshopt；生产组合 ≤25% 基线；KTX2 贴图 ≤50% PNG |
| LOD（新增） | 无 | LOD1/2 近景 48.017/37.576dB；远景 64.949/53.643dB | 3 级 LOD；LOD1 近景 PSNR ≥40dB；LOD2 近景 ≥32dB、远景 ≥40dB |
| 对话（新增） | 无 | inkjs Continue 0.044ms/步 | 单步 Continue ≤1ms（P95） |
| 编译预热（新增） | 无 | 未 warmup 首帧 203–233ms；warmup 后 18–36ms | 加载门覆盖首帧预热；masked warmup ≤1.5s（冷）；预热后 reveal 最大帧 ≤50ms |

关键说明：

- **300 角色 60fps 是边界值，不是稳健通过**。ticket 11 测到 40.4fps，ticket 18 干净重跑（caffeinate、无并发负载）平均 60.0/60.1fps，但 fpsMin 43.3–51.3；1080p 补充测试 fpsMin 低至 26.6。预算必须留余量，并同时看分位数。
- **`frameTimeMsAverage ≤ 16.6667` 阈值会造成状态抖动**（60fps 四舍五入即 16.7ms）；主判据改为 `fpsAverage`，帧时间用 p95。
- 区域加载的 50MB 是内存 Blob 解析，不含网络下载；首屏预算需在 P1 用生产构建单独验证。
- WebGPU 在 300 角色填充率场景无收益（39.4fps vs WebGL2 40.4fps），维持「增强路径、非基线」决策。
