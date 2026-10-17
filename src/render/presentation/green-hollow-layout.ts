/**
 * 翠谷（green_hollow）正式布局数据（票 25）。
 *
 * 决策：布局放在渲染层常量而不是 content/，因为 P1 的 content schema
 * 只描述玩法实体（区域/NPC/敌人/物品/任务），不包含美术摆放；
 * 等 P2 需要 Agent 批量生产区域时再把布局提升为区域资产的正式字段。
 *
 * 坐标系：世界 X/Z（与 GameSession 快照一致），Y=0 为地面。
 * 所有地面贴片用中心点 + 宽深描述，贴片按 y 分层避免 z-fighting。
 * 布局由测试保证：确定性、在区域边界内、实体出生点与道具不重叠。
 */

export const GREEN_HOLLOW_REGION_ID = "region:green_hollow";

export const GREEN_HOLLOW_BOUNDS = {
  minX: -24,
  maxX: 24,
  minZ: -20,
  maxZ: 20,
} as const;

export type GroundTextureId = "grass" | "stone-path" | "dirt-path" | "water";

export interface GroundPatch {
  id: string;
  texture: GroundTextureId;
  /** 贴片中心。 */
  x: number;
  z: number;
  width: number;
  depth: number;
  /** 分层高度：草地 0，路/广场略高，水面最高。 */
  y: number;
  /** 一张贴图覆盖的世界尺寸（米）；用于计算 UV 平铺次数。 */
  tileSize: number;
}

export type PropKind = "tree-large" | "bush" | "stone-wall" | "barrel" | "crate";

export interface PropPlacement {
  id: string;
  kind: PropKind;
  x: number;
  z: number;
  /** 屏幕空间 billboard 的缩放（1 = 原始尺寸）。 */
  scale: number;
  /** 是否参与遮挡描边判定。 */
  occluder: boolean;
  zone: "treeline" | "village" | "pond" | "cave-mouth" | "tunnel" | "deep";
}

/** billboard 的世界尺寸（宽高比 = 1024:765）。 */
export interface PropDimensions {
  width: number;
  height: number;
  /** 遮挡 OBB 的半宽/半高/半深（世界单位，未乘 scale）。 */
  occluderHalfWidth: number;
  occluderHalfHeight: number;
  occluderHalfDepth: number;
  /** 遮挡盒中心相对地面的高度。 */
  occluderCenterY: number;
}

export const PROP_DIMENSIONS: Record<PropKind, PropDimensions> = {
  "tree-large": {
    width: 5.1,
    height: 3.81,
    occluderHalfWidth: 0.7,
    occluderHalfHeight: 1.6,
    occluderHalfDepth: 0.35,
    occluderCenterY: 1.6,
  },
  bush: {
    width: 2.4,
    height: 1.79,
    occluderHalfWidth: 0.7,
    occluderHalfHeight: 0.55,
    occluderHalfDepth: 0.3,
    occluderCenterY: 0.55,
  },
  "stone-wall": {
    width: 4.3,
    height: 3.21,
    occluderHalfWidth: 1.9,
    occluderHalfHeight: 0.9,
    occluderHalfDepth: 0.35,
    occluderCenterY: 0.9,
  },
  barrel: {
    width: 1.4,
    height: 1.05,
    occluderHalfWidth: 0.45,
    occluderHalfHeight: 0.45,
    occluderHalfDepth: 0.3,
    occluderCenterY: 0.45,
  },
  crate: {
    width: 1.4,
    height: 1.05,
    occluderHalfWidth: 0.45,
    occluderHalfHeight: 0.45,
    occluderHalfDepth: 0.3,
    occluderCenterY: 0.45,
  },
};

/**
 * 地面分层：
 * - 草地铺满整个区域
 * - 石板广场位于村庄中心
 * - 泥土路东西贯穿、并向南接水塘
 * - 水塘带一圈石板岸
 */
