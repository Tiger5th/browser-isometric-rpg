/**
 * 探索回报的视觉件（票 37）：宝箱与萤光草。
 *
 * 资产：资产 agent 的产出（artifacts/exploration/ 留档，选中的候选复制到
 * assets/exploration/），走与 prop/敌人精灵同一套「白底抠白 + billboard」基建
 * （见 exploration-textures.ts）。宝箱按开启状态切关闭/开启两张贴图；
 * 萤光草是 billboard 并做呼吸摇曳。
 *
 * 贴图缺失或加载失败时回落到程序化占位（合并网格的木箱 / 叶簇），
 * 这样场景不会因为一张 PNG 缺失就整个起不来——占位路径同样只出 1–2 个网格。
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import type { ChestDefinition, CollectibleDefinition } from "../../logic/content/types";
import { createToonMaterial } from "../anime/toonMaterial";

/** 宝箱 billboard 世界尺寸（贴图 1:1，保持不拉伸）。 */
const CHEST_SIZE = 1.3;
/** 萤光草 billboard 世界尺寸。 */
const GRASS_SIZE = { width: 0.72, height: 0.45 };

export interface ChestVisual {
  root: TransformNode;
  /** 可点击的网格（带 metadata.chestId）。 */
  mesh: Mesh;
  /** 关闭态 / 开启态贴图；缺省（无贴图）时为 null，走程序化占位。 */
  closed: BaseTexture | null;
  open: BaseTexture | null;
  /** 程序化占位的箱盖节点；贴图路径为 null。 */
  lid: Mesh | null;
  /** 当前开启动画进度 0–1。 */
  openProgress: number;
  /** 当前是否已经切到「开启态」外观。 */
  openLook: boolean;
  /** 开启动画进度阈值：超过它才切贴图（占位路径用 Infinity，即不切）。 */
  swapAt: number;
}

export interface CollectibleVisual {
  root: TransformNode;
  mesh: Mesh;
  /** 呼吸/摇曳相位偏移（确定性，不用随机）。 */
  phase: number;
}

function solidMaterial(scene: Scene, name: string, hex: string, emissive = false): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.FromHexString(hex);
  material.specularColor = Color3.Black();
  if (emissive) {
    material.emissiveColor = Color3.FromHexString(hex).scale(0.85);
  }
  return material;
}

function billboard(
  scene: Scene,
  name: string,
  parent: TransformNode,
  width: number,
  height: number,
  texture: BaseTexture,
): Mesh {
  const mesh = MeshBuilder.CreatePlane(name, { width, height }, scene);
  mesh.parent = parent;
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.material = createToonMaterial(scene, `${name}.material`, texture, {
    useVertexColors: false,
    unlit: true,
    alphaCutoff: 0.35,
  });
  return mesh;
}

/**
 * 宝箱视觉：优先用贴图（关闭/开启两张），无贴图时用程序化占位。
 * 两种路径都只出 1–2 个网格，不额外放大 draw call 预算。
 */
export function createChestVisual(
  scene: Scene,
  root: TransformNode,
  chest: ChestDefinition,
  textures: { closed: BaseTexture | null; open: BaseTexture | null },
): ChestVisual {
  const node = new TransformNode(`visual.${chest.id}`, scene);
  node.parent = root;
  node.position.set(chest.position.x, chest.position.y, chest.position.z);
  if (chest.rotation !== undefined) {
    node.rotation.set(chest.rotation.x, chest.rotation.y, chest.rotation.z);
  }

  if (textures.closed !== null) {
    const mesh = billboard(scene, `${chest.id}.mesh`, node, CHEST_SIZE, CHEST_SIZE, textures.closed);
    mesh.position.y = CHEST_SIZE / 2;
    mesh.metadata = { chestId: chest.id };
    mesh.isPickable = true;
    return {
      root: node,
      mesh,
      closed: textures.closed,
      open: textures.open,
      lid: null,
      openProgress: 0,
      openLook: false,
      swapAt: 0.5,
    };
  }

  // 程序化占位：箱体（含包边，合并成 1 个网格）+ 可开合箱盖。
  const bodyMaterial = solidMaterial(scene, `${chest.id}.body`, "#8a5a32");
  const trimMaterial = solidMaterial(scene, `${chest.id}.trim`, "#c9a227");
  const body = MeshBuilder.CreateBox(
    `${chest.id}.body`,
    { width: 0.9, height: 0.55, depth: 0.6 },
    scene,
  );
  body.position.y = 0.275;
  const bands = [-0.42, 0.42].map((offsetX, index) => {
    const band = MeshBuilder.CreateBox(
      `${chest.id}.band.${index}`,
      { width: 0.07, height: 0.58, depth: 0.63 },
      scene,
    );
    band.position.set(offsetX, 0.28, 0);
    return band;
  });
  const mergedBody = Mesh.MergeMeshes([body, ...bands], true, true) as Mesh;
  if (mergedBody === null) {
    throw new Error(`宝箱 ${chest.id} 合并失败`);
  }
  mergedBody.name = `${chest.id}.body`;
  mergedBody.parent = node;
  mergedBody.material = bodyMaterial;
  mergedBody.metadata = { chestId: chest.id };
  mergedBody.isPickable = true;

  const lidPivot = new TransformNode(`${chest.id}.lidPivot`, scene);
  lidPivot.parent = node;
  lidPivot.position.set(0, 0.55, -0.3);
  const lid = MeshBuilder.CreateBox(
    `${chest.id}.lid`,
    { width: 0.92, height: 0.18, depth: 0.62 },
    scene,
  );
  lid.parent = lidPivot;
  lid.position.set(0, 0.09, 0.3);
  lid.material = trimMaterial;
  lid.isPickable = false;

  return {
    root: node,
    mesh: mergedBody,
    closed: null,
    open: null,
    lid,
    openProgress: 0,
    openLook: false,
    swapAt: Number.POSITIVE_INFINITY,
  };
}

