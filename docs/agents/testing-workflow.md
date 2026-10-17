# 测试与 Agent 工作流约定

来源：.scratch/browser-isometric-rpg/issues/06-agent-workflow.md（决策 2026-10-17）

## 架构强制项

- `src/logic/`：零引擎依赖的纯 TS（修饰器、存档迁移、任务状态机、数据校验）——必须可用 vitest 直接测试。
- `src/render/`：Babylon 依赖层——只做集成/冒烟测试。

## 测试分层

| 层 | 内容 | 工具 | 时机 |
|---|---|---|---|
| L1 | 逻辑单测 | vitest | 每 commit |
| L2 | 内容 JSON schema + 引用完整性 | 自研 lint 脚本 | 每 commit |
| L3 | 资产规范校验 | glTF-Transform lint | 每 PR |
| L4 | 浏览器冒烟（加载/切区/存档往返） | **ego-browser（优先）**，Playwright 后备 | 每 PR |
| L5 | 截图对比 / 帧率 / 预算断言 | ego-browser + SceneInstrumentation | 夜间，只报告不阻塞 |

## 浏览器测试约定

- 本机与开发环境：一律用 ego-browser（用户已登录环境，能力优于裸 Playwright）。
- CI 无 ego-browser 时才降级 Playwright。

## Agent 任务拆分

- 一个任务 = 一个可独立验证的变更；禁止跨层大 PR。
- 内容生产（对话/任务/关卡数据）与代码修改分任务类型；内容任务以 L2 为验收，代码任务以 L1+L4 为验收。
- 每任务带验收标准 + 引用相关 ADR/规范。

## 审查流程

- Agent 产出 → L1–L4 自动验证 → 人工审查只看：架构偏离、数据模型变更、ADR 冲突（冲突须显式标记，见 domain.md）。
- 产出物回写 .scratch/ issue 文件。
