# 10: 项目骨架 + Harness 雏形

**What to build:** 初始化项目（npm/Vite/TypeScript），锁定 Babylon.js 9.x 精确版本与 recast-navigation-js 版本（ADR-0001），建立 src/logic（零引擎依赖）与 src/render（Babylon 层）分离结构（ADR-0005），实现 P0Harness 的最小可运行版本：一个灰盒场景 + 具名 scenario 注册机制 + 统一 JSON 测量报告输出（场景名、指标、数值、环境信息）。验收时打开页面能看到灰盒场景，并能产出一份报告文件。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 打开页面可见正交相机灰盒场景（程序化几何体）
- [ ] 至少一个 hello scenario 可执行并输出结构化 JSON 报告
- [ ] src/logic 有一个纯 TS 模块被 vitest 覆盖（验证逻辑/表现分离可行）
- [ ] Babylon 与 recast 版本锁定在 package.json（精确版本，非 caret）
- [ ] GLOSSARY.md 词汇在代码命名中沿用（Region/Harness/Entity 等）
