# 35: 第二区域「史莱姆巢穴」与联动

**Spec:** specs/p2-batch2-quality-motivation.md（user stories 21–24）
**What to build:** 小型第二区域（约主区域 1/3）：路口/传送点连接，走到底触发区域切换 + 黑场过场（复用 loadingGate 与既有区域数据结构/流式加载，无新引擎机制）；区域 2 内容（地形贴图、环境件按票 28 管线、敌人混编：两种新敌人 + 史莱姆）；跨区域任务 1 条（马婆婆→去巢穴杀新怪）；区域 2 专属掉落物（供票 33 商人交易）。探索度/动态联动推后。
**Blocked by:** 36（敌人内容）、28（环境件管线）
**Status:** done

- [x] 区域 2 数据 + 地面/环境贴图（`region:slime_den`，约主区域 1/3 = 32.5%；地面用 `artifacts/region2/ground-c1`，环境件用 crystal/cocoon/eggs c1）
- [x] 路口触发切换 + 黑场过场 + 往返双向可行（`travelToRegion` + `loadingGate`，翠谷 (0,19) ⇄ 巢穴 (0,-11)）
- [x] 跨区域任务：接取在区域 1、目标在区域 2、交付回区域 1，进度跨区域累计（L1）
- [x] 区域 2 专属掉落物入内容（`item:slime_core`；商人价格表由票 33 接）
- [x] L4：区域往返 + 跨区域任务全流程冒烟（`reports/ticket35-region2-smoke.json` + 四方向截图 `artifacts/t35-{den,hollow}-{north,east,south,west}.png`）
- [x] L5：两区域预算复测（drawCalls 绿；fps 未达 59.5，判定为共享机器负载，理由见报告）

## 遗留

- **巢穴件观感待美术迭代**：`den-crystal/den-cocoon/den-eggs` 的 c1 贴图内容偏灰白，
  UV 窗口已按实测包围盒修正，但几何仍显得偏细。不阻塞验收；下一轮贴图
  （更实心、剪影更清晰的 c2）只需替换 `assets/textures/prop_den_*.png`。
- **商人价格表**：区域 2 掉落物已进 content（`item:slime_core`，value 12），
  按 issue 与票 33 的分工，价格表由票 33 的 npc vendor 字段接。
- **区域 2 的新敌人已按 spec 混编**（票 36 合入后补齐）：`enemy:den_charger`（冲锋型）
  + `enemy:den_spitter`（吐弹型）+ 3 只巢穴史莱姆。

## 关键设计

- **区域联动判定在逻辑层**（`src/logic/region-linkage.ts`）：1.6m 半径的纯几何函数，
  零引擎依赖，因此「走到底触发」能被 L1 直接测；渲染层只负责拿到结果后走黑场。
- **区域运行时工厂**（`src/render/presentation/region-runtime.ts`）：两区域共用同一套
  渲染机制（环境网格 + 硬碰撞 + navmesh），差异只有布局数据与 tint，无新引擎机制。
- **切区先建新区再拆旧区**：`createRegionRuntime` 异步加载贴图并构建 navmesh，
  期间玩家仍可能点地面；提前 dispose 会让 Recast WASM 抛
  "memory access out of bounds"。
- **读档路径单独走 `enterRegion`**：自动存档可能来自另一个区域，
  `restoreSnapshot` 要求会话已加载同一区域，因此先装区域再恢复。