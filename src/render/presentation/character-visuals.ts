/**
 * 角色视觉（票 25）：占位角色 glb + P0 程序化角色工厂，统一 toon。
 *
 * - 玩家：assets/character_anime_placeholder.glb（P0 程序化占位角色导出）。
 *   加载后替换成 toon 材质、开启描边，并驱动 glTF 的 walk/run 动画。
 *   glb 内含 morph_anime_placeholder_blink；toon shader 已支持 morph，
 *   update() 会周期性驱动眨眼。
 * - NPC：票 37 验收修复——NPC 原本全是 P0 的程序化胶囊球（高度 1.12m，
 *   球头球身），和玩家的真实 glb 放在一个场景里非常出戏。
 *   现在 NPC 复用 loadPlayerCharacter 的同一条加载/toon/描边管线
 *   （同一份 character_vroid_lod0.glb，缺资源时回落 placeholder，
 *   placeholder 再缺则回落到 createProceduralNpc），并按角色色板卡主色
 *   tint 区分个体。
 *
 *   **身高归一化**：三套模型原始高度不一（VRoid 1.58m / placeholder 1.77m /
 *   程序化 1.12m）。normalizeCharacterHeight() 按包围盒高度统一缩放到
 *   TARGET_CHARACTER_HEIGHT_M，让 NPC 与玩家并排时身高一致。
 *
 * - 敌人：复用 P0 character-proto 的球体 / 精灵，换成 toon 材质。
 */
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
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

/**
 * 角色统一身高（米）：所有角色模型按包围盒缩放到这个高度。
 *
 * 没有这一步，NPC（VRoid 1.58m）与玩家（VRoid 1.58m）巧合一致，但一旦
 * placeholder 回退（1.77m）就会「NPC 矮一头」；程序化 NPC 更矮（1.12m）。
 */
export const TARGET_CHARACTER_HEIGHT_M = 1.7;

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
  // 票 37 验收修复：玩家与 NPC 走同一套身高归一化。
  // VRoid 装进来是 0.297m 的世界高度（模型自带的单位/缩放），
  // 不归一化的话「NPC 与玩家等高」无从谈起（NPC 克隆的是同一份资产，
  // 克隆时会带着玩家缩放后的结果，所以归一化点放在玩家这一步最省事）。
  normalizeCharacterHeight(rootNode, meshes);

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

/**
 * 按包围盒高度把一组网格缩放到目标身高。
 *
 * 用 `getHierarchyBoundingVectors(true)`（**世界坐标**包围盒）而不是逐网格
 * boundingBox：VRoid/placeholder 是多网格资产（身体/头发/眼…），逐网格缩放
 * 会让部件比例错乱。缩放写在**根节点**上，不碰网格自身的顶点。
 *
 * 注意这里乘的是**相对系数** target/measured，而不是把 scaling 设成 target：
 * 包围盒量的是已经含当前根节点缩放的世界高度（实测 VRoid 装进来是
 * 0.297m），直接赋值会把角色放大 5.7 倍。
 *
 * 返回归一化后的实际世界高度；退化（无可测网格 / 高度为 0）时返回原高度（= 不缩放）。
 */
export function normalizeCharacterHeight(
  root: TransformNode,
  meshes: readonly AbstractMesh[],
  targetHeight = TARGET_CHARACTER_HEIGHT_M,
): number {
  const meshesWithVertices = meshes.filter((mesh) => mesh.getTotalVertices() > 0);
  if (meshesWithVertices.length === 0) {
    return 0;
  }
  // 必须从**层级根节点**量：mesh[0] 往往是一个叶子小部件（眼睛/发片），
  // 拿它的包围盒当身高会量到几厘米，整只角色被放大十几倍
  // （实测 VRoid 21 个网格，角色站着一层楼高）。
  const bounds = root.getHierarchyBoundingVectors(true);
  const currentHeight = bounds.max.y - bounds.min.y;
  if (!Number.isFinite(currentHeight) || currentHeight <= 1e-4) {
    return 0;
  }
  root.scaling.setAll(root.scaling.x * (targetHeight / currentHeight));
  // 包围盒基线是局部量，会跟着缩放一起放大；把基线归零，
  // 让角色站在 root 所在的 y=0 地面上。
  root.position.y = root.position.y - bounds.min.y * root.scaling.y;
  return targetHeight;
}

