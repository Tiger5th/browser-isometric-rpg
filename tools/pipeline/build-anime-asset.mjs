#!/usr/bin/env node
/**
 * 二次元占位角色生成器（Blender / VRoid 不可用时的降级资产）。
 *
 * 产出 `assets/character_anime_placeholder.glb`：
 * - 单一蒙皮网格，约 1.1 万三角（符合 05 规范角色 ≤ 15k）
 * - 23 根人形骨骼（b_ 前缀）+ 双马尾次级骨骼
 * - 顶点色分区（皮肤/头发/外套/裙装/靴子）+ 512² baseColor 贴图
 * - 一个 blink morph target（验证 morph 导入链路）
 * - walk / run 两段程序化骨骼动画（模拟 Mixamo 烘焙结果）
 *
 * 资产命名全部遵循 05 规范，可直接通过 `npm run assets:lint`。
 *
 * 用法：node tools/pipeline/build-anime-asset.mjs [输出路径]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import {
  EXTMeshoptCompression,
  KHRDracoMeshCompression,
} from "@gltf-transform/extensions";

import { encodePng } from "./lib/png.mjs";

const TAU = Math.PI * 2;
const TEXTURE_SIZE = 512;
const WALK_FRAMES = 30;
const RUN_FRAMES = 24;

const BONES = [
  { name: "b_root", parent: null, translation: [0, 0, 0] },
  { name: "b_hips", parent: "b_root", translation: [0, 0.82, 0] },
  { name: "b_spine", parent: "b_hips", translation: [0, 0.18, 0] },
  { name: "b_chest", parent: "b_spine", translation: [0, 0.18, 0] },
  { name: "b_neck", parent: "b_chest", translation: [0, 0.16, 0] },
  { name: "b_head", parent: "b_neck", translation: [0, 0.1, 0] },
  { name: "b_shoulder_l", parent: "b_chest", translation: [-0.18, 0.08, 0] },
  { name: "b_upperarm_l", parent: "b_shoulder_l", translation: [-0.1, 0, 0] },
  { name: "b_lowerarm_l", parent: "b_upperarm_l", translation: [0, -0.26, 0] },
  { name: "b_hand_l", parent: "b_lowerarm_l", translation: [0, -0.22, 0] },
  { name: "b_shoulder_r", parent: "b_chest", translation: [0.18, 0.08, 0] },
  { name: "b_upperarm_r", parent: "b_shoulder_r", translation: [0.1, 0, 0] },
  { name: "b_lowerarm_r", parent: "b_upperarm_r", translation: [0, -0.26, 0] },
  { name: "b_hand_r", parent: "b_lowerarm_r", translation: [0, -0.22, 0] },
  { name: "b_upperleg_l", parent: "b_hips", translation: [-0.11, -0.08, 0] },
  { name: "b_lowerleg_l", parent: "b_upperleg_l", translation: [0, -0.34, 0] },
  { name: "b_foot_l", parent: "b_lowerleg_l", translation: [0, -0.34, 0] },
  { name: "b_upperleg_r", parent: "b_hips", translation: [0.11, -0.08, 0] },
  { name: "b_lowerleg_r", parent: "b_upperleg_r", translation: [0, -0.34, 0] },
  { name: "b_foot_r", parent: "b_lowerleg_r", translation: [0, -0.34, 0] },
  { name: "b_hair_l", parent: "b_head", translation: [-0.24, 0.06, -0.1] },
  { name: "b_hair_r", parent: "b_head", translation: [0.24, 0.06, -0.1] },
];
const BONE_INDEX = new Map(BONES.map((bone, index) => [bone.name, index]));

/** 世界坐标下的绑定位置（骨骼仅做平移）。 */
function worldBonePositions() {
  const positions = new Map();
  for (const bone of BONES) {
    const parent = bone.parent ? positions.get(bone.parent) : [0, 0, 0];
    positions.set(bone.name, [
      parent[0] + bone.translation[0],
      parent[1] + bone.translation[1],
      parent[2] + bone.translation[2],
    ]);
  }
  return positions;
}

const BONE_WORLD = worldBonePositions();