export const GROUND_PATCHES: readonly GroundPatch[] = [
  {
    id: "ground.grass.base",
    texture: "grass",
    x: 0,
    z: 0,
    width: GREEN_HOLLOW_BOUNDS.maxX - GREEN_HOLLOW_BOUNDS.minX,
    depth: GREEN_HOLLOW_BOUNDS.maxZ - GREEN_HOLLOW_BOUNDS.minZ,
    y: 0,
    tileSize: 6,
  },
  {
    id: "ground.stone.plaza",
    texture: "stone-path",
    x: 0,
    z: -1,
    width: 14,
    depth: 11,
    y: 0.012,
    tileSize: 5,
  },
  {
    id: "ground.dirt.west",
    texture: "dirt-path",
    x: -15.5,
    z: 2,
    width: 17,
    depth: 3.2,
    y: 0.008,
    tileSize: 4,
  },
  {
    id: "ground.dirt.east",
    texture: "dirt-path",
    x: 15.5,
    z: 2,
    width: 17,
    depth: 3.2,
    y: 0.008,
    tileSize: 4,
  },
  {
    id: "ground.dirt.south",
    texture: "dirt-path",
    x: 2,
    z: 8.5,
    width: 3.2,
    depth: 13,
    y: 0.009,
    tileSize: 4,
  },
  {
    id: "ground.stone.pond-shore",
    texture: "stone-path",
    x: -12,
    z: 12,
    width: 12.5,
    depth: 9,
    y: 0.006,
    tileSize: 5,
  },
  {
    id: "ground.water.pond",
    texture: "water",
    x: -12,
    z: 12,
    width: 11,
    depth: 7.5,
    y: 0.014,
    tileSize: 4.5,
  },
];

/**
 * 村庄摆放。北侧石墙 + 四周树带围出边界，广场周边是木桶/木箱，
 * 水塘边有灌木。位置刻意避开玩家/NPC/敌人出生点。
 */
export const PROPS: readonly PropPlacement[] = [
  // 北侧边界石墙
  { id: "prop.wall.north-west", kind: "stone-wall", x: -8, z: -16.5, scale: 1.5, occluder: true, zone: "treeline" },
  { id: "prop.wall.north-east", kind: "stone-wall", x: 8, z: -16.5, scale: 1.5, occluder: true, zone: "treeline" },
  { id: "prop.wall.west", kind: "stone-wall", x: -20.5, z: -6, scale: 1.2, occluder: true, zone: "treeline" },
  { id: "prop.wall.east", kind: "stone-wall", x: 20.5, z: -6, scale: 1.2, occluder: true, zone: "treeline" },

  // 树带
  { id: "prop.tree.north-west", kind: "tree-large", x: -20, z: -15.5, scale: 1.05, occluder: true, zone: "treeline" },
  { id: "prop.tree.north", kind: "tree-large", x: -12, z: -17, scale: 0.9, occluder: true, zone: "treeline" },
  { id: "prop.tree.north-east", kind: "tree-large", x: 12.5, z: -16, scale: 0.95, occluder: true, zone: "treeline" },
  { id: "prop.tree.east", kind: "tree-large", x: 20, z: -13.5, scale: 1.1, occluder: true, zone: "treeline" },
  { id: "prop.tree.far-west", kind: "tree-large", x: -21, z: 4, scale: 1.0, occluder: true, zone: "treeline" },
  { id: "prop.tree.far-east", kind: "tree-large", x: 21, z: 3, scale: 1.05, occluder: true, zone: "treeline" },
  { id: "prop.tree.south-east", kind: "tree-large", x: 17, z: 15, scale: 1.0, occluder: true, zone: "treeline" },
  { id: "prop.tree.south-west", kind: "tree-large", x: -19.5, z: 17, scale: 0.95, occluder: true, zone: "treeline" },
  // 广场东侧的村庄树：既是自然景观，也是遮挡描边的确定性探针点。
  { id: "prop.tree.village-east", kind: "tree-large", x: 9.5, z: -1.5, scale: 1.0, occluder: true, zone: "village" },

  // 广场周边植被
  { id: "prop.bush.north-west", kind: "bush", x: -6, z: -8.5, scale: 1.0, occluder: true, zone: "village" },
  { id: "prop.bush.north-east", kind: "bush", x: 6.5, z: -9, scale: 0.9, occluder: true, zone: "village" },
  { id: "prop.bush.south-west", kind: "bush", x: -5.5, z: 6, scale: 1.0, occluder: true, zone: "village" },
  { id: "prop.bush.south-east", kind: "bush", x: 9, z: 6.5, scale: 0.85, occluder: true, zone: "village" },
  { id: "prop.bush.pond-north", kind: "bush", x: -16, z: 7, scale: 1.1, occluder: true, zone: "pond" },
  { id: "prop.bush.pond-east", kind: "bush", x: -5.5, z: 11, scale: 0.9, occluder: true, zone: "pond" },

  // 广场集市道具
  { id: "prop.barrel.market-west", kind: "barrel", x: -2.6, z: 3.2, scale: 1.0, occluder: true, zone: "village" },
  { id: "prop.barrel.market-north", kind: "barrel", x: 2.8, z: -7.2, scale: 0.95, occluder: true, zone: "village" },
  { id: "prop.crate.market-east", kind: "crate", x: 4.8, z: 2.7, scale: 1.05, occluder: true, zone: "village" },
  { id: "prop.crate.market-west", kind: "crate", x: -6.2, z: -3.6, scale: 1.0, occluder: true, zone: "village" },
];

