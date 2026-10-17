/**
 * 翠谷正式环境视觉（票 25 + 票 28 网格化）。
 *
 * - 地面：每个 patch 一个 Ground mesh，UV 按世界尺寸/tileSize 缩放，
 *   贴图设为 WRAP，因此一张 1024² 贴图可以自然平铺整个区域。
 * - 硬碰撞件（树/石墙/木桶/木箱）：票 28 起改为**程序化几何拼装的真网格**
 *   （prop-mesh-recipe 配方 + 同一批 Gemini 贴图的 UV 窗口），
 *   挂 Babylon collider（checkCollisions + ellipsoid）供 moveWithCollisions 使用。
 * - 灌木：保持 billboard 可穿；角色进入时由表现层按 bushOcclusionAt 半透明。
 * - 遮挡盒：网格件的 OBB 与视觉包围盒一致，供射线-OBB 遮挡描边使用。
 */
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
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
  type PropPlacement,
} from "./green-hollow-layout";
import { buildPropMesh, type MeshedPropKind } from "./prop-mesh-builder";
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
  /** billboard 灌木（可穿）。 */
  propMeshes: Mesh[];
  /** 网格化硬碰撞件的全部零件网格（树/墙/桶/箱）。 */
  meshedParts: Mesh[];
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
  namePrefix = "environment",
): Mesh {
  const mesh = MeshBuilder.CreateGround(
    `${namePrefix}.${patch.id}`,
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
  namePrefix = "environment",
): Mesh {
  const dimensions = PROP_DIMENSIONS[kind];
  const mesh = MeshBuilder.CreatePlane(
    `${namePrefix}.${propId}`,
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
  return createRegionEnvironment(scene, root, forward, {
    patches: GROUND_PATCHES,
    props: PROPS,
  });
}

/**
 * 按任意一组「地面贴片 + 道具」布局创建环境视觉（票 35：区域 2 复用同一管线）。
 *
 * 区域 2 不新增渲染机制，只是换一组布局数据与（可选的）贴图 tint；
 * 因此这里把翠谷的实现收敛成一个参数化入口，翠谷自己只是一次特例调用。
 */
export async function createRegionEnvironment(
  scene: Scene,
  root: TransformNode,
  forward: { x: number; y: number; z: number },
  layout: {
    patches: readonly GroundPatch[];
    props: readonly PropPlacement[];
    /** 整体色调（区域 2 用来把复用的主区域贴图压暗）。 */
    tint?: Color3;
    /** 命名空间前缀，避免两区域的网格重名。 */
    namePrefix?: string;
  },
): Promise<EnvironmentVisuals> {
  const textures = await loadEnvironmentTextures(scene);
  const materials: Material[] = [];
  const prefix = layout.namePrefix ?? "environment";
  const tint = layout.tint;

  const groundMaterials = new Map<string, Material>();
  for (const [id, texture] of Object.entries(textures.ground)) {
    const material = createToonMaterial(
      scene,
      `material.${prefix}.ground.${id}`,
      texture,
      { useVertexColors: false, unlit: true, ...(tint ? { tint } : {}) },
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
      `material.${prefix}.prop.${kind}`,
      texture,
      {
        useVertexColors: false,
        unlit: true,
        alphaCutoff: 0.35,
        ...(tint ? { tint } : {}),
      },
    );
    propMaterials.set(kind, material);
    materials.push(material);
  }

  const groundMeshes = layout.patches.map((patch) => {
    const material = groundMaterials.get(patch.texture);
    if (!material) {
      throw new Error(`缺少地面材质：${patch.texture}`);
    }
    return createGroundPatch(scene, root, patch, material, prefix);
  });

  const propMeshes: Mesh[] = [];
  const meshedParts: Mesh[] = [];
  const occluders: WorldOccluder[] = [];
  for (const prop of layout.props) {
    const material = propMaterials.get(prop.kind);
    if (!material) {
      throw new Error(`缺少道具材质：${prop.kind}`);
    }
    if (prop.kind === "bush") {
      // 灌木：billboard 可穿（user story 16），保持票 25 方案。
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
          prefix,
        ),
      );
    } else {
      // 树/石墙/木桶/木箱：真网格 + 硬碰撞（user story 15）。
      meshedParts.push(
        ...buildPropMesh({
          scene,
          root,
          propId: prop.id,
          kind: prop.kind as MeshedPropKind,
          x: prop.x,
          z: prop.z,
          scale: prop.scale,
          material,
        }),
      );
    }

    if (prop.occluder) {
      const dimensions = PROP_DIMENSIONS[prop.kind];
      // 遮挡盒沿用票 25 的尺寸（树干/墙体的窄盒 + billboard 深度）：
      // 射线-OBB 的每帧成本对盒子的尺寸不敏感，但「树冠全宽」会让描边在
      // 离树干很远的地方触发，观感反而发散；硬碰撞尺寸另见
      // world-physics.buildPropColliders（那才是「不可穿」的权威）。
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
    meshedParts,
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
      for (const mesh of meshedParts) {
        mesh.dispose();
      }
      for (const material of materials) {
        material.dispose();
      }
      textures.dispose();
    },
  };
}
