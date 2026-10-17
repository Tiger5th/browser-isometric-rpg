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