/**
 * 宝箱开启动画：0 = 闭合，1 = 完全打开。
 * 贴图路径在中点切到「开启态」那张；占位路径是箱盖绕后缘掀起。
 */
export function advanceChestVisual(visual: ChestVisual, dtMs: number, target: number): void {
  const step = Math.min(1, dtMs / 260);
  visual.openProgress += (target - visual.openProgress) * step;
  if (Math.abs(target - visual.openProgress) < 1e-3) {
    visual.openProgress = target;
  }

  if (visual.lid !== null) {
    visual.lid.rotation.x = -visual.openProgress * 1.9;
    return;
  }
  if (visual.open !== null && !visual.openLook && visual.openProgress >= visual.swapAt) {
    visual.openLook = true;
    visual.mesh.material?.dispose();
    visual.mesh.material = createToonMaterial(
      visual.mesh.getScene(),
      `${visual.mesh.name}.open`,
      visual.open,
      { useVertexColors: false, unlit: true, alphaCutoff: 0.35 },
    );
  }
}

/**
 * 萤光草：billboard + 呼吸摇曳。贴图缺失时回落成合并成单网格的自发光叶簇。
 */
export function createCollectibleVisual(
  scene: Scene,
  root: TransformNode,
  collectible: CollectibleDefinition,
  index: number,
  texture: BaseTexture | null,
): CollectibleVisual {
  const node = new TransformNode(`visual.${collectible.id}`, scene);
  node.parent = root;
  node.position.set(collectible.position.x, collectible.position.y, collectible.position.z);

  if (texture !== null) {
    const mesh = billboard(
      scene,
      `${collectible.id}.mesh`,
      node,
      GRASS_SIZE.width,
      GRASS_SIZE.height,
      texture,
    );
    mesh.position.y = GRASS_SIZE.height / 2;
    mesh.metadata = { collectibleId: collectible.id };
    mesh.isPickable = true;
    return { root: node, mesh, phase: index * 0.9 };
  }

  const material = solidMaterial(scene, `${collectible.id}.glow`, "#7ef0c8", true);
  material.alpha = 0.92;
  const blades = 5;
  const parts = [];
  for (let blade = 0; blade < blades; blade += 1) {
    const angle = (blade / blades) * Math.PI * 2;
    const leaf = MeshBuilder.CreateCylinder(
      `${collectible.id}.blade.${blade}`,
      { height: 0.34, diameterTop: 0, diameterBottom: 0.07, tessellation: 4 },
      scene,
    );
    leaf.position.set(Math.cos(angle) * 0.11, 0.17, Math.sin(angle) * 0.11);
    // 叶片应向外倒（顶端背离簇心）：绕 Z 正旋转把 +Y 顶端推向 -X、
    // 绕 X 正旋转推向 +Z，所以这里取负号（原来的 +cos/+sin 会全部内倾）。
    leaf.rotation.z = -Math.cos(angle) * 0.45;
    leaf.rotation.x = -Math.sin(angle) * 0.45;
    parts.push(leaf);
  }
  const cluster = Mesh.MergeMeshes(parts, true, true) as Mesh;
  if (cluster === null) {
    throw new Error(`收集品 ${collectible.id} 合并失败`);
  }
  cluster.name = `${collectible.id}.cluster`;
  cluster.parent = node;
  cluster.material = material;
  cluster.metadata = { collectibleId: collectible.id };
  cluster.isPickable = true;
  return { root: node, mesh: cluster, phase: index * 0.9 };
}

/** 收集品呼吸/摇曳（确定性正弦；拾取后由调用方隐藏整组节点）。 */
export function animateCollectibleVisual(visual: CollectibleVisual, elapsedMs: number): void {
  visual.root.rotation.y = Math.sin((elapsedMs / 900 + visual.phase) * Math.PI * 2) * 0.12;
  const pulse = 0.85 + Math.sin((elapsedMs / 1200 + visual.phase) * Math.PI * 2) * 0.15;
  visual.root.scaling.setAll(pulse);
}