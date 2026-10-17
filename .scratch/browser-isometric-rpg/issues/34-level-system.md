# 34: 等级系统正式化

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 18–20）

**What to build:** 经验阈值曲线进 content（初版 L2=100、L3=250、L4=450、每级 +250 递增，可调）；升级加属性（每级 +2 攻击 +2 防御 +10 maxHp，修饰器入账）；GameSession 在 xp 入账时结算升级并发射 `player-level-up` 事件（票 27 已定义该事件，本票为逻辑层生产者）；累计 xp/等级随票 31 快照 v3 入档；HUD 等级徽标（票 24 HUD 扩展）。

**Blocked by:** 无（与 31 合流快照 v3）
**Status:** ready-for-agent

- [x] L1：xp 入账→跨阈值→升级→属性变化→事件发射序列（vitest）
- [x] L1：升级状态快照往返（等级/cumulativeXp 不丢）
- [x] L2：等级曲线 content schema 正负向
- [x] HUD 显示等级 + 升级时属性飘字数据就绪（消费在票 27）
- [x] L4：打怪升级→读档→等级保持 冒烟（reports/）——已跑通 10/10 断言通过，报告 `.scratch/browser-isometric-rpg/reports/ticket34-l4-smoke.json`，截图 `artifacts/p1-world-34-level-up.png` / `p1-world-34-after-load.png`

## Answer（实现记录，2026-10-17）

### 曲线进 content（L2）

- `content/level-curves/standard.json` + `content/schema/level-curve.schema.json`；
  初版 L2=100、L3=250、L4=450，之后每级 +250（L5=700、L6=1000），每级 +2 攻 +2 防 +10 maxHp。
- 运行时解释口 `src/logic/leveling.ts`（纯逻辑，L1 直测）：`levelForXp` /
  `xpToNextLevel` / `nextLevelThreshold` / `modifiersForLevel` / `levelProgressRatio` /
  `resolveLevelProgress`，外加结构校验 `validateLevelCurve`。
- **schema 管不了区间关系**，所以阈值严格递增、等级序号从 1 连续、首级阈值为 0
  这三条由 `validateLevelCurve` 在 L2 lint 里兜（issue code `level-curve`）；
  负向测试加了两个用例（阈值倒退、defaultModifiers 为空）。

### 升级结算（L1）

- 经验入账收敛到 `GameSession.grantExperience()` / 私有 `creditExperience()`：击杀奖励
  与非击杀发奖（任务/调试）走同一条路径，经验事件 + 逐级升级只写一处。
- 跨多级时**逐级**发 `player-level-up`，`level` 依次 2、3……；`attributesGained`
  给的是该级相对上一级的属性增量（HUD 飘字直接消费，票 27 的反馈层已接上）。
- 等级加成走修饰器系统的 **`level` 源**（新增 `ModifierSourceKind`），每次按当前等级
  **整源重算**（先 `removeModifiersBySource` 再 append），不逐次叠加——所以读档重算、
  跨级、撤销都不会重复入账。maxHp 变大后按差额补当前生命，升级不会反而变脆。
- 等级记在玩家 `baseAttributes.level`（随实体快照往返）。**本票没改快照结构**。

### 与票 31 合流（merge p2-integration）

- 票 31 已声明快照 v3 的 `playerLevel` / `cumulativeXp` / `worldState`，但只声明
  未写入（注释写着「升级结算本体在成长系统」）。合流后**本票成为它们的写入方**：
  `this.playerLevel` 与 `this.cumulativeXp` 是等级/经验的唯一真相来源，实体属性上的
  `level`/`xp` 是同一事实的渲染层镜像，随之更新。
- 好处是 user story 20 的另一半白拿：`save-slots.ts` 的存档元数据本来就读
  `snapshot.playerLevel`，现在选槽界面显示的等级是真实的了。
- 合并只有一处冲突（`GameSession` 字段声明区），手工融合：保留票 31 的
  `worldState` / `getWorldState`，把 `playerLevel`/`cumulativeXp` 接上本票的写入方。
- L1 里补了 `snapshot().playerLevel` / `cumulativeXp` 的往返断言——
  待办里那条「若字段不在就写条件测试」已不需要：合流时票 31 已就位。

### HUD 等级徽标

- 换算抽成纯函数 `src/render/ui/level-hud.ts` 的 `levelHudView()`（L1 直测），
  `quest-loop-ui.ts` 只搭 DOM——它被多票并行修改，所以新增逻辑尽量不落在那。
- DOM 上新增 `[data-testid="hud-level"]`（徽标 + `data-level`）。经验条比例按
  **本级区间**算（刚进级不会跳到满格），文案分母是下一级的**累计**阈值。
- `xpToNext` 属性保留为旧内容口径的回落；接了曲线后不再手填。

### 遗留

- ~~**L4 未在本机执行**~~（2026-10-18 已补跑）：ego-browser 运行时可用，
  `npm run dev -- --port 5199` 起服务后
  `ego-browser nodejs -e 'await import("file:///<仓库绝对路径>/.scratch/browser-isometric-rpg/smoke/round-03-level-system.mjs")'`
  即可复现。跑之前要修三处脚本问题（都已修进脚本）：
  `task.page("p1-world")` 只引用**已存在**的 Page（改 `task.newPage()`）；
  taskSpace 名要带时间戳避免与既有 space 冲突；打怪前必须 `teleportTo`
  到怪身上并从 Node 侧等真实时间——否则 `tryAttack` 因超出射程静默拒绝，
  一只也打不死，`killsGrantXp` 断言会假红。
- 内容里只有 3 只史莱姆 × 10 经验，凑不满 100 阈值；L4 用 `grantExperience` 补足，
  它与击杀完全同路径。后续想真打升级，得给区域加怪或调 `xp`。
- `ContentBundle.levelCurves` 目前只支持一条曲线（多于一条显式报错）。
