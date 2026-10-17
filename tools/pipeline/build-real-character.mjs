#!/usr/bin/env node
/**
 * 真实角色资产构建编排（票 30）：VRM → 动画重定向 → VRM 扩展剥离 → GLB。
 *
 * 产出 `assets/character_vroid_lod0.glb`（既有约定名，anime-pipeline 与
 * p1-world 都会自动优先加载它，见两处的 import.meta.glob）。
 *
 * 流程：
 *   1. 读配置 `assets/character-real.config.json`（数据驱动；贴图替换槽位
 *      留给票 29 的色板卡产出，见配置内 TODO）。
 *   2. 动画重定向：源动画 GLB（Mixamo rig）→ extract → 按目标 VRM 的
 *      humanoid map 合并（tools/pipeline/retarget-animations.mjs）。
 *   3. VRM 扩展剥离（tools/pipeline/vrm-to-glb.mjs 的 convertVrmToGlb）：
 *      剥 VRM/VRMC_* 扩展，保留网格/蒙皮/morph/动画，Babylon 标准 glTF
 *      loader 可直接加载。
 *
 * 贴图替换（Blender，可选独立步骤，不在此脚本内）：
 *   blender --background --factory-startup \
 *     --python tools/pipeline/blender/prepare_vrm_character.py -- \
 *     --input assets/character_vroid_lod0.glb \
 *     --output assets/character_vroid_lod0.glb \
 *     --texture-map body=assets/textures/character_body_palette.png
 *   TODO(票 29)：色板卡贴图产出后，把 --texture-map 路径换成语板卡贴图
 *   并重跑（配置文件 character-textures 槽位只是记录，不参与本脚本）。
 *
 * 用法：
 *   node tools/pipeline/build-real-character.mjs                 # 读默认配置
 *   node tools/pipeline/build-real-character.mjs --config <path> # 指定配置
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { convertVrmToGlb, parseGlb, writeGlb } from "./vrm-to-glb.mjs";
import { extractAnimations, retargetAnimations } from "./retarget-animations.mjs";

/**
 * 裁剪 morph targets：VRoid 导出常带 100+ 表情 shape keys，而游戏运行时
 * 只驱动眨眼；toon shader 一旦带 MORPHTARGETS 定义，顶点着色器会为每个
 * target 付出额外顶点成本（票 30 实测 129 targets 时 p1-world 掉到 45fps）。
 * 只保留 keepPattern 命中的 target，同步裁 mesh.weights 与 extras.targetNames。
 */
export function filterMorphTargets(json, keepPattern) {
  if (!keepPattern) {
    return { kept: 0, removed: 0 };
  }
  const pattern = new RegExp(keepPattern, "i");
  let kept = 0;
  let removed = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const targets = primitive.targets ?? [];
      const filtered = [];
      const keptIndices = [];
      targets.forEach((target, index) => {
        const name = mesh.extras?.targetNames?.[index];
        if (name && pattern.test(name)) {
          keptIndices.push(index);
          filtered.push(target);
        }
      });
      if (filtered.length === targets.length) {
        kept += targets.length;
        continue;
      }
      removed += targets.length - filtered.length;
      kept += filtered.length;
      if (filtered.length > 0) {
        primitive.targets = filtered;
      } else {
        delete primitive.targets;
      }
      if (mesh.extras?.targetNames) {
        mesh.extras.targetNames = keptIndices.map((index) => mesh.extras.targetNames[index]);
      }
      if (mesh.weights) {
        mesh.weights = keptIndices.map((index) => mesh.weights[index]);
      }
    }
  }
  return { kept, removed };
}

const ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_CONFIG = resolve(ROOT, "assets/character-real.config.json");
const DEFAULT_OUTPUT = resolve(ROOT, "assets/character_vroid_lod0.glb");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value =
      argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : true;
    args[key] = value;
    if (value !== true) index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(args.config ?? DEFAULT_CONFIG);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const outputPath = resolve(args.out ?? DEFAULT_OUTPUT);

  const vrmPath = resolve(ROOT, config.sourceVrm);
  if (config.sourceVrm.startsWith("TODO")) {
    console.error(
      "[build-real-character] 配置中的 sourceVrm 仍是 TODO：请先完成 VRM 挑选下载" +
        "（Booth 需登录；候选与许可证记录见 artifacts/ticket-30-vrm-candidates/）",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[build-real-character] 源 VRM：${config.sourceVrm}`);

  // ---- 1. 动画重定向（可选：没有动画源时跳过，角色仍可加载但无 walk/run）
  let characterBuffer = await readFile(vrmPath);
  const animSource = config.animations?.source;
  if (animSource && !animSource.startsWith("TODO")) {
    const animPath = resolve(ROOT, animSource);
    const names = config.animations.names ?? ["Walk_Loop", "Jog_Fwd_Loop", "Sword_Attack"];
    const renameMap = config.animations.rename ?? {};
    const extracted = extractAnimations(await readFile(animPath), names, renameMap);
    console.log(
      `[build-real-character] 动画提取：${extracted.stats.animations.join(", ")} · ` +
        `${extracted.stats.channels} 通道 · rest 姿态 ${extracted.stats.restPoseBones} 骨`,
    );
    const retargeted = retargetAnimations(
      extracted.glb,
      characterBuffer,
      config.animations.map ?? "vrm",
    );
    characterBuffer = retargeted.glb;
    console.log(
      `[build-real-character] 动画重定向：新增 ${retargeted.stats.addedAnimations
        .map((a) => `${a.name}(${a.channels}ch)`)
        .join(", ")} · hips 高度比 ${retargeted.stats.hipsScale.toFixed(3)} · ` +
        `骨骼映射 ${retargeted.stats.mappedBones.length} · 丢弃 ${retargeted.stats.droppedBones.length}`,
    );
    if (retargeted.stats.droppedBones.length > 0) {
      console.log(
        `[build-real-character] 丢弃明细：${retargeted.stats.droppedBones.join(", ")}`,
      );
    }
  } else {
    console.log("[build-real-character] 无动画源（跳过重定向）");
  }

  // ---- 2. morph 裁剪（默认只留眨眼；配置 morphs.keep 为正则字符串）
  const parsed = parseGlb(characterBuffer);
  const morphStats = filterMorphTargets(
    parsed.json,
    config.morphs?.keep ?? "blink|まばたき",
  );
  characterBuffer = writeGlb(parsed.json, parsed.bin);
  console.log(
    `[build-real-character] morph 裁剪（keep=${config.morphs?.keep ?? "blink|まばたき"}）：` +
      `保留 ${morphStats.kept} · 移除 ${morphStats.removed}`,
  );

  // ---- 3. VRM 扩展剥离 → 标准 glTF GLB
  const { glb, stats } = convertVrmToGlb(characterBuffer);
  await writeFile(outputPath, glb);
  console.log(`[build-real-character] 产出：assets/${outputPath.split("/").pop()}`);
  console.log(
    `[build-real-character] VRM 扩展剥离：${stats.stripped.join(", ") || "(无需)"}` +
      (stats.specVersion ? ` · specVersion ${stats.specVersion}` : ""),
  );
  console.log(
    `[build-real-character] 保留：${stats.nodes} nodes · ${stats.primitives} primitives · ` +
      `${stats.skins} skins · ${stats.animations} animations · ${stats.materials} materials · ` +
      `${(glb.byteLength / 1024 / 1024).toFixed(2)} MiB`,
  );
}

main().catch((error) => {
  console.error(`[build-real-character] 失败：${error.message}`);
  process.exitCode = 1;
});