const SKIN = [0.98, 0.82, 0.72];
const HAIR = [0.92, 0.42, 0.62];
const HAIR_LIGHT = [0.97, 0.55, 0.72];
const JACKET = [0.16, 0.36, 0.78];
const SKIRT = [0.1, 0.16, 0.36];
const BOOT = [0.08, 0.08, 0.1];
const EYE = [0.06, 0.1, 0.26];

/**
 * 部件定义。bone 为 null 时由 skinWeightsFor 按高度混合髋/脊/胸。
 * 所有部件都是封闭椭球，合并后拓扑仍然流形（无边界边/非流形边）。
 */
const PARTS = [
  { part: "head", bone: "b_head", center: [0, 1.46, 0], radii: [0.23, 0.25, 0.22], lon: 44, lat: 22, color: SKIN },
  { part: "hair_back", bone: "b_head", center: [0, 1.51, -0.08], radii: [0.25, 0.26, 0.21], lon: 40, lat: 20, color: HAIR },
  { part: "hair_fringe", bone: "b_head", center: [0, 1.66, 0.09], radii: [0.23, 0.075, 0.1], lon: 24, lat: 12, color: HAIR_LIGHT },
  { part: "hair_tail_l", bone: "b_hair_l", center: [-0.3, 1.3, -0.1], radii: [0.09, 0.3, 0.09], lon: 16, lat: 12, color: HAIR },
  { part: "hair_tail_r", bone: "b_hair_r", center: [0.3, 1.3, -0.1], radii: [0.09, 0.3, 0.09], lon: 16, lat: 12, color: HAIR },
  { part: "eye_l", bone: "b_head", center: [-0.085, 1.48, 0.205], radii: [0.05, 0.07, 0.03], lon: 12, lat: 8, color: EYE },
  { part: "eye_r", bone: "b_head", center: [0.085, 1.48, 0.205], radii: [0.05, 0.07, 0.03], lon: 12, lat: 8, color: EYE },
  { part: "mouth", bone: "b_head", center: [0, 1.37, 0.208], radii: [0.035, 0.018, 0.018], lon: 10, lat: 6, color: [0.55, 0.22, 0.28] },
  { part: "neck", bone: "b_neck", center: [0, 1.34, 0], radii: [0.07, 0.08, 0.07], lon: 16, lat: 10, color: SKIN },
  { part: "torso", bone: null, center: [0, 1.08, 0], radii: [0.21, 0.26, 0.14], lon: 36, lat: 20, color: JACKET },
  { part: "skirt", bone: "b_hips", center: [0, 0.82, 0], radii: [0.24, 0.15, 0.17], lon: 28, lat: 14, color: SKIRT },
  { part: "arm_upper_l", bone: "b_upperarm_l", center: [-0.28, 1.14, 0], radii: [0.075, 0.22, 0.075], lon: 16, lat: 12, color: JACKET },
  { part: "arm_lower_l", bone: "b_lowerarm_l", center: [-0.28, 0.89, 0], radii: [0.055, 0.2, 0.055], lon: 16, lat: 12, color: SKIN },
  { part: "hand_l", bone: "b_hand_l", center: [-0.28, 0.7, 0], radii: [0.06, 0.07, 0.05], lon: 12, lat: 8, color: SKIN },
  { part: "arm_upper_r", bone: "b_upperarm_r", center: [0.28, 1.14, 0], radii: [0.075, 0.22, 0.075], lon: 16, lat: 12, color: JACKET },
  { part: "arm_lower_r", bone: "b_lowerarm_r", center: [0.28, 0.89, 0], radii: [0.055, 0.2, 0.055], lon: 16, lat: 12, color: SKIN },
  { part: "hand_r", bone: "b_hand_r", center: [0.28, 0.7, 0], radii: [0.06, 0.07, 0.05], lon: 12, lat: 8, color: SKIN },
  { part: "leg_upper_l", bone: "b_upperleg_l", center: [-0.11, 0.57, 0], radii: [0.085, 0.24, 0.085], lon: 18, lat: 12, color: SKIRT },
  { part: "leg_lower_l", bone: "b_lowerleg_l", center: [-0.11, 0.27, 0], radii: [0.07, 0.2, 0.07], lon: 16, lat: 12, color: EYE },
  { part: "foot_l", bone: "b_foot_l", center: [-0.11, 0.06, 0.04], radii: [0.08, 0.06, 0.12], lon: 16, lat: 10, color: BOOT },
  { part: "leg_upper_r", bone: "b_upperleg_r", center: [0.11, 0.57, 0], radii: [0.085, 0.24, 0.085], lon: 18, lat: 12, color: SKIRT },
  { part: "leg_lower_r", bone: "b_lowerleg_r", center: [0.11, 0.27, 0], radii: [0.07, 0.2, 0.07], lon: 16, lat: 12, color: EYE },
  { part: "foot_r", bone: "b_foot_r", center: [0.11, 0.06, 0.04], radii: [0.08, 0.06, 0.12], lon: 16, lat: 10, color: BOOT },
];

