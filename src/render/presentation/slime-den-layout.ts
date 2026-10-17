/**
 * 史莱姆巢穴（slime_den）正式布局数据（票 35）。
 *
 * 区域 2 的规模：约主区域（翠谷 ±24×±20 = 1920m²）的三分之一
 * （±13×±12 = 624m²，32.5%）。坐标原点与翠谷共享：巢穴洞口在翠谷南缘
 * （0, 19），因此巢穴的返回洞口放在北缘（0, -11）——走进翠谷路口就跳回翠谷，
 * 两个区域之间不靠副本传送点，而是「沿同一条路走下去」。
 *
 * 贴图资产：artifacts/region2/ 的暗色调瓦片由资产 agent 产出，落地前
 * 复用翠谷同一批贴图 + SLIME_DEN_TINT 调暗占位（见 textures.ts 的
 * loadSlimeDenTextures）。切换到真资产时只需替换贴图文件名，
 * 布局/碰撞/导航数据不变。
 *
 * 与 green-hollow-layout 同风格：纯数据 + 自检函数，测试保证确定性、
 * 在边界内、道具不与实体锚点重叠。
 */

import {
  GROUND_PATCHES as HOLLOW_PATCHES,
  PROP_DIMENSIONS,
  type GroundPatch,
  type GroundTextureId,
  type PropKind,
  type PropPlacement,
} from "./green-hollow-layout";
import type { LandscapeHill, LandscapeIssue, LandscapeTree } from "./world-physics";
import { validateLandscape } from "./world-physics";

export const SLIME_DEN_REGION_ID = "region:slime_den";

/** 巢穴可行走区：约翠谷的 1/3。 */
export const SLIME_DEN_BOUNDS = {
  minX: -13,
  maxX: 13,
  minZ: -12,
  maxZ: 12,
} as const;

/**
 * 巢穴的环带外边界（含雾化余量）：与翠谷同一条公式，只是区域更小，
 * 因此环带也更近——巢穴的四方向纵深因此比主区域更「紧」。
 */
export const SLIME_DEN_LANDSCAPE_BOUNDS = {
  minX: SLIME_DEN_BOUNDS.minX - 44,
  maxX: SLIME_DEN_BOUNDS.maxX + 44,
  minZ: SLIME_DEN_BOUNDS.minZ - 44,
  maxZ: SLIME_DEN_BOUNDS.maxZ + 44,
} as const;

/** 巢穴的暗色调：复用翠谷贴图时乘上去的 tint（资产 agent 产出后去掉）。 */
export const SLIME_DEN_TINT = { r: 0.55, g: 0.52, b: 0.62 } as const;

/** 出口：北缘洞口，对齐翠谷南缘的 cave_mouth。 */
export const SLIME_DEN_EXITS = [
  {
    id: "exit:den_to_hollow",
    targetRegionId: "region:green_hollow",
    position: { x: 0, y: 0, z: -11 },
  },
] as const;

/** 玩家出生点（content/regions/slime_den.json 的 spawn 保持一致）。 */
export const SLIME_DEN_PLAYER_SPAWN = { x: 0, y: 0, z: -6 } as const;

/**
 * 地面：一张压暗的草地铺满巢穴 + 一条从洞口通向深处的泥土路 + 深处的水洼。
 * tileSize 与翠谷一致，UV 平铺节奏因此在两区域之间不会有突变。
 */
export const SLIME_DEN_GROUND_PATCHES: readonly GroundPatch[] = [
  {
    id: "den.ground.cave-floor",
    // 巢穴专用暗色调瓦片（artifacts/region2/ground-c1 → assets/textures/region2_ground_tile.png）。
    texture: "cave-floor" as GroundTextureId,
    x: 0,
    z: 0,
    width: SLIME_DEN_BOUNDS.maxX - SLIME_DEN_BOUNDS.minX,
    depth: SLIME_DEN_BOUNDS.maxZ - SLIME_DEN_BOUNDS.minZ,
    y: 0,
    tileSize: 6,
  },
  {
    id: "den.ground.tunnel",
    texture: "dirt-path" as GroundTextureId,
    x: 0,
    z: -2,
    width: 3.4,
    depth: 18,
    y: 0.008,
    tileSize: 4,
  },
  {
    id: "den.ground.deep-pool",
    texture: "water" as GroundTextureId,
    x: 6.5,
    z: 7.5,
    width: 6,
    depth: 5,
    y: 0.012,
    tileSize: 4.5,
  },
  {
    id: "den.ground.core-dais",
    texture: "stone-path" as GroundTextureId,
    x: 0,
    z: 7,
    width: 8,
    depth: 6,
    y: 0.014,
    tileSize: 5,
  },
];

