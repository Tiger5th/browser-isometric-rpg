/**
 * 翠谷的 Recast/Detour navmesh（P1 正式表现层寻路，票 28 更新）。
 *
 * 为什么放在渲染层：
 * - 布局（树/墙/水塘）属于表现层常量，逻辑层 content schema 不描述美术摆放；
 * - 逻辑层 GameSession 仍是直线推进，渲染层把点击目标经 navmesh 拆成路点，
 *   逐个提交 moveTo —— 这样 L1 测试完全不依赖 WASM，逻辑契约不变。
 *
 * 障碍来源（票 28 起）：**硬碰撞体**（树/石墙/木桶/木箱，见 world-physics
 * buildPropColliders）+ 水塘矩形。灌木刻意不进 navmesh：它是可穿的
 * （user story 16），若仍作为障碍，玩家点灌木中心会被吸附到灌木外，
 * 「进入灌木半透明」的视觉反馈永远触发不了。Recast 的 walkableRadius
 * 会自动把可行走面从障碍边缘收缩 0.5m。
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
} from "./green-hollow-layout";
import { buildPropColliders, colliderObstacleSpecs } from "./world-physics";

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
  // 单一数据源：navmesh 排除范围与硬碰撞求解使用同一份 collider 清单
  // （colliderObstacleSpecs 的纯逻辑在 world-physics 中，L1 直测）。
  const specs: BoxObstacleSpec[] = colliderObstacleSpecs(buildPropColliders());

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