function createEllipsoid({ lon, lat, center, radii }) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const [cx, cy, cz] = center;
  const [rx, ry, rz] = radii;

  positions.push(cx, cy + ry, cz);
  normals.push(0, 1, 0);
  uvs.push(0.5, 1);

  for (let i = 1; i < lat; i += 1) {
    const theta = (Math.PI * i) / lat;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    for (let j = 0; j < lon; j += 1) {
      const phi = (TAU * j) / lon;
      const ux = sinTheta * Math.cos(phi);
      const uy = cosTheta;
      const uz = sinTheta * Math.sin(phi);
      positions.push(cx + rx * ux, cy + ry * uy, cz + rz * uz);
      const nx = ux / rx;
      const ny = uy / ry;
      const nz = uz / rz;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / length, ny / length, nz / length);
      uvs.push(j / lon, 1 - i / lat);
    }
  }

  const bottomIndex = positions.length / 3;
  positions.push(cx, cy - ry, cz);
  normals.push(0, -1, 0);
  uvs.push(0.5, 0);

  const ringStart = (i) => 1 + (i - 1) * lon;
  for (let j = 0; j < lon; j += 1) {
    const next = (j + 1) % lon;
    indices.push(0, ringStart(1) + next, ringStart(1) + j);
  }
  for (let i = 1; i < lat - 1; i += 1) {
    const upper = ringStart(i);
    const lower = ringStart(i + 1);
    for (let j = 0; j < lon; j += 1) {
      const next = (j + 1) % lon;
      const a = upper + j;
      const b = upper + next;
      const c = lower + next;
      const d = lower + j;
      indices.push(a, c, d, a, b, c);
    }
  }
  const lastRing = ringStart(lat - 1);
  for (let j = 0; j < lon; j += 1) {
    const next = (j + 1) % lon;
    indices.push(lastRing + j, lastRing + next, bottomIndex);
  }

  return {
    positions,
    normals,
    uvs,
    indices,
    vertexCount: positions.length / 3,
  };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function skinWeightsFor(part, y) {
  if (part.bone) {
    const index = BONE_INDEX.get(part.bone);
    return { joints: [index, 0, 0, 0], weights: [1, 0, 0, 0] };
  }

  // 躯干在髋 / 脊 / 胸之间按高度平滑过渡。
  const spineT = clamp01((y - 0.88) / 0.22);
  const chestT = clamp01((y - 1.08) / 0.18);
  const hips = 1 - spineT;
  const spine = spineT * (1 - chestT);
  const chest = spineT * chestT;
  const sum = hips + spine + chest || 1;
  return {
    joints: [
      BONE_INDEX.get("b_hips"),
      BONE_INDEX.get("b_spine"),
      BONE_INDEX.get("b_chest"),
      0,
    ],
    weights: [hips / sum, spine / sum, chest / sum, 0],
  };
}

/** 近白色柔光贴图：顶点色负责分区，贴图只提供低对比度布料纹理。 */
function buildTexture() {
  const rgba = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const diagonal = Math.sin(((x + y) / TEXTURE_SIZE) * Math.PI * 8);
      const dot = Math.sin((x / 16) * Math.PI) * Math.sin((y / 16) * Math.PI);
      let value = 236 + 12 * diagonal + 4 * dot;
      if ((x + y) % 96 < 2) {
        value -= 18;
      }
      const offset = (y * TEXTURE_SIZE + x) * 4;
      rgba[offset] = Math.max(0, Math.min(255, Math.round(value)));
      rgba[offset + 1] = Math.max(0, Math.min(255, Math.round(value * 0.99)));
      rgba[offset + 2] = Math.max(0, Math.min(255, Math.round(value)));
      rgba[offset + 3] = 255;
    }
  }
  return encodePng(TEXTURE_SIZE, TEXTURE_SIZE, rgba);
}

