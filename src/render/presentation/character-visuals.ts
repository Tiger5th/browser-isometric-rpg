/**
 * 角色视觉（票 25）：占位角色 glb + P0 程序化角色工厂，统一 toon。
 *
 * - 玩家：assets/character_anime_placeholder.glb（P0 程序化占位角色导出）。
 *   加载后替换成 toon 材质、开启描边，并驱动 glTF 的 walk/run 动画。
 *   glb 内含 morph_anime_placeholder_blink；toon shader 已支持 morph，
 *   update() 会周期性驱动眨眼。
 * - NPC / 敌人：复用 P0 character-proto 的程序化角色/球体，换成 toon 材质，
 *   保持与玩家一致的描边与色阶。
 */
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

import { createToonMaterial } from "../anime/toonMaterial";
import {
  CHARACTER_ANIMATION_FRAMES,
  createCharacterAnimations,
  createCharacterPrototype,
  createCharacterSkeleton,
} from "../character-proto";
import { createWhiteTexture } from "./textures";

const OUTLINE_WIDTH = 0.022;
const OUTLINE_COLOR = new Color3(0.05, 0.04, 0.08);
const BLINK_INTERVAL_MS = 3_600;
const BLINK_DURATION_MS = 140;
/** 眨眼 morph 目标名（占位资产 morph_anime_placeholder_blink；VRM 系 blink/まばたき）。 */
const BLINK_MORPH_PATTERN = /blink|まばたき/i;

export interface PlayerCharacter {
  rootNode: TransformNode;
  meshes: AbstractMesh[];
  container: AssetContainer;
  materials: Material[];
  walk: AnimationGroup | null;
  run: AnimationGroup | null;
  moving: boolean;
  morphTargetCount: number;
  morphTargetNames: string[];
  /** 设置移动状态：移动时循环 walk，停下后回到待机（停止动画组）。 */
  setMoving(moving: boolean): void;
  /** 立刻眨眼（ego-browser 验证/截图用）。 */
  triggerBlink(holdMs?: number): void;
  /** 每帧推进眨眼计时。 */
  update(deltaMs: number): void;
  /** 当前 morph 影响值（眨眼时为 1）。 */
  getMorphInfluence(): number;
  /** toon shader 是否实际编译了 MORPHTARGETS 定义。 */
  isMorphShaderReady(): boolean;
  dispose(): void;
}

function baseTextureOf(material: Material | null) {
  if (!material) {
    return null;
  }
  const active = material.getActiveTextures();
  return active[0] ?? null;
}

/** 从 glTF 材质读基色（PBR/Standard/Unlit 都落在 albedo/diffuse 上）。 */
function baseColorOf(material: Material | null): Color3 | null {
  if (!material) {
    return null;
  }
  const candidate = material as Material & {
    albedoColor?: Color3;
    diffuseColor?: Color3;
  };
  return candidate.albedoColor ?? candidate.diffuseColor ?? null;
}

async function fetchGlb(url: string, fileName: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`加载角色资产失败：HTTP ${response.status} (${fileName})`);
  }
  const bytes = await response.arrayBuffer();
  return new File([bytes], fileName, { type: "model/gltf-binary" });
}

