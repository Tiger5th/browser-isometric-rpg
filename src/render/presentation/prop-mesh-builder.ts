/**
 * 程序化网格环境件（票 28）：把配方实例化为 Babylon 真网格。
 *
 * 与票 25 的 billboard 方案的关系：
 * - 灌木保持 billboard（可穿，见 world-physics 的 PASSABLE_KINDS）；
 * - 树/石墙/木桶/木箱改用这里的真网格（硬碰撞，见 buildPropColliders）；
 * - 贴图沿用同一批 Gemini 资产，靠 UV 窗口取贴图的不同区域贴到不同零件上。
 *
 * 为什么不用 PBR/StandardMaterial：既有 toon shader 是自定义 ShaderMaterial，
 * 不采样 Babylon 的 UV 变换矩阵；因此这里**直接把 UV 写进顶点数据**
 * （VertexBuffer.UVKind），零件用整块网格的窗口坐标寻址贴图。
 * 这样也避免了每零件一个 material（draw call 会翻倍）。
 */
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Material } from "@babylonjs/core/Materials/material";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import {
  getPropMeshRecipe,
  PROP_MESH_RECIPES,
  SPHERE_SEGMENTS,
  CYLINDER_SEGMENTS,
  type PrimitiveKind,
  type PropPart,
} from "./prop-mesh-recipe";

/**
 * 已网格化的环境件种类：以 prop-mesh-recipe 的配方表为唯一权威。
 * 区域 1 的四类硬碰撞件 + 区域 2 的三类巢穴件（票 35）；
 * 灌木保持 billboard 可穿，不在此表内。
 */
export type MeshedPropKind = keyof typeof PROP_MESH_RECIPES;

export interface BuildPropMeshOptions {
  scene: Scene;
  root: TransformNode;
  /** 环境件 id（布局里的 prop.*）。 */
  propId: string;
  kind: MeshedPropKind;
  x: number;
  z: number;
  scale: number;
  material: Material;
}

/** 把 UV 窗口写进网格顶点数据：整张贴图被窗口裁剪后铺到零件表面。 */
export function applyUvWindow(mesh: Mesh, part: PropPart): void {
  if (!part.uv) {
    return;
  }
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  if (!uvs) {
    return;
  }
  const { u, v, width, height } = part.uv;
  for (let index = 0; index < uvs.length; index += 2) {
    uvs[index] = u + uvs[index] * width;
    uvs[index + 1] = v + uvs[index + 1] * height;
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, false, 2);
}

function createPrimitive(
  scene: Scene,
  name: string,
  primitive: PrimitiveKind,
  part: PropPart,
): Mesh {
  const { width, height, depth } = part.size;
  switch (primitive) {
    case "cylinder":
      return MeshBuilder.CreateCylinder(
        name,
        { height, diameter: width, tessellation: CYLINDER_SEGMENTS },
        scene,
      );
    case "box":
      return MeshBuilder.CreateBox(name, { width, height, depth }, scene);
    case "sphere":
      return MeshBuilder.CreateSphere(
        name,
        { diameter: width, segments: SPHERE_SEGMENTS },
        scene,
      );
    case "disc":
      // 圆盘用极矮的圆柱实现：顶面即贴图里的桶口。
      return MeshBuilder.CreateCylinder(
        name,
        { height: Math.max(0.02, height), diameter: width, tessellation: CYLINDER_SEGMENTS },
        scene,
      );
    case "torus":
      return MeshBuilder.CreateTorus(
        name,
        { diameter: width, thickness: height, tessellation: CYLINDER_SEGMENTS },
        scene,
      );
    default:
      throw new Error(`未知基元：${primitive}`);
  }
}

/**
 * 按配方拼装一个环境件的真网格。
 * 返回全部零件网格（调用方负责 dispose 与加入遮挡/描边列表）。
 */
export function buildPropMesh(options: BuildPropMeshOptions): Mesh[] {
  const { scene, root, propId, kind, x, z, scale, material } = options;
  const recipe = getPropMeshRecipe(kind);
  const meshes: Mesh[] = [];

  for (const part of recipe.parts) {
    if (part.render === false) {
      continue;
    }
    const mesh = createPrimitive(
      scene,
      `environment.${propId}.${part.id}`,
      part.primitive,
      part,
    );
    mesh.position.set(
      x + part.offset.x * scale,
      part.offset.y * scale,
      z + part.offset.z * scale,
    );
    mesh.scaling.setAll(scale);
    // 贴图窗口写进 UV（ Babylon 的 ShaderMaterial 不做 UV 变换）。
    applyUvWindow(mesh, part);
    mesh.material = material;
    mesh.isPickable = false;
    // 硬碰撞件必须参与射线-OBB 遮挡判定（树/墙挡住角色时描边）。
    mesh.parent = root;
    meshes.push(mesh);
  }

  return meshes;
}

/** 一个环境件整棵的三角数（LOD 逐件下调时的实际依据）。 */
export function propMeshTriangleCount(kind: MeshedPropKind): number {
  return getPropMeshRecipe(kind).estimatedTriangles;
}
