# 33: 村庄聚点、经济与 NPC 行为

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 12–17）

**What to build:** 村庄安全区（敌人 AI 拒止，逻辑层）；商人 NPC——交易 UI（卖出史莱姆凝胶/买入治疗草药，价格表进 npc schema vendor 字段，复用 item 与金币）；NPC 行为逻辑：每 NPC 巡逻路线（点位列表 walk→停留张望→下一点，表现层驱动）+ 对话时停下面向 + 任务完成「换锚点」事件（世界因你而变）；NPC 巡逻进度（当前点位索引）进 EntitySnapshot 可选字段，实时位置随 entities.position 入档；新增 2 NPC（商人 + 氛围位），色板卡由票 29 管线产出。

**Blocked by:** 29（色板卡）、34（等级/金币数值口径）
**Status:** ready-for-agent

- [ ] 安全区内敌人不进入（L1：拒止逻辑测试）
- [ ] 买卖闭环：卖凝胶得金币、买草药扣金币入包（L1 交易结算测试）
- [ ] L2：npc vendor 价格表 schema 正负向
- [ ] NPC 巡逻（走停张望）+ 对话暂停面向 + 结束继续 + 任务后换锚点（L4 断言位置变化）
- [ ] 读档后 NPC 位置与巡逻进度恢复（L1 快照往返）
- [ ] 2 新 NPC 内容 + 色板卡落 content/（同卡出贴图与立绘）
- [ ] L4：村庄全流程冒烟（reports/ + artifacts/）
