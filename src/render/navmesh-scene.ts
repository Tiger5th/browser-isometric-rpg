import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import type { Bounds2D, BoxObstacleSpec } from "../logic/navmesh-geometry";
import { updateOrthographicFrustum } from "./camera";
import { GREYBOX_REGION_ID } from "./greybox";

const GRID_TEXTURE_SIZE = 256;
const GRID_WORLD_STEP = 8;

function createGridMaterial(
  scene: Scene,
  name: string,
  tint: Color3,
  bounds: Bounds2D,
): StandardMaterial {
  const texture = new DynamicTexture(
    `${name}.grid`,
    { width: GRID_TEXTURE_SIZE, height: GRID_TEXTURE_SIZE },
    scene,
    false,
  );
  const context = texture.getContext();
  context.fillStyle = "#252b34";
  context.fillRect(0, 0, GRID_TEXTURE_SIZE, GRID_TEXTURE_SIZE);
  context.strokeStyle = "#323b47";
  context.lineWidth = 2;
  const cells = 4;
  for (let index = 0; index <= cells; index += 1) {
    const offset = (GRID_TEXTURE_SIZE / cells) * index;
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(offset, GRID_TEXTURE_SIZE);
    context.stroke();
    context.beginPath();
    context.moveTo(0, offset);
    context.lineTo(GRID_TEXTURE_SIZE, offset);
    context.stroke();
  }
  texture.update();
  texture.uScale = Math.max(1, (bounds.maxX - bounds.minX) / (GRID_WORLD_STEP * cells));
  texture.vScale = Math.max(1, (bounds.maxZ - bounds.minZ) / (GRID_WORLD_STEP * cells));

  const material = new StandardMaterial(name, scene);
  material.diffuseTexture = texture;
  material.diffuseColor = tint;
  material.specularColor = Color3.Black();
  return material;
}

/** 程序化地面：网格纹理 + 区域色调，不依赖正式美术资产。 */
export function createGroundVisual(
  scene: Scene,
  root: TransformNode,
  bounds: Bounds2D,
  name: string,
  tint: Color3,
  y = 0,
): void {
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const ground = MeshBuilder.CreateGround(
    name,
    { width, height: depth, subdivisions: 1 },
    scene,
  );
  ground.position.set((bounds.minX + bounds.maxX) / 2, y, (bounds.minZ + bounds.maxZ) / 2);
  ground.material = createGridMaterial(scene, `${name}.material`, tint, bounds);
  ground.isPickable = false;
  ground.parent = root;
}

/** 障碍物视觉体；与 navmesh 输入几何使用同一组 spec。 */
export function createObstacleVisuals(
  scene: Scene,
  root: TransformNode,
  specs: readonly BoxObstacleSpec[],
  materials: readonly StandardMaterial[],
): void {
  specs.forEach((spec, index) => {
    const mesh = MeshBuilder.CreateBox(
      `${spec.name}.visual`,
      { width: spec.width, height: spec.height, depth: spec.depth },
      scene,
    );
    mesh.position.set(spec.x, spec.height / 2, spec.z);
    mesh.material = materials[index % materials.length];
    mesh.isPickable = false;
    mesh.parent = root;
  });
}

export function createObstacleMaterial(
  scene: Scene,
  name: string,
  color: Color3,
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  return material;
}

/** 场景切换相机可视范围；teardown 时用默认值恢复。 */
export function setCameraSpan(scene: Scene, verticalSpan: number): void {
  const camera = scene.activeCamera;
  if (!camera) {
    return;
  }
  const engine = scene.getEngine();
  const height = engine.getRenderHeight();
  const aspect = height > 0 ? engine.getRenderWidth() / height : 1;
  updateOrthographicFrustum(camera, aspect, verticalSpan);
}

/** 寻路场景与 hello 灰盒互斥：进入场景时隐藏，退出时恢复。 */
export function setGreyboxEnabled(scene: Scene, enabled: boolean): void {
  scene.getTransformNodeByName(GREYBOX_REGION_ID)?.setEnabled(enabled);
}