/**
 * NPC 保留的网格数量（票 37 验收 + L5 预算）。
 *
 * VRoid 一个角色有 21 个网格（躯干/头发/眼/嘴/手…）。在等距相机
 * CAMERA_VERTICAL_SPAN=30 的距离下，脸和手只有几个像素，但每个都是一次
 * draw call：4 个 NPC = 84 次，实测把总 draw call 从 172 推到 ~450，
 * 越过 350 的预算。
 *
 * 保留最大的这些（躯干 + 主要衣饰），其余小部件直接不画：
 * **不影响骨骼动画**（动画走 skeleton，与网格数量无关），
 * 也不影响点击（点击用 mesh[0] 做遮挡描边锚点，见 p1-world）。
 *
 * 如果日后要把 NPC 数量上到几十个，应当改走 LOD：远处用合并网格的静态版本。
 */
export const NPC_VISIBLE_MESH_LIMIT = 6;

/**
 * 按包围盒体积从大到小排一组网格（只留有顶点的）。
 */
function meshesByVolumeDesc(meshes: readonly AbstractMesh[]): AbstractMesh[] {
  return meshes
    .filter((mesh) => mesh.getTotalVertices() > 0)
    .slice()
    .sort((a, b) => {
      const boxA = a.getBoundingInfo().boundingBox;
      const boxB = b.getBoundingInfo().boundingBox;
      const volumeA = boxA.extendSize.x * boxA.extendSize.y * boxA.extendSize.z;
      const volumeB = boxB.extendSize.x * boxB.extendSize.y * boxB.extendSize.z;
      return volumeB - volumeA;
    });
}

/**
 * 找一组网格里包围盒最大的那个（多半是躯干）。
 *
 * 描边要画在「体量够大、看得见轮廓」的那块上；挂在小部件上只是白白多一个
 * draw call（描边渲染是一趟额外的绘制）。
 */
function largestMeshOf(meshes: readonly AbstractMesh[]): AbstractMesh | null {
  let best: AbstractMesh | null = null;
  let bestVolume = -1;
  for (const mesh of meshes) {
    if (mesh.getTotalVertices() === 0) {
      continue;
    }
    const info = mesh.getBoundingInfo().boundingBox;
    const volume = info.extendSize.x * info.extendSize.y * info.extendSize.z;
    if (volume > bestVolume) {
      bestVolume = volume;
      best = mesh;
    }
  }
  return best;
}

/** NPC 的 glb 角色：与玩家共用加载/toon/描边管线，但材料与动画独立。 */
export interface NpcCharacter {
  rootNode: TransformNode;
  /** 实际参与渲染的网格（预算裁剪后的子集）。 */
  meshes: AbstractMesh[];
  /** 实际参与渲染的网格数量（预算裁剪后的计数）。 */
  visibleMeshCount: number;
  materials: Material[];
  /** 归一化后的实际身高（米）：默认 TARGET_CHARACTER_HEIGHT_M。 */
  heightM: number;
  /** 色调（受击闪白要还原到它；色板卡主色）。 */
  baseTint: Color3;
  setMoving(moving: boolean): void;
  dispose(): void;
}

/**
 * 从一份**已装载**的 AssetContainer 克隆一个 NPC 角色。
 *
 * 为什么不直接 fetch 同一份 glb 加载 4 次：10MB 的 VRM 每次重新解析 +
 * 上传是纯浪费。用 instantiateModelsToScene 克隆容器里的资产
 * （网格/骨骼/动画都克隆，贴图共享），再按色板卡主色重铺 toon 材质。
 *
 * NPC 只有 4 个，克隆后各占一份网格缓冲（draw call 不变：仍是同一个 mesh 数）。
 */
