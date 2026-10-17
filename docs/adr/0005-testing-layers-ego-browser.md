# ADR-0005: 五层测试分层；浏览器测试优先 ego-browser

日期：2026-10-17　状态：已接受

## 决策

测试分五层：L1 逻辑单测（vitest，每 commit）→ L2 内容数据校验（每 commit）→ L3 资产 lint（glTF-Transform，每 PR）→ L4 浏览器冒烟（每 PR）→ L5 性能/视觉（夜间，只报告不阻塞）。逻辑/表现分离（src/logic 零引擎依赖）是架构强制项。浏览器测试一律优先 ego-browser（用户已登录环境），Playwright 仅作 CI 后备。

## 理由

- 渲染层不可单测，逻辑/表现分离是测试策略的前提而非可选项。
- AI Agent 大量生产内容 → 内容校验（L2）必须是质检关卡。
- ego-browser 具备用户登录态与个人上下文，能力优于裸 Playwright（用户指定）。

## 代价

- headless WebGL（L4）稳定性是已知风险，允许重试；L5 不阻塞合入。
- ego-browser 在 CI 不可用时行为差异需维护两套驱动适配。

完整约定见 `docs/agents/testing-workflow.md`。
