# 票 30 · Booth 免费 VRM 候选与许可证记录

日期：2026-10-17。用途：玩家角色真实资产（仅自用，不商用——用户在 09 号票确认「自用不商用」）。

## 被卡环节（需要用户人工步骤）

**Booth（booth.pm）免费下载需要登录**。ego-browser 浏览/搜索/筛选全程可用，
但 `booth.pm/downloadables/*` 直链 302 到 `booth.pm/users/sign_in`，本机浏览器
profile 无 Booth 登录态（`Sign In` 可见，userPage 为空）。VRoid Hub 有
Cloudflare 挑战且下载同样需要登录。

需要用户做的一步：在 ego-browser 打开 https://booth.pm/users/sign_in 登录
Booth（或告知已有的账号信息由 agent 重试）。登录后 agent 即可完成下载与
`sourceVrm` 配置切换。

## 当前使用的角色（可运行）

| 项 | 值 |
|---|---|
| 模型 | **Seed-san**（VirtualCast, Inc.） |
| 来源 | VRM 官方规范样例仓库 vrm-c/vrm-specification（免登录） |
| URL | https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san |
| 许可证 | VRM Public License 1.0（https://vrm.dev/en/licenses/1.0/） |
| 元数据 | avatarPermission=everyone · commercialUsage=corporation · modification=allowModificationRedistribution · allowRedistribution=true · **creditNotation=required（需署名）** |
| 署名 | 模型：VirtualCast, Inc.（Seed-san）。若游戏对外发布需在致谢中保留 |
| 规格 | VRM 1.0 · 5 mesh/5 skin · 147 nodes · 43 morph targets · 10.9 MB |
| 截图 | artifacts/ticket-30-vrm-candidates/seed-san-official-screenshot.png |

## Booth 候选（已筛选待下载，截图在同目录）

| 候选 | 价格 | 许可证要点 | 截图 |
|---|---|---|---|
| 「黒曜/Kokuyou」VRM（6666669 / ROLOCK） | 0 JPY | 改変OK · 商用OK · 无需署名 · **禁再配布 · 禁 AI 学习 · 仅本人使用**（统一规约 https://6666669.booth.pm/items/6789317） | 01-kokuyou-rolock.png |
| 「水瀬ほむら」VRM（沙七の水面） | 0 JPY | 「アバターとして使うのもヨシ、商用利用もなんでもヨシ」（页面声明，无统一规约文件） | 02-minase-homura.png |
| 「Shuera / シュエラ」（ゆずはこ） | 0 JPY | VN3 ライセンス（比上述严格：禁转用/再配布，自用 OK） | 03-shuera.png |

淘汰说明：「あきら」（こむちゃのおみせ）免费但为 VRChat Unitypackage + VN3
禁转用，与 VRM→glTF 管线不匹配。热门排序前列（マヌカ/セレスティア等）均为
付费（5000–7000 JPY），不符合票面「免费」要求。

## 动画源（walk / run / attack）

| 项 | 值 |
|---|---|
| 主路径 | **Quaternius Universal Animation Library**（用户提供 zip，CC0 1.0，UE 骨架，43 动作含 Walk_Loop / Jog_Fwd_Loop / Sword_Attack） |
| 落库 | assets/animation-sources/ual_standard.glb（7.3 MB，CC0 可入库） |
| 备选 | three.js Soldier.glb（CC0，Mixamo rig，Walk/Run/Idle/TPose）——已验证 extract/retarget 全链路 |
| Mixamo 官网 | www.mixamo.com 站点可达但 API 需 Adobe 登录（403），未走通；如用户有 Adobe 账号可作为动作源补充 |
| 重定向 | tools/pipeline/retarget-animations.mjs：源 TPose 采样 → rest 修正四元数重定向（q' = qRestT ⊗ qRestS⁻¹ ⊗ q）→ hips 平移按骨架高度比缩放（Seed-san 比 0.867） |

## 换贴图（票 29 依赖，接口已留）

- 数据驱动接口：`assets/character-real.config.json` 的 `textures` 槽位
  （body/face）+ `tools/pipeline/blender/prepare_vrm_character.py
  --texture-map <槽位>=<PNG 路径>`。
- **TODO(票 29)**：色板卡贴图产出后填入配置并重跑
  `npm run assets:real-character`。