function quatFromAxisAngle(axis, angle) {
  const half = angle / 2;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function axisAngle(x, y, z, angle) {
  return quatFromAxisAngle([x, y, z], angle);
}

/**
 * 一段走/跑循环的姿态函数。
 * 返回 Map<boneName, quaternion> 与 hips 的 Y 位移。
 */
function buildPose(kind, t) {
  const phase = t * TAU;
  const walk = kind === "walk";
  const legSwing = walk ? 0.55 : 0.95;
  const armSwing = walk ? 0.45 : 0.8;
  const kneeBase = walk ? 0.22 : 0.5;
  const kneeSwing = walk ? 0.35 : 0.55;
  const bob = walk ? 0.018 : 0.045;
  const lean = walk ? 0.02 : 0.14;
  const sin = Math.sin(phase);
  const pose = new Map();

  pose.set("b_upperleg_l", axisAngle(1, 0, 0, sin * legSwing));
  pose.set("b_upperleg_r", axisAngle(1, 0, 0, -sin * legSwing));
  pose.set(
    "b_lowerleg_l",
    axisAngle(1, 0, 0, kneeBase + kneeSwing * Math.max(0, -sin)),
  );
  pose.set(
    "b_lowerleg_r",
    axisAngle(1, 0, 0, kneeBase + kneeSwing * Math.max(0, sin)),
  );
  pose.set("b_upperarm_l", axisAngle(1, 0, 0, -sin * armSwing));
  pose.set("b_upperarm_r", axisAngle(1, 0, 0, sin * armSwing));
  pose.set(
    "b_lowerarm_l",
    axisAngle(1, 0, 0, (walk ? 0.18 : 0.55) + 0.12 * Math.sin(phase + Math.PI / 2)),
  );
  pose.set(
    "b_lowerarm_r",
    axisAngle(1, 0, 0, (walk ? 0.18 : 0.55) + 0.12 * Math.sin(phase - Math.PI / 2)),
  );
  pose.set(
    "b_spine",
    quatMultiply(axisAngle(1, 0, 0, lean), axisAngle(0, 1, 0, sin * (walk ? 0.06 : 0.1))),
  );
  pose.set("b_chest", axisAngle(0, 1, 0, -sin * (walk ? 0.04 : 0.08)));
  pose.set("b_head", axisAngle(0, 1, 0, -sin * 0.03));
  pose.set(
    "b_hair_l",
    axisAngle(0, 0, 1, (walk ? 0.08 : 0.18) + 0.12 * Math.sin(phase + Math.PI / 3)),
  );
  pose.set(
    "b_hair_r",
    axisAngle(0, 0, 1, -(walk ? 0.08 : 0.18) - 0.12 * Math.sin(phase + Math.PI / 3)),
  );

  return { pose, bob: 0.82 + bob * Math.abs(Math.sin(phase * 2)) };
}

function addAccessor(doc, buffer, name, type, array, normalized = false) {
  const accessor = doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer);
  if (normalized) {
    accessor.setNormalized(true);
  }
  return accessor;
}

function addRotationChannel(doc, buffer, animation, boneNodes, boneName, times, poses, clipName) {
  const output = new Float32Array(times.length * 4);
  poses.forEach((pose, index) => {
    const rotation = pose.get(boneName) ?? [0, 0, 0, 1];
    output.set(rotation, index * 4);
  });
  const inputAccessor = addAccessor(
    doc,
    buffer,
    `attr_anime_placeholder_${clipName}_${boneName}_time`,
    "SCALAR",
    times,
  );
  const outputAccessor = addAccessor(
    doc,
    buffer,
    `attr_anime_placeholder_${clipName}_${boneName}_rotation`,
    "VEC4",
    output,
  );
  const sampler = doc
    .createAnimationSampler(`anim_anime_placeholder_${clipName}_${boneName}_sampler`)
    .setInput(inputAccessor)
    .setOutput(outputAccessor)
    .setInterpolation("LINEAR");
  animation
    .addSampler(sampler)
    .addChannel(
      doc
        .createAnimationChannel(`anim_anime_placeholder_${clipName}_${boneName}_channel`)
        .setSampler(sampler)
        .setTargetNode(boneNodes.get(boneName))
        .setTargetPath("rotation"),
    );
}

