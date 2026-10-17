#!/usr/bin/env node
/**
 * 动画重定向：Mixamo/UE rig 动画 → 目标角色骨骼（票 30）。
 *
 * 背景
 * ----
 * 本项目要 walk / run / attack 三个动作。Mixamo（Adobe）下载动画需要账号登录，
 * 但 Mixamo 的 rig 命名规范（`mixamorig:Hips`）与 UE mannequin 命名都是公开
 * 标准，大量 CC0 动画资产直接使用：
 *   - three.js Soldier.glb（CC0，Mixamo rig：Walk/Run/Idle/TPose）
 *   - Quaternius Universal Animation Library（CC0，UE rig：Walk_Loop /
 *     Jog_Fwd_Loop / Sword_Attack 等 43 个动作）
 *
 * 纯「改名拷贝轨道」只在两套骨架 rest 姿态一致时成立。Mixamo rest = T-pose，
 * UE rig rest = A-pose，VRM humanoid rest = T-pose——因此本工具做数学重定向：
 *
 *   1. extract：从源 GLB 取指定动画 + 采样 TPose 动画首帧作为源 rest 姿态
 *      （无 TPose 时退回节点静态 rotation），连同动画数据输出轻量 GLB
 *      （rest 姿态存进 extras.retargetRestPose）。
 *   2. retarget：源骨骼 → VRM humanoid 角色（role）→ 目标节点；
 *      对每帧旋转做 rest 修正 q' = qRestT ⊗ qRestS⁻¹ ⊗ q
 *      （把「相对源 rest 的旋转增量」应用到目标 rest 上）；
 *      hips 平移按骨架高度比缩放；其余平移/缩放轨道丢弃（防滑步/防形变）。
 *
 * 骨骼映射：`--map vrm`（推荐）读目标 VRM 的 humanoid map
 *   （VRM 1.0 `VRMC_vrm.humanoid.humanBones` / 0.x `VRM.humanoid`），
 *   按标准角色名（hips / leftUpperArm / ...）对齐，与节点命名无关。
 *   `--map project` 按本项目 P0/P1 占位骨架的 b_ 名字映射。
 *
 * 用法：
 *   node tools/pipeline/retarget-animations.mjs extract \
 *     --source <anim.glb> --names Walk_Loop,Jog_Fwd_Loop --out anims.glb
 *   node tools/pipeline/retarget-animations.mjs retarget \
 *     --source anims.glb --target character.vrm --map vrm --out out.glb
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

// ------------------------------------------------------------------ 数学

export function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quatInvert(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

function quatNormalize(q) {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (length === 0) return [0, 0, 0, 1];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

export { quatInvert, quatNormalize };

/** glTF type 字段 → 分量数。 */
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// ------------------------------------------------------------------ 骨骼映射

/** 源骨骼名（小写、去前缀）→ VRM humanoid 角色。 */
const SOURCE_BONE_TO_VRM_ROLE = {
  // Mixamo（mixamorig: 前缀去除后）
  hips: "hips",
  spine: "spine",
  spine1: "chest",
  spine2: "upperChest",
  neck: "neck",
  head: "head",
  leftshoulder: "leftShoulder",
  leftarm: "leftUpperArm",
  leftforearm: "leftLowerArm",
  lefthand: "leftHand",
  leftupleg: "leftUpperLeg",
  leftleg: "leftLowerLeg",
  leftfoot: "leftFoot",
  lefttoebase: "leftToes",
  rightshoulder: "rightShoulder",
  rightarm: "rightUpperArm",
  rightforearm: "rightLowerArm",
  righthand: "rightHand",
  rightupleg: "rightUpperLeg",
  rightleg: "rightLowerLeg",
  rightfoot: "rightFoot",
  righttoebase: "rightToes",
  // UE mannequin（Quaternius UAL / Unreal / Godot 导出惯例）
  pelvis: "hips",
  spine_01: "spine",
  spine_02: "chest",
  spine_03: "upperChest",
  neck_01: "neck",
  clavicle_l: "leftShoulder",
  upperarm_l: "leftUpperArm",
  lowerarm_l: "leftLowerArm",
  hand_l: "leftHand",
  thigh_l: "leftUpperLeg",
  calf_l: "leftLowerLeg",
  foot_l: "leftFoot",
  ball_l: "leftToes",
  toe_l: "leftToes",
  clavicle_r: "rightShoulder",
  upperarm_r: "rightUpperArm",
  lowerarm_r: "rightLowerArm",
  hand_r: "rightHand",
  thigh_r: "rightUpperLeg",
  calf_r: "rightLowerLeg",
  foot_r: "rightFoot",
  ball_r: "rightToes",
  toe_r: "rightToes",
};