/**
 * 环境件：洞口两侧的石墙（挡住从侧面走进巢穴）、深处的岩壁、
 * 沿路的枯木与灌木，以及被史莱姆啃出的木箱残骸。
 * 石墙刻意避开 |x|<3 的往返通道（见测试），否则玩家会被卡在洞口。
 */
export const SLIME_DEN_PROPS: readonly PropPlacement[] = [
  // 洞口两侧
  { id: "den.prop.wall.mouth-west", kind: "stone-wall", x: -5.5, z: -8.5, scale: 1.4, occluder: true, zone: "cave-mouth" },
  { id: "den.prop.wall.mouth-east", kind: "stone-wall", x: 5.5, z: -8.5, scale: 1.4, occluder: true, zone: "cave-mouth" },

  // 深处围出核心台地
  { id: "den.prop.wall.deep-west", kind: "stone-wall", x: -6, z: 8.5, scale: 1.2, occluder: true, zone: "deep" },
  { id: "den.prop.wall.deep-east", kind: "stone-wall", x: 6, z: 8.5, scale: 1.2, occluder: true, zone: "deep" },

  // 枯木与灌木
  { id: "den.prop.tree.tunnel-west", kind: "tree-large", x: -7.5, z: -4, scale: 0.9, occluder: true, zone: "tunnel" },
  { id: "den.prop.tree.tunnel-east", kind: "tree-large", x: 7.5, z: -2.5, scale: 0.95, occluder: true, zone: "tunnel" },
  { id: "den.prop.tree.deep-west", kind: "tree-large", x: -9.5, z: 4.5, scale: 0.85, occluder: true, zone: "deep" },
  { id: "den.prop.tree.deep-east", kind: "tree-large", x: 9.5, z: 3, scale: 0.9, occluder: true, zone: "deep" },
  { id: "den.prop.bush.tunnel-west", kind: "bush", x: -3.2, z: -5.5, scale: 0.9, occluder: true, zone: "tunnel" },
  { id: "den.prop.bush.tunnel-east", kind: "bush", x: 3.2, z: -5.5, scale: 0.85, occluder: true, zone: "tunnel" },
  { id: "den.prop.bush.deep-west", kind: "bush", x: -3.5, z: 9, scale: 0.95, occluder: true, zone: "deep" },
  { id: "den.prop.bush.deep-east", kind: "bush", x: 3.5, z: 9.5, scale: 0.9, occluder: true, zone: "deep" },

  // 巢穴残骸
  { id: "den.prop.crate.core-west", kind: "crate", x: -3, z: 5.5, scale: 0.9, occluder: true, zone: "deep" },
  { id: "den.prop.crate.core-east", kind: "crate", x: 3, z: 5.5, scale: 0.95, occluder: true, zone: "deep" },
  { id: "den.prop.barrel.mouth", kind: "barrel", x: -2.4, z: -9.4, scale: 0.9, occluder: true, zone: "cave-mouth" },

  // 巢穴件（artifacts/region2/ 的晶簇/茧/蛋贴图，票 35）：
  // 深处围住核心台地，洞口两侧各一丛晶簇，茧与蛋沿路分布。
  { id: "den.prop.crystal.mouth-west", kind: "den-crystal", x: -3.2, z: -7.2, scale: 1.0, occluder: true, zone: "cave-mouth" },
  { id: "den.prop.crystal.mouth-east", kind: "den-crystal", x: 2.6, z: -8.6, scale: 1.0, occluder: true, zone: "cave-mouth" },
  { id: "den.prop.crystal.core-north", kind: "den-crystal", x: -2.6, z: 4.2, scale: 0.95, occluder: true, zone: "deep" },
  { id: "den.prop.crystal.core-south", kind: "den-crystal", x: 4.6, z: 10.4, scale: 1.05, occluder: true, zone: "deep" },
  { id: "den.prop.cocoon.tunnel", kind: "den-cocoon", x: -2.6, z: -2.5, scale: 1.0, occluder: true, zone: "tunnel" },
  { id: "den.prop.cocoon.deep-west", kind: "den-cocoon", x: -6.8, z: 6.5, scale: 0.95, occluder: true, zone: "deep" },
  { id: "den.prop.eggs.tunnel", kind: "den-eggs", x: 3.8, z: -3.5, scale: 0.95, occluder: true, zone: "tunnel" },
  { id: "den.prop.eggs.deep-east", kind: "den-eggs", x: 6.5, z: 1.5, scale: 1.0, occluder: true, zone: "deep" },
];