function addHipsBounceChannel(doc, buffer, animation, boneNodes, times, heights, clipName) {
  const output = new Float32Array(times.length * 3);
  heights.forEach((height, index) => {
    output.set([0, height, 0], index * 3);
  });
  const inputAccessor = addAccessor(
    doc,
    buffer,
    `attr_anime_placeholder_${clipName}_hips_time`,
    "SCALAR",
    times,
  );
  const outputAccessor = addAccessor(
    doc,
    buffer,
    `attr_anime_placeholder_${clipName}_hips_translation`,
    "VEC3",
    output,
  );
  const sampler = doc
    .createAnimationSampler(`anim_anime_placeholder_${clipName}_hips_sampler`)
    .setInput(inputAccessor)
    .setOutput(outputAccessor)
    .setInterpolation("LINEAR");
  animation
    .addSampler(sampler)
    .addChannel(
      doc
        .createAnimationChannel(`anim_anime_placeholder_${clipName}_hips_channel`)
        .setSampler(sampler)
        .setTargetNode(boneNodes.get("b_hips"))
        .setTargetPath("translation"),
    );
}

function buildClip(doc, buffer, boneNodes, kind, frameCount) {
  const clipName = kind;
  const animation = doc.createAnimation(`anim_anime_placeholder_${clipName}`);
  const duration = kind === "walk" ? 1.0 : 0.72;
  const times = new Float32Array(frameCount + 1);
  const poses = [];
  const heights = [];
  for (let frame = 0; frame <= frameCount; frame += 1) {
    const t = frame / frameCount;
    times[frame] = t * duration;
    const { pose, bob } = buildPose(kind, t);
    poses.push(pose);
    heights.push(bob);
  }

  const animatedBones = [
    "b_upperleg_l",
    "b_upperleg_r",
    "b_lowerleg_l",
    "b_lowerleg_r",
    "b_upperarm_l",
    "b_upperarm_r",
    "b_lowerarm_l",
    "b_lowerarm_r",
    "b_spine",
    "b_chest",
    "b_head",
    "b_hair_l",
    "b_hair_r",
  ];
  for (const boneName of animatedBones) {
    addRotationChannel(doc, buffer, animation, boneNodes, boneName, times, poses, clipName);
  }
  addHipsBounceChannel(doc, buffer, animation, boneNodes, times, heights, clipName);
  return animation;
}

