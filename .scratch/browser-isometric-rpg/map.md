# 浏览器端等距视角 RPG — 决策地图

## Notes

- 平台：浏览器为首要平台；长期目标接近大型商业 RPG 的表现、深度、规模与内容完整度。
- 硬约束：不得以一次性 Demo 收尾；架构必须支持长期扩展（多地区、多章节）。
- 当前阶段：规划与研究，不写游戏代码。
- 交付方式：一个 ticket 解决一个明确决策；需要人工选择时列出选项与代价，等待用户决定。
- 研究规则：优先官方文档 / 成熟开源仓库 / 有方法的技术研究；记录来源、版本、已知限制、待验证假设；区分「已确认事实 / 未验证假设 / 需人工决策」；不把宣传材料当生产能力证明。

## Decisions-so-far

（暂无）

- **02 等距角色控制：已决策 — 纯点击移动；寻路 = Crowd Navigation V2；碰撞 = moveWithCollisions（默认无物理）；遮挡 = HighlightLayer 描边；大世界 = 官方 Floating Origin。**原型验证假设见 issues/02 Answer 节。

- **01 引擎选型：已决策 — Babylon.js（9.x，锁版本，季度评估升级）**。ADR-0001 已写入 `docs/adr/0001-babylonjs-engine.md`。02/03/05/07 已解锁。
- 补充研究确认排除 Godot 4 Web（C# 不可用、加载慢）、Unity（许可风险）、Unreal（串流成本）、Phaser 纯 2D（放弃 3D）、Bevy（生态不成熟）。

- **03 地图构建器/流式加载：已决策 — Babylon Editor（手摆）+ Node Geometry（程序化），双轨防绑定；区域切换从加载门起步（AssetContainer 原语）。**原型验证假设见 issues/03 Answer 节。

- **05 资产管线：研究完成，待确认**。Blender → headless glTF 导出 → glTF-Transform（meshopt+KTX2+lint）→ Babylon loader。全链路 MIT/Apache 无许可风险。规范草案与预算初值已写入 issues/05。

- **07 兼容性/性能预算/许可证：已决策 — WebGL2 基线 + WebGPU 增强 + iOS Safari 15+。**性能预算初值与许可证清单见 issues/07，数字以 02 原型实测修正。

- **04 系统边界：已决策 — 对话 = Ink；存档/任务/背包/装备/行为 AI 自研（数据驱动 + EntityId + 修饰器）；AI 移动 = Crowd V2。**

- **06 Agent 工作流：已批准并写入 `docs/agents/testing-workflow.md`**。修订：浏览器测试优先 ego-browser（用户指定），Playwright 仅作 CI 后备。

- **09 美术方向：已修订（用户确认二次元风格、自用不商用）— 免费方案：VRoid 捏角色 + Mixamo 动画 + AI 免费档场景件 + Babylon toon 渲染拉齐。Meshy Pro 方案作废。**商用风险清零。

- **文档基建完成（2026-10-17）**：GLOSSARY.md 建立；ADR-0002~0005 写入（点击移动/区域流式/数据驱动系统/测试分层）。
- **P0 已规格化并拆票**：specs/p0-prototype-validation.md（18 条 user story，ready-for-agent）→ 拆为 tickets 10–18。10 无阻塞；10→{11,12,14,15,16} 并行；13←11；17←10,15；18←11..17 汇总。
- **09 美术已修订**：二次元风格 + 自用不商用 → 免费方案（VRoid + Mixamo + AI 免费档 + toon 渲染）；链路验证在 17 号票。
- **10 号票已完成并合并**（714b3bb：Babylon 9.31.0 / recast-navigation 0.43.1 锁版本，P0Harness + hello 场景 + JSON 报告，vitest 5/5）。备注：recast 包名实为 `recast-navigation`。
- **16 号票已完成合并**（0b16d8a：修饰器 schema 可冻结、inkjs 2.4.0 可用无需自研 DSL、存档迁移链雏形 35/35 绿）。
- **11 号票已完成合并**（c924ba9：300 角色两路径实测，未达 60fps，瓶颈=GPU 填充率，降分辨率后 60fps；WebGPU 无收益）。
- **12 号票已完成合并**（72f82bb：200×200 navmesh 143ms/45KB、50 agents 避让正常、热替换无尖峰；规模上限=200×200 主线程生成）。
- **15 号票已完成合并**（8693d36：meshopt 锁定、自动 LOD 可接受、KTX2 兼容（Safari 未实测）、lint 就位；Blender 未装——headless 导出可重复性 blocked，需用户安装 Blender 后补测）。
- **14 号票已完成合并**（3b83e8a：50MB 区域 preload 55ms 但首帧 shader 编译卡 ~200ms——黑场须盖预热；**Editor git 友好，不触发 LDtk 降级**）。
- **13 号票已完成合并**（381a63f：24 角色描边 60fps，HighlightLayer 0.65ms/帧——**描边方案可用**；scene.pick 有 GC 长帧坑，用零分配射线-OBB 替代）。
- **当前 frontier：17 运行中；18 待 17。**

## Fog

**八大主题全部解决（2026-10-17）。** 路线图与风险清单见 issues/08-scaling-roadmap.md。

- 全部关键架构决策已确认（引擎/渲染/控制/地图/资产/系统/测试七条线，ADR-0001）。
- P0 原型验证有 9 项待实测假设，建议下一步用 /to-spec 规格化 P0 任务。