/** 本项目 P0/P1 占位骨架（b_ 前缀，见 character-proto.ts）的名字映射。 */
const MIXAMO_TO_PROJECT = {
  Hips: "b_hips",
  Spine: "b_spine",
  Spine1: "b_chest",
  Spine2: "b_chest",
  Neck: "b_neck",
  Head: "b_head",
  LeftShoulder: "b_shoulder_l",
  LeftArm: "b_upperarm_l",
  LeftForeArm: "b_lowerarm_l",
  LeftHand: "b_hand_l",
  RightShoulder: "b_shoulder_r",
  RightArm: "b_upperarm_r",
  RightForeArm: "b_lowerarm_r",
  RightHand: "b_hand_r",
  LeftUpLeg: "b_upperleg_l",
  LeftLeg: "b_lowerleg_l",
  LeftFoot: "b_foot_l",
  RightUpLeg: "b_upperleg_r",
  RightLeg: "b_lowerleg_r",
  RightFoot: "b_foot_r",
  LeftToeBase: "b_foot_l",
  RightToeBase: "b_foot_r",
};

/** 从目标 GLB JSON 读 VRM humanoid 角色 → node 索引映射（1.0 与 0.x 都支持）。 */
export function readVrmHumanoidMap(targetJson) {
  const vrm1 = targetJson.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (vrm1 && typeof vrm1 === "object") {
    const map = new Map();
    for (const [role, entry] of Object.entries(vrm1)) {
      if (entry && typeof entry.node === "number") map.set(role, entry.node);
    }
    if (map.size > 0) return map;
  }
  const vrm0 = targetJson.extensions?.VRM?.humanoid?.humanBones;
  if (Array.isArray(vrm0)) {
    const map = new Map();
    for (const entry of vrm0) {
      if (entry?.bone && typeof entry.node === "number") map.set(entry.bone, entry.node);
    }
    if (map.size > 0) return map;
  }
  return null;
}

/** 动画名规范化：与 character-visuals.ts 的 /walk/i、/run/i 匹配约定一致。 */
export function normalizeAnimationName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ------------------------------------------------------------------ GLB 容器

export function parseGlb(buffer) {
  if (buffer.byteLength < 12) {
    throw new Error("文件过小，不是 GLB 容器");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error("不是 GLB 容器（magic 不匹配）");
  }
  if (view.getUint32(4, true) !== 2) {
    throw new Error("不支持的 GLB 版本（仅支持 2）");
  }
  const totalLength = view.getUint32(8, true);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, chunkLength);
    offset += chunkLength;
    if (chunkType === CHUNK_JSON && json === null) {
      json = JSON.parse(new TextDecoder().decode(chunk).replace(/\u0000+$/g, "").trim());
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = chunk.slice();
    }
  }
  if (!json) {
    throw new Error("GLB 缺少 JSON 块");
  }
  return { json, bin };
}

