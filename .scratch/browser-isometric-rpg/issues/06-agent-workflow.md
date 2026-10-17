# AI Agent 的任务拆分 / 测试 / 代码审查 / CI 工作流

Type: research
Status: resolved
Blocked by: —

## 问题

本项目大量工作将由 AI Agent 完成，如何组织才能保证质量与可回溯：任务拆分粒度、测试策略（引擎代码哪些可测、怎么测）、审查流程、CI 配置。

## 调研范围

- 游戏代码的可测试性方案：逻辑/表现分离到什么程度，headless 运行引擎测试（如 Playwright + WebGL）是否实际可行。
- 现有 AI 辅助游戏开发的开源仓库/文章中有方法、可验证的实践（剔除宣传内容）。
- CI 中运行渲染相关测试的成本与稳定性。

## 产出

- 测试分层策略草案
- Agent 任务拆分与审查流程约定（可写入 docs/agents/ 供工程技能读取）

---

## Answer（研究结果，2026-10-17）

### 已确认事实

**游戏代码的可测试性（关键约束确认）**
- 渲染层无法（也不应）单测。Chrome 112+ 的 headless 是完整浏览器（官方文档），WebGL 在 headless + SwiftShader/真实 GPU 下可运行，Playwright 可驱动 → **渲染冒烟测试（截图对比、帧率采样）可行但慢、稳定性中等**。
- Babylon 本身与 DOM 耦合低，逻辑代码（修饰器、存档迁移、任务状态机、数据校验）纯 TS 可 vitest 直测。**结论：逻辑/表现分离不是可选项，是测试策略的前提**——架构上强制：`src/logic`（零引擎依赖，可 100% 单测）/ `src/render`（Babylon 依赖，集成测试）。

**测试分层策略（草案）**

| 层 | 内容 | 工具 | CI 成本 |
|---|---|---|---|
| L1 单测 | 修饰器模型、存档迁移链、任务/背包逻辑、数据校验 | vitest（17k stars，MIT，活跃） | 秒级，每 commit |
| L2 数据测试 | 所有内容 JSON 通过 schema 校验 + 引用完整性（任务引用的对话 ID 存在等） | 自研 lint 脚本（复用 05 的 glTF-Transform 校验模式） | 秒级，每 commit |
| L3 资产测试 | .glb 命名/三角数/贴图规范 | glTF-Transform lint | 分钟级，每 PR |
| L4 冒烟 | headless 加载首场景、区域切换、存档读写往返 | Playwright + Babylon | 分钟级，每 PR（可标记 flaky 重试） |
| L5 视觉/性能 | 截图对比、帧率采样、预算断言（07 的预算数字） | Playwright + SceneInstrumentation | 需 GPU runner，夜间或每周 |
- L4 的 WebGL 环境稳定性是最大风险项——先跑通再扩大；L5 允许 flaky，只报告不阻塞。

**Agent 任务拆分与审查流程（约定草案，写入 docs/agents/）**
- 拆分粒度：一个任务 = 一个可独立验证的变更（一个系统模块 / 一个内容数据包 / 一个管线脚本）。禁止「跨层大 PR」。
- 每任务必须带：验收标准（可执行测试 or 可检查产物）+ 影响的 ADR/规范引用。
- 内容生产（对话/任务/关卡数据）与代码修改分离成不同任务类型，内容任务以 L2 数据测试为验收，代码任务以 L1+L4 为验收。
- 审查流程：Agent 产出 → L1–L4 自动验证 → 人工审查只看：架构偏离、数据模型变更、ADR 冲突（用 docs/agents/domain.md 的冲突标记约定）。
- 产出物回写 `.scratch/` issue 文件（本仓库已有约定）。

**证据缺口（诚实记录）**
- 「AI 辅助游戏开发」方向的公开资料多为宣传性内容，无可验证方法的生产级实践案例可引用——本 ticket 的约定是**从上述测试策略反推的设计**，不是业界验证过的最佳实践。需在原型期实测迭代。

### 待原型验证的假设

1. Playwright + Babylon headless WebGL 的加载冒烟测试在 CI（GitHub Actions 免费 runner）上的稳定性与耗时。
2. vitest 直接测 Babylon 逻辑类（不渲染）的可行性边界。
3. L5 截图对比在无 GPU runner 上的可重复性（SwiftShader 渲染差异）。

### 需要人工决策

- 测试分层与审查流程约定是否批准写入 `docs/agents/`？（批准后正式生效，工程技能开始读取）

## 决策（2026-10-17，用户确认）

- 测试分层与审查约定**批准**，写入 `docs/agents/testing-workflow.md`。
- **用户指定修订**：浏览器相关测试一律优先使用本机 ego-browser（用户已登录环境、个人上下文，强于裸 Playwright）；Playwright 仅作为 ego-browser 不可用时的 CI 后备。
