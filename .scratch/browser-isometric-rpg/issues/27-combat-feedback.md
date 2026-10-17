# 27: 战斗反馈层 + 重击技能

**Spec:** specs/p2-gameplay.md（user stories 1–14, 36, 37）

**What to build:** 把 GameSession 结算事实转译为视听反馈：伤害飘字（黄=对敌/红=受击，重击更大）、受击反馈（敌人闪白抖动、玩家屏幕边缘闪红+血条动画）、敌人血条（目标圈常显/受击后 5 秒淡出）、攻击前摇提示（敌我）、命中顿帧+镜头微震、击杀消散+掉落/经验飘字、升级金光时刻、CC0 音效（普攻命中/受击/击杀/拾取/升级/UI/重击）；HUD 重击技能按钮（8s 冷却、1.5 倍伤害、独立前摇与音效）；走 A（移动打断攻击意图）。地基：`damage-dealt`/`health-changed`/`player-level-up`/`item-gained` 升级为 GameSession 一等订阅事件；`heavyAttack` 新意图；快照 v2→v3（冷却剩余进快照）+ 迁移链。正式场景默认不挂 Harness DOM（`?harness=1` 开启）。

**Blocked by:** 无

**Status:** ready-for-agent

- [ ] L1：重击意图（倍率/冷却/快照往返/迁移链 v2→v3）+ 新事件序列测试（vitest）
- [ ] L2：无 schema 变更则跳过；有技能内容数据则 lint 通过
- [ ] L4：p1-world ego-browser 冒烟——重击全流程（按钮/冷却/飘字）、走 A 打断、读档后冷却恢复、正式场景无 Harness 面板（`?harness=1` 才有）
- [ ] L4：反馈可视化断言——飘字出现与消失、目标圈+血条、击杀消散（截图 artifacts/）
- [ ] 音效文件落 assets/audio/（CC0，注明来源与许可证），事件驱动播放，首次交互解锁
- [ ] L5 预算不回归（反馈层零分配优先，参照遮挡描边先例）
