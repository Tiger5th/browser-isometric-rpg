# content/ 内容数据格式

本目录是 P1 垂直切片的全部游戏内容，也是 P2 Agent 批量内容生产的**合同**。
内容 = 纯数据（JSON + ink），引擎代码不随章节增长；格式稳定性优先于字段丰富度。

- Schema 版本：**1**（2026-10-17，票 20）
- 机器可读 schema：`content/schema/*.schema.json`（JSON Schema draft 2020-12）
- 类型视图：`src/logic/content/types.ts`
- 校验入口：`npm run content:lint`（L2，结果写入 `reports/content-lint.json`）

## 目录结构

```
content/
  schema/             JSON schema（合同本身）
  regions/            区域
  npcs/               NPC
  enemy-templates/    敌人模板（共享属性/AI/掉落）
  enemies/            敌人实例（放置 + 模板变体）
  items/              物品
  quests/             任务
  dialogues/          ink 对话源文件
```

**一个文件 = 一个定义**。文件名必须等于 id 去掉命名空间前缀后的部分：
`items/traveler_sword.json` ↔ `item:traveler_sword`，
`enemy-templates/slime.json` ↔ `enemy_template:slime`。
这条规则由 L2 强制，便于 Agent 生成与 diff。

## 通用约定

- UTF-8 JSON；所有 schema 均为 `additionalProperties: false`——**未知字段会被拒绝**，防止拼写错误悄悄生效。
- id 命名空间（小写蛇形，`[a-z0-9_]`）：

  | 类别 | 前缀 | 示例 |
  |---|---|---|
  | 区域 | `region:` | `region:green_hollow` |
  | NPC | `npc:` | `npc:elder_ma` |
  | 敌人模板 | `enemy_template:` | `enemy_template:slime` |
  | 敌人实例 | `enemy:` | `enemy:slime_meadow` |
  | 物品 | `item:` | `item:traveler_sword` |
  | 任务 | `quest:` | `quest:cull_slimes` |
  | 任务目标 | `objective:` | `objective:kill_slimes` |
  | 玩家实体 | `entity:` | `entity:player` |

- 坐标：世界坐标，单位米，Y 轴向上；`position`/`rotation` 均为 `{x,y,z}`，旋转单位为弧度（`Entity.state.rotation` 同一约定）。
- `attributes` 是**开放数值表**：`maxHp`/`hp`/`attack`/`defense`/`moveSpeed`/`xp` 是 P1 识别的一组键，其余键原样保留。新增键不需要改 schema。
- 修饰器（装备/任务奖励共用）字段与 `src/logic/modifier.ts` 完全一致：
  `{ attribute, operation: "add" | "multiply", value }`；
  最终属性 = `(base + Σadd) × (1 + Σmultiply)`。

## 各类型字段

### 区域 `regions/<local>.json`

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | `region:` + 文件名 |
| `displayName` | 是 | 展示名 |
| `asset.model` | 是 | 区域 glTF/GLB 路径（表现层解释） |
| `asset.navmesh` | 否 | navmesh 资产路径 |
| `player.id` | 是 | 玩家 EntityId，跨区域稳定（如 `entity:player`） |
| `player.templateId` | 是 | 玩家模板标识 |
| `player.displayName` | 是 | 玩家名 |
| `player.spawn.position` | 是 | 出生点 |
| `player.spawn.rotation` | 否 | 出生朝向 |
| `player.baseAttributes` | 是 | 玩家基础属性 |
| `exits` | 否 | `{id, targetRegionId, position, rotation?}`，目标区域必须存在 |

### NPC `npcs/<local>.json`

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` / `displayName` | 是 | 同通用约定 |
| `templateId` | 是 | 外观/行为模板 id（表现层解释） |
| `regionId` | 是 | 所在区域，必须存在 |
| `position` / `rotation` | 位置必填、旋转可选 | 放置 |
| `baseAttributes` | 否 | 基础属性；缺省空表 |
| `tags` | 否 | 行为/剧情标签；缺省 `["npc"]` |
| `dialogueId` | 否 | 对应 `dialogues/<dialogueId>.ink`，必须存在 |
| `questIds` | 否 | 该 NPC 可提供的任务，必须都存在 |

### 敌人模板 `enemy-templates/<local>.json`

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` / `displayName` | 是 | 同通用约定 |
| `aiProfileId` | 是 | AI 档案 id（逻辑层解释；P1 实现 `ai:melee_chaser` 状态机） |
| `baseAttributes` | 是 | 共享基础属性 |
| `drops` | 否 | `{itemId, chance(0–1), min, max}`；`itemId` 必须存在，`max ≥ min` |
| `tags` | 否 | 共享标签 |