export function writeGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonPadded = new Uint8Array(jsonBytes.byteLength + jsonPad);
  jsonPadded.fill(0x20);
  jsonPadded.set(jsonBytes);

  const binPad = bin ? (4 - (bin.byteLength % 4)) % 4 : 0;
  const binPadded = bin ? new Uint8Array(bin.byteLength + binPad) : null;
  if (binPadded) {
    binPadded.set(bin);
  }

  const total = 12 + 8 + jsonPadded.byteLength + (binPadded ? 8 + binPadded.byteLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = 12;
  view.setUint32(offset, jsonPadded.byteLength, true);
  view.setUint32(offset + 4, CHUNK_JSON, true);
  offset += 8;
  out.set(jsonPadded, offset);
  offset += jsonPadded.byteLength;
  if (binPadded) {
    view.setUint32(offset, binPadded.byteLength, true);
    view.setUint32(offset + 4, CHUNK_BIN, true);
    offset += 8;
    out.set(binPadded, offset);
  }
  return out;
}

/** 取 bufferView 覆盖的字节（只支持内嵌 buffer，即 GLB）。 */
function bufferViewBytes(json, bin, view) {
  const buffer = json.buffers?.[view.buffer ?? 0];
  if (buffer?.uri) {
    throw new Error("外部 buffer 的 GLB 暂不支持（请先内嵌为 GLB）");
  }
  const start = view.byteOffset ?? 0;
  return bin.subarray(start, start + view.byteLength);
}

/** 读 accessor 的全部数据（float32 假定；动画采样器均为 FLOAT）。 */
function readAccessorFloats(json, bin, accessor) {
  if (accessor.componentType !== 5126) {
    throw new Error(
      `accessor componentType ${accessor.componentType} 非 FLOAT（5126），本工具只处理动画采样数据`,
    );
  }
  const components = TYPE_COMPONENTS[accessor.type] ?? 1;
  if (accessor.bufferView === undefined) {
    return new Float32Array(accessor.count * components);
  }
  const view = json.bufferViews[accessor.bufferView];
  const bytes = bufferViewBytes(json, bin, view);
  const stride = view.byteStride ?? components * 4;
  const out = new Float32Array(accessor.count * components);
  if (stride === components * 4) {
    // 紧凑排列：直接按 accessor.byteOffset 偏移读取
    const start = accessor.byteOffset ?? 0;
    out.set(new Float32Array(bytes.buffer, bytes.byteOffset + start, accessor.count * components));
  } else {
    // 交错排列：逐元素读取
    for (let index = 0; index < accessor.count; index += 1) {
      const elementStart = (accessor.byteOffset ?? 0) + index * stride;
      const f32 = new Float32Array(
        bytes.buffer,
        bytes.byteOffset + elementStart,
        components,
      );
      out.set(f32, index * components);
    }
  }
  return out;
}

// ------------------------------------------------------------------ extract

/** 源动画名里识别 TPose（用于采样源 rest 姿态）。 */
const TPOSE_PATTERN = /^(a_)?t[-_]?pose$/i;

/**
 * 从源 GLB 提取动画：保留骨骼层级（含祖先链）与指定动画 + TPose，
 * 丢掉网格/材质/贴图；同时采样 TPose 首帧作为源 rest 姿态存入
 * extras.retargetRestPose（retarget 阶段做 rest 修正用）。
 */
export function extractAnimations(sourceBuffer, names, renameMap = {}) {
  const { json, bin } = parseGlb(sourceBuffer);
  const wanted = new Set(names.map((name) => normalizeAnimationName(renameMap[name] ?? name)));

  const skin = json.skins?.[0] ?? null;
  if (!skin) {
    throw new Error("源 GLB 没有 skin（无法确定骨骼集合）");
  }

  // 用 children 反查父节点（glTF 没有 parentIndex 字段）。
  const parentOf = new Array(json.nodes.length).fill(undefined);
  json.nodes.forEach((node, index) => {
    for (const child of node.children ?? []) {
      parentOf[child] = index;
    }
  });
  // 骨骼及其祖先链都要保留，否则层级会断。
  const keepNodes = new Set();
  for (const joint of skin.joints) {
    let current = joint;
    while (current !== undefined && !keepNodes.has(current)) {
      keepNodes.add(current);
      current = parentOf[current];
    }
  }

  const allAnimations = json.animations ?? [];
  const selected = allAnimations.filter((anim) => {
    const normalized = normalizeAnimationName(renameMap[anim.name] ?? anim.name);
    return wanted.has(normalized) || TPOSE_PATTERN.test(anim.name);
  });
  if (selected.filter((anim) => !TPOSE_PATTERN.test(anim.name)).length === 0) {
    throw new Error(
      `源 GLB 中没有名为 ${[...wanted].join(", ")} 的动画；` +
        `现有：${allAnimations.map((a) => a.name).join(", ") || "(无)"}`,
    );
  }

  // ---- node 重映射
  const kept = [...keepNodes].sort((a, b) => a - b);
  const nodeRemap = new Map(kept.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const nodes = kept.map((oldIndex) => {
    const node = json.nodes[oldIndex];
    const copy = { name: node.name };
    if (node.children) {
      const children = node.children
        .filter((child) => nodeRemap.has(child))
        .map((child) => nodeRemap.get(child));
      if (children.length > 0) copy.children = children;
    }
    if (node.translation) copy.translation = node.translation;
    if (node.rotation) copy.rotation = node.rotation;
    if (node.scale) copy.scale = node.scale;
    return copy;
  });
  const roots = kept
    .filter((oldIndex) => parentOf[oldIndex] === undefined)
    .map((oldIndex) => nodeRemap.get(oldIndex));

  // ---- accessor / bufferView 收集与字节复制（4 字节对齐）
  const accessorIndices = new Set();
  for (const anim of selected) {
    for (const sampler of anim.samplers) {
      accessorIndices.add(sampler.input);
      accessorIndices.add(sampler.output);
    }
  }
  const sortedAccessors = [...accessorIndices].sort((a, b) => a - b);
  const accessorRemap = new Map(
    sortedAccessors.map((oldIndex, newIndex) => [oldIndex, newIndex]),
  );

  const viewIndices = new Set();
  for (const index of sortedAccessors) {
    const accessor = json.accessors[index];
    if (accessor.bufferView !== undefined) viewIndices.add(accessor.bufferView);
  }
  const sortedViews = [...viewIndices].sort((a, b) => a - b);
  const viewRemap = new Map(sortedViews.map((oldIndex, newIndex) => [oldIndex, newIndex]));

  const sourceBin = bin ?? new Uint8Array(0);
  const parts = [];
  let cursor = 0;
  const bufferViews = sortedViews.map((oldIndex) => {
    const view = json.bufferViews[oldIndex];
    const bytes = bufferViewBytes(json, sourceBin, view);
    const pad = (4 - (cursor % 4)) % 4;
    if (pad > 0) {
      parts.push(new Uint8Array(pad));
      cursor += pad;
    }
    const copy = { buffer: 0, byteOffset: cursor, byteLength: view.byteLength };
    if (view.byteStride !== undefined) copy.byteStride = view.byteStride;
    if (view.target !== undefined) copy.target = view.target;
    parts.push(bytes);
    cursor += view.byteLength;
    return copy;
  });
  const newBin = new Uint8Array(cursor);
  let writeCursor = 0;
  for (const part of parts) {
    newBin.set(part, writeCursor);
    writeCursor += part.byteLength;
  }

  const accessors = sortedAccessors.map((oldIndex) => {
    const accessor = json.accessors[oldIndex];
    const copy = { ...accessor };
    if (accessor.bufferView !== undefined) {
      copy.bufferView = viewRemap.get(accessor.bufferView);
    } else {
      delete copy.bufferView;
    }
    copy.byteOffset = accessor.byteOffset ?? 0;
    return copy;
  });

  const animations = selected.map((anim) => {
    const channels = [];
    for (const channel of anim.channels) {
      const mappedNode = nodeRemap.get(channel.target.node);
      if (mappedNode === undefined) {
        continue; // 轨道指向非骨骼节点，丢弃
      }
      channels.push({
        sampler: channel.sampler,
        target: { node: mappedNode, path: channel.target.path },
      });
    }
    return {
      name: normalizeAnimationName(renameMap[anim.name] ?? anim.name),
      channels,
      samplers: anim.samplers.map((sampler) => ({
        input: accessorRemap.get(sampler.input),
        output: accessorRemap.get(sampler.output),
        interpolation: sampler.interpolation ?? "LINEAR",
      })),
    };
  });

  // ---- 源 rest 姿态采样（TPose 首帧；无 TPose 用节点静态 rotation）
  const tpose = animations.find((anim) => TPOSE_PATTERN.test(anim.name));
  const restPose = {};
  if (tpose) {
    // 同一节点可同时有 translation 与 rotation 通道，按「节点:路径」去重。
    const sampledKeys = new Set();
    for (const channel of tpose.channels) {
      const nodeName = nodes[channel.target.node]?.name ?? "";
      const key = `${nodeName}:${channel.target.path}`;
      if (sampledKeys.has(key)) continue;
      const sampler = tpose.samplers[channel.sampler];
      if (sampler === undefined) continue;
      const accessor = accessors[sampler.output];
      const floats = readAccessorFloats(
        { bufferViews, accessors },
        newBin,
        accessor,
      );
      if (channel.target.path === "rotation" && floats.length >= 4) {
        (restPose[nodeName] ??= {}).rotation = [floats[0], floats[1], floats[2], floats[3]];
        sampledKeys.add(key);
      } else if (channel.target.path === "translation" && floats.length >= 3) {
        (restPose[nodeName] ??= {}).translation = [floats[0], floats[1], floats[2]];
        sampledKeys.add(key);
      }
    }
  }

  const outJson = {
    asset: json.asset,
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: newBin.byteLength }],
    animations,
    extras: { retargetRestPose: restPose },
  };

  const stats = {
    sourceNodes: json.nodes.length,
    keptNodes: nodes.length,
    animations: animations.map((a) => a.name),
    channels: animations.reduce((sum, a) => sum + a.channels.length, 0),
    accessors: accessors.length,
    bufferViews: bufferViews.length,
    restPoseBones: Object.keys(restPose).length,
  };
  return { glb: writeGlb(outJson, newBin), stats, json: outJson };
}

