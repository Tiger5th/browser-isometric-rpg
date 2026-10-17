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
- **17 号票已完成合并**（98d7866：toon 渲染验证通过（自定义 shader，Babylon 9.31 无官方 ToonMaterial）；VRoid 真人链路 blocked——用户手做指引在票 Comments；VRM→GLB 工具就绪）。
- **18 号票已完成合并（3501caf）——P0 全部 9 张票完成**。最终报告：artifacts/p0-final-report.md。冒烟 9/9；**300 角色干净重跑 60fps 但无余量**（必须动态分辨率）；预算已修正；三个降级预案均未触发；建议进入 P1（前置：用户手做 VRoid + 装 Blender）。
- **code-review 完成：8 项发现全部修复并合并**（5b4e416：morph delta 数据 bug、多材质 toon、顶点色回退、开关重置、加载门时序、取景 span、容器清理、fps 口径）。main 与 p0-integration 同步。
- **P1 规格已发布并拆票**：specs/p1-vertical-slice.md → tickets 19–26。19 无阻塞；19→20→{21,22} 并行→23（需 19–22）→24（需 22,23）→25（组装）→26（验收）。
- **P0 正式收尾。** 遗留：VRoid 真人资产（用户手做 15 分钟，指引在票 17 Comments）、Blender 安装（补测 `npm run assets:blender:repro`）、toon shader morph 支持、真实 VRoid 多材质实机验证。下一步：进入 P1 规格（/to-spec）。
- **19 号票已完成**（17a7f0f：GameSession 零引擎依赖——实体集合 + 手动时钟 + moveTo 意图 + 可序列化快照；click-move 场景用 P0 角色经 Crowd V2 走到点击点；渲染层只读快照；L1 6 测试、全量 49/49、build 通过；分支 worktree-agent-a312606604c8cf863，待合入 p1-integration）。
- **20 号票已完成**（359dc3e：content schema v1（JSON Schema 2020-12 + 引用完整性 + ink 任务标签）与 P1 最小内容集（1 区域/2 NPC/3 个同模板敌人/4 物品/1 任务）；L2 `npm run content:lint` 可运行、负向测试 12 例；GameSession.loadRegion 从内容实例化实体；全量 61/61、build 通过；格式合同见 content/README.md；分支 worktree-agent-a6d3077c444a13262，待合入 p1-integration）。
- **21 号票已完成**（bdfb182：GameSession 战斗闭环——attack 意图 + 回合冷却、修饰器后属性参与命中/伤害、敌人 idle→patrol→chase→attack→dead 状态机、击杀经验/掉落入背包、玩家死亡延迟重生（出生点/满血/活敌重置）；快照 v2 新增 attributes/combat/container；L1 80/80、build 与 content:lint 通过；combat-loop 场景 ego-browser 冒烟 passed；分支 worktree-agent-a3ffe0543360b177d，待合入 p1-integration）。
- **22 号票已完成**（4ba7d2d：GameSession 内置对话状态（inkjs 复用、ink 状态可序列化进快照）、任务状态机（可接→进行中→可交→完成）、offer/turnin 标签驱动接取与交付、enemy-killed 事件推进击杀目标、奖励物品入背包 + 修饰器生效；对话经 `EXTERNAL questStatus` 只读查询按任务状态分支；新增 dialogue-quest HUD 场景（HUD 显示目标/进度/背包，ego-browser 冒烟走通全闭环）；与票 21 合流后，会话内击杀经 `onEnemyKilled` 直接推进任务，外部战斗可用 `GameSession.emitCombatEvent({ type: "enemy-killed", enemyId, enemyTemplateId })`；分支 worktree-agent-aa910623c14a0d8dc，合并 781a8c8 已含 p1-integration）。
- **23 号票已完成**（872e7a3：存读档闭环——`GameSession.restoreSnapshot()` 完整恢复实体/属性/战斗/任务/背包/奖励账本/对话 ink 状态/时钟/重生计时；存档 `{version:2, sections:{session:GameSessionSnapshot}}` 持久化到 IndexedDB，逻辑层经 `SaveStorage` 适配器注入、IndexedDB 实现留在 render 层；P0 迁移链接入正式版本号并演练 v1→v2（含负向测试）；dialogue-quest HUD 增加存档/读档/删除存档按钮，刷新后自动读档并重建网格与 HUD；L1 116/116、build 与 content:lint 通过；L4 ego-browser 刷新读档 17/17 断言通过（reports/p1-save-load-smoke.json、artifacts/p1-save-load-after-reload.png）；分支 worktree-agent-a84034340c700e539）。

- **24 号票已完成**（HUD/背包/装备 UI：`useItem`/`equip`/`unequip` 意图 + 修饰器即时生效；HUD 显示 HP/经验条（`xpToNext` 内容属性）/攻击/防御/任务；背包面板支持使用消耗品、装备/卸下、装备栏三槽位与 I 键开关；UI 只读快照、只提交意图；L1 126/126、build 与 content:lint 通过；L4 ego-browser HP 51→81、攻击 12→17→12 断言通过（reports/p1-hud-inventory-smoke.json、artifacts/p1-hud-inventory.png））。

## Fog

**八大主题全部解决（2026-10-17）。** 路线图与风险清单见 issues/08-scaling-roadmap.md。

- 全部关键架构决策已确认（引擎/渲染/控制/地图/资产/系统/测试七条线，ADR-0001）。
- P0 原型验证有 9 项待实测假设，建议下一步用 /to-spec 规格化 P0 任务。
- **P0 遗留项处理方案已定（2026-10-17）**：用户走票 17 完整版手做（VRoid + Blender + Mixamo，覆盖票 15 的 Blender 补测），与 19 号票开工并行；toon shader morph 挂票 25 验收（票面已有该条）。19 号票开工。
- **美术方向二次修订（2026-10-17，用户确认）**：环境贴图化（Gemini 生图为主，ego-browser 驱动）+ 角色保持 3D（占位角色顶 P1）；VRoid/Mixamo 手做作废、Blender 暂缓（票 15/17 遗留关闭）；风格锚定图先行，锚定后批量生成环境贴图集。
