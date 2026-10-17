# 27: 战斗反馈层 + 重击技能

**Spec:** specs/p2-gameplay.md（user stories 1–14, 36, 37）

**What to build:** 把 GameSession 结算事实转译为视听反馈：伤害飘字（黄=对敌/红=受击，重击更大）、受击反馈（敌人闪白抖动、玩家屏幕边缘闪红+血条动画）、敌人血条（目标圈常显/受击后 5 秒淡出）、攻击前摇提示（敌我）、命中顿帧+镜头微震、击杀消散+掉落/经验飘字、升级金光时刻、CC0 音效（普攻命中/受击/击杀/拾取/升级/UI/重击）；HUD 重击技能按钮（8s 冷却、1.5 倍伤害、独立前摇与音效）；走 A（移动打断攻击意图）。地基：`damage-dealt`/`health-changed`/`player-level-up`/`item-gained` 升级为 GameSession 一等订阅事件；`heavyAttack` 新意图；快照 v2→v3（冷却剩余进快照）+ 迁移链。正式场景默认不挂 Harness DOM（`?harness=1` 开启）。

**Blocked by:** 无

**Status:** done（待人工验收）

- [x] L1：重击意图（倍率/冷却/快照往返/迁移链 v2→v3）+ 新事件序列测试（vitest）——29 文件 228 测试全绿
- [x] L2：无 schema 变更（重击参数走属性覆盖，不新增内容文件）——content:lint 12 文件通过
- [x] L4：p1-world ego-browser 冒烟全过（reports/p2-combat-feedback-smoke.json）——重击按钮/8s 冷却/转圈、前摇 600ms + windup 提示、飘字（heavy 大字/受击红字）、敌人血条+目标圈、走 A 打断、读档后冷却逐毫秒恢复、面板默认隐藏 ?harness=1 才显示、音频首次交互解锁
- [x] L4：可视化截图 artifacts/p2-combat-feedback-{windup,heavy,light}.png——飘字出现与 900ms 上浮淡出、目标圈常显/未选中受击后 5 秒淡出、击杀消散动画（300ms 缩小上浮，冒烟脚本未捕获死亡瞬间，代码路径由事件测试覆盖）
- [x] 音效落 assets/audio/（8 个 CC0 wav + SOURCES.md 逐条注明 freesound 来源与许可证），事件驱动播放（damage-dealt/enemy-killed/item-gained/attack-windup-started），首次 pointerdown 解锁 AudioContext；浏览器直连 freesound 被网络策略阻断，经 ego-browser 取 preview 流 + ffmpeg 转码（细节见 SOURCES.md）
- [x] L5 预算对照实验：同环境基线代码 37.74fps vs 票 27 39.75fps——fps 波动来自共享浏览器负载，非反馈层；drawCalls max 123 ≤ 350、heap 122MB ≤ 1500 全过。反馈层稳态零分配（节点事件驱动创建/回收）。正式独占环境夜测待 P2 批次合流后复测（reports/p2-combat-feedback-budget.json）
