# 28: 世界质感——网格化碰撞 + 边界景观 + 光照氛围

**Spec:** specs/p2-gameplay.md（user stories 15–21）

**What to build:** 树/石墙/木桶/木箱 4 类 billboard → 程序化几何拼装真网格（Babylon 内置几何 + 现有 Gemini 贴图，CC0 低模包为后备）+ 硬碰撞 collider（不可穿模）；灌木保留 billboard 可穿，角色进入时轻微遮挡/半透明（草丛机制视觉预留）；地图边界外低细节景观环带 + 渐暗雾（消除黑色虚无，风格进锚定图，agent 用 ego-browser 出「远景/天际线」样本）；全场唯一主光左上 45°、暗部紫灰、ImageProcessing 明亮暖色分级；NPC 待机行为（呼吸摆动/偶尔踱步）。

**Blocked by:** 无

**Status:** ready-for-agent

- [ ] 4 类环境件为真网格 + 硬碰撞，玩家/敌人均不可穿；灌木可穿且有进入视觉反馈
- [ ] 边界外景观环带 + 雾，四个方向无黑色虚无（截图 artifacts/ 四方向）
- [ ] 统一主光与色调分级生效，与锚定图观感一致
- [ ] NPC 待机行为，无站桩
- [ ] L1：布局/碰撞常量纯逻辑测试（先例 green-hollow-layout.test.ts）
- [ ] L4：ego-browser 冒烟——撞树被挡、灌木可走、移动不被误挡死
- [ ] L5：预算复测绿（fps ≥59.5、drawCalls ≤350、heap 达标），超支则逐件 LOD
- [ ] 远景风格样本图进风格锚定（artifacts/，含用户确认留档）