export function instantiateNpcCharacter(
  scene: Scene,
  source: AssetContainer,
  prefix: string,
  tint: Color3,
  options: { outlineWidth?: number; visibleMeshLimit?: number } = {},
): NpcCharacter {
  // 走 Babylon 的官方多实例入口：网格/骨骼/动画各自一份（贴图共享），
  // 因此 NPC 有独立的走路动画与 skinning 姿态，但显存增量只有顶点缓冲。
  // AssetContainer 本身没有 clone()，这是官方推荐的复制方式。
  const entries = source.instantiateModelsToScene(
    (sourceName) => `${prefix}.${sourceName}`,
    false,
  );

  const meshes = entries.rootNodes
    .flatMap((root) => root.getChildMeshes(false))
    .filter((mesh): mesh is AbstractMesh => mesh.getTotalVertices() > 0);

  const materials: Material[] = [];
  let fallbackTexture: BaseTexture | null = null;
  // 描边只给**最大的那个网格**（多半是身体），不给眼睛/发片等小部件。
  //
  // 预算原因（L5，票 37 验收）：VRoid 一个角色 21 个网格，每个开描边就是
  // 2 个 draw call；4 个 NPC = 168 个。描边在小部件上看不出来（几像素宽），
  // 却把总 draw call 从 136 推到 400+（预算 350）。
  const outlineSource = largestMeshOf(meshes);
  // 预算裁剪：只画最大的 NPC_VISIBLE_MESH_LIMIT 个网格，其余小部件
  // 保留节点但关掉渲染（骨骼动画仍作用于它们，切近距离时能重新打开）。
  const ranked = meshesByVolumeDesc(meshes);
  const visibleSet = new Set(ranked.slice(0, options.visibleMeshLimit ?? NPC_VISIBLE_MESH_LIMIT));
  let visibleCount = 0;
  for (const mesh of meshes) {
    if (!visibleSet.has(mesh)) {
      // 直接 dispose 掉看不见的小部件（脸/眼/发片）。它们在等距相机下只有
      // 几个像素，保留下来只会：① 多占显存 ② 每份都独立编译一套着色器
      // （NPC glb 化后编译量翻几倍，实测把 whenReadyAsync 拖到分钟级）。
      mesh.dispose(false, false);
      continue;
    }
    visibleCount += 1;
    const useVertexColors = mesh.isVerticesDataPresent("color");
    let texture = baseTextureOf(mesh.material);
    if (!texture) {
      if (!fallbackTexture) {
        fallbackTexture = createWhiteTexture(scene);
      }
      texture = fallbackTexture;
    }
    // 一律压色板卡主色：VRoid 的头发/脸有各自贴图，不压色的话
    // 四个 NPC 会长得一模一样，认不出谁是谁。
    const material = createToonMaterial(
      scene,
      `material.${prefix}.${mesh.name}`,
      texture,
      { useVertexColors, rimStrength: 0.55, tint },
    );
    materials.push(material);
    mesh.material = material;
    mesh.useVertexColors = useVertexColors;
    const isOutlineSource = mesh === outlineSource;
    mesh.renderOutline = false;
    void isOutlineSource;
    if (isOutlineSource) {
      mesh.outlineWidth = options.outlineWidth ?? OUTLINE_WIDTH;
    }
    mesh.outlineColor = OUTLINE_COLOR;
    mesh.isPickable = true;
  }

  const rootNode =
    entries.rootNodes.find((root): root is TransformNode => root instanceof TransformNode) ??
    new TransformNode(`${prefix}.root`, scene);
  const heightM = normalizeCharacterHeight(rootNode, meshes);

  const walk = entries.animationGroups.find((group) => /walk/i.test(group.name)) ?? null;
  for (const group of entries.animationGroups) {
    group.stop();
  }

  return {
    rootNode,
    meshes,
    visibleMeshCount: visibleCount,
    materials,
    heightM,
    baseTint: tint,

    setMoving(moving: boolean): void {
      if (walk === null) {
        return;
      }
      if (moving) {
        walk.start(true, 1.0);
      } else {
        walk.stop();
        walk.reset();
      }
    },

    dispose(): void {
      for (const group of entries.animationGroups) {
        group.stop();
      }
      // Babylon 的官方克隆清理入口：连同克隆出的网格/骨骼/动画一起销毁。
      entries.dispose();
      for (const material of materials) {
        material.dispose();
      }
    },
  };
}

