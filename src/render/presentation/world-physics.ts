/**
 * 世界碰撞与边界景观的纯逻辑常量与求解（票 28）。
 *
 * 设计约束（来自 GLOSSARY「逻辑层」）：
 * - 本模块零引擎依赖，可在 vitest 中直测；
 * - 网格化碰撞的「权威事实」在这里：哪些环境件有硬碰撞、碰撞盒多大、
 *   灌木是否可穿、边界环带多宽、雾在哪里开始变暗；
 * - 渲染层（environment-visuals / p1-world）只消费这些常量做几何拼装与
 *   每帧位移求解，不自行发明尺寸。
 *
 * 坐标系与 green-hollow-layout 一致：世界 X/Z，Y=0 为地面。
 */

import { GREEN_HOLLOW_BOUNDS, PROP_DIMENSIONS, PROPS } from "./green-hollow-layout";
import type { PropKind } from "./green-hollow-layout";

/** 玩家/敌人碰撞椭球的水平半径（米）。角色宽约 0.8m。 */
export const CHARACTER_COLLIDER_RADIUS = 0.4;

/**
 * 有硬碰撞的环境件（玩家/敌人均不可穿）。
 * 灌木刻意排除：保留 billboard 可穿（草丛机制预留，user story 16）。
 */
export const HARD_COLLIDER_KINDS: readonly PropKind[] = [
  "tree-large",
  "stone-wall",
  "barrel",
  "crate",
  // 巢穴件（票 35）：晶簇/茧/蛋是实心障碍，茧蛋比灌木高所以不可穿。
  "den-crystal",
  "den-cocoon",
  "den-eggs",
];

/** 可穿过的环境件（无碰撞，仅有进入视觉反馈）。 */
export const PASSABLE_KINDS: readonly PropKind[] = ["bush"];

/** 硬碰撞件的最小实体厚度：再薄的墙也要挡住角色，不能侧向漏过。 */
const MIN_COLLIDER_THICKNESS = 0.9;

/** 圆柱（树/桶/箱）相对碰撞半径的额外间隙，避免贴脸滑不动。 */
const CYLINDER_PADDING = 0.12;

/** 盒状件（墙）额外间隙：墙体视觉上厚，碰撞盒略收一点便于贴墙走。 */
const BOX_PADDING = 0.05;

/** 硬碰撞高度：树到树冠下沿，桶/箱到顶面，墙到墙顶。 */
export const COLLIDER_HEIGHTS: Record<PropKind, number> = {
  "tree-large": 1.7,
  bush: 0.9,
  "stone-wall": 1.5,
  barrel: 0.9,
  crate: 0.9,
  "den-crystal": 1.3,
  "den-cocoon": 1.4,
  "den-eggs": 1.0,
};

export type ColliderShape = "cylinder" | "box";

export interface PropCollider {
  id: string;
  kind: PropKind;
  /** 碰撞体中心（树/桶/箱为圆柱轴心，位于地面）。 */
  x: number;
  z: number;
  shape: ColliderShape;
  /** 圆柱半径或盒子的半宽（米，已含 scale）。 */
  radius: number;
  /** 盒子的半深（米，已含 scale）；圆柱件为 0。 */
  halfDepth: number;
  /** 从地面算起的高度（米，已含 scale）。 */
  height: number;
}

/**
 * 从布局推导硬碰撞体清单（纯函数，确定性）。
 * 顺序与 PROPS 一致，方便测试与渲染层逐件对照。
 */