/** 玩家出生点（content/regions/green_hollow.json 的 spawn 保持一致）。 */
export const PLAYER_SPAWN = { x: 0, y: 0, z: 0 } as const;

/** 与布局相关的实体出生点；仅用于测试与场景摆放校验。 */
export const ENTITY_ANCHORS = {
  "entity:player": PLAYER_SPAWN,
  "npc:elder_ma": { x: 6, y: 0, z: 4 },
  "npc:scout_lin": { x: -6, y: 0, z: 3 },
  "enemy:slime_meadow": { x: 12, y: 0, z: -4 },
  "enemy:slime_blue": { x: 14, y: 0, z: -6 },
  "enemy:slime_elder": { x: 16, y: 0, z: -10 },
} as const;

export interface LayoutIssue {
  id: string;
  message: string;
}

/** 布局自检：地面贴片在边界内、道具不与实体锚点/彼此重叠。 */
export function validateLayout(
  props: readonly PropPlacement[] = PROPS,
  patches: readonly GroundPatch[] = GROUND_PATCHES,
  anchors: Readonly<Record<string, { x: number; z: number }>> = ENTITY_ANCHORS,
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const { minX, maxX, minZ, maxZ } = GREEN_HOLLOW_BOUNDS;

  for (const patch of patches) {
    if (patch.width <= 0 || patch.depth <= 0) {
      issues.push({ id: patch.id, message: "地面贴片尺寸必须为正" });
    }
    if (
      patch.x - patch.width / 2 < minX ||
      patch.x + patch.width / 2 > maxX ||
      patch.z - patch.depth / 2 < minZ ||
      patch.z + patch.depth / 2 > maxZ
    ) {
      issues.push({ id: patch.id, message: "地面贴片超出区域边界" });
    }
  }

  // 道具 footprint 的一半作为最小间距；玩家/NPC/敌人出生点至少留 1.2m。
  const footprint = (prop: PropPlacement): number =>
    (PROP_DIMENSIONS[prop.kind].width * prop.scale) / 2;

  props.forEach((prop, index) => {
    const { x, z } = prop;
    if (
      x - footprint(prop) < minX ||
      x + footprint(prop) > maxX ||
      z - footprint(prop) < minZ ||
      z + footprint(prop) > maxZ
    ) {
      issues.push({ id: prop.id, message: "道具超出区域边界" });
    }
    for (const [anchorId, anchor] of Object.entries(anchors)) {
      const distance = Math.hypot(prop.x - anchor.x, prop.z - anchor.z);
      // 木桶/木箱可以靠近 NPC（集市），树/墙/灌木必须在 1.2m 之外。
      const minDistance = prop.kind === "barrel" || prop.kind === "crate" ? 0.8 : 1.2;
      if (distance < footprint(prop) * 0.5 + minDistance) {
        issues.push({ id: prop.id, message: `与实体锚点 ${anchorId} 过近` });
      }
    }
    for (let otherIndex = index + 1; otherIndex < props.length; otherIndex += 1) {
      const other = props[otherIndex];
      const minGap = (footprint(prop) + footprint(other)) * 0.55;
      if (Math.hypot(prop.x - other.x, prop.z - other.z) < minGap) {
        issues.push({ id: prop.id, message: `与 ${other.id} 重叠` });
      }
    }
  });

  return issues;
}