// ------------------------------------------------------------------ retarget

/**
 * 把动画 GLB 合并进目标角色 GLB：
 * - 源骨骼 → role（`--map vrm`，读目标 humanoid map）或按名字（project）；
 * - 旋转轨道做 rest 修正：q' = qRestT ⊗ qRestS⁻¹ ⊗ q；
 * - hips 平移按骨架高度比缩放；其余平移/缩放轨道丢弃；
 * - 目标已有同名动画时被新动画覆盖。
 */
export function retargetAnimations(sourceBuffer, targetBuffer, mapName) {
  const source = parseGlb(sourceBuffer);
  const target = parseGlb(targetBuffer);
  const sourceJson = source.json;
  const targetJson = target.json;
  const sourceBin = source.bin ?? new Uint8Array(0);

  // ---- 解析映射方案：vrm（humanoid map）或按名字（project）
  let resolveTargetNode = null;
  let hipsTargetNode = -1;
  if (mapName === "vrm") {
    const roleMap = readVrmHumanoidMap(targetJson);
    if (!roleMap) {
      throw new Error(
        "目标 GLB 没有 VRM humanoid map（既无 VRMC_vrm 也无 VRM 扩展）；" +
          "VRM 角色请用 --map vrm，非 VRM 骨架请用 --map project",
      );
    }
    const nodes = targetJson.nodes ?? [];
    hipsTargetNode = roleMap.get("hips") ?? -1;
    resolveTargetNode = (sourceNodeName) => {
      const normalized = sourceNodeName.replace(/^mixamorig:/, "").toLowerCase();
      const role = SOURCE_BONE_TO_VRM_ROLE[normalized];
      if (!role) return { index: -1, label: sourceNodeName, role: null };
      const nodeIndex = roleMap.get(role);
      if (nodeIndex === undefined || !nodes[nodeIndex]) {
        return { index: -1, label: `${sourceNodeName}→role:${role}`, role };
      }
      return { index: nodeIndex, label: `${sourceNodeName}→${role}(${nodes[nodeIndex].name})`, role };
    };
  } else if (mapName === "project") {
    const nodes = targetJson.nodes ?? [];
    resolveTargetNode = (sourceNodeName) => {
      const stripped = sourceNodeName.replace(/^mixamorig:/, "");
      const mapped = MIXAMO_TO_PROJECT[stripped];
      if (!mapped) return { index: -1, label: sourceNodeName, role: null };
      const index = nodes.findIndex((n) => n.name === mapped);
      if (index < 0) return { index: -1, label: `${sourceNodeName}→${mapped}`, role: null };
      if (mapped === "b_hips") hipsTargetNode = index;
      return { index, label: `${sourceNodeName}→${mapped}`, role: null };
    };
  } else {
    throw new Error(`未知映射方案 ${mapName}；可用：vrm, project`);
  }

  // ---- 源 rest 姿态（extract 存在 extras.retargetRestPose；退回节点静态值）
  const sourceRest = new Map(); // 源 node 索引 -> { rotation, translation }
  const embeddedRest = sourceJson.extras?.retargetRestPose ?? {};
  const nameToSourceIndex = new Map(
    (sourceJson.nodes ?? []).map((node, index) => [node.name, index]),
  );
  for (const [name, rest] of Object.entries(embeddedRest)) {
    const index = nameToSourceIndex.get(name);
    if (index !== undefined) sourceRest.set(index, rest);
  }
  for (const [index, node] of (sourceJson.nodes ?? []).entries()) {
    if (!sourceRest.has(index)) {
      sourceRest.set(index, {
        rotation: node.rotation ?? [0, 0, 0, 1],
        translation: node.translation ?? [0, 0, 0],
      });
    }
  }

  // ---- hips 高度比（源 rest vs 目标 rest）
  let hipsScale = 1;
  if (hipsTargetNode >= 0) {
    const targetHips = (targetJson.nodes ?? [])[hipsTargetNode];
    let sourceHipsTranslation = null;
    for (const [index, rest] of sourceRest.entries()) {
      const nodeName = sourceJson.nodes[index]?.name ?? "";
      const normalized = nodeName.replace(/^mixamorig:/, "").toLowerCase();
      if (SOURCE_BONE_TO_VRM_ROLE[normalized] === "hips" && rest.translation) {
        sourceHipsTranslation = rest.translation;
        break;
      }
    }
    if (targetHips?.translation && sourceHipsTranslation) {
      const targetLength = Math.hypot(...targetHips.translation);
      const sourceLength = Math.hypot(...sourceHipsTranslation);
      if (sourceLength > 1e-6) {
        hipsScale = targetLength / sourceLength;
      }
    }
  }

  // ---- 目标 rest 旋转
  const targetNodes = targetJson.nodes ?? [];
  const targetRestOf = (nodeIndex) =>
    quatNormalize(targetNodes[nodeIndex]?.rotation ?? [0, 0, 0, 1]);

  const animations = [];
  const dropped = new Set();
  const renamed = [];
  const skippedTranslationBones = new Set();

  // 新 bufferViews（每个保留的 accessor 单独成 view，旋转输出在拷贝时重写）
  const targetBin = target.bin ?? new Uint8Array(0);
  const viewOffset = (targetJson.bufferViews ?? []).length;
  const accessorOffset = (targetJson.accessors ?? []).length;
  const appendedViews = [];
  const appendedAccessors = [];
  const parts = [];
  let binCursor = targetBin.byteLength;
  parts.push(targetBin);

  const appendAccessor = (accessor, transformFloats) => {
    const view = sourceJson.bufferViews[accessor.bufferView];
    const bytes = bufferViewBytes(sourceJson, sourceBin, view);
    const components = TYPE_COMPONENTS[accessor.type] ?? 1;
    let outputBytes = bytes;
    if (transformFloats) {
      const floats = readAccessorFloats(sourceJson, sourceBin, accessor);
      transformFloats(floats, components);
      outputBytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
    }
    const pad = (4 - (binCursor % 4)) % 4;
    if (pad > 0) {
      parts.push(new Uint8Array(pad));
      binCursor += pad;
    }
    parts.push(outputBytes);
    appendedViews.push({
      buffer: 0,
      byteOffset: binCursor,
      byteLength: outputBytes.byteLength,
    });
    const newAccessor = {
      componentType: accessor.componentType,
      count: accessor.count,
      type: accessor.type,
      // 追加 view 在输出里的索引 = 目标既有 view 数 + 追加序号。
      bufferView: viewOffset + appendedViews.length - 1,
      byteOffset: 0,
    };
    appendedAccessors.push(newAccessor);
    binCursor += outputBytes.byteLength;
    return appendedAccessors.length - 1;
  };

  for (const anim of sourceJson.animations ?? []) {
    if (TPOSE_PATTERN.test(anim.name)) {
      continue; // TPose 只用于 rest 采样，不进最终角色
    }
    const channels = [];
    const samplers = [];
    for (const channel of anim.channels) {
      const sourceNode = sourceJson.nodes[channel.target.node] ?? {};
      const { index: targetIndex, label, role } = resolveTargetNode(sourceNode.name ?? "");
      if (targetIndex < 0) {
        dropped.add(label);
        continue;
      }
      renamed.push(label);

      if (channel.target.path === "scale") {
        continue; // 目标骨架保持自己的骨长/缩放
      }
      if (channel.target.path === "translation") {
        const normalized = (sourceNode.name ?? "").replace(/^mixamorig:/, "").toLowerCase();
        const isHips = role === "hips" || normalized === "hips" || normalized === "pelvis";
        if (!isHips) {
          skippedTranslationBones.add(sourceNode.name ?? "");
          continue; // 非根平移拷贝会破坏骨长
        }
        const sampler = anim.samplers[channel.sampler];
        const inIndex =
          appendAccessor(sourceJson.accessors[sampler.input], null) + accessorOffset;
        const outIndex =
          appendAccessor(sourceJson.accessors[sampler.output], (floats) => {
            for (let offset = 0; offset < floats.length; offset += 3) {
              floats[offset] *= hipsScale;
              floats[offset + 1] *= hipsScale;
              floats[offset + 2] *= hipsScale;
            }
          }) + accessorOffset;
        channels.push({
          sampler: samplers.length,
          target: { node: targetIndex, path: "translation" },
        });
        samplers.push({ input: inIndex, output: outIndex, interpolation: sampler.interpolation ?? "LINEAR" });
        continue;
      }

      // rotation：rest 修正
      const sampler = anim.samplers[channel.sampler];
      const sourceRestRotation = quatNormalize(
        sourceRest.get(channel.target.node)?.rotation ?? [0, 0, 0, 1],
      );
      const correction = quatMultiply(
        targetRestOf(targetIndex),
        quatInvert(sourceRestRotation),
      );
      const inIndex =
        appendAccessor(sourceJson.accessors[sampler.input], null) + accessorOffset;
      const outIndex =
        appendAccessor(sourceJson.accessors[sampler.output], (floats) => {
          for (let offset = 0; offset + 3 < floats.length; offset += 4) {
            const corrected = quatNormalize(
              quatMultiply(correction, [floats[offset], floats[offset + 1], floats[offset + 2], floats[offset + 3]]),
            );
            floats[offset] = corrected[0];
            floats[offset + 1] = corrected[1];
            floats[offset + 2] = corrected[2];
            floats[offset + 3] = corrected[3];
          }
        }) + accessorOffset;
      channels.push({
        sampler: samplers.length,
        target: { node: targetIndex, path: "rotation" },
      });
      samplers.push({ input: inIndex, output: outIndex, interpolation: sampler.interpolation ?? "LINEAR" });
    }
    if (channels.length === 0) {
      continue;
    }
    animations.push({
      name: normalizeAnimationName(anim.name),
      channels,
      samplers,
    });
  }

  if (animations.length === 0) {
    throw new Error("重定向后没有剩余动画轨道（映射表与目标骨架完全不匹配）");
  }

  // ---- 组装输出
  const newBin = new Uint8Array(binCursor);
  let cursor = 0;
  for (const part of parts) {
    newBin.set(part, cursor);
    cursor += part.byteLength;
  }

  const outJson = {
    ...targetJson,
    accessors: [...(targetJson.accessors ?? []), ...appendedAccessors],
    bufferViews: [...(targetJson.bufferViews ?? []), ...appendedViews],
    animations: [
      ...(targetJson.animations ?? []).filter(
        (existing) => !animations.some((added) => added.name === existing.name),
      ),
      ...animations,
    ],
  };
  if (targetJson.buffers?.[0]) {
    outJson.buffers = [{ ...targetJson.buffers[0], byteLength: newBin.byteLength }];
  }

  const stats = {
    targetNodes: targetNodes.length,
    addedAnimations: animations.map((a) => ({ name: a.name, channels: a.channels.length })),
    mappedBones: [...new Set(renamed)],
    droppedBones: [...dropped],
    skippedTranslationBones: [...skippedTranslationBones],
    hipsScale,
    appendedAccessors: appendedAccessors.length,
    outputBytes: null,
  };
  const glb = writeGlb(outJson, newBin);
  stats.outputBytes = glb.byteLength;
  return { glb, stats };
}

