#!/usr/bin/env node
/**
 * 程序化测试资产生成器（Blender 不可用时的后备路径）。
 *
 * 产出与 Blender 脚本语义一致的最小资产：
 * - 单一蒙皮网格（角色代理，约 1.15 万三角）
 * - 7 根骨骼 + 一段骨骼旋转动画
 * - 1 个 shape key（morph target）+ 权重动画
 * - 1 张 1024×1024 baseColor 贴图
 *
 * 用法：node tools/pipeline/build-test-asset.mjs [输出路径]
 * 默认输出：assets/character_test_lod0.glb
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
const TEXTURE_SIZE = 1024;

const BONES = [
  { name: "b_root", parent: null, translation: [0, 0, 0] },
  { name: "b_spine", parent: "b_root", translation: [0, 0.75, 0] },
  { name: "b_head", parent: "b_spine", translation: [0, 0.95, 0] },
  { name: "b_arm_l", parent: "b_spine", translation: [-0.42, 0.8, 0] },
  { name: "b_arm_r", parent: "b_spine", translation: [0.42, 0.8, 0] },
  { name: "b_leg_l", parent: "b_root", translation: [-0.18, 0.75, 0] },
  { name: "b_leg_r", parent: "b_root", translation: [0.18, 0.75, 0] },
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

function createEllipsoid({ lon, lat, center, radii, part }) {
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
    part,
    positions,
    normals,
    uvs,
    indices,
    vertexCount: positions.length / 3,
  };
}

function createParts() {
  return [
    createEllipsoid({
      part: "body",
      lon: 80,
      lat: 48,
      center: [0, 1.15, 0],
      radii: [0.42, 0.6, 0.28],
    }),
    createEllipsoid({
      part: "head",
      lon: 48,
      lat: 24,
      center: [0, 1.95, 0],
      radii: [0.3, 0.32, 0.3],
    }),
    createEllipsoid({
      part: "arm_l",
      lon: 20,
      lat: 12,
      center: [-0.55, 1.35, 0],
      radii: [0.11, 0.42, 0.11],
    }),
    createEllipsoid({
      part: "arm_r",
      lon: 20,
      lat: 12,
      center: [0.55, 1.35, 0],
      radii: [0.11, 0.42, 0.11],
    }),
    createEllipsoid({
      part: "leg_l",
      lon: 20,
      lat: 12,
      center: [-0.18, 0.45, 0],
      radii: [0.13, 0.5, 0.13],
    }),
    createEllipsoid({
      part: "leg_r",
      lon: 20,
      lat: 12,
      center: [0.18, 0.45, 0],
      radii: [0.13, 0.5, 0.13],
    }),
  ];
}

/** 按部件写入蒙皮权重；身体在 root/spine 间做线性混合。 */
function skinWeightsFor(part, x, y) {
  const joints = [0, 0, 0, 0];
  const weights = [0, 0, 0, 0];
  const set = (bone, weight) => {
    joints[0] = BONE_INDEX.get(bone);
    weights[0] = weight;
  };

  if (part === "head") {
    set("b_head", 1);
  } else if (part === "arm_l") {
    set("b_arm_l", 1);
  } else if (part === "arm_r") {
    set("b_arm_r", 1);
  } else if (part === "leg_l") {
    set("b_leg_l", 1);
  } else if (part === "leg_r") {
    set("b_leg_r", 1);
  } else {
    const t = Math.min(1, Math.max(0, (y - 0.6) / 0.9));
    joints[0] = BONE_INDEX.get("b_root");
    weights[0] = 1 - t;
    joints[1] = BONE_INDEX.get("b_spine");
    weights[1] = t;
  }

  const sum = weights[0] + weights[1] + weights[2] + weights[3] || 1;
  return { joints, weights: weights.map((weight) => weight / sum) };
}

function buildTexture() {
  const rgba = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const checker = (Math.floor(u * 16) + Math.floor(v * 16)) % 2 === 0;
      let r = 58 + 118 * u;
      let g = 76 + 96 * v;
      let b = 128 + 74 * (1 - u * v);
      if (!checker) {
        r *= 0.72;
        g *= 0.74;
        b *= 0.82;
      }
      if (x % 128 < 3 || y % 128 < 3) {
        r = 232;
        g = 204;
        b = 96;
      }
      const dx = u - 0.5;
      const dy = v - 0.5;
      const radius = Math.hypot(dx, dy);
      if (Math.abs(radius - 0.3) < 0.008) {
        r = 236;
        g = 242;
        b = 250;
      }
      const offset = (y * TEXTURE_SIZE + x) * 4;
      rgba[offset] = Math.round(r);
      rgba[offset + 1] = Math.round(g);
      rgba[offset + 2] = Math.round(b);
      rgba[offset + 3] = 255;
    }
  }
  return encodePng(TEXTURE_SIZE, TEXTURE_SIZE, rgba);
}

async function main() {
  const outputPath = resolve(
    process.argv[2] ?? "assets/character_test_lod0.glb",
  );

  const parts = createParts();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const joints = [];
  const weights = [];
  const morphPositions = [];

  for (const part of parts) {
    const vertexOffset = positions.length / 3;
    for (let i = 0; i < part.vertexCount; i += 1) {
      const x = part.positions[i * 3];
      const y = part.positions[i * 3 + 1];
      const z = part.positions[i * 3 + 2];
      positions.push(x, y, z);
      normals.push(
        part.normals[i * 3],
        part.normals[i * 3 + 1],
        part.normals[i * 3 + 2],
      );
      uvs.push(part.uvs[i * 2], part.uvs[i * 2 + 1]);

      const skin = skinWeightsFor(part.part, x, y);
      joints.push(...skin.joints);
      weights.push(...skin.weights);

      // shape key：头部沿法线鼓起。
      const bulge = part.part === "head" ? 0.09 : 0;
      morphPositions.push(
        x + part.normals[i * 3] * bulge,
        y + part.normals[i * 3 + 1] * bulge,
        z + part.normals[i * 3 + 2] * bulge,
      );
    }
    for (const index of part.indices) {
      indices.push(index + vertexOffset);
    }
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const addAccessor = (name, type, array) =>
    doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer);

  const positionAccessor = addAccessor(
    "attr_character_test_position",
    "VEC3",
    new Float32Array(positions),
  );
  const normalAccessor = addAccessor(
    "attr_character_test_normal",
    "VEC3",
    new Float32Array(normals),
  );
  const uvAccessor = addAccessor(
    "attr_character_test_texcoord",
    "VEC2",
    new Float32Array(uvs),
  );
  const jointAccessor = addAccessor(
    "attr_character_test_joints",
    "VEC4",
    new Uint16Array(joints),
  );
  const weightAccessor = addAccessor(
    "attr_character_test_weights",
    "VEC4",
    new Float32Array(weights),
  );
  const indexAccessor = addAccessor(
    "attr_character_test_indices",
    "SCALAR",
    new Uint16Array(indices),
  );
  const morphAccessor = addAccessor(
    "attr_character_test_morph_head",
    "VEC3",
    new Float32Array(morphPositions),
  );

  const png = buildTexture();
  const texture = doc
    .createTexture("texture_test_character_base")
    .setImage(png)
    .setMimeType("image/png");

  const material = doc
    .createMaterial("material_test_character")
    .setBaseColorTexture(texture)
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.85);
  material
    .getBaseColorTextureInfo()
    .setMagFilter(9729)
    .setMinFilter(9987)
    .setWrapS(10497)
    .setWrapT(10497);

  const primitive = doc
    .createPrimitive("primitive_character_test_body")
    .setAttribute("POSITION", positionAccessor)
    .setAttribute("NORMAL", normalAccessor)
    .setAttribute("TEXCOORD_0", uvAccessor)
    .setAttribute("JOINTS_0", jointAccessor)
    .setAttribute("WEIGHTS_0", weightAccessor)
    .setIndices(indexAccessor)
    .setMaterial(material)
    .addTarget(
      doc
        .createPrimitiveTarget("morph_character_test_head_bulge")
        .setAttribute("POSITION", morphAccessor),
    );

  const mesh = doc
    .createMesh("character_test_lod0")
    .addPrimitive(primitive);

  const boneNodes = new Map();
  for (const bone of BONES) {
    const node = doc.createNode(bone.name).setTranslation(bone.translation);
    boneNodes.set(bone.name, node);
    if (bone.parent) {
      boneNodes.get(bone.parent).addChild(node);
    }
  }

  // 骨骼节点使用 TRS；逆绑定矩阵放在 skin 中，避免覆盖节点变换。
  const skin = doc
    .createSkin("skin_test_character")
    .setSkeleton(boneNodes.get("b_root"))
    .setInverseBindMatrices(
      addAccessor(
        "attr_character_test_inverse_bind",
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
    .createNode("character_test_lod0")
    .setMesh(mesh)
    .setSkin(skin);

  const scene = doc.createScene("scene_test_character");
  scene.addChild(meshNode);
  scene.addChild(boneNodes.get("b_root"));

  const times = new Float32Array(9);
  const armRotation = new Float32Array(9 * 4);
  const morphWeights = new Float32Array(9);
  for (let i = 0; i < 9; i += 1) {
    const t = i / 8;
    times[i] = t * 2;
    const angle = Math.sin(t * TAU) * 0.55;
    armRotation[i * 4] = 0;
    armRotation[i * 4 + 1] = 0;
    armRotation[i * 4 + 2] = Math.sin(angle / 2);
    armRotation[i * 4 + 3] = Math.cos(angle / 2);
    morphWeights[i] = (Math.sin(t * TAU) + 1) / 2;
  }

  const timeAccessor = addAccessor(
    "attr_character_test_anim_time",
    "SCALAR",
    times,
  );
  const rotationAccessor = addAccessor(
    "attr_character_test_anim_arm_rotation",
    "VEC4",
    armRotation,
  );
  const weightAccessor2 = addAccessor(
    "attr_character_test_anim_morph_weight",
    "SCALAR",
    morphWeights,
  );

  const animation = doc.createAnimation("anim_test_character_idle");
  const rotationSampler = doc
    .createAnimationSampler("anim_test_character_idle_rotation")
    .setInput(timeAccessor)
    .setOutput(rotationAccessor)
    .setInterpolation("LINEAR");
  animation
    .addSampler(rotationSampler)
    .addChannel(
      doc
        .createAnimationChannel("anim_test_character_idle_arm")
        .setSampler(rotationSampler)
        .setTargetNode(boneNodes.get("b_arm_r"))
        .setTargetPath("rotation"),
    );

  const morphSampler = doc
    .createAnimationSampler("anim_test_character_idle_morph")
    .setInput(timeAccessor)
    .setOutput(weightAccessor2)
    .setInterpolation("LINEAR");
  animation
    .addSampler(morphSampler)
    .addChannel(
      doc
        .createAnimationChannel("anim_test_character_idle_morph_channel")
        .setSampler(morphSampler)
        .setTargetNode(meshNode)
        .setTargetPath("weights"),
    );

  doc.getRoot().setDefaultScene(scene);

  const io = new NodeIO().registerExtensions([
    KHRDracoMeshCompression,
    EXTMeshoptCompression,
  ]);
  await mkdir(dirname(outputPath), { recursive: true });
  const glb = await io.writeBinary(doc);
  await writeFile(outputPath, glb);

  const triangleCount = indices.length / 3;
  console.log(
    `[build-test-asset] ${outputPath} · ${triangleCount} tris · ${positions.length / 3} verts · ${(
      glb.byteLength / 1024
    ).toFixed(1)} KiB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