export async function loadPlayerCharacter(
  scene: Scene,
  url: string,
  fileName: string,
): Promise<PlayerCharacter> {
  const file = await fetchGlb(url, fileName);
  const container = await SceneLoader.LoadAssetContainerAsync("", file, scene);
  container.addAllToScene();

  const meshes = container.meshes.filter(
    (mesh): mesh is AbstractMesh => mesh.getTotalVertices() > 0,
  );
  if (meshes.length === 0) {
    throw new Error("角色资产没有可渲染网格");
  }

  const materials: Material[] = [];
  let morphTargetCount = 0;
  const morphTargetNames: string[] = [];
  /** 无贴图网格共享的白贴图（懒创建，整个角色一张）。 */
  let fallbackTexture: BaseTexture | null = null;

  for (const mesh of meshes) {
    const useVertexColors = mesh.isVerticesDataPresent("color");
    let texture = baseTextureOf(mesh.material);
    let tint: Color3 | undefined;
    if (!texture) {
      // VRM 常见单色材质网格（无贴图，只有 baseColor 因子）：
      // 用共享白贴图 + 材质基色 tint 保持颜色，不再直接报错。
      if (!fallbackTexture) {
        fallbackTexture = createWhiteTexture(scene);
      }
      texture = fallbackTexture;
      tint = baseColorOf(mesh.material) ?? undefined;
    }
    const material = createToonMaterial(
      scene,
      `material.player.${mesh.name}`,
      texture,
      { useVertexColors, rimStrength: 0.55, tint },
    );
    materials.push(material);
    mesh.material = material;
    mesh.useVertexColors = useVertexColors;
    mesh.renderOutline = true;
    mesh.outlineWidth = OUTLINE_WIDTH;
    mesh.outlineColor = OUTLINE_COLOR;
    mesh.isPickable = true;

    const manager = mesh.morphTargetManager;
    if (manager) {
      morphTargetCount += manager.numTargets;
      for (let index = 0; index < manager.numTargets; index += 1) {
        const target = manager.getTarget(index);
        if (target) {
          morphTargetNames.push(target.name);
        }
      }
    }
  }

  const rootNode =
    container.rootNodes.find((node) => node instanceof TransformNode) ??
    new TransformNode("player.root", scene);
  if (!rootNode.parent) {
    rootNode.parent = null;
  }

  const walk =
    container.animationGroups.find((group) => /walk/i.test(group.name)) ??
    container.animationGroups[0] ??
    null;
  const run =
    container.animationGroups.find((group) => /run/i.test(group.name)) ?? null;
  for (const group of container.animationGroups) {
    group.stop();
  }

  let blinkUntil = 0;
  let nextBlinkAt = performance.now() + BLINK_INTERVAL_MS;
  let morphShaderReady = false;
  let morphShaderCheckedAt = 0;

  /**
   * 眨眼 morph 定位：真实 VRM 是多网格资产，morph 目标通常只挂在头部网格
   * （占位资产是单网格），且目标顺序不保证（VRM 1.0 表情命名驱动）。
   * 因此按名字扫描所有网格的 morphTargetManager，找 blink/まばたき 目标；
   * 找不到名字匹配时退回第一个有 morph 的网格的 0 号目标（占位行为）。
   */
  let blinkManager: MorphTargetManager | null = null;
  let blinkTargetIndexValue = 0;
  let blinkMaterial: Material | null = null;
  for (let index = 0; index < meshes.length; index += 1) {
    const manager = meshes[index].morphTargetManager;
    if (!manager || manager.numTargets === 0) {
      continue;
    }
    if (!blinkManager) {
      // 兜底：第一个有 morph 的网格
      blinkManager = manager;
      blinkTargetIndexValue = 0;
      blinkMaterial = materials[index] ?? null;
    }
    for (let targetIndex = 0; targetIndex < manager.numTargets; targetIndex += 1) {
      const target = manager.getTarget(targetIndex);
      if (target && BLINK_MORPH_PATTERN.test(target.name)) {
        blinkManager = manager;
        blinkTargetIndexValue = targetIndex;
        blinkMaterial = materials[index] ?? null;
        break;
      }
    }
    if (
      blinkManager === manager &&
      blinkTargetIndexValue !== 0 &&
      blinkMaterial === materials[index]
    ) {
      break; // 已按名字命中，停止扫描
    }
  }

  const blinkInfluence = (): number => {
    if (!blinkManager) {
      return 0;
    }
    return blinkManager.getTarget(blinkTargetIndexValue)?.influence ?? 0;
  };

  const player: PlayerCharacter = {
    rootNode,
    meshes,
    container,
    materials,
    walk,
    run,
    moving: false,
    morphTargetCount,
    morphTargetNames,

    setMoving(moving: boolean): void {
      if (moving === player.moving) {
        return;
      }
      player.moving = moving;
      if (!walk) {
        return;
      }
      if (moving) {
        walk.start(true, 1.0);
      } else {
        walk.stop();
        walk.reset();
      }
    },

    triggerBlink(holdMs = BLINK_DURATION_MS): void {
      blinkUntil = performance.now() + holdMs;
      nextBlinkAt = blinkUntil + BLINK_INTERVAL_MS;
      if (blinkManager) {
        const target = blinkManager.getTarget(blinkTargetIndexValue);
        if (target) {
          target.influence = 1;
        }
      }
    },

    update(deltaMs: number): void {
      const now = performance.now();
      if (now >= nextBlinkAt) {
        player.triggerBlink();
      }
      if (blinkManager && now > blinkUntil) {
        const target = blinkManager.getTarget(blinkTargetIndexValue);
        if (target && target.influence !== 0) {
          target.influence = 0;
        }
      }
      void deltaMs;

      // shader 编译是异步的：每 500ms 检查一次 morph 定义是否生效。
      // 检查的是携带眨眼 morph 的网格材质（真实 VRM 的 morph 不在 0 号网格）。
      if (!morphShaderReady && now - morphShaderCheckedAt > 500) {
        morphShaderCheckedAt = now;
        const effect = blinkMaterial?.getEffect() ?? materials[0]?.getEffect();
        if (effect?.defines?.includes("MORPHTARGETS")) {
          morphShaderReady = true;
        }
      }
    },

    getMorphInfluence: blinkInfluence,
    isMorphShaderReady: () => morphShaderReady,

    dispose(): void {
      for (const group of container.animationGroups) {
        group.stop();
      }
      container.dispose();
      for (const material of materials) {
        material.dispose();
      }
    },
  };

  return player;
}

