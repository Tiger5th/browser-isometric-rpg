import { Animation } from "@babylonjs/core/Animations/animation";
// 注册 Scene.beginAnimation 等动画副作用（Babylon 9 按需加载）。
import "@babylonjs/core/Animations/animatable";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";

/** 骨骼动画循环长度（帧）与采样帧率；11/13 号场景共用。 */
export const CHARACTER_ANIMATION_FRAMES = 30;
export const CHARACTER_ANIMATION_FPS = 30;
/** spine 骨骼索引；场景可用它抽样确认动画推进。 */
export const CHARACTER_BONE_SPINE = 1;
/** head 骨骼索引。 */
export const CHARACTER_BONE_HEAD = 2;

const BONE_ROOT = 0;
const BONE_SPINE = CHARACTER_BONE_SPINE;
const BONE_HEAD = CHARACTER_BONE_HEAD;

export interface CharacterAnimations {
  sway: Animation;
  nod: Animation;
}

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 按顶点高度分配三根骨骼的蒙皮权重：
 * 脚部 → root，腰部 → spine，头部 → head，中间线性过渡。
 */
function computeSkinWeights(y: number): [number, number, number] {
  const rootToSpine = clamp01((y - 0.2) / 0.35);
  const spineToHead = clamp01((y - 0.82) / 0.28);
  if (y < 0.2) {
    return [1, 0, 0];
  }
  if (y < 0.82) {
    return [1 - rootToSpine, rootToSpine, 0];
  }
  if (y < 1.1) {
    return [0, 1 - spineToHead, spineToHead];
  }
  return [0, 0, 1];
}

function applySkinWeights(mesh: Mesh): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) {
    throw new Error("角色原型缺少顶点位置数据");
  }

  const vertexCount = positions.length / 3;
  const matricesIndices = new Float32Array(vertexCount * 4);
  const matricesWeights = new Float32Array(vertexCount * 4);

  for (let index = 0; index < vertexCount; index += 1) {
    const weights = computeSkinWeights(positions[index * 3 + 1]);
    const offset = index * 4;
    matricesIndices[offset] = BONE_ROOT;
    matricesIndices[offset + 1] = BONE_SPINE;
    matricesIndices[offset + 2] = BONE_HEAD;
    matricesIndices[offset + 3] = 0;
    matricesWeights[offset] = weights[0];
    matricesWeights[offset + 1] = weights[1];
    matricesWeights[offset + 2] = weights[2];
    matricesWeights[offset + 3] = 0;
  }

  mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, matricesIndices, false);
  mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, matricesWeights, false);
}

/** 程序化占位角色：胶囊身体 + 球形头部合并为单个 skinned mesh。 */
export function createCharacterPrototype(scene: Scene, prefix: string): Mesh {
  const body = MeshBuilder.CreateCapsule(
    `${prefix}proto-body`,
    { radius: 0.24, height: 0.95, tessellation: 8, subdivisions: 2, capSubdivisions: 2 },
    scene,
  );
  body.position.y = 0.475;

  const head = MeshBuilder.CreateSphere(`${prefix}proto-head`, { diameter: 0.44, segments: 8 }, scene);
  head.position.y = 1.12;

  const merged = Mesh.MergeMeshes([body, head], true, true, undefined, false, false);
  if (!merged) {
    throw new Error("角色原型合并网格失败");
  }
  merged.name = `${prefix}proto`;
  applySkinWeights(merged);
  return merged;
}

/**
 * Bone.rotation 的 getter 返回临时 Vector3，动画必须走 rotationQuaternion
 * （setter 会写回 _localRotation），否则关键帧值会被丢弃。
 */
function createQuaternionAnimation(
  name: string,
  axis: Vector3,
  keys: Array<{ frame: number; angle: number }>,
): Animation {
  const animation = new Animation(
    name,
    "rotationQuaternion",
    CHARACTER_ANIMATION_FPS,
    Animation.ANIMATIONTYPE_QUATERNION,
    Animation.ANIMATIONLOOPMODE_CYCLE,
  );
  animation.setKeys(
    keys.map((key) => ({ frame: key.frame, value: Quaternion.RotationAxis(axis, key.angle) })),
  );
  return animation;
}

/** 创建 sway（spine）+ nod（head）两条循环动画；多个 skeleton 共享同一份 Animation 定义。 */
export function createCharacterAnimations(): CharacterAnimations {
  const sway = createQuaternionAnimation("character.sway", new Vector3(0, 0, 1), [
    { frame: 0, angle: -0.16 },
    { frame: CHARACTER_ANIMATION_FRAMES / 2, angle: 0.16 },
    { frame: CHARACTER_ANIMATION_FRAMES, angle: -0.16 },
  ]);
  const nod = createQuaternionAnimation("character.nod", new Vector3(1, 0, 0), [
    { frame: 0, angle: 0.1 },
    { frame: CHARACTER_ANIMATION_FRAMES / 2, angle: -0.08 },
    { frame: CHARACTER_ANIMATION_FRAMES, angle: 0.1 },
  ]);
  return { sway, nod };
}

export function createCharacterMaterial(
  scene: Scene,
  name: string,
  diffuse: Color3,
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse;
  material.specularColor = Color3.Black();
  return material;
}

export function createCharacterSkeleton(
  scene: Scene,
  prefix: string,
  index: number,
  animations: CharacterAnimations,
): Skeleton {
  const skeleton = new Skeleton(`${prefix}${index}.skeleton`, `${prefix}${index}.skeleton`, scene);

  const root = new Bone("root", skeleton, null, Matrix.Identity());
  const spine = new Bone("spine", skeleton, root, Matrix.Translation(0, 0.5, 0));
  new Bone("head", skeleton, spine, Matrix.Translation(0, 0.42, 0));

  spine.animations = [animations.sway];
  skeleton.bones[BONE_HEAD].animations = [animations.nod];
  return skeleton;
}