/** 与 content/enemies/*.json 的坐标一致（巢穴 3 只史莱姆 + 玩家出生点）。 */
export const SLIME_DEN_ENTITY_ANCHORS = {
  "entity:player": SLIME_DEN_PLAYER_SPAWN,
  "enemy:slime_den_watcher": { x: 3.5, y: 0, z: -1 },
  "enemy:slime_den_brood": { x: -4, y: 0, z: 2 },
  "enemy:slime_den_core": { x: 0, y: 0, z: 6 },
  "enemy:den_charger": { x: -5, y: 0, z: -3 },
  "enemy:den_spitter": { x: 7, y: 0, z: 4 },
} as const;

/**
 * 巢穴景观：山丘比翠谷矮（洞口是往下走的，不是登高），
 * 位置沿用「四边中点 + 四角」的确定性公式，参数按巢穴边界缩放。
 */
export const SLIME_DEN_HILLS: readonly LandscapeHill[] = (() => {
  const hills: LandscapeHill[] = [];
  const { minX, maxX, minZ, maxZ } = SLIME_DEN_BOUNDS;
  const midpoints: Array<[string, number, number, number, number]> = [
    ["hill.north", 0, minZ - 13, 15, 5.5],
    ["hill.south", 0, maxZ + 13, 15, 6.5],
    ["hill.west", minX - 13, 0, 15, 5],
    ["hill.east", maxX + 13, 0, 15, 6],
    ["hill.north-west", minX - 10, minZ - 10, 11, 4],
    ["hill.north-east", maxX + 10, minZ - 10, 11, 4.5],
    ["hill.south-west", minX - 10, maxZ + 10, 11, 4],
    ["hill.south-east", maxX + 10, maxZ + 10, 11, 4.5],
  ];
  for (const [id, x, z, radius, height] of midpoints) {
    hills.push({ id, x, z, radius, height });
  }
  return hills;
})();

/** 巢穴远景枯木：沿椭圆环带 14 棵，全部在可行走区外。 */
export const SLIME_DEN_TREES: readonly LandscapeTree[] = (() => {
  const trees: LandscapeTree[] = [];
  const count = 14;
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + Math.PI / 14;
    const jitter = 24 + (index % 3) * 3;
    trees.push({
      id: `den.tree.ring.${index.toString().padStart(2, "0")}`,
      x: Number((Math.cos(angle) * (jitter + 4)).toFixed(3)),
      z: Number((Math.sin(angle) * jitter * 0.95).toFixed(3)),
      scale: 0.8 + (index % 4) * 0.2,
    });
  }
  return trees;
})();

export interface SlimeDenLayoutIssue {
  id: string;
  message: string;
}

/**
 * 布局自检：贴片在边界内、道具不与实体锚点/彼此重叠。
 * 与 green-hollow-layout.validateLayout 同规则，只是换一组数据与锚点。
 */
export function validateSlimeDenLayout(
  props: readonly PropPlacement[] = SLIME_DEN_PROPS,
  patches: readonly GroundPatch[] = SLIME_DEN_GROUND_PATCHES,
  anchors: Readonly<Record<string, { x: number; z: number }>> = SLIME_DEN_ENTITY_ANCHORS,
): SlimeDenLayoutIssue[] {
  const issues: SlimeDenLayoutIssue[] = [];
  const { minX, maxX, minZ, maxZ } = SLIME_DEN_BOUNDS;

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

  const footprint = (prop: PropPlacement): number =>
    (PROP_DIMENSIONS[prop.kind as PropKind].width * prop.scale) / 2;

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

/** 景观自检：复用 world-physics 的四方向覆盖规则，只换巢穴的边界与摆位。 */
export function validateSlimeDenLandscape(
  hills: readonly LandscapeHill[] = SLIME_DEN_HILLS,
  trees: readonly LandscapeTree[] = SLIME_DEN_TREES,
  bounds = SLIME_DEN_BOUNDS,
): LandscapeIssue[] {
  return validateLandscape(hills, trees, bounds);
}

/** 巢穴的水面贴片（不可行走，navmesh 与渲染层共用同一份坐标）。 */
export function slimeDenWaterPatch(): GroundPatch | undefined {
  return SLIME_DEN_GROUND_PATCHES.find((patch) => patch.texture === "water");
}

/** 巢穴复用了哪些翠谷贴图（资产 agent 产出 region2 贴图后从这里换名）。 */
export function slimeDenReusedTextures(): GroundTextureId[] {
  return [...new Set(SLIME_DEN_GROUND_PATCHES.map((patch) => patch.texture))];
}

/** 巢穴用到的主区域贴图 id 是否都真实存在（防止贴图清单与布局脱节）。 */
export function slimeDenTextureCoverage(): string[] {
  const hollowTextures = new Set(HOLLOW_PATCHES.map((patch) => patch.texture));
  return slimeDenReusedTextures()
    .filter((texture) => !hollowTextures.has(texture))
    .map((texture) => `巢穴引用了翠谷没有的贴图：${texture}`);
}