export interface ProceduralCharacter {
  mesh: Mesh;
  skeleton: Skeleton | null;
  material: Material;
  dispose(): void;
}

/** NPC：P0 程序化骨骼角色 + toon 材质。 */
export function createProceduralNpc(
  scene: Scene,
  root: TransformNode,
  prefix: string,
  tint: Color3,
  whiteTexture: BaseTexture,
): ProceduralCharacter {
  const mesh = createCharacterPrototype(scene, prefix);
  mesh.parent = root;
  const material = createToonMaterial(scene, `${prefix}material`, whiteTexture, {
    useVertexColors: false,
    tint,
  });
  mesh.material = material;
  mesh.renderOutline = true;
  mesh.outlineWidth = OUTLINE_WIDTH;
  mesh.outlineColor = OUTLINE_COLOR;

  const animations = createCharacterAnimations();
  const skeleton = createCharacterSkeleton(scene, prefix, 0, animations);
  mesh.skeleton = skeleton;
  scene.beginAnimation(skeleton, 0, CHARACTER_ANIMATION_FRAMES, true, 0.8);

  return {
    mesh,
    skeleton,
    material,
    dispose() {
      scene.stopAnimation(skeleton);
      skeleton.dispose();
      mesh.dispose();
      material.dispose();
    },
  };
}

/** 敌人：史莱姆球体 + toon 材质（与玩家/NPC 同一套色阶与描边）。 */
export function createSlimeEnemy(
  scene: Scene,
  root: TransformNode,
  prefix: string,
  tint: Color3,
  whiteTexture: BaseTexture,
): ProceduralCharacter {
  const mesh = MeshBuilder.CreateSphere(
    `${prefix}mesh`,
    { diameter: 0.9, segments: 10 },
    scene,
  );
  mesh.parent = root;
  const material = createToonMaterial(scene, `${prefix}material`, whiteTexture, {
    useVertexColors: false,
    tint,
    rimStrength: 0.6,
  });
  mesh.material = material;
  mesh.renderOutline = true;
  mesh.outlineWidth = OUTLINE_WIDTH;
  mesh.outlineColor = OUTLINE_COLOR;

  return {
    mesh,
    skeleton: null,
    material,
    dispose() {
      mesh.dispose();
      material.dispose();
    },
  };
}
