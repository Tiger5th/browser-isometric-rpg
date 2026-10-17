# 21: 战斗闭环

**What to build:** 玩家可点击敌人发起攻击；敌人有状态机（idle→patrol→chase→attack→dead）；命中/伤害公式使用修饰器后的属性；胜利获得经验与掉落物；玩家死亡从存档点重生。全部规则在 GameSession 内，回合制时间步进，L1 全覆盖。

**Blocked by:** 19, 20

**Status:** resolved

- [x] 点击敌人 → 攻击意图 → 伤害结算 → 敌人死亡 → 经验/掉落进背包
- [x] 敌人状态机完整：靠近触发察觉/追击/攻击玩家
- [x] 玩家死亡 → 重生（回存档点，状态按设计恢复）
- [x] L1：战斗全规则（命中/伤害/经验/掉落/死亡/重生）测试绿，公式吃修饰器有测试
- [x] 渲染层同步攻击表现（动画触发即可，不追求打击感）

## Answer

已实现并提交：分支 `worktree-agent-a3ffe0543360b177d`，commit `bdfb182`。

**逻辑层（src/logic/game-session.ts，零渲染依赖）**

- `attack(attacker, target)` 意图：射程内立即结算一轮，之后按 `attackIntervalMs`（缺省 1000ms）冷却，由 `advance()` 手动步进（内部 100ms 固定步长）。
- 公式：命中率 `clamp(0.9 + (accuracy-evasion)/100, 0.05, 1)`；伤害 `max(1, round(attack-defense))`；全部属性取修饰器后的 `(base+Σadd)×(1+Σmultiply)`，另有测试覆盖攻击/防御/重生 maxHp。
- 敌人状态机：`idle→patrol→chase→attack→dead`；察觉半径 8、脱战 16、巡逻半径 4、idle 2s，均可用属性覆盖；被攻击立即仇恨。
- 击杀：经验（模板 `xp`）累加到玩家属性；掉落按 `chance/min..max` 掷点、按 `maxStack` 合并/拆栈入背包。
- 玩家死亡：等待 `respawnDelayMs`（缺省 1000ms）回区域出生点、生命回满（含修饰器 maxHp）；活着的敌人回出生点并回满血，已死敌人不刷新；重生后敌人有一个攻击间隔缓冲。
- 事件流：`drainEvents()` → `attack` / `death` / `xp` / `loot` / `respawn`，供渲染与票 22 消费（本票不改任务状态机）。
- 快照升级到 v2：实体新增 `attributes`（修饰器后有效属性）、`combat`（hp/maxHp/aiState/targetId/cooldown）、`container`（背包）。默认值写入 `content/README.md`。

**渲染层**

- 新增 `src/render/scenarios/combat-loop.ts` 并注册：真实 content 数据加载区域；点击敌人提交 `attack`，点地面 `moveTo`；敌人按快照位置/状态驱动移动与颜色（idle 绿/patrol 黄绿/chase 橙/attack 红/dead 沉没）；`attack` 事件触发冲刺与受击闪白；死亡事件后下沉消失。
- 调试入口 `window.P0CombatDebug`（快照/敌人/攻击/事件日志）。

**验证**

- `npx vitest run`：12 个测试文件、80/80 通过（新增 20 个战斗测试，覆盖命中/未命中/冷却/自动接近/修饰器/击杀经验掉落/掉率/maxStack/AI 三态/死亡重生/快照隔离）。
- `npm run build`：通过；`npm run content:lint`：12 个内容文件 + 1 个对话通过。
- L4 ego-browser：`combat-loop` 场景 `passed`（14 次攻击事件、1 次敌人死亡、XP 10、凝胶 x2、玩家 HP 80；无页面错误）。
