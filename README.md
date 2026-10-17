# browser-isometric-rpg

浏览器端等距视角 RPG——目标是逼近大型商业 RPG 的表现、深度与规模，同时保持浏览器为首要平台、架构支持多年扩展（多地区、多章节、AI 批量内容生产）。

**当前状态：P1 垂直切片完成**——单区域完整玩法闭环可玩：点击移动（navmesh 寻路）→ 战斗（AI 状态机/伤害/掉落）→ 对话（ink）→ 任务 → 背包装备（修饰器即时生效）→ 存读档（IndexedDB + 版本迁移）。二次元 toon 渲染 + 环境贴图 + 遮挡描边 + 动态分辨率全部就位。

## 核心特性

- **引擎**：[Babylon.js](https://www.babylonjs.com/) 9.31（WebGL2 基线，WebGPU 自动增强），Recast/Detour 寻路（recast-navigation）
- **逻辑/表现彻底分离**：游戏规则全部在 `src/logic/`（纯 TypeScript，零引擎依赖，vitest 直测 181 个测试）；`src/render/` 只消费快照 + 提交意图
- **数据驱动内容**：角色/敌人/NPC/物品/任务全部是 `content/` 下的 JSON + ink 文件，引擎代码不随内容增长，L2 校验（schema + 引用完整性）把关——为 AI 批量生产内容铺路
- **快照可序列化**：`GameSession.snapshot()` 完整还原会话（含对话中间状态），存档带版本迁移链，旧存档自动升级
- **资产管线**：glTF-Transform（meshopt + KTX2）+ 资产 lint（命名/三角数/贴图尺寸）+ headless Blender 导出（可重复性验证）
- **性能预算断言**：动态分辨率默认开启；fps/draw calls/内存随报告输出，L5 夜测判据

## 快速开始

```bash
npm install
npm run dev
```

打开 `http://localhost:5173/?scenario=p1-world` 进入完整玩法场景（端口被占用时 Vite 会顺延，以终端输出为准）。

**试玩路线**：点击地面移动 → 点 NPC 对话接任务 → 点史莱姆战斗（杀 3 只）→ 回 NPC 交任务拿装备 → 按 `I` 开背包穿装备/用药 → 点「存档」→ 刷新页面验证读档恢复。

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm test` | 全量逻辑测试（vitest） |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run content:lint` | 内容数据校验（schema + 引用完整性） |
| `npm run assets:lint` | 资产校验（glb/PNG） |

### 场景一览

URL 参数 `?scenario=` 切换：

| 场景 | 内容 |
|---|---|
| `p1-world` | **P1 完整玩法**（正式画面 + 全闭环） |
| `dialogue-quest` | 对话/任务/存档闭环 |
| `combat-loop` | 战斗调试 |
| `click-move` | 点击移动 + 寻路 |
| `anime-pipeline` | toon 渲染开/关对比 |
| `occlusion-outline` | 遮挡描边演示 |

## 架构

```
content/            内容数据包（JSON schema + ink 对话）—— P2 起 AI 批量生产
src/logic/          游戏逻辑（零引擎依赖，快照/意图/事件，vitest 覆盖）
src/render/         Babylon 渲染层（只读快照 + 提交意图）
  presentation/     正式表现（贴图环境/toon/动态分辨率）
  scenarios/        具名场景（Harness 驱动，统一 JSON 报告）
  ui/               HUD/背包/对话 DOM UI
tools/              资产管线（glTF-Transform/Blender/lint）与内容校验
artifacts/          截图与阶段报告
reports/            运行时测量 JSON
docs/adr/           架构决策记录（0001–0005）
```

关键决策见 [docs/adr/](docs/adr/)：引擎选型（0001）、点击移动与寻路（0002）、区域流式加载（0003）、数据驱动系统 + ink（0004）、测试分层（0005）。

## 测试分层

- **L1**：逻辑单测（vitest，181+）——战斗/任务/对话/存档/修饰器全规则
- **L2**：内容校验（schema + 引用完整性 + 负向测试）
- **L3**：资产 lint（glb/PNG，每 PR 运行）
- **L4**：浏览器闭环冒烟（Playwright 兼容驱动，完整玩法链路断言）
- **L5**：性能/视觉夜测（fps/draw calls/内存 vs 预算，只报告不阻塞）

## 美术管线

二次元风格、自用不商用、全链路免费：

- **环境**：AI 生成平铺贴图（正俯视）+ 立面物件贴图（45° 等距白底，运行时抠图做 billboard）
- **角色**：程序化占位角色 + 自定义 toon shader（三阶色阶 + rim + 描边 + 色彩分级，支持 morph 表情）
- **风格一致性**：锚定参考图 + 统一提示词 + 渲染侧 toon 拉齐（一致性是管线属性，不靠运气）

## 路线图

- **P0**（已完成）：9 项技术假设原型验证（引擎/渲染/寻路/遮挡/区域加载/资产管线/逻辑层/二次元链路）
- **P1**（已完成）：垂直切片——单区域完整玩法闭环
- **P2**（规划中）：完整第一章——区域布局进 content、AI 批量内容生产、真实角色资产（Booth 高模 + Blender 换装/绑骨）、音效（公有领域音效库 + AI 生成 BGM）

## 许可

游戏项目本身自用开发中。第三方组件许可：Babylon.js (Apache-2.0)、recast-navigation (Zlib)、inkjs (MIT)、gltf-transform (MIT)。
