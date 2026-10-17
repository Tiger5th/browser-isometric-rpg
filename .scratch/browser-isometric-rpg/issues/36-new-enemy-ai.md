# 36: 两种新敌人 AI——冲锋型与吐弹型

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 25–27）

**What to build:** 冲锋型：chase 后加 windup（0.6s 明显前摇，配合票 27 前摇提示）→ charge（直线高速，路径命中判定一次）→ recovery 硬直（走位躲开后可白打）；冲锋被硬碰撞挡停。吐弹型：ranged-kite（保持攻击距离，玩家接近则后撤），投射物为逻辑层实体（位置/速度/命中在 GameSession，表现层只渲染）。敌人模板 schema 扩展 aiProfile 字段（chaser/windup-charge/ranged-kite）。两种敌人独立外形贴图（Gemini，色板卡管线顺路）。死亡轻惩罚顺路落地：复活回村出生点 + 扣 10% 金币（向上取整，无金币则免）。

**Blocked by:** 27（前摇提示/事件地基）
**Status:** ready-for-agent

- [ ] L1：冲锋状态机序列（windup→charge→命中/挡停→recovery）+ 走位躲避可行（vitest）
- [ ] L1：吐弹 kiting 行为 + 投射物命中判定 + 玩家受击事件
- [ ] L2：aiProfile schema 正负向
- [ ] 两种敌人独立贴图落 assets/（artifacts/ 留档）
- [ ] 死亡惩罚：回村复活 + 金币扣除 + 快照往返（L1）
- [ ] L4：两种敌人实战冒烟（躲冲锋/被迫接近吐弹怪）（reports/ + artifacts/）