export function buildPropColliders(
  props: readonly { id: string; kind: PropKind; x: number; z: number; scale: number }[] = PROPS,
): PropCollider[] {
  const colliders: PropCollider[] = [];
  for (const prop of props) {
    if (!HARD_COLLIDER_KINDS.includes(prop.kind)) {
      continue;
    }
    const dimensions = PROP_DIMENSIONS[prop.kind];
    const occluderHalfWidth = dimensions.occluderHalfWidth * prop.scale;
    const occluderHalfDepth = dimensions.occluderHalfDepth * prop.scale;
    if (prop.kind === "tree-large") {
      colliders.push({
        id: prop.id,
        kind: prop.kind,
        x: prop.x,
        z: prop.z,
        shape: "cylinder",
        radius: Math.max(0.3, occluderHalfWidth - CYLINDER_PADDING),
        halfDepth: 0,
        height: COLLIDER_HEIGHTS[prop.kind] * prop.scale,
      });
      continue;
    }
    if (prop.kind === "stone-wall") {
      colliders.push({
        id: prop.id,
        kind: prop.kind,
        x: prop.x,
        z: prop.z,
        shape: "box",
        // 石墙的遮挡盒是沿视觉墙走向的长条：碰撞盒沿用同一长宽比，
        // 但保证最小厚度，否则角色能从墙的侧面缝隙穿过。
        radius: occluderHalfWidth - BOX_PADDING,
        halfDepth: Math.max(MIN_COLLIDER_THICKNESS / 2, occluderHalfDepth - BOX_PADDING),
        height: COLLIDER_HEIGHTS[prop.kind] * prop.scale,
      });
      continue;
    }
    // 木桶/木箱：立方碰撞体，宽高一致。
    colliders.push({
      id: prop.id,
      kind: prop.kind,
      x: prop.x,
      z: prop.z,
      shape: "box",
      radius: Math.max(0.3, occluderHalfWidth - BOX_PADDING),
      halfDepth: Math.max(MIN_COLLIDER_THICKNESS / 2, occluderHalfDepth - BOX_PADDING),
      height: COLLIDER_HEIGHTS[prop.kind] * prop.scale,
    });
  }
  return colliders;
}

/**
 * 轴对齐盒（世界空间）的水平侵入深度；圆柱退化为等半径方盒。
 * 返回 0 表示不接触。Box-Padding 已计入 radius/halfDepth。
 */
export function colliderOverlap(
  collider: PropCollider,
  x: number,
  z: number,
  radius = CHARACTER_COLLIDER_RADIUS,
): number {
  const dx = Math.abs(x - collider.x) - collider.radius - radius;
  const dz = Math.abs(z - collider.z) - collider.halfDepth - radius;
  if (dx >= 0 || dz >= 0) {
    return 0;
  }
  // 取较浅的一个轴作为推出方向，让角色贴着表面滑而不是对角弹飞。
  return Math.min(-dx, -dz);
}

/** 碰撞体是否覆盖给定水平位置（含角色半径）。 */
export function isBlockedByCollider(
  collider: PropCollider,
  x: number,
  z: number,
  radius = CHARACTER_COLLIDER_RADIUS,
): boolean {
  return colliderOverlap(collider, x, z, radius) > 0;
}

/**
 * 单步位移求解：把 from 推向 to，但被硬碰撞体与区域边界挡住。
 * 逐轴求解（X 后 Z）保证贴墙滑行；两个轴都被堵时把角色推到碰撞体表面，
 * 而不是原地钉死（否则贴脸状态会永久卡住移动）。
 *
 * 返回实际落点；blocked 表示本次位移是否被任意碰撞体削减。
 */
export interface MoveResult {
  x: number;
  z: number;
  blocked: boolean;
  /** 命中的碰撞体 id（首个挡住目标的）；仅用于调试/报告。 */
  blockedBy: string | null;
}

/**
 * 把角色从碰撞体表面推回到不重叠的位置（沿最近的法线方向）。
 * 圆柱（树/桶/箱）用径向距离；盒子（墙）用逐轴推出。
 */
function pushOutOfCollider(
  collider: PropCollider,
  x: number,
  z: number,
  radius: number,
): { x: number; z: number } {
  const dx = x - collider.x;
  const dz = z - collider.z;
  const distance = Math.hypot(dx, dz);

  if (collider.shape === "cylinder") {
    if (distance <= 1e-6) {
      // 极端情况：角色就在轴心上，任意方向推出（取 +Z）。
      return { x, z: collider.z + collider.radius + radius };
    }
    const scale = (collider.radius + radius) / distance;
    return { x: collider.x + dx * scale, z: collider.z + dz * scale };
  }

  // 盒状：取较浅的一个轴推出，让角色贴着长边滑行。
  const overlapX = collider.radius + radius - Math.abs(dx);
  const overlapZ = collider.halfDepth + radius - Math.abs(dz);
  if (overlapZ < overlapX) {
    const sign = dz >= 0 ? 1 : -1;
    return { x, z: collider.z + sign * (collider.halfDepth + radius) };
  }
  const sign = dx >= 0 ? 1 : -1;
  return { x: collider.x + sign * (collider.radius + radius), z };
}

