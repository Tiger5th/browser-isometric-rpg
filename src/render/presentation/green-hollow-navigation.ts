/**
 * 翠谷的 Recast/Detour navmesh（P1 正式表现层寻路）。
 *
 * 为什么放在渲染层：
 * - 布局（树/墙/水塘）属于表现层常量，逻辑层 content schema 不描述美术摆放；
 * - 逻辑层 GameSession 仍是直线推进，渲染层把点击目标经 navmesh 拆成路点，
 *   逐个提交 moveTo —— 这样 L1 测试完全不依赖 WASM，逻辑契约不变。
 *
 * 障碍来源：PROPS 的遮挡盒（树干/石墙/木桶）+ 水塘矩形。Recast 的
 * walkableRadius 会自动把可行走面从障碍边缘收缩 0.5m。
 */

import { NavMeshQuery, type NavMesh } from "recast-navigation";

import {
  createRegionGeometry,
  type BoxObstacleSpec,
} from "../../logic/navmesh-geometry";
import {
  buildNavMesh,
  initializeNavigation,
} from "../navigation";
import {
  GREEN_HOLLOW_BOUNDS,
  GROUND_PATCHES,
  PROP_DIMENSIONS,
  PROPS,
} from "./green-hollow-layout";

export interface PathPoint {
  x: number;
  z: number;
}

export interface GreenHollowNavigation {
  /** 返回从 from 到 to 的路点序列（含终点）；失败返回 null。 */
  findPath(from: PathPoint, to: PathPoint): PathPoint[] | null;
  dispose(): void;
}

function obstacleSpecs(): BoxObstacleSpec[] {
  const specs: BoxObstacleSpec[] = PROPS.map((prop) => {
    const dimensions = PROP_DIMENSIONS[prop.kind];
    return {
      name: `obstacle.${prop.id}`,
      x: prop.x,
      z: prop.z,
      width: dimensions.occluderHalfWidth * 2 * prop.scale,
      depth: dimensions.occluderHalfDepth * 2 * prop.scale,
      height: dimensions.occluderHalfHeight * 2 * prop.scale,
    };
  });

  // 水塘不可行走：用低矮实体盒覆盖水面，让 Recast 把它当成障碍。
  const pond = GROUND_PATCHES.find((patch) => patch.texture === "water");
  if (pond !== undefined) {
    specs.push({
      name: "obstacle.ground.water",
      x: pond.x,
      z: pond.z,
      width: pond.width,
      depth: pond.depth,
      height: 1.5,
    });
  }
  return specs;
}

export async function createGreenHollowNavigation(): Promise<GreenHollowNavigation> {
  await initializeNavigation();
  const stats = buildNavMesh(
    createRegionGeometry(GREEN_HOLLOW_BOUNDS, obstacleSpecs(), 4),
  );
  const navMesh: NavMesh = stats.navMesh;
  const query = new NavMeshQuery(navMesh);
  // 角色/点击点可能短暂落在障碍边缘或水面：扩大最近多边形搜索范围，
  // 让 computePath 能把起终点吸附到可行走面，而不是直接失败。
  query.defaultQueryHalfExtents = { x: 5, y: 5, z: 5 };

  return {
    findPath(from, to) {
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