/**
 * 独立装载一份 NPC 用的 glb 容器（**不入场景层级**）。
 *
 * 为什么不能直接复用玩家的 AssetContainer：玩家的 rootNode 之后会被
 * `parent` 到场景根节点上（p1-world 这么做），Babylon 的
 * `instantiateModelsToScene` 会校验容器层级，发现「有 parent 不在容器里」
 * 就整批放弃克隆（实测：4 个 NPC 全都拿不到网格）。
 *
 * 所以这里另装一份**干净的**容器作为 NPC 的克隆源。代价是同一份 glb
 * 解析两次（一次性，约 100ms 级别），换来 NPC 独立动画 + 不受玩家层级
 * 摆布；顶点/贴图仍然共享，不是 4 份显存。
 */
export async function loadNpcCharacterBase(
  scene: Scene,
  url: string,
  fileName: string,
): Promise<AssetContainer> {
  const file = await fetchGlb(url, fileName);
  const container = await SceneLoader.LoadAssetContainerAsync("", file, scene);
  // addAllToScene 会把资产挂进场景；NPC 源容器只需要「已解析」，不入场景。
  // 这里刻意不调用它——instantiateModelsToScene 自己会负责加进场景。
  return container;
}

/**
 * NPC 视觉装配所需的输入：一份**未入场景**的 glb 容器。
 *
 * 「NPC 用同一份 glb」的意义在这里体现：场景只下载一次字节，
 * NPC 是它的一份容器多实例化出来的。
 */
export function npcCharacterFromBase(
  scene: Scene,
  base: AssetContainer | null,
  prefix: string,
  tint: Color3,
): NpcCharacter | null {
  if (base === null) {
    return null;
  }
  try {
    return instantiateNpcCharacter(scene, base, prefix, tint);
  } catch (error) {
    // 克隆失败不该让整个场景起不来：调用方回落到程序化角色。
    console.warn(`NPC ${prefix} 克隆 glb 失败，回落程序化角色：`, error);
    return null;
  }
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

/**
 * 敌人精灵（票 36）：白底立面贴图抠白后的 billboard。
 * 两种新敌人（冲锋型/吐弹型）各有独立贴图，史莱姆仍走上面的程序化球体。
 * 贴图长宽比 1024:765，billboard 用 1.9m × 1.42m 保持不拉伸。
 */
export function createSpriteEnemy(
  scene: Scene,
  root: TransformNode,
  prefix: string,
  texture: BaseTexture,
  options: { width?: number; height?: number; outline?: boolean } = {},
): ProceduralCharacter {
  const width = options.width ?? 1.9;
  const height = options.height ?? 1.42;
  const mesh = MeshBuilder.CreatePlane(`${prefix}mesh`, { width, height }, scene);
  mesh.parent = root;
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  const material = createToonMaterial(scene, `${prefix}material`, texture, {
    useVertexColors: false,
    unlit: true,
    alphaCutoff: 0.35,
  });
  mesh.material = material;
  if (options.outline !== false) {
    mesh.renderOutline = true;
    mesh.outlineWidth = OUTLINE_WIDTH;
    mesh.outlineColor = OUTLINE_COLOR;
  }

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