export function resolveMoveWithColliders(
  from: { x: number; z: number },
  to: { x: number; z: number },
  colliders: readonly PropCollider[],
  options: {
    radius?: number;
    bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  } = {},
): MoveResult {
  const radius = options.radius ?? CHARACTER_COLLIDER_RADIUS;
  const bounds = options.bounds ?? GREEN_HOLLOW_BOUNDS;
  let x = from.x;
  let z = from.z;
  let blockedBy: string | null = null;

  const clampToBounds = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

  const firstBlocker = (candidateX: number, candidateZ: number): PropCollider | null => {
    for (const collider of colliders) {
      if (isBlockedByCollider(collider, candidateX, candidateZ, radius)) {
        return collider;
      }
    }
    return null;
  };

  /** 若推出后的位置仍与其它碰撞体重叠，则退回原位（贴住当前障碍，绝不穿模）。 */
  const accept = (candidateX: number, candidateZ: number, fallbackX: number, fallbackZ: number) =>
    firstBlocker(candidateX, candidateZ) === null
      ? { x: candidateX, z: candidateZ }
      : { x: fallbackX, z: fallbackZ };

  // X 轴：目标在边界内且不被任何碰撞体覆盖才前进，否则本轴不动。
  const targetX = clampToBounds(to.x, bounds.minX + radius, bounds.maxX - radius);
  if (targetX !== x) {
    const hit = firstBlocker(targetX, z);
    if (hit === null) {
      x = targetX;
    } else {
      blockedBy ??= hit.id;
      const pushed = pushOutOfCollider(hit, x, z, radius);
      const accepted = accept(
        clampToBounds(pushed.x, bounds.minX + radius, bounds.maxX - radius),
        z,
        x,
        z,
      );
      x = accepted.x;
    }
  }

  // Z 轴：同理，使用已求解的 x，保证贴墙滑行。
  const targetZ = clampToBounds(to.z, bounds.minZ + radius, bounds.maxZ - radius);
  if (targetZ !== z) {
    const hit = firstBlocker(x, targetZ);
    if (hit === null) {
      z = targetZ;
    } else {
      blockedBy ??= hit.id;
      const pushed = pushOutOfCollider(hit, x, z, radius);
      const accepted = accept(
        x,
        clampToBounds(pushed.z, bounds.minZ + radius, bounds.maxZ - radius),
        x,
        z,
      );
      z = accepted.z;
    }
  }

  return { x, z, blocked: blockedBy !== null, blockedBy };
}

/* ------------------------------------------------------------------ */
/* navmesh 障碍：与硬碰撞共用同一份 collider 清单                       */
/* ------------------------------------------------------------------ */

