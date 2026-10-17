/**
 * 翠谷正式环境视觉（票 25）：平铺地面 + billboard 贴图物件。
 *
 * - 地面：每个 patch 一个 Ground mesh，UV 按世界尺寸/tileSize 缩放，
 *   贴图设为 WRAP，因此一张 1024² 贴图可以自然平铺整个区域。
 * - 立面物件：白底贴图抠白后贴到朝相机的 plane（billboard），
 *   用 alpha test 裁剪而不是透明混合，避免排序问题与 overdraw。
 * - 遮挡盒：billboard 的 OBB 与屏幕对齐（axisZ = 相机前向），
 *   供射线-OBB 遮挡描边使用。
 */
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Material } from "@babylonjs/core/Materials/material";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import { createToonMaterial } from "../anime/toonMaterial";
import {
  createCameraAlignedBox,
  type OccluderBox,
} from "../occlusion/ray-obb";
import {
  GROUND_PATCHES,
  PROP_DIMENSIONS,
  PROPS,
  type GroundPatch,
  type PropKind,
} from "./green-hollow-layout";
import {
  loadEnvironmentTextures,
  type EnvironmentTextures,
  type TextureLoadStats,
} from "./textures";

export interface WorldOccluder {
  id: string;
  box: OccluderBox;
}

export interface EnvironmentVisuals {
  groundMeshes: Mesh[];
  propMeshes: Mesh[];
  occluders: WorldOccluder[];
  materials: Material[];
  textures: EnvironmentTextures;
  keyStats: TextureLoadStats[];
  dispose(): void;
}

/** 把平面 UV 按世界尺寸缩放，实现贴图平铺。 */
export function tileGroundUvs(
  mesh: Mesh,
  width: number,
  depth: number,
  tileSize: number,
): void {
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  if (!uvs) {
    return;
  }
  const tilesX = Math.max(1, width / tileSize);
  const tilesY = Math.max(1, depth / tileSize);
  for (let index = 0; index < uvs.length; index += 2) {
    uvs[index] *= tilesX;
    uvs[index + 1] *= tilesY;
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, false, 2);
}

function createGroundPatch(
  scene: Scene,
  root: TransformNode,
  patch: GroundPatch,
  material: Material,
): Mesh {
  const mesh = MeshBuilder.CreateGround(
    `environment.${patch.id}`,
    { width: patch.width, height: patch.depth, subdivisions: 1 },
    scene,
  );
  mesh.position.set(patch.x, patch.y, patch.z);
  tileGroundUvs(mesh, patch.width, patch.depth, patch.tileSize);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.parent = root;
  return mesh;
}

/** billboard 平面：底边贴地，朝相机（正交相机下所有 plane 朝向一致）。 */
function createPropBillboard(
  scene: Scene,
  root: TransformNode,
  propId: string,
  kind: PropKind,
  x: number,
  z: number,
  scale: number,
  material: Material,
): Mesh {
  const dimensions = PROP_DIMENSIONS[kind];
  const mesh = MeshBuilder.CreatePlane(
    `environment.${propId}`,
    { width: dimensions.width * scale, height: dimensions.height * scale },
    scene,
  );
  mesh.position.set(x, (dimensions.height * scale) / 2 + 0.02, z);
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.parent = root;
  return mesh;
}

/**
 * 依据布局创建全部环境视觉。
 * forward 为相机前向（射线方向），用于生成 billboard 遮挡盒。
 */
export async function createGreenHollowEnvironment(
  scene: Scene,
  root: TransformNode,
  forward: { x: number; y: number; z: number },
): Promise<EnvironmentVisuals> {
  const textures = await loadEnvironmentTextures(scene);
  const materials: Material[] = [];

  const groundMaterials = new Map<string, Material>();
  for (const [id, texture] of Object.entries(textures.ground)) {
    const material = createToonMaterial(
      scene,
      `material.environment.ground.${id}`,
      texture,
      { useVertexColors: false, unlit: true },
    );
    groundMaterials.set(id, material);
    materials.push(material);
  }

  const propMaterials = new Map<PropKind, Material>();
  for (const [kind, texture] of Object.entries(textures.props) as Array<
    [PropKind, typeof textures.props[PropKind]]
  >) {
    const material = createToonMaterial(
      scene,
      `material.environment.prop.${kind}`,
      texture,
      { useVertexColors: false, unlit: true, alphaCutoff: 0.35 },
    );
    propMaterials.set(kind, material);
    materials.push(material);
  }

  const groundMeshes = GROUND_PATCHES.map((patch) => {
    const material = groundMaterials.get(patch.texture);
    if (!material) {
      throw new Error(`缺少地面材质：${patch.texture}`);
    }
    return createGroundPatch(scene, root, patch, material);
  });

  const propMeshes: Mesh[] = [];
  const occluders: WorldOccluder[] = [];
  for (const prop of PROPS) {
    const material = propMaterials.get(prop.kind);
    if (!material) {
      throw new Error(`缺少道具材质：${prop.kind}`);
    }
    propMeshes.push(
      createPropBillboard(
        scene,
        root,
        prop.id,
        prop.kind,
        prop.x,
        prop.z,
        prop.scale,
        material,
      ),
    );
    if (prop.occluder) {
      const dimensions = PROP_DIMENSIONS[prop.kind];
      occluders.push({
        id: prop.id,
        box: createCameraAlignedBox(
          {
            x: prop.x,
            y: dimensions.occluderCenterY * prop.scale,
            z: prop.z,
          },
          forward,
          dimensions.occluderHalfWidth * prop.scale,
          dimensions.occluderHalfHeight * prop.scale,
          dimensions.occluderHalfDepth,
        ),
      });
    }
  }

  return {
    groundMeshes,
    propMeshes,
    occluders,
    materials,
    textures,
    keyStats: textures.keyStats,
    dispose() {
      for (const mesh of groundMeshes) {
        mesh.dispose();
      }
      for (const mesh of propMeshes) {
        mesh.dispose();
      }
      for (const material of materials) {
        material.dispose();
      }
      textures.dispose();
    },
  };
}