### 敌人实例 `enemies/<local>.json`

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` / `displayName` | 是 | 实例身份 |
| `templateId` | 是 | 必须指向已存在的敌人模板 |
| `regionId` | 是 | 所在区域，必须存在 |
| `position` / `rotation` | 位置必填、旋转可选 | 放置 |
| `tags` | 否 | 与模板标签合并（去重，模板在前） |
| `overrides.baseAttributes` | 否 | 覆盖模板属性；同键以实例为准 |

多个实例共用同一 `templateId` 即「同模板变体」——P1 的三个史莱姆就是这样做的。

### 物品 `items/<local>.json`

公共字段：`id`、`displayName`、`kind`、`description` 必填；`maxStack`（整数 ≥1，缺省 1）、`value`（≥0，缺省 0）可选。

按 `kind` 判别：

- `equipment`：必须带 `equipment: { slot: "weapon" | "armor" | "accessory", modifiers: [...] }`。
- `consumable`：必须带 `consumable: { effects: [{ type: "restore", attribute, amount }] }`。
- `misc`：不得带 `equipment`/`consumable`。

### 任务 `quests/<local>.json`

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` / `title` | 是 | 任务身份 |
| `description` | 否 | 任务描述 |
| `giverNpcId` | 是 | 发布者，必须存在，且其 `questIds` 必须登记本任务 |
| `turnInNpcId` | 否 | 回报对象，缺省 = `giverNpcId` |
| `objectives` | 是 | 至少一项。v1 仅 `{ id, type: "kill", enemyTemplateId, count }` |
| `rewards` | 是 | 至少一个字段：`items: [{itemId, quantity}]` 和/或 `modifiers: [...]` |

P1 任务：`quest:cull_slimes`（杀 3 只 `enemy_template:slime` → 物品 + 属性奖励 → 回马婆婆复命）。

## ink 对话约定

- 源文件：`content/dialogues/<dialogueId>.ink`，`dialogueId` 即文件名（不含扩展名），如 `elder_ma.ink` ↔ `dialogueId: "elder_ma"`。
- 运行时不打包 ink 编译器：构建/工具阶段用 `inkjs/full` 编译，运行时用 `src/logic/dialogue.ts` 的 `createDialogue(compiledJson)` 加载。
- L2 会用 `Compiler` 编译每个 `.ink`，语法错误直接失败。
- 任务标签（独占一行，L2 校验引用的任务存在）：

  ```
  # quest:offer:<questId>     // 对话中可接取任务
  # quest:turnin:<questId>    // 对话中可回报任务
  ```

  P1 示例见 `content/dialogues/elder_ma.ink`。

## 数据 → Entity 映射

`src/logic/content/region-loader.ts` 的 `instantiateRegionEntities(index, regionId)`：

| 内容 | Entity.identity.type | identity.templateId | 说明 |
|---|---|---|---|
| 区域玩家的 `player` | `player` | `player.templateId` | tags 固定 `["player"]` |
| NPC | `npc` | NPC 的 `templateId` | `references.dialogueId/questIds` 直接映射；tags 缺省 `["npc"]` |
| 敌人实例 | `enemy` | 模板 id | `baseAttributes` = 模板 ⊕ 实例覆盖；`references.aiProfileId` 来自模板；tags = 模板 + 实例 |

`GameSession.loadRegion(bundle, regionId)` 调用上述函数并注册实体；P1 只支持单区域会话。
实例化顺序确定：玩家 → NPC（按 id）→ 敌人（按 id）。

## 战斗运行时约定（GameSession，票 21）

战斗规则全部在 `src/logic/game-session.ts`，content/ 只提供数值与掉落表：

- **属性来源**：命中/伤害/射程/速度都取修饰器后的有效属性
  `(base + Σadd) × (1 + Σmultiply)`；当前生命单独存于会话运行时，快照字段为 `combat.hp`。
- **回合制时间步进**：攻击是意图（`attack(attacker, target)`）。射程内立即结算一轮，
  之后按 `attackIntervalMs`（缺省 1000ms）冷却；时间由 `advance(deltaMs)` 手动推进。