export interface NavObstacleSpec {
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

/**
 * 从硬碰撞体推导 Recast 障碍盒（纯函数，navmesh 与碰撞的单一数据源）。
 *
 * 两个关键点：
 * - 灌木不在 colliders 里 → 不会被排除出 navmesh（user story 16 可穿）；
 * - Recast 的 walkableRadius 会把障碍四周各侵蚀 0.5m，木桶/木箱这类
 *   小件会被侵蚀到消失；给一个最小 footprint，保证寻路仍绕开它们。
 */
export function colliderObstacleSpecs(
  colliders: readonly PropCollider[] = buildPropColliders(),
  minFootprint = 1.5,
): NavObstacleSpec[] {
  return colliders.map((collider) => ({
    name: `obstacle.${collider.id}`,
    x: collider.x,
    z: collider.z,
    width: Math.max(minFootprint, collider.radius * 2),
    depth: Math.max(
      minFootprint,
      (collider.shape === "cylinder" ? collider.radius : collider.halfDepth) * 2,
    ),
    height: collider.height,
  }));
}

/* ------------------------------------------------------------------ */
/* 灌木：可穿 + 进入视觉反馈                                           */
/* ------------------------------------------------------------------ */

/** 灌木视觉影响半径（米）：角色进入该范围即视为「在灌木中」。 */
export const BUSH_INFLUENCE_RADIUS = 1.1;

/** 灌木遮挡时角色的最低不透明度（再深也保持 0.55，角色始终可辨）。 */
export const BUSH_OCCLUSION_MIN_ALPHA = 0.55;

export interface BushProximity {
  /** 最近灌木的 id；不在任何灌木内时为 null。 */
  bushId: string | null;
  /** 0 = 完全在灌木外，1 = 完全被灌木遮挡。 */
  occlusion: number;
}

/**
 * 依据角色位置计算灌木遮挡强度（纯函数）。
 * 多棵灌木取最高强度；强度随距灌木中心的距离线性衰减。
 */
export function bushOcclusionAt(
  x: number,
  z: number,
  bushes: readonly { id: string; x: number; z: number; influence?: number }[],
): BushProximity {
  let best: BushProximity = { bushId: null, occlusion: 0 };
  for (const bush of bushes) {
    const influence = bush.influence ?? BUSH_INFLUENCE_RADIUS;
    const distance = Math.hypot(x - bush.x, z - bush.z);
    if (distance >= influence) {
      continue;
    }
    const occlusion = 1 - distance / influence;
    if (occlusion > best.occlusion) {
      best = { bushId: bush.id, occlusion };
    }
  }
  return best;
}

/** 灌木遮挡强度 → 角色材质不透明度（表现层用，纯计算）。 */
export function bushAlphaForOcclusion(occlusion: number): number {
  const clamped = Math.min(1, Math.max(0, occlusion));
  return 1 - clamped * (1 - BUSH_OCCLUSION_MIN_ALPHA);
}

/* ------------------------------------------------------------------ */
/* 边界景观环带 + 渐暗雾                                              */
/* ------------------------------------------------------------------ */

/**
 * 环带外缘距区域边界的距离（米）。环带从边界向外铺这么宽的低细节景观，
 * 相机再往外就是雾，四方向都不会出现黑色虚无。
 *
 * 取值依据：等距相机（radius=40）可见地面从 24m（屏幕底）延伸到 68.7m
 *（屏幕上角），且视线始终落在环带矩形内；环带外缘离相机最近 54m，
 * 必须大于 FOG_END（48m），否则雾还没饱和就露出环带边界（黑色虚无）。
 */
export const LANDSCAPE_RING_WIDTH = 52;

/** 环带内的小山丘数量（四边各一 + 四角，固定布局，见 LANDSCAPE_HILLS）。 */
export const LANDSCAPE_HILL_COUNT = 8;

/**
 * 环带与区域之间的雾起始/结束距离（世界单位，从相机算起）。
 * 结束距离必须**早于**环带外缘（约 74m 之外）：雾在外缘前完全饱和成雾色，
 * 屏幕四角看到的是雾色而不是环带边缘被暗角压成的黑块。
 * 起始 22m：区域远缘（相机约 31m）开始轻微起雾，形成「渐暗过渡」。
 */
export const FOG_START = 22;
export const FOG_END = 48;

/** 雾色：锚定图天空的灰蓝紫，暗部不纯黑。 */
export const FOG_COLOR = { r: 0.44, g: 0.47, b: 0.56 } as const;

/** 环带基调色（低模小山/远景树），比草地暗一档并偏冷。 */
export const LANDSCAPE_HILL_COLOR = { r: 0.3, g: 0.4, b: 0.34 } as const;
export const LANDSCAPE_TREE_COLOR = { r: 0.22, g: 0.34, b: 0.26 } as const;
/** 环带地面（草色，比区域内的草地贴图暗一档，形成纵深）。 */
export const LANDSCAPE_GROUND_COLOR = { r: 0.32, g: 0.42, b: 0.3 } as const;

export interface LandscapeHill {
  id: string;
  x: number;
  z: number;
  /** 底面半径。 */
  radius: number;
  height: number;
}

/**
 * 环带景观的确定性摆放：四边中点各一座大山，四角各一座小山。
 * 全部在区域边界之外，不会进入可行走区域。
 */
export const LANDSCAPE_HILLS: readonly LandscapeHill[] = [
  { id: "hill.north", x: 0, z: GREEN_HOLLOW_BOUNDS.minZ - 18, radius: 20, height: 8 },
  { id: "hill.south", x: 0, z: GREEN_HOLLOW_BOUNDS.maxZ + 18, radius: 20, height: 8 },
  { id: "hill.west", x: GREEN_HOLLOW_BOUNDS.minX - 18, z: 0, radius: 20, height: 8 },
  { id: "hill.east", x: GREEN_HOLLOW_BOUNDS.maxX + 18, z: 0, radius: 20, height: 8 },
  { id: "hill.north-west", x: GREEN_HOLLOW_BOUNDS.minX - 14, z: GREEN_HOLLOW_BOUNDS.minZ - 14, radius: 14, height: 6 },
  { id: "hill.north-east", x: GREEN_HOLLOW_BOUNDS.maxX + 14, z: GREEN_HOLLOW_BOUNDS.minZ - 14, radius: 14, height: 6 },
  { id: "hill.south-west", x: GREEN_HOLLOW_BOUNDS.minX - 14, z: GREEN_HOLLOW_BOUNDS.maxZ + 14, radius: 14, height: 6 },
  { id: "hill.south-east", x: GREEN_HOLLOW_BOUNDS.maxX + 14, z: GREEN_HOLLOW_BOUNDS.maxZ + 14, radius: 14, height: 6 },
];

/** 环带外边界（含雾化余量），供渲染层建地面与 navmesh 排除。 */
export const LANDSCAPE_BOUNDS = {
  minX: GREEN_HOLLOW_BOUNDS.minX - LANDSCAPE_RING_WIDTH,
  maxX: GREEN_HOLLOW_BOUNDS.maxX + LANDSCAPE_RING_WIDTH,
  minZ: GREEN_HOLLOW_BOUNDS.minZ - LANDSCAPE_RING_WIDTH,
  maxZ: GREEN_HOLLOW_BOUNDS.maxZ + LANDSCAPE_RING_WIDTH,
} as const;

/** 等距相机的世界位置（radius=40，alpha/beta 为标准值；见 camera.ts）。 */
export const ISOMETRIC_CAMERA_POSITION = {
  x: 40 * Math.cos(-Math.PI / 4) * Math.sin(Math.acos(1 / Math.sqrt(3))),
  y: 40 * Math.cos(Math.acos(1 / Math.sqrt(3))),
  z: 40 * Math.sin(-Math.PI / 4) * Math.sin(Math.acos(1 / Math.sqrt(3))),
} as const;

/**
 * 相机到环带外缘的最近 3D 距离（米）。
 * 雾的结束距离必须小于这个值，否则屏幕边缘会露出环带边界（黑色虚无）。
 * fog 用的是视线方向的 3D 距离，因此这里也算 3D（环带外缘在地面 y≈0）。
 */
export function landscapeEdgeMinDistance(
  camera: { x: number; y: number; z: number } = ISOMETRIC_CAMERA_POSITION,
): number {
  const { minX, maxX, minZ, maxZ } = LANDSCAPE_BOUNDS;
  // 等距相机看向区域中心，一定在环带矩形内部；最近外缘点在离相机最近的
  // 那条边上，Z（或 X）坐标与相机对齐。
  const nearestX = Math.abs(camera.x - minX) < Math.abs(maxX - camera.x) ? minX : maxX;
  const nearestZ = Math.abs(camera.z - minZ) < Math.abs(maxZ - camera.z) ? minZ : maxZ;
  const distanceToXEdge = Math.hypot(nearestX - camera.x, camera.y);
  const distanceToZEdge = Math.hypot(nearestZ - camera.z, camera.y);
  return Math.min(distanceToXEdge, distanceToZEdge);
}

/**
 * 环带内确定性的远景树位（低细节圆锥/圆球，不进 navmesh、不占 draw call 预算外）。
 * 位置在区域边界之外、山丘之间，保证四方向都有纵深。
 */
export interface LandscapeTree {
  id: string;
  x: number;
  z: number;
  scale: number;
}

export const LANDSCAPE_TREES: readonly LandscapeTree[] = (() => {
  const trees: LandscapeTree[] = [];
  const ringRadius = 44;
  // 沿半径 44m 的圆周取 20 个点；区域是 ±24/±20，最远的边缘距离约 31m，
  // 因此 44m 处全部在可行走区域外，又能填住屏幕四角。
  for (let index = 0; index < 20; index += 1) {
    const angle = (index / 20) * Math.PI * 2 + Math.PI / 20;
    const radiusJitter = ringRadius + (index % 3) * 4;
    trees.push({
      id: `tree.ring.${index.toString().padStart(2, "0")}`,
      x: Number((Math.cos(angle) * radiusJitter).toFixed(3)),
      z: Number((Math.sin(angle) * radiusJitter * 0.9).toFixed(3)),
      scale: 0.9 + (index % 4) * 0.24,
    });
  }
  return trees;
})();

/**
 * 环带自检：景观不得压进行走区域，且四方向都必须有内容。
 * 与 green-hollow-layout 的 validateLayout 同一风格：返回问题列表，空 = 通过。
 */
/** 区域可行走区的二维边界（翠谷与区域 2 共用同一形状）。 */
export interface Bounds2DLike {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface LandscapeIssue {
  id: string;
  message: string;
}

export function validateLandscape(
  hills: readonly LandscapeHill[] = LANDSCAPE_HILLS,
  trees: readonly LandscapeTree[] = LANDSCAPE_TREES,
  bounds: Bounds2DLike = GREEN_HOLLOW_BOUNDS,
): LandscapeIssue[] {
  const issues: LandscapeIssue[] = [];

  if (hills.length !== LANDSCAPE_HILL_COUNT) {
    issues.push({ id: "landscape.hills", message: `山丘数量应为 ${LANDSCAPE_HILL_COUNT}` });
  }

  const insideRegion = (x: number, z: number): boolean =>
    x > bounds.minX && x < bounds.maxX && z > bounds.minZ && z < bounds.maxZ;

  for (const hill of hills) {
    if (hill.radius <= 0 || hill.height <= 0) {
      issues.push({ id: hill.id, message: "山丘尺寸必须为正" });
    }
    // 山丘可以压到区域边缘（视觉接缝），但不得深入超过半径的 60%。
    const innerX = hill.x - Math.sign(hill.x || 1) * hill.radius * 0.6;
    const innerZ = hill.z - Math.sign(hill.z || 1) * hill.radius * 0.6;
    if (insideRegion(innerX, innerZ)) {
      issues.push({ id: hill.id, message: "山丘深入可行走区域" });
    }
  }

  for (const tree of trees) {
    if (insideRegion(tree.x, tree.z)) {
      issues.push({ id: tree.id, message: "远景树落在可行走区域内" });
    }
  }

  // 四方向覆盖：北/南/东/西各至少一件景观（山丘或远景树）。
  const quadrants: Array<{
    name: string;
    outside: (x: number, z: number) => boolean;
  }> = [
    { name: "north", outside: (_x, pz) => pz < bounds.minZ },
    { name: "south", outside: (_x, pz) => pz > bounds.maxZ },
    { name: "west", outside: (px, _z) => px < bounds.minX },
    { name: "east", outside: (px, _z) => px > bounds.maxX },
  ];
  for (const quadrant of quadrants) {
    const hasHill = hills.some((hill) => quadrant.outside(hill.x, hill.z));
    const hasTree = trees.some((tree) => quadrant.outside(tree.x, tree.z));
    if (!hasHill && !hasTree) {
      issues.push({ id: `landscape.${quadrant.name}`, message: "该方向没有景观内容" });
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* 统一光照：全场唯一主光，左上 45°                                    */
/* ------------------------------------------------------------------ */

/**
 * 主光方向（指向光源的单位向量）。
 *
 * 「左上 45°」是**屏幕空间**约定（锚定图里树在左上、墙影朝右下）。
 * 等距相机（alpha=-45°）的屏幕左 = 世界 (-0.577, 0, -0.577) 即西北向，
 * 屏幕上方再叠 ~39° 仰角，得到 (-0.577, 0.63, -0.577) 附近。
 * 归一化后仰角约 39°、方位角约 -135°（0 = -Z）。
 */
export const KEY_LIGHT_DIRECTION = normalize3(-0.577, 0.63, -0.577);

/** 主光色：暖白（明亮暖色基调）。 */
export const KEY_LIGHT_COLOR = { r: 1.0, g: 0.96, b: 0.88 } as const;

/**
 * 唯一主光强度。自定义 toon shader 自带 lightColor/ambientColor（不受场景光影响），
 * 这个强度只作用于少数 StandardMaterial 网格（景观环带 disableLighting，也不受影响），
 * 因此取值偏保守：足够让「全场唯一主光」在 ego-browser 里可断言，又不改变既有观感。
 */
export const SCENE_LIGHT_INTENSITY = 1.0;

/** 环境/暗部色：锚定图紫灰（不用纯黑）。 */
export const AMBIENT_COLOR = { r: 0.42, g: 0.4, b: 0.52 } as const;

/** 暗部提亮地板（toon shader shadowFloor）：紫灰暗部不会死黑。 */
export const SHADOW_FLOOR = 0.34;

export function normalize3(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const length = Math.hypot(x, y, z);
  if (length === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  return { x: x / length, y: y / length, z: z / length };
}

/**
 * 光照方向自检：唯一主光必须从左上（-X/-Z）来且高于水平面 35° 以上，
 * 保证树/墙的影子朝画面右下（等距视角下的自然方向）。
 */
export function validateKeyLight(
  direction: { x: number; y: number; z: number } = KEY_LIGHT_DIRECTION,
): LandscapeIssue[] {
  const issues: LandscapeIssue[] = [];
  const horizontalLength = Math.hypot(direction.x, direction.z);
  const elevation = Math.atan2(direction.y, horizontalLength) * (180 / Math.PI);
  const azimuth = Math.atan2(direction.x, direction.z) * (180 / Math.PI);
  if (direction.x >= 0 || direction.z >= 0) {
    issues.push({ id: "light.direction", message: "主光必须来自左上（-X/-Z）" });
  }
  if (elevation < 35 || elevation > 70) {
    issues.push({ id: "light.elevation", message: `主光仰角应在 35–70°，当前 ${elevation.toFixed(1)}°` });
  }
  // 水平方位必须落在等距画面的左上象限（-90° 到 -180° 之间）。
  if (azimuth > -90 || azimuth < -180) {
    issues.push({
      id: "light.azimuth",
      message: `主光水平方位应在画面左上（-90°..-180°），当前 ${azimuth.toFixed(1)}°`,
    });
  }
  return issues;
}

/** 仰角（度）：写进场景报告，便于 L5 留档核对「左上 45°」。 */
export function keyLightElevationDegrees(
  direction: { x: number; y: number; z: number } = KEY_LIGHT_DIRECTION,
): number {
  const horizontalLength = Math.hypot(direction.x, direction.z);
  return Math.atan2(direction.y, horizontalLength) * (180 / Math.PI);
}

/**
 * 主光在水平面上的方位角（度；0 = 世界 -Z 即画面深处，-90 = 世界 -X 即画面左）。
 * 等距相机的「左上」= -90° 再偏向深处 45°，因此落在 -135° 附近。
 */
export function keyLightAzimuthDegrees(
  direction: { x: number; y: number; z: number } = KEY_LIGHT_DIRECTION,
): number {
  return Math.atan2(direction.x, direction.z) * (180 / Math.PI);
}

/** 等距相机下「屏幕左上」对应的水平方向（0 = -Z）；用于校验光照符合锚定图。 */
export const SCREEN_UPPER_LEFT_AZIMUTH_DEGREES = -135;

/* ------------------------------------------------------------------ */
/* NPC 待机行为（表现层，纯计算）                                       */
/* ------------------------------------------------------------------ */

/** 呼吸摆动的幅度（弧度）与周期。 */
export const NPC_BREATH_AMPLITUDE = 0.035;
export const NPC_BREATH_PERIOD_MS = 3_200;

/** 踱步：待机多久后可能触发一次转身/小步移动。 */
export const NPC_PACE_MIN_INTERVAL_MS = 4_000;
export const NPC_PACE_MAX_INTERVAL_MS = 9_000;
/** 单次踱步的最大位移（米）。 */
export const NPC_PACE_RADIUS = 1.2;
/**
 * 玩家靠近到该距离内时**禁用踱步**（票 37 验收修复）。
 *
 * 诊断：巡逻（逻辑层，content 的 patrol）与踱步（表现层）叠加成两个
 * 真相源，NPC 在玩家面前每隔几秒就挪一步，看起来「躁动」而不是待机。
 * 巡逻本身已有对话冻结 + 交互期冻结，所以近距离直接站定最自然。
 */
export const NPC_PACE_PLAYER_DISABLE_RADIUS = 3;

export interface NpcIdleSample {
  /** 呼吸引起的身体倾斜（绕 X 轴，弧度）。 */
  sway: number;
  /** 踱步目标（等下次采样时由表现层读取）；null 表示站着不动。 */
  paceTarget: { x: number; z: number } | null;
  /** 踱步期间应面向的角度（弧度）；null 表示保持原朝向。 */
  faceYaw: number | null;
}

export interface NpcIdleState {
  /** 当前朝向（弧度）。 */
  yaw: number;
  /** 距离下次踱步的剩余毫秒；<=0 时应触发一次。 */
  paceCooldownMs: number;
  /** 确定性随机源（mulberry32），保证重进区域演出一致。 */
  random: () => number;
}

/**
 * 推进一个 NPC 的待机行为：返回本帧的呼吸摆动与踱步目标。
 * 纯函数式（输入状态 → 输出 + 新状态副本），可直接在 vitest 中断言：
 * - 无随机输入时（random 恒 0）不踱步；
 * - 摆动幅度有界且周期性。
 */
export function sampleNpcIdle(
  state: NpcIdleState,
  elapsedMs: number,
  deltaMs: number,
  home: { x: number; z: number },
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } = GREEN_HOLLOW_BOUNDS,
  playerPosition: { x: number; z: number } | null = null,
): { sample: NpcIdleSample; next: NpcIdleState } {
  const phase = (elapsedMs % NPC_BREATH_PERIOD_MS) / NPC_BREATH_PERIOD_MS;
  const sway = Math.sin(phase * Math.PI * 2) * NPC_BREATH_AMPLITUDE;

  const next: NpcIdleState = {
    yaw: state.yaw,
    paceCooldownMs: Math.max(0, state.paceCooldownMs - deltaMs),
    random: state.random,
  };

  let paceTarget: { x: number; z: number } | null = null;
  let faceYaw: number | null = null;

  // 玩家在附近：站定（只保留呼吸摆动）。冷却照常递减，玩家走开后
  // 不需要重新等一个完整周期就能恢复踱步。
  const playerNear =
    playerPosition !== null &&
    Math.hypot(playerPosition.x - home.x, playerPosition.z - home.z) <
      NPC_PACE_PLAYER_DISABLE_RADIUS;

  if (next.paceCooldownMs === 0 && !playerNear) {
    const angle = state.random() * Math.PI * 2;
    const distance = NPC_PACE_RADIUS * (0.35 + state.random() * 0.65);
    paceTarget = clampPaceTarget(
      {
        x: home.x + Math.cos(angle) * distance,
        z: home.z + Math.sin(angle) * distance,
      },
      home,
      bounds,
    );
    faceYaw = Math.atan2(paceTarget.x - home.x, paceTarget.z - home.z);
    next.yaw = faceYaw;
    // 重新装填冷却；随机区间由 constantRandom 提供时保持确定性。
    const roll = state.random();
    next.paceCooldownMs =
      NPC_PACE_MIN_INTERVAL_MS + roll * (NPC_PACE_MAX_INTERVAL_MS - NPC_PACE_MIN_INTERVAL_MS);
  }

  return { sample: { sway, paceTarget, faceYaw }, next };
}

/**
 * 把踱步目标收回区域边界内：边缘 NPC（如贴界的守卫）不能踱出世界。
 * 只做坐标钳制，保持方向不变（角色仍朝着原来的角度走，只是步长变短）。
 */
function clampPaceTarget(
  target: { x: number; z: number },
  home: { x: number; z: number },
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): { x: number; z: number } {
  const margin = CHARACTER_COLLIDER_RADIUS + 0.2;
  const clampedX = Math.min(
    bounds.maxX - margin,
    Math.max(bounds.minX + margin, target.x),
  );
  const clampedZ = Math.min(
    bounds.maxZ - margin,
    Math.max(bounds.minZ + margin, target.z),
  );
  // 若被钳制回原位（home 本身贴界），保持原地不动：faceYaw 仍指向原方向，
  // 但目标与 home 重合，表现层的位移为 0。
  if (clampedX === home.x && clampedZ === home.z) {
    return { x: home.x, z: home.z };
  }
  return { x: clampedX, z: clampedZ };
}