async function main() {
  const outputPath = resolve(
    process.argv[2] ?? "assets/character_anime_placeholder.glb",
  );

  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const joints = [];
  const weights = [];
  const morphPositions = [];

  for (const part of PARTS) {
    const geometry = createEllipsoid(part);
    const vertexOffset = positions.length / 3;
    for (let i = 0; i < geometry.vertexCount; i += 1) {
      const x = geometry.positions[i * 3];
      const y = geometry.positions[i * 3 + 1];
      const z = geometry.positions[i * 3 + 2];
      positions.push(x, y, z);
      normals.push(
        geometry.normals[i * 3],
        geometry.normals[i * 3 + 1],
        geometry.normals[i * 3 + 2],
      );
      uvs.push(geometry.uvs[i * 2], geometry.uvs[i * 2 + 1]);
      colors.push(
        Math.round(part.color[0] * 255),
        Math.round(part.color[1] * 255),
        Math.round(part.color[2] * 255),
        255,
      );

      const skin = skinWeightsFor(part, y);
      joints.push(...skin.joints);
      weights.push(...skin.weights);

      // blink morph：glTF 的 morph POSITION 是相对 base 的 delta（loader 会加回 base），
      // 因此眼睛顶点写 target - base；其余顶点 delta 必须为 0，否则会被平移。
      if (part.part.startsWith("eye_")) {
        const centerY = part.center[1];
        const targetY = centerY + (y - centerY) * 0.12;
        morphPositions.push(0, targetY - y, -0.004);
      } else {
        morphPositions.push(0, 0, 0);
      }
    }
    for (const index of geometry.indices) {
      indices.push(index + vertexOffset);
    }
  }

  const doc = new Document();
  const buffer = doc.createBuffer();

  const positionAccessor = addAccessor(
    doc,
    buffer,
    "attr_anime_placeholder_position",
    "VEC3",
    new Float32Array(positions),
  );
  const normalAccessor = addAccessor(
    doc,
    buffer,
    "attr_anime_placeholder_normal",
    "VEC3",
    new Float32Array(normals),
  );
  const uvAccessor = addAccessor(
    doc,
    buffer,
    "attr_anime_placeholder_texcoord",
    "VEC2",
    new Float32Array(uvs),
  );
  const colorAccessor = addAccessor(
    doc,
    buffer,
    "attr_anime_placeholder_color",
    "VEC4",
    new Uint8Array(colors),
    true,
  );
  const jointAccessor = addAccessor(
    doc,
    buffer,
    "attr_anime_placeholder_joints",
    "VEC4",
    new Uint16Array(joints),
  );
  const weightAccessor = addAccessor(
    doc,
    buffer,
    "attr_anime_placeholder_weights",
    "VEC4",
    new Float32Array(weights),
  );
  const indexAccessor = addAccessor(
    doc,
    buffer,
    "attr_anime_placeholder_indices",
    "SCALAR",
    new Uint16Array(indices),
  );
  const morphAccessor = addAccessor(
    doc,
    buffer,
    "attr_anime_placeholder_morph_blink",
    "VEC3",
    new Float32Array(morphPositions),
  );

  const png = buildTexture();
  const texture = doc
    .createTexture("texture_anime_placeholder_base")
    .setImage(png)
    .setMimeType("image/png");

  const material = doc
    .createMaterial("material_anime_placeholder")
    .setBaseColorTexture(texture)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.9);
  material
    .getBaseColorTextureInfo()
    .setMagFilter(9729)
    .setMinFilter(9987)
    .setWrapS(10497)
    .setWrapT(10497);

  const primitive = doc
    .createPrimitive("primitive_anime_placeholder_body")
    .setAttribute("POSITION", positionAccessor)
    .setAttribute("NORMAL", normalAccessor)
    .setAttribute("TEXCOORD_0", uvAccessor)
    .setAttribute("COLOR_0", colorAccessor)
    .setAttribute("JOINTS_0", jointAccessor)
    .setAttribute("WEIGHTS_0", weightAccessor)
    .setIndices(indexAccessor)
    .setMaterial(material)
    .addTarget(
      doc
        .createPrimitiveTarget("morph_anime_placeholder_blink")
        .setAttribute("POSITION", morphAccessor),
    );

  const mesh = doc
    .createMesh("character_anime_placeholder_lod0")
    .addPrimitive(primitive);

  const boneNodes = new Map();
  for (const bone of BONES) {
    const node = doc.createNode(bone.name).setTranslation(bone.translation);
    boneNodes.set(bone.name, node);
    if (bone.parent) {
      boneNodes.get(bone.parent).addChild(node);
    }
  }

  const skin = doc
    .createSkin("skin_anime_placeholder")
    .setSkeleton(boneNodes.get("b_root"))
    .setInverseBindMatrices(
      addAccessor(
        doc,
        buffer,
        "attr_anime_placeholder_inverse_bind",
        "MAT4",
        new Float32Array(
          BONES.flatMap((bone) => {
            const [x, y, z] = BONE_WORLD.get(bone.name);
            return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1];
          }),
        ),
      ),
    );
  for (const bone of BONES) {
    skin.addJoint(boneNodes.get(bone.name));
  }

  const meshNode = doc
    .createNode("character_anime_placeholder_lod0")
    .setMesh(mesh)
    .setSkin(skin);

  buildClip(doc, buffer, boneNodes, "walk", WALK_FRAMES);
  buildClip(doc, buffer, boneNodes, "run", RUN_FRAMES);

  const scene = doc.createScene("scene_anime_placeholder");
  scene.addChild(meshNode);
  scene.addChild(boneNodes.get("b_root"));
  doc.getRoot().setDefaultScene(scene);

  const io = new NodeIO().registerExtensions([
    KHRDracoMeshCompression,
    EXTMeshoptCompression,
  ]);
  await mkdir(dirname(outputPath), { recursive: true });
  const glb = await io.writeBinary(doc);
  await writeFile(outputPath, glb);

  console.log(
    `[build-anime-asset] ${outputPath} · ${indices.length / 3} tris · ` +
      `${positions.length / 3} verts · ${BONES.length} bones · ` +
      `${(glb.byteLength / 1024).toFixed(1)} KiB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
