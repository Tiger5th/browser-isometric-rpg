# ADR-0002: 纯点击移动 + Crowd Navigation V2 寻路

日期：2026-10-17　状态：已接受

## 决策

角色移动采用纯点击移动（Diablo 系）；寻路采用 Babylon 官方 Crowd Navigation V2（底层 recast-navigation-js）；碰撞用 moveWithCollisions，默认不启用物理引擎；被遮挡的角色用 HighlightLayer 描边。

## 理由

- 等距 RPG 的主流控制方案，与 navmesh 寻路天然契合，实现最简单。
- V1 被官方弃用；V2 基于 ES6 兼容、活跃维护的 recast-navigation-js（MIT）。
- 物理引擎在需要推开/投掷前是纯成本。
- 3D 引擎下深度缓冲自动处理排序，等距遮挡问题只剩"被挡角色的可视性"，描边方案成本可控。

## 代价

- 键盘动作类玩法（如 WASD 闪避）未来如需加入，控制层要扩展——按放弃的能力计入取舍。
- 遮挡描边在多角色同屏时的开销待原型实测（P0 验证项 3）。