// ------------------------------------------------------------------ CLI

function parseCli(argv) {
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
  const [command, ...rest] = process.argv.slice(2);
  const args = parseCli(rest);

  if (command === "extract") {
    const source = await readFile(resolve(args.source));
    const names = String(args.names ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) {
      throw new Error("extract 需要 --names Walk,Run,...");
    }
    const renameMap = args.rename ? JSON.parse(args.rename) : {};
    const { glb, stats } = extractAnimations(source, names, renameMap);
    const out = resolve(args.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, glb);
    console.log(`[retarget] extract → ${out}`);
    console.log(
      `[retarget] 骨骼节点 ${stats.keptNodes}/${stats.sourceNodes} · ` +
        `动画 ${stats.animations.join(", ")} · ${stats.channels} 通道 · ` +
        `rest 姿态 ${stats.restPoseBones} 骨 · ` +
        `${(glb.byteLength / 1024).toFixed(1)} KiB`,
    );
    return;
  }

  if (command === "retarget") {
    const source = await readFile(resolve(args.source));
    const target = await readFile(resolve(args.target));
    const { glb, stats } = retargetAnimations(source, target, args.map ?? "vrm");
    const out = resolve(args.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, glb);
    console.log(`[retarget] retarget(${args.map ?? "vrm"}) → ${out}`);
    console.log(
      `[retarget] 新增动画：${stats.addedAnimations
        .map((a) => `${a.name}(${a.channels}ch)`)
        .join(", ")} · hips 高度比 ${stats.hipsScale.toFixed(3)}`,
    );
    console.log(`[retarget] 骨骼映射 ${stats.mappedBones.length} 个，丢弃 ${stats.droppedBones.length} 个`);
    if (stats.droppedBones.length > 0) {
      console.log(`[retarget] 丢弃明细：${stats.droppedBones.join(", ")}`);
    }
    console.log(`[retarget] 输出 ${(stats.outputBytes / 1024).toFixed(1)} KiB`);
    return;
  }

  console.log(
    "用法：\n" +
      "  node tools/pipeline/retarget-animations.mjs extract --source <anim.glb> --names Walk_Loop,Jog_Fwd_Loop --out anims.glb\n" +
      "  node tools/pipeline/retarget-animations.mjs retarget --source anims.glb --target character.vrm --map vrm|project --out out.glb",
  );
  process.exitCode = 1;
}

// 只有直接执行时才跑 CLI；被 import（测试/其他脚本）时不执行。
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`[retarget] 失败：${error.message}`);
    process.exitCode = 1;
  });
}
