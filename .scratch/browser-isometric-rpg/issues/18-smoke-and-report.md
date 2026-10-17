# 18: 冒烟测试与 P0 汇总报告

**What to build:** 用 ego-browser 驱动 Harness 全部场景做 L4 冒烟（加载/执行/报告产出，验证稳定性与耗时，允许 flaky 重试）；汇总 10–17 全部数字，产出结构化 P0 报告（每项：实测数字 vs 07 阈值 vs 结论）；据报告修正 07 性能预算、列出受影响 ADR（0002/0003/0004）的更新建议、给出进入 P1 的决策建议。对应 spec user story 15/17。

**Blocked by:** 11, 12, 13, 14, 15, 16, 17

**Status:** resolved (3501caf 合并至 p0-integration)

- [x] ego-browser 冒烟跑通全部场景（9/9，两轮 20 条记录，耗时 ~50s/轮；asset-pipeline 需先 assets:vendor），稳定性/耗时数字进报告
- [x] P0 报告产出（artifacts/p0-final-report.md + .json，18 项三栏）（artifacts/ 内，含全部 18 项数字 vs 阈值 vs 结论）
- [x] 07 预算按实测修正（帧率分辨率联动、区域预算加预热行、内存校准 251–286MB）（草案数值 → 实测数值）
- [x] ADR-0002/0003/0004（含 0005）更新建议列出
- [x] 进入 P1 建议明确：**建议进入**，三个降级预案均未触发（含各验证项是否通过、降级预案是否触发）
