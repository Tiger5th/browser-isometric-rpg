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
- **AI 档案（aiProfile）**：敌人模板上的一段纯数据，决定状态机分支：`chaser`（近战追击）/ `windup-charge`（蓄力冲锋：windup → charge → recovery）/ `ranged-kite`（保持距离吐弹）。逻辑层解释为状态机参数，缺省即 `chaser`。
- **冲锋链路（windup-charge）**：明显前摇 → 直线高速冲锋（路径命中判定一次，被硬碰撞挡停）→ recovery 硬直。方向在前摇结束时锁定，因此前摇中横移即可走位躲开。
- **投射物（Projectile）**：吐弹型敌人的远程攻击，是**逻辑层实体**：位置、速度、命中判定全在 `GameSession`，表现层只渲染 `projectile-spawned`/`projectile-removed` 两个事件。

## 资产与管线

- **资产管线**：Blender 源文件 → headless glTF 导出 → glTF-Transform（meshopt + KTX2 + lint）→ dist .glb → Babylon loader。
- **lint（资产校验）**：对 .glb 自动检查命名、三角数、贴图尺寸、材质数。CI 中每 PR 运行。
- **AI 生成资产**：美术生产方式（已决策）。跨资产**一致性**靠技术方案（统一 base mesh、贴图统一调色、shader 风格化拉齐），不靠运气。

## 表现与体验

- **反馈层（Feedback Layer）**：表现层中把 GameSession 结算事实（伤害/死亡/拾取/升级/状态变化）转译为视觉与听觉信号的部分。只消费事件、不改变游戏状态。事件流：`damage-dealt`/`health-changed`/`player-level-up`/`item-gained` 等一等订阅事件（与 `enemy-killed` 同级）。
- **两段式对话**：对话交互约定——点击 NPC 只触发寻路靠近；到达后 NPC 头顶气泡按钮出现；点击气泡才进入对话。移动意图随时打断。
- **角色色板卡（Character Palette Card）**：每个主要角色一张的颜色规范（主色/辅色/点缀色 + 发色服装关键词）。3D 贴图、立绘、头像同卡生成，保证资产间不漂移。
- **世界状态（World State）**：快照中记录世界事实的通用容器（宝箱开启、收集计数、机关状态等）。新系统的事实优先挂世界状态而非逐项加快照字段。
- **存档槽（Save Slot）**：一个独立的存档位置，键为 `auto`（自动存档）或 `slot-1..3`（手动槽）。槽位元数据（存档时间、游戏时长、等级）存在存档文件的 `meta` 分节而非会话快照内——快照只描述世界事实。
- **自动存档（Autosave）**：关键节点（区域切换/任务状态变化/获得重要物品）与 `beforeunload` 兜底时写入 `auto` 槽的存档动作。自动存档永不抛错，失败只通报不影响游戏。
- **安全区（Safe Zone）**：敌人 AI 被逻辑层拒止不得进入的地带。村庄聚点位于安全区内。
- **欣赏模式（Showcase Mode）**：相机自由缩放旋转的状态；一键复位回到出厂等距预设（alpha/beta/radius 常量）。
- **等级曲线（Level Curve）**：累计经验 → 等级的阈值表 + 每级属性加成（票 34）。内容数据（`content/level-curves/*.json`），解释口 `src/logic/leveling.ts`。升级加成走修饰器系统的 `level` 源，按当前等级**整源重算**（不是逐次叠加），因此读档与跨级都不会重复入账。
- **等级徽标（Level Badge）**：HUD 上的 `Lv.N` 与经验条。显示值由 `src/render/ui/level-hud.ts` 的纯函数 `levelHudView()` 换算，HUD 只搭 DOM。
- **标题画面（Title Screen）**：打开游戏的正式入口。logo（生成图）+ 氛围背景（游戏画面派生）+ 版本号 + 「继续游戏」/「新游戏」；入场演出 2.4 秒（logo 淡入 + 雾气/粒子）可点击跳过。入口路由判定在 `src/logic/title-menu.ts`（纯函数），DOM 只负责演出与交互；进入游戏复用加载门黑场过场。
- **入场意图（Entry Intent）**：标题画面选定的「读哪个槽 / 是不是新游戏」，一次性交给场景构建消费（`src/render/title-entry.ts`）。因此「经标题进入」与「harness 直入」走同一段场景代码。
- **换锚点（Re-anchor）**：任务状态变化时 NPC 移动到新默认位置的机制——「世界因你而变」的最小实现。

## 测试与流程

- **测试五层（L1–L5）**：L1 逻辑单测（vitest）→ L2 内容校验 → L3 资产 lint → L4 浏览器冒烟（**优先 ego-browser**，Playwright 仅 CI 后备）→ L5 性能/视觉夜测（只报告不阻塞）。见 `docs/agents/testing-workflow.md`。
- **P0–P3**：路线图阶段。P0 灰盒原型验证（9 项技术假设）→ P1 垂直切片 → P2 完整第一章 → P3 扩展期。
