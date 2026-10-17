# 33: 村庄聚点、经济与 NPC 行为

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 12–17）
**Implementation Decisions:** 规格「村庄聚点与经济」节
**Status:** done

- [x] 安全区内敌人不进入（L1：拒止逻辑测试）——`src/logic/safe-zone.ts` 纯几何 + `GameSession.updateEnemyBehavior` 拒止（优先级高于感知半径与「被点过一次」）；L4 实测区内 0 敌进入、出区最近 1.95m 追上
- [x] 买卖闭环：卖凝胶得金币、买草药扣金币入包（L1 交易结算测试）——`src/logic/trade.ts` 报价算术 + `GameSession.trySellToVendor/tryBuyToVendor`；金币不足按可负担件数下调，绝不透支
- [x] L2：npc vendor 价格表 schema 正负向——`vendor`/`patrol`/`reanchors`/`safeZones` 进 schema；新增 7 条负向（物品引用、价格为 0、无价差、单点路线、首点错位、坏任务引用、零半长宽）全部拦截
- [x] NPC 巡逻（走停张望）+ 对话暂停面向 + 结束继续 + 任务后换锚点（L4 断言位置变化）——`src/logic/npc-patrol.ts` 状态机；对话开始即冻结、ink 走完或移动打断后继续；交付任务时逻辑层落位新锚点并广播 `npc-reanchored`
- [x] 读档后 NPC 位置与巡逻进度恢复（L1 快照往返）——`EntitySnapshot.patrolIndex` 可选字段；无巡逻路线的实体不写该字段
- [x] 2 新 NPC 内容 + 色板卡落 content/（同卡出贴图与立绘）——老陶（商人）与铁七（铁匠/伏笔位），色板卡 `status: pending`；**立绘未出图**（本机无 Gemini CLI），表现层走主色程序化占位
- [x] L4：村庄全流程冒烟（reports/ + artifacts/）——`reports/l4-ticket33-village.json` 12/12 通过；截图 `artifacts/p33-village-safezone.png`、`artifacts/p33-trade-panel.png`

## 新增/修改

- 新模块：`src/logic/safe-zone.ts`、`src/logic/trade.ts`、`src/logic/npc-patrol.ts`
- `GameSession`：安全区拒止、商人报价/买卖、巡逻推进与进度、换锚点、`getVillageEvidence` 所需的只读查询；新事件 `npc-reanchored` / `trade-completed`
- 表现层：新文件 `src/render/ui/trade-panel.ts`（不碰 quest-loop-ui）；`p1-world` 接 2 新 NPC + 巡逻 + 摊位 + 安全区地面标记
- 内容：`merchant_bo` / `smith_qi` NPC + 色板卡 + ink；`green_hollow` 增 `safeZones`；马婆婆/林斥候加巡逻路线，马婆婆加 `reanchors`

## 遗留

- 两个新 NPC 的立绘未生成（色板卡 `status: pending`）：本机无 Gemini CLI，需按色板卡关键词补出 `assets/portraits/{merchant_bo,smith_qi}.png` 后把 status 改 `generated`。
- 安全区目前只有地面标记可视化，没有围墙/围栏几何；地形美术归关卡制作。
- `src/render/babylon-boundary.test.ts` 的 barrel 导入用例在本机并行跑 vitest 时会撞 5s 超时（约 10s 导入耗时），单独跑通过；与本票改动无关，未处理。
