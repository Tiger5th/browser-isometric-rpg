# 20: content/ 数据格式 + 最小内容集

**What to build:** 定义 content/ 数据格式（区域/NPC/敌人模板/物品/任务的 JSON schema + ink 对话文件约定），并产出 P1 最小内容集（1 区域、2 NPC、3 敌人同模板变体、4 物品、1 任务的数据）。配 L2 校验脚本：schema 校验 + 引用完整性（任务引用的敌人/NPC/物品必须存在）。此格式是 P2 Agent 批量内容生产的合同，稳定性优先。

**Blocked by:** 19 (GameSession 骨架——数据模型要对齐 Entity)

**Status:** ready-for-agent

- [ ] content/ 目录含全部最小内容集数据文件
- [ ] L2 校验脚本可运行，schema + 引用完整性检查就位
- [ ] 负向测试：坏引用/坏 schema 被正确拒绝
- [ ] GameSession 能从内容数据实例化实体（区域加载走通）
- [ ] 格式决策记录（字段含义、扩展约定）写入 content/README
