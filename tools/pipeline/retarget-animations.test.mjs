import { describe, expect, it } from "vitest";

import {
  extractAnimations,
  normalizeAnimationName,
  parseGlb,
  quatInvert,
  quatMultiply,
  quatNormalize,
  readVrmHumanoidMap,
  retargetAnimations,
  writeGlb,
} from "./retarget-animations.mjs";

/** 欧拉角（弧度）→ 四元数 [x,y,z,w]。 */
function quatFromEuler(x, y, z) {
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function quatClose(a, b, epsilon = 1e-5) {
  // 双覆盖等价（q 与 -q 表示同一旋转）
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return Math.abs(dot - 1) < epsilon;
}

describe("四元数数学", () => {
  it("乘法单位元：q ⊗ identity = q", () => {
    const q = quatFromEuler(0.3, 0.7, 1.1);
    expect(quatMultiply(q, [0, 0, 0, 1])).toEqual(q);
    expect(quatMultiply([0, 0, 0, 1], q)).toEqual(q);
  });

  it("逆 ⊗ 自身 = identity", () => {
    const q = quatNormalize(quatFromEuler(0.3, 0.7, 1.1));
    const left = quatMultiply(quatInvert(q), q);
    const right = quatMultiply(q, quatInvert(q));
    for (const result of [left, right]) {
      expect(result[0]).toBeCloseTo(0, 10);
      expect(result[1]).toBeCloseTo(0, 10);
      expect(result[2]).toBeCloseTo(0, 10);
      expect(result[3]).toBeCloseTo(1, 10);
    }
  });

  it("90° 绕 Z 轴：与已知值一致", () => {
    const q = quatNormalize(quatFromEuler(0, 0, Math.PI / 2));
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(q[2]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it("normalize 处理零向量与非归一输入", () => {
    expect(quatNormalize([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
    const q = quatNormalize([0, 0, 0, 2]);
    expect(q).toEqual([0, 0, 0, 1]);
  });
});

describe("骨骼名映射", () => {
  it("normalizeAnimationName：空格/大小写归一", () => {
    expect(normalizeAnimationName("Walk_Loop")).toBe("walk_loop");
    expect(normalizeAnimationName("  Sword Attack ")).toBe("sword_attack");
    expect(normalizeAnimationName("Jog-Fwd-Loop")).toBe("jog_fwd_loop");
  });

  it("readVrmHumanoidMap 支持 VRM 1.0 与 0.x 两种结构", () => {
    const vrm1 = {
      extensions: {
        VRMC_vrm: { humanoid: { humanBones: { hips: { node: 3 }, head: { node: 7 } } } },
      },
    };
    const map1 = readVrmHumanoidMap(vrm1);
    expect(map1.get("hips")).toBe(3);
    expect(map1.get("head")).toBe(7);

    const vrm0 = {
      extensions: {
        VRM: { humanoid: { humanBones: [{ bone: "hips", node: 2 }] } },
      },
    };
    const map0 = readVrmHumanoidMap(vrm0);
    expect(map0.get("hips")).toBe(2);

    expect(readVrmHumanoidMap({})).toBeNull();
  });
});

// ------------------------------------------------------------------ 合成 GLB

/** 构造一个最小两骨动画 GLB（源：UE 风格 pelvis→upperarm_l）。 */
function buildSourceGlb({ upperarmRest, animQuat, hipsTranslation }) {
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: "pelvis",
        rotation: [0, 0, 0, 1],
        translation: hipsTranslation,
        children: [1],
      },
      { name: "upperarm_l", rotation: upperarmRest },
    ],
    skins: [{ joints: [0, 1] }],
    accessors: [
      { componentType: 5126, count: 2, type: "SCALAR" }, // 0: times
      { componentType: 5126, count: 2, type: "VEC4" }, // 1: upperarm rotation
      { componentType: 5126, count: 2, type: "VEC3" }, // 2: pelvis translation
    ],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
    animations: [
      {
        name: "Walk_Loop",
        channels: [
          { sampler: 0, target: { node: 1, path: "rotation" } },
          { sampler: 1, target: { node: 0, path: "translation" } },
          { sampler: 2, target: { node: 1, path: "scale" } },
        ],
        samplers: [
          { input: 0, output: 1, interpolation: "LINEAR" }, // rotation
          { input: 0, output: 2, interpolation: "LINEAR" }, // hips translation
          { input: 0, output: 1, interpolation: "LINEAR" }, // scale（复用 rotation accessor 占位）
        ],
      },
    ],
  };

  // 二进制：times [0,1] | rotations (8 floats) | translations (6 floats)
  const times = new Float32Array([0, 1]);
  const rotations = new Float32Array([
    ...animQuat,
    ...animQuat, // 两个关键帧同值，便于断言
  ]);
  const translations = new Float32Array([0, 2, 0, 0, 2.2, 0]); // rest 2.0 → 动画抬到 2.0/2.2
  const binParts = [
    new Uint8Array(times.buffer),
    new Uint8Array(rotations.buffer),
    new Uint8Array(translations.buffer),
  ];
  // 线性化 + 4 字节对齐
  const linear = [];
  let cursor = 0;
  const orderedViews = [];
  for (const part of binParts) {
    const pad = (4 - (cursor % 4)) % 4;
    if (pad > 0) {
      const padding = new Uint8Array(pad);
      linear.push(padding);
      cursor += pad;
    }
    linear.push(part);
    orderedViews.push({ buffer: 0, byteOffset: cursor, byteLength: part.byteLength });
    cursor += part.byteLength;
  }
  const bin = new Uint8Array(cursor);
  let write = 0;
  for (const part of linear) {
    bin.set(part, write);
    write += part.byteLength;
  }
  json.bufferViews = orderedViews;
  json.buffers = [{ byteLength: bin.byteLength }];
  // accessor 0 → view0（times），1 → view1（rotations），2 → view2（translations）
  json.accessors[0].bufferView = 0;
  json.accessors[1].bufferView = 1;
  json.accessors[2].bufferView = 2;

  return { buffer: writeGlb(json, bin), json };
}

/** 构造目标 VRM GLB（VRM 1.0 humanoid map + 自有 rest 姿态 + 既有 bufferView/accessor）。
 *  既有 view/accessor 用于回归：追加动画的索引必须偏移目标已有数量。 */
function buildTargetGlb({ hipsRest, upperarmRest }) {
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "hips", rotation: [0, 0, 0, 1], translation: hipsRest, children: [1] },
      { name: "uarm.L", rotation: upperarmRest },
    ],
    accessors: [{ componentType: 5126, count: 1, type: "SCALAR", bufferView: 0 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
    buffers: [{ byteLength: 4 }],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        humanoid: { humanBones: { hips: { node: 0 }, leftUpperArm: { node: 1 } } },
      },
    },
  };
  return { buffer: writeGlb(json, new Uint8Array([255, 255, 255, 255])), json };
}

describe("extract → retarget 端到端（合成 GLB）", () => {
  it("rest 修正：源 rest 姿态帧落在目标 rest 上；hips 平移按高度比缩放", () => {
    const sourceRestArm = quatFromEuler(0, 0, 1.2); // 源 rest：A-pose 式张开
    const targetRestArm = quatFromEuler(0, Math.PI / 2, 0); // 目标 rest 轴向不同
    const animDelta = quatFromEuler(0.5, 0, 0); // 相对源 rest 的摆动

    const source = buildSourceGlb({
      upperarmRest: sourceRestArm,
      animQuat: animDelta,
      hipsTranslation: [0, 1.0, 0],
    });
    const target = buildTargetGlb({
      hipsRest: [0, 0.8, 0],
      upperarmRest: targetRestArm,
    });

    // extract：带改名 Walk_Loop → walk
    const { glb: animsGlb, stats } = extractAnimations(
      source.buffer,
      ["Walk_Loop"],
      { Walk_Loop: "walk" },
    );
    expect(stats.animations).toEqual(["walk"]);
    expect(stats.restPoseBones).toBe(0); // 无 TPose → 用节点静态 rotation

    const { glb: resultGlb, stats: rStats } = retargetAnimations(
      animsGlb,
      target.buffer,
      "vrm",
    );

    expect(rStats.addedAnimations.map((a) => a.name)).toEqual(["walk"]);
    expect(rStats.hipsScale).toBeCloseTo(0.8, 5);

    const { json: out } = parseGlb(resultGlb);
    expect(out.animations).toHaveLength(1);
    const walk = out.animations[0];

    // 通道：upperarm rotation + pelvis(hips) translation；scale 被丢弃
    const paths = walk.channels.map(
      (ch) => `${out.nodes[ch.target.node].name}:${ch.target.path}`,
    );
    expect(paths).toContain("uarm.L:rotation");
    expect(paths).toContain("hips:translation");
    expect(paths).not.toContain("uarm.L:scale");

    // rest 修正数学断言：corrected = qRestT ⊗ qRestS⁻¹ ⊗ q
    const rotationChannel = walk.channels.find(
      (ch) => ch.target.path === "rotation",
    );
    const rotationSampler = walk.samplers[rotationChannel.sampler];
    const { bin } = parseGlb(resultGlb);
    const rotationAccessor = out.accessors[rotationSampler.output];
    const view = out.bufferViews[rotationAccessor.bufferView];
    const floats = new Float32Array(
      bin.buffer,
      bin.byteOffset + view.byteOffset,
      rotationAccessor.count * 4,
    );
    const expected = quatNormalize(
      quatMultiply(targetRestArm, quatMultiply(quatInvert(sourceRestArm), animDelta)),
    );
    expect(quatClose([floats[0], floats[1], floats[2], floats[3]], expected)).toBe(true);

    // hips 平移按高度比 0.8 缩放（源 2.0 → 目标 1.6）
    const translationChannel = walk.channels.find(
      (ch) => ch.target.path === "translation",
    );
    const translationSampler = walk.samplers[translationChannel.sampler];
    const tAccessor = out.accessors[translationSampler.output];
    const tView = out.bufferViews[tAccessor.bufferView];
    const tFloats = new Float32Array(
      bin.buffer,
      bin.byteOffset + tView.byteOffset,
      tAccessor.count * 3,
    );
    expect(tFloats[1]).toBeCloseTo(2 * 0.8, 4);
    expect(tFloats[4]).toBeCloseTo(2.2 * 0.8, 4);
  });

  it("非 hips 平移与 scale 轨道被丢弃并计入报告", () => {
    const source = buildSourceGlb({
      upperarmRest: [0, 0, 0, 1],
      animQuat: [0, 0, 0, 1],
      hipsTranslation: [0, 1, 0],
    });
    const target = buildTargetGlb({ hipsRest: [0, 0.8, 0], upperarmRest: [0, 0, 0, 1] });
    const { glb: animsGlb } = extractAnimations(source.buffer, ["Walk_Loop"]);
    const { stats } = retargetAnimations(animsGlb, target.buffer, "vrm");
    // 合成源里 scale 通道挂在 upperarm_l（非 hips）→ 被丢弃
    const walk = stats.addedAnimations.find((a) => a.name === "walk_loop");
    expect(walk.channels).toBe(2); // rotation + hips translation
  });

  it("目标没有 humanoid map 时 --map vrm 报错", () => {
    const source = buildSourceGlb({
      upperarmRest: [0, 0, 0, 1],
      animQuat: [0, 0, 0, 1],
      hipsTranslation: [0, 1, 0],
    });
    const { glb: animsGlb } = extractAnimations(source.buffer, ["Walk_Loop"]);
    const plainTarget = writeGlb(
      { asset: { version: "2.0" }, nodes: [{ name: "hips" }] },
      new Uint8Array(0),
    );
    expect(() => retargetAnimations(animsGlb, plainTarget, "vrm")).toThrow(
      /humanoid map/,
    );
  });
});
