# GLOSSARY

项目核心词汇。定义来自 01–09 号研究 ticket 的已确认决策（`.scratch/browser-isometric-rpg/`）。

## 架构与运行时

- **引擎**：Babylon.js 9.x（锁定小版本，季度评估升级）。见 ADR-0001。
- **渲染基线**：WebGL2（全主流浏览器）。**WebGPU 增强路径**：可用则启用，Babylon 自动回退。
- **逻辑层（Logic）**：`src/logic/` 下零引擎依赖的纯 TypeScript 代码。必须可用 vitest 直接测试。
- **表现层（Render）**：`src/render/` 下依赖 Babylon 的代码。只做集成/冒烟测试。

## 世界与关卡

- **区域（Region）**：流式加载的基本单位。一个区域 = 一个 glTF/babylon 文件 + 一个元数据 JSON（锚点、navmesh、触发器）。加载进 AssetContainer，进出场景切换。
- **加载门（Load Gate）**：区域切换方式——门/电梯/过场掩蔽加载。后续可升级无缝流式，底层机制共用。
- **章节（Chapter）**：内容数据包 = 内容 JSON（对话 ink + 任务 + 实体表）+ 区域文件集合。引擎代码不随章节增长。
- **地区（Area）**：区域文件的组合。多地区无架构差异，Floating Origin 保证大坐标精度。
- **灰盒（Greybox）**：无正式美术的占位几何体。P0 原型的美术形态。

## 实体与系统

- **实体（Entity）**：全局唯一 EntityId 标识的游戏对象（角色/敌人/道具）。身份 + 状态 + 容器 + 属性 + 引用。
- **修饰器（Modifier）**：属性变更的统一机制。装备加成、任务奖励、buff 共用同一修饰器模型。
- **数据驱动（Data-driven）**：内容 = 纯数据（JSON/ink），系统 = 通用逻辑。AI Agent 按此生产内容，L2 校验把关。
- **行为状态机 → 行为树**：敌人 AI 决策层，状态机起步（P2），行为树在 P3 引入。

## 资产与管线

- **资产管线**：Blender 源文件 → headless glTF 导出 → glTF-Transform（meshopt + KTX2 + lint）→ dist .glb → Babylon loader。
- **lint（资产校验）**：对 .glb 自动检查命名、三角数、贴图尺寸、材质数。CI 中每 PR 运行。
- **AI 生成资产**：美术生产方式（已决策）。跨资产**一致性**靠技术方案（统一 base mesh、贴图统一调色、shader 风格化拉齐），不靠运气。

## 测试与流程

- **测试五层（L1–L5）**：L1 逻辑单测（vitest）→ L2 内容校验 → L3 资产 lint → L4 浏览器冒烟（**优先 ego-browser**，Playwright 仅 CI 后备）→ L5 性能/视觉夜测（只报告不阻塞）。见 `docs/agents/testing-workflow.md`。
- **P0–P3**：路线图阶段。P0 灰盒原型验证（9 项技术假设）→ P1 垂直切片 → P2 完整第一章 → P3 扩展期。
