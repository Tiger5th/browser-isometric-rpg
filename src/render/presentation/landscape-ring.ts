/**
 * 边界景观环带 + 渐暗雾 + 统一主光（票 28，user stories 18/19）。
 *
 * 渲染层装配：
 * - 环带地面：一块铺到 LANDSCAPE_BOUNDS 的大 ground，颜色比区域内暗一档；
 * - 远景：8 座低模山丘（圆锥）+ 16 棵远景树（细圆柱 + 球冠），全部在
 *   可行走区域外、不进 navmesh、不参与碰撞；
 * - 雾：Scene 线性雾，从 FOG_START 渐暗到 FOG_END，颜色是锚定图天空的灰蓝紫，
 *   四个方向都不会出现黑色虚无；
 * - 主光：全场唯一 DirectionalLight，方向/颜色来自 world-physics 常量
 *   （左上 45°、暖白、暗部紫灰），替换 main.ts 里默认的双光源设置。
 */
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import {
  AMBIENT_COLOR,
  FOG_COLOR,
  FOG_END,
  FOG_START,
  KEY_LIGHT_COLOR,
  KEY_LIGHT_DIRECTION,
  LANDSCAPE_BOUNDS,
  LANDSCAPE_GROUND_COLOR,
  LANDSCAPE_HILLS,
  LANDSCAPE_HILL_COLOR,
  LANDSCAPE_TREE_COLOR,
  LANDSCAPE_TREES,
  SCENE_LIGHT_INTENSITY,
} from "./world-physics";

// AMBIENT_COLOR 目前由 toon shader 的 ambientColor uniform 承载（见 toonMaterial.ts），
// 这里保留引用以便未来给 StandardMaterial 网格也用同一紫灰补色。
void AMBIENT_COLOR;

export interface LandscapeVisuals {
  meshes: Mesh[];
  materials: StandardMaterial[];
  dispose(): void;
}

function flatMaterial(
  scene: Scene,
  name: string,
  color: { r: number; g: number; b: number },
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = new Color3(color.r, color.g, color.b);
  // 全自发光（disableLighting 下 diffuse 不参与着色）：
  // 环带是远景剪影，自发光保证雾能把它干净地混到明亮的雾色上；
  // 若用暗 emissive（color*0.55），屏幕角落的暗角会把山丘压成近黑，
  // 正好撞上「四方向无黑色虚无」的验收线（ego-browser 截图复现过）。
  material.emissiveColor = new Color3(color.r, color.g, color.b);
  material.specularColor = Color3.Black();
  material.disableLighting = true;
  return material;
}

/**
 * 关掉场景默认的双光源（main.ts 的 hemi + sun），改为票 28 的唯一主光。
 * 自定义 toon shader 不读 Babylon 灯光，但环境件/地面是 unlit 的，
 * 因此这一步主要服务于「全场唯一主光」这一事实本身（ ego-browser 断言用）。
 */
export function installUnifiedKeyLight(scene: Scene): DirectionalLight {
  for (const light of scene.lights.slice()) {
    light.setEnabled(false);
  }
  const light = new DirectionalLight(
    "light.key.world",
    new Vector3(KEY_LIGHT_DIRECTION.x, KEY_LIGHT_DIRECTION.y, KEY_LIGHT_DIRECTION.z),
    scene,
  );
  light.intensity = SCENE_LIGHT_INTENSITY;
  light.diffuse = new Color3(KEY_LIGHT_COLOR.r, KEY_LIGHT_COLOR.g, KEY_LIGHT_COLOR.b);
  light.specular = Color3.Black();
  return light;
}

/** 渐暗雾：线性模式，颜色取锚定图天空，避免纯黑。 */
export function installLandscapeFog(scene: Scene): void {
  scene.fogEnabled = true;
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogStart = FOG_START;
  scene.fogEnd = FOG_END;
  scene.fogColor = new Color3(FOG_COLOR.r, FOG_COLOR.g, FOG_COLOR.b);
}

/**
 * 低细节景观环带：地面 + 山丘 + 远景树。
 * 全部 disableLighting 的扁平材质（远景不需要光照），且不参与碰撞/寻路。
 */
export function createLandscapeRing(scene: Scene, root: TransformNode): LandscapeVisuals {
  const meshes: Mesh[] = [];
  const materials: StandardMaterial[] = [];

  const groundMaterial = flatMaterial(scene, "material.landscape.ground", LANDSCAPE_GROUND_COLOR);
  const hillMaterial = flatMaterial(scene, "material.landscape.hill", LANDSCAPE_HILL_COLOR);
  const treeMaterial = flatMaterial(scene, "material.landscape.tree", LANDSCAPE_TREE_COLOR);
  materials.push(groundMaterial, hillMaterial, treeMaterial);

  const width = LANDSCAPE_BOUNDS.maxX - LANDSCAPE_BOUNDS.minX;
  const depth = LANDSCAPE_BOUNDS.maxZ - LANDSCAPE_BOUNDS.minZ;
  const ground = MeshBuilder.CreateGround(
    "landscape.ground",
    { width, height: depth, subdivisions: 1 },
    scene,
  );
  ground.position.set(
    (LANDSCAPE_BOUNDS.minX + LANDSCAPE_BOUNDS.maxX) / 2,
    -0.06,
    (LANDSCAPE_BOUNDS.minZ + LANDSCAPE_BOUNDS.maxZ) / 2,
  );
  ground.material = groundMaterial;
  ground.isPickable = false;
  ground.parent = root;
  meshes.push(ground);

  for (const hill of LANDSCAPE_HILLS) {
    const mesh = MeshBuilder.CreateCylinder(
      `landscape.${hill.id}`,
      {
        height: hill.height,
        diameterTop: hill.radius * 0.35,
        diameterBottom: hill.radius * 2,
        tessellation: 7,
      },
      scene,
    );
    mesh.position.set(hill.x, hill.height / 2 - 0.4, hill.z);
    mesh.material = hillMaterial;
    mesh.isPickable = false;
    mesh.parent = root;
    meshes.push(mesh);
  }

  for (const tree of LANDSCAPE_TREES) {
    const height = 3.2 * tree.scale;
    const trunk = MeshBuilder.CreateCylinder(
      `landscape.${tree.id}.trunk`,
      { height: height * 0.35, diameter: 0.28 * tree.scale, tessellation: 4 },
      scene,
    );
    trunk.position.set(tree.x, height * 0.175, tree.z);
    trunk.material = treeMaterial;
    trunk.isPickable = false;
    trunk.parent = root;
    meshes.push(trunk);

    const crown = MeshBuilder.CreateCylinder(
      `landscape.${tree.id}.crown`,
      {
        height: height * 0.75,
        diameterTop: 0.01,
        diameterBottom: 1.7 * tree.scale,
        tessellation: 5,
      },
      scene,
    );
    crown.position.set(tree.x, height * 0.35 + height * 0.375, tree.z);
    crown.material = treeMaterial;
    crown.isPickable = false;
    crown.parent = root;
    meshes.push(crown);
  }

  return {
    meshes,
    materials,
    dispose() {
      for (const mesh of meshes) {
        mesh.dispose();
      }
      for (const material of materials) {
        material.dispose();
      }
    },
  };
}
