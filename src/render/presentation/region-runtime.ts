/**
 * 区域运行时（票 35）：把「一个区域的可视部分」打包成可创建/销毁的整体。
 *
 * 票 35 之前，翠谷的场景装配全部写在 p1-world 的 setup 里，切区意味着把
 * 那几十行 setup 再抄一遍。这里把「布局数据 → 环境网格 + 硬碰撞体 +
 * navmesh」收敛成一个工厂：切区 = 销毁旧 runtime + 建新 runtime。
 *
 * 两区域共用同一套渲染机制，差异只有布局数据与暗色调 tint，
 * 因此这里没有新引擎机制，只有参数化。环带/主光/雾仍由 landscape-ring
 * 负责（山丘与远景树摆位已是参数）。
 */

import type { Material } from "@babylonjs/core/Materials/material";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { NavMeshQuery } from "recast-navigation";

import {
  createRegionGeometry,
  type BoxObstacleSpec,
} from "../../logic/navmesh-geometry";
import type { RegionLinkageExit } from "../../logic/region-linkage";
import {
  createRegionEnvironment,
  type EnvironmentVisuals,
} from "./environment-visuals";
import type { GreenHollowNavigation, PathPoint } from "./green-hollow-navigation";
import type { GroundPatch, PropPlacement } from "./green-hollow-layout";
import { buildNavMesh, initializeNavigation } from "../navigation";
import {
  buildPropColliders,
  colliderObstacleSpecs,
  type Bounds2DLike,
  type PropCollider,
} from "./world-physics";

export interface RegionRuntimeLayout {
  regionId: string;
  bounds: Bounds2DLike;
  groundPatches: readonly GroundPatch[];
  props: readonly PropPlacement[];
  exits: readonly RegionLinkageExit[];
  /** 整体色调（区域 2 压暗复用贴图用；缺省 = 原色）。 */
  tint?: { r: number; g: number; b: number };
  /** 网格命名空间前缀，避免两区域重名。 */
  namePrefix: string;
  /** 水面贴片（不可行走，进 navmesh 排除）。 */
  waterPatch?: GroundPatch;
}

export interface RegionRuntime {
  readonly regionId: string;
  readonly bounds: Bounds2DLike;
  readonly exits: readonly RegionLinkageExit[];
  readonly props: readonly PropPlacement[];
  readonly colliders: readonly PropCollider[];
  readonly environment: EnvironmentVisuals;
  readonly navigation: GreenHollowNavigation;
  dispose(): void;
}

/**
 * 硬碰撞体 → Recast 障碍盒：与翠谷共用同一份推导逻辑（单一数据源），
 * 追加水面矩形（水洼不能走）。
 */
export function regionNavObstacleSpecs(
  colliders: readonly PropCollider[],
  waterPatch: GroundPatch | undefined,
): BoxObstacleSpec[] {
  const specs: BoxObstacleSpec[] = colliderObstacleSpecs([...colliders]);
  if (waterPatch !== undefined) {
    specs.push({
      name: `obstacle.${waterPatch.id}.water`,
      x: waterPatch.x,
      z: waterPatch.z,
      width: waterPatch.width,
      depth: waterPatch.depth,
      height: 1.5,
    });
  }
  return specs;
}

/** 按可行走区 + 障碍盒构建一个区域的 navmesh 查询器。 */
export async function createRegionNavigation(
  bounds: Bounds2DLike,
  obstacles: BoxObstacleSpec[],
): Promise<GreenHollowNavigation> {
  await initializeNavigation();
  const stats = buildNavMesh(createRegionGeometry(bounds, obstacles, 4));
  const navMesh = stats.navMesh;
  const query = new NavMeshQuery(navMesh);
  // 角色/点击点可能短暂落在障碍边缘：扩大最近多边形搜索范围，
  // 让 computePath 能把起终点吸附到可行走面，而不是直接失败。
  query.defaultQueryHalfExtents = { x: 5, y: 5, z: 5 };

  return {
    findPath(from: PathPoint, to: PathPoint) {
      const result = query.computePath(
        { x: from.x, y: 0, z: from.z },
        { x: to.x, y: 0, z: to.z },
      );
      if (!result.success || result.path.length === 0) {
        return null;
      }
      return result.path.map((point) => ({ x: point.x, z: point.z }));
    },
    dispose() {
      query.destroy();
      navMesh.destroy();
    },
  };
}

/**
 * 建一个区域的完整可视部分：环境网格 + 硬碰撞体 + navmesh。
 * 遮挡盒不重复造——环境视觉内部已按同一份布局算过一次，
 * 调用方直接用 `environment.occluders`。
 */
export async function createRegionRuntime(
  scene: Scene,
  root: TransformNode,
  forward: { x: number; y: number; z: number },
  layout: RegionRuntimeLayout,
): Promise<RegionRuntime> {
  const colliders = buildPropColliders(layout.props);
  const environment = await createRegionEnvironment(scene, root, forward, {
    patches: layout.groundPatches,
    props: layout.props,
    ...(layout.tint
      ? { tint: new Color3(layout.tint.r, layout.tint.g, layout.tint.b) }
      : {}),
    namePrefix: layout.namePrefix,
  });

  // navmesh 的可行走区与渲染层硬碰撞用同一份 collider 清单：
  // 点不到树里，寻路也会绕开树，两个系统不会各说各话。
  const navigation = await createRegionNavigation(
    layout.bounds,
    regionNavObstacleSpecs(colliders, layout.waterPatch),
  );

  return {
    regionId: layout.regionId,
    bounds: layout.bounds,
    exits: layout.exits,
    props: layout.props,
    colliders,
    environment,
    navigation,
    dispose() {
      navigation.dispose();
      environment.dispose();
    },
  };
}

export interface RegionLandscapeParts {
  meshes: Mesh[];
  materials: Material[];
}