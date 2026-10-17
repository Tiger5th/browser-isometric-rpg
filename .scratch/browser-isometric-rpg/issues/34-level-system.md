# 34: 等级系统正式化

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 18–20）

**What to build:** 经验阈值曲线进 content（初版 L2=100、L3=250、L4=450、每级 +250 递增，可调）；升级加属性（每级 +2 攻击 +2 防御 +10 maxHp，修饰器入账）；GameSession 在 xp 入账时结算升级并发射 `player-level-up` 事件（票 27 已定义该事件，本票为逻辑层生产者）；累计 xp/等级随票 31 快照 v3 入档；HUD 等级徽标（票 24 HUD 扩展）。

**Blocked by:** 无（与 31 合流快照 v3）
**Status:** ready-for-agent

- [ ] L1：xp 入账→跨阈值→升级→属性变化→事件发射序列（vitest）
- [ ] L1：升级状态快照往返（等级/cumulativeXp 不丢）
- [ ] L2：等级曲线 content schema 正负向
- [ ] HUD 显示等级 + 升级时属性飘字数据就绪（消费在票 27）
- [ ] L4：打怪升级→读档→等级保持 冒烟（reports/）
