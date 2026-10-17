# 30: 真实角色接入——VRM + Blender + Mixamo（agent 全程）

**Spec:** specs/p2-gameplay.md（user stories 32–35）

**What to build:** 玩家角色从占位 glb 升级为真实 VRM：agent 挑选并下载 Booth 高精度免费 VRM（许可证确认仅自用）→ 安装 Blender 并脚本化处理（换贴图/绑骨，顺路完成 P0 遗留的 headless 导出补测 `npm run assets:blender:repro`）→ Mixamo 重定向 walk/run/attack → 既有 VRM→GLB 工具链 → toon 渲染 + 描边 + morph 眨眼在真实资产上验证。角色贴图按票 29 色板卡生成/替换（依赖其生图工作流）。

**Blocked by:** 29（色板卡与生图工作流）

**Status:** done (2026-10-17，分支 worktree-agent-abe6c788802baa7c6；VRM 源为官方样例 Seed-san，Booth 下载卡登录待用户)

- [x] Blender 安装并 headless 可运行，`assets:blender:repro` 补测通过（P0 遗留清账）——Blender 4.5.3 LTS（download.blender.org 被本机代理阻断，改用清华镜像 dmg + `/Users/joule/.local/bin/blender` 包装器；软链接启动会挂内置 Python）。repro 首跑 failed，定位为 **bmesh 面序跨进程非确定**（顶点/位置数据一致、面排列不同，Blender 4.5.3 实测）→ export_test_asset.py 增加导出前按规范化 key 重排面（sort_bmesh_faces_deterministic），两次导出 SHA-256 一致（719c6813…）
- [x] VRM 挑选与许可证记录（截图 artifacts/ticket-30-vrm-candidates/，README.md 有完整许可证表）——**Booth 免费下载需登录（被卡，需用户登录 ego-browser 后 agent 继续）**；改用免登录的 VRM 官方样例 **Seed-san**（VirtualCast，VRM Public License 1.0：可改可再配布、需署名、avatarPermission=everyone）作为可运行源；Booth 候选已筛好 3 个（黒曜/Kokuyou 0 JPY 规约最宽、水瀬ほむら 0 JPY、Shuera 0 JPY VN3）
- [x] Mixamo 重定向 walk/run/attack——**Mixamo 官网 API 需 Adobe 登录，未走通**；改用免登录 CC0 源：Quaternius Universal Animation Library（用户提供 zip，UE 骨架 43 动作）Walk_Loop→walk、Jog_Fwd_Loop→run、Sword_Attack→attack；three.js Soldier.glb（Mixamo rig CC0）已验证为第二路径。新工具 tools/pipeline/retarget-animations.mjs：源 TPose 采样 → VRM humanoid role 映射 → rest 修正四元数重定向（q'=qRestT⊗qRestS⁻¹⊗q）→ hips 平移按骨架高度比缩放（0.867）；重定向数学有 L1 测试（合成 GLB 端到端 9 例，含摆角守恒回归：与源相对摆角最大差 1e-5 rad）。修复过两个重定向 bug（TPose 采样按节点去重挡掉旋转通道；追加 accessor 的 bufferView 索引漏加目标既有偏移）
- [x] toon 渲染 + 描边 + morph 眨眼在真实 VRM 上正常（多材质 morph 回归）——anime-pipeline 场景 passed（toonMaterialActive=1、outlineEnabled=1、morphTargetCount=129、boneMotionRangeRad=0.515）。character-visuals 改造：眨眼 morph 按 名字（blink/まばたき）跨全部网格扫描（真实 VRM morph 不在 0 号网格）；无贴图网格（VRM 单色材质）回退白贴图+基色 tint
- [x] L4：p1-world 用真实角色跑通完整闭环冒烟——passed（6991ms），截图 artifacts/ticket-30-vrm-candidates/l4-real-character-{idle,walk}.png；移动时 walk 动画组 playing、navmesh 移动正常
- [x] L5：真实角色资产下预算复测绿——reports/p1-world-real-character.json：fps 60.02（≥59.5）、drawCalls 58（≤350，占位角色为 38）、jsHeap 139.7MB（≤1500）
- [x] 贴图按色板卡替换：数据驱动接口已留——`assets/character-real.config.json` textures 槽位 + `tools/pipeline/blender/prepare_vrm_character.py --texture-map 槽位=PNG`；**TODO(票 29)**：色板卡产出后填路径重跑 `npm run assets:real-character`

**产出**：`npm run assets:real-character`（tools/pipeline/build-real-character.mjs）→ assets/character_vroid_lod0.glb（10.46 MiB，147 nodes/21 primitives/5 skins/17 materials/3 动画/129 morph），p1-world 与 anime-pipeline 自动优先加载。lint 新增外部资产类别（EXTERNAL_ASSETS，命名/拓扑降 warning、预算放宽但仍受控，结构性错误不放宽）。