- **命中与伤害**：
  - 命中率 = `clamp(0.9 + (accuracy - evasion) / 100, 0.05, 1)`（缺省 0.9）；
  - 伤害 = `max(1, round(attack - defense))`；
  - `accuracy`/`evasion`/`attackRange`/`attackIntervalMs` 可在属性表按需覆盖。
- **敌人状态机**（`ai:melee_chaser`，P1 唯一档案；未知档案回退到该档案）：
  `idle → patrol → chase → attack → dead`。玩家进入 `aggroRadius`（缺省 8）或被攻击即仇恨；
  进入 `attackRange`（缺省 2）后停下攻击；距离超过 `aggroRadius × 2` 脱战回 idle。
  `patrolRadius`（缺省 4，绕出生点四点巡逻）、`idleMs`（缺省 2000）可覆盖。
- **击杀奖励**：经验 = 模板 `xp` 属性，累加到玩家 `baseAttributes.xp`；
  掉落按模板 `drops` 的 `chance` / `min..max` 掷点，按物品 `maxStack` 合并进背包。
- **玩家死亡与重生**（P1 默认设计）：
  - 死亡后等待 `respawnDelayMs`（缺省 1000ms，构造参数可覆盖）回到**区域出生点**；
  - 生命恢复为修饰器后的 `maxHp`；攻击目标、移动意图、冷却全部清空；
  - 活着的敌人重置到各自出生点并回满血（避免蹲尸），**已死亡的敌人不刷新**；
  - 重生后敌人获得一个完整攻击间隔的冷却缓冲，避免同一帧再次击杀玩家。
- **事件流**：`drainEvents()` 返回 `attack`（含 hit/damage/剩余生命）、`death`、
  `xp`、`loot`、`respawn`。渲染层只消费事件与 `snapshot()`，不读内部状态。
- **快照版本**：`GAME_SESSION_SNAPSHOT_VERSION = 2`（新增 `attributes` / `combat` /
  `container` 字段）。票 23 的存档以快照为准。

## 引用完整性（L2 强制）

- `npc.regionId` → 区域；`npc.dialogueId` → ink 文件；`npc.questIds[]` → 任务
- `enemy.regionId` → 区域；`enemy.templateId` → 敌人模板
- `enemy-template.drops[].itemId` → 物品（且 `max ≥ min`）
- `quest.giverNpcId` / `turnInNpcId` → NPC；`objectives[].enemyTemplateId` → 敌人模板；
  `rewards.items[].itemId` → 物品；giver 的 `questIds` 必须反向登记该任务
- `region.exits[].targetRegionId` → 区域
- ink 任务标签 → 任务
- 所有 id 全局唯一；文件名必须与 id 对应

不做的事：不检查 `asset.model` 指向的 GLB 是否存在（资产由 L3 管线校验）；不解释属性含义。

## 校验与新增内容

```bash
npm run content:lint   # L2：schema + 引用完整性 + ink 编译，报告写入 reports/content-lint.json
npx vitest run         # L1：含 content 负向测试（坏 schema / 坏引用 / 重复 id / 坏文件名）
```

> lint 脚本用 Node 的类型剥离直接 import `src/logic/content/validate.ts`，需要
> Node ≥ 22.18（本仓库开发环境为 Node 24）。`validate.ts` 必须保持 erasable-only 语法。

新增内容的最小步骤：

1. 在对应目录建 JSON，id 前缀与文件名匹配；
2. 若引用其他内容，先确保目标定义存在（或同批加入）；
3. 运行 `npm run content:lint`，零 issue 后再提交。

## 扩展约定（P2 合同稳定性）

- **新增可选字段**：向后兼容，可随功能票加入；需同步 schema、`types.ts`、本 README。
- **新增必填字段、修改字段语义、扩展 enum**：属于合同变更——必须同时更新 schema、`types.ts`、本 README，并在同一个 PR 内迁移全部现有内容与消费代码。
- **新增内容类别**：新目录 + 新 schema + 校验规则 + 文档，四者缺一不可。
- **不要写隐式约定**：所有会影响运行时的字段都必须出现在 schema 与本文档中；schema 禁止未知字段就是为了逼出显式声明。
- 内容文件不存运行期状态（位置变更、任务进度、装备状态都进 `GameSession.snapshot()` / 存档，不回写 content/）。
