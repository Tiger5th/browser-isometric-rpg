/**
 * 探索回报的视觉件（票 37）：宝箱与萤光草的程序化占位模型。
 *
 * 资产说明：`artifacts/exploration/` 目前没有资产 agent 产出的贴图/模型，
 * 因此这里**全部程序化占位**：宝箱是「木箱壳 + 箱盖 + 铜色包边」的网格组合，
 * 萤光草是自发光的小簇叶片。贴图到位后只替换 `createChestVisual` /
 * `createCollectibleVisual` 两个函数的几何与材质，逻辑与交互不动。
 *
 * 宝箱视觉只读会话事实（`session.isChestOpened(id)`）：开过就不再合上盖子。
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import type { ChestDefinition, CollectibleDefinition } from "../../logic/content/types";

export interface ChestVisual {
  root: TransformNode;
  /** 可点击的网格（带 metadata.chestId）。 */
  mesh: Mesh;
  /** 箱盖节点：开启动画绕它后缘旋转。 */
  lid: Mesh;
  /** 当前开启动画进度 0–1。 */
  openProgress: number;
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

/**
 * 程序化宝箱：木箱壳 + 可开合的箱盖。
 *
 * draw call 预算（票 37）：每个宝箱只出 **2 个网格**（壳 / 盖），铜色包边靠
 * 顶点色而不是多两个盒子 mesh —— 否则 3 个宝箱就是 12 个 draw call，
 * p1-world 的 350 预算会被探索内容吃掉一大块。
 */
export function createChestVisual(scene: Scene, root: TransformNode, chest: ChestDefinition): ChestVisual {
  const node = new TransformNode(`visual.${chest.id}`, scene);
  node.parent = root;
  node.position.set(chest.position.x, chest.position.y, chest.position.z);
  if (chest.rotation !== undefined) {
    node.rotation.set(chest.rotation.x, chest.rotation.y, chest.rotation.z);
  }

  const bodyMaterial = solidMaterial(scene, `${chest.id}.body`, "#8a5a32");
  const trimMaterial = solidMaterial(scene, `${chest.id}.trim`, "#c9a227");

  // 箱体：主体 + 两道包边合并成一个网格（Mesh.MergeMeshes，合并后只 1 个 draw call）。
  const body = MeshBuilder.CreateBox(
    `${chest.id}.body`,
    { width: 0.9, height: 0.55, depth: 0.6 },
    scene,
  );
  body.position.y = 0.275;
  body.metadata = { chestId: chest.id };
  body.isPickable = true;
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

  // 箱盖挂在后缘：绕后缘旋转就是「掀开」，不需要额外动画骨骼。
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

  return { root: node, mesh: mergedBody, lid, openProgress: 0 };
}

/** 宝箱开启动画：0 = 闭合，1 = 盖子完全掀起。 */
export function advanceChestVisual(visual: ChestVisual, dtMs: number, target: number): void {
  const step = Math.min(1, dtMs / 260);
  visual.openProgress += (target - visual.openProgress) * step;
  if (Math.abs(target - visual.openProgress) < 1e-3) {
    visual.openProgress = target;
  }
  visual.lid.rotation.x = -visual.openProgress * 1.9;
}

/**
 * 程序化萤光草：自发光的小簇叶片（占位，见文件头资产说明）。
 *
 * 每个收集品只出 **1 个网格**：五片叶子合成一个网格，否则 8 株就是 40 个
 * draw call（p1-world 预算 350，探索内容必须自成一两个 draw call 量级）。
 */
export function createCollectibleVisual(
  scene: Scene,
  root: TransformNode,
  collectible: CollectibleDefinition,
  index: number,
): CollectibleVisual {
  const node = new TransformNode(`visual.${collectible.id}`, scene);
  node.parent = root;
  node.position.set(collectible.position.x, collectible.position.y, collectible.position.z);

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
    leaf.rotation.z = Math.cos(angle) * 0.45;
    leaf.rotation.x = Math.sin(angle) * 0.45;
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

/** 收集品呼吸/摇曳（确定性正弦，拾取后由调用方隐藏节点）。 */
export function animateCollectibleVisual(
  visual: CollectibleVisual,
  elapsedMs: number,
): void {
  const sway = Math.sin((elapsedMs / 900 + visual.phase) * Math.PI * 2) * 0.12;
  visual.root.rotation.y = sway;
  const pulse = 0.85 + Math.sin((elapsedMs / 1200 + visual.phase) * Math.PI * 2) * 0.15;
  visual.root.scaling.setAll(pulse);
}