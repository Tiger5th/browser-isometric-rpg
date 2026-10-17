/**
 * 生成 Recast/Detour navmesh 输入几何的纯函数模块。
 *
 * 约定：右手系、+Y 向上、三角形逆时针（从外侧看）——
 * 与 recast-navigation-js 的输入要求一致，不依赖 Babylon 网格绕序。
 */

export type Vec3Tuple = [number, number, number];

export interface MeshGeometry {
  /** 扁平坐标数组：x1,y1,z1,x2,y2,z2,… */
  positions: number[];
  /** 扁平索引数组，每三个索引一个三角形。 */
  indices: number[];
}

export interface Bounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface BoxObstacleSpec {
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  /** 从地面算起的高度。 */
  height: number;
}

export interface ObstacleOptions {
  /** 与区域边界的最小距离。 */
  margin?: number;
  /** 障碍物之间的最小间距。 */
  clearance?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** 障碍物不得进入的矩形区域（例如跨区加载门）。 */
  exclusionZones?: Bounds2D[];
}

/** 确定性 PRNG（mulberry32），保证场景可重复。 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function intersects(left: Bounds2D, right: Bounds2D): boolean {
  return (
    left.minX < right.maxX &&
    left.maxX > right.minX &&
    left.minZ < right.maxZ &&
    left.maxZ > right.minZ
  );
}

function randomBetween(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

/**
 * 在区域内确定性地撒放轴对齐盒状障碍物。
 * 所有尺寸都按“先定尺寸再定中心”的顺序采样，确保不越界。
 */
export function createBoxObstacleSpecs(
  bounds: Bounds2D,
  count: number,
  seed: number,
  options: ObstacleOptions = {},
): BoxObstacleSpec[] {
  const margin = options.margin ?? 4;
  const clearance = options.clearance ?? 2;
  const minWidth = options.minWidth ?? 2;
  const maxWidth = options.maxWidth ?? 6;
  const minHeight = options.minHeight ?? 2;
  const maxHeight = options.maxHeight ?? 4;
  const exclusionZones = options.exclusionZones ?? [];
  const random = createSeededRandom(seed);
  const specs: BoxObstacleSpec[] = [];

  for (let index = 0; index < count; index += 1) {
    let placed: BoxObstacleSpec | null = null;

    for (let attempt = 0; attempt < 64 && placed === null; attempt += 1) {
      const width = randomBetween(random, minWidth, maxWidth);
      const depth = randomBetween(random, minWidth, maxWidth);
      const height = randomBetween(random, minHeight, maxHeight);
      const halfWidth = width / 2;
      const halfDepth = depth / 2;
      const minX = bounds.minX + margin + halfWidth;
      const maxX = bounds.maxX - margin - halfWidth;
      const minZ = bounds.minZ + margin + halfDepth;
      const maxZ = bounds.maxZ - margin - halfDepth;
      if (minX >= maxX || minZ >= maxZ) {
        continue;
      }

      const x = randomBetween(random, minX, maxX);
      const z = randomBetween(random, minZ, maxZ);
      const candidateBounds: Bounds2D = {
        minX: x - halfWidth,
        maxX: x + halfWidth,
        minZ: z - halfDepth,
        maxZ: z + halfDepth,
      };

      if (exclusionZones.some((zone) => intersects(candidateBounds, zone))) {
        continue;
      }

      const tooClose = specs.some((spec) => {
        const dx = Math.abs(spec.x - x);
        const dz = Math.abs(spec.z - z);
        const minDistance =
          Math.max(spec.width, spec.depth) / 2 + Math.max(width, depth) / 2 + clearance;
        return Math.hypot(dx, dz) < minDistance;
      });
      if (tooClose) {
        continue;
      }

      placed = {
        name: `obstacle.${index.toString().padStart(2, "0")}`,
        x,
        z,
        width,
        depth,
        height,
      };
    }

    if (placed) {
      specs.push(placed);
    }
  }

  return specs;
}

/** 水平地面，法线 +Y，逆时针索引。 */
export function createGroundGeometry(bounds: Bounds2D, subdivisions = 4): MeshGeometry {
  const cells = Math.max(1, Math.floor(subdivisions));
  const positions: number[] = [];
  const indices: number[] = [];
  const columns = cells + 1;

  for (let row = 0; row <= cells; row += 1) {
    const z = bounds.minZ + ((bounds.maxZ - bounds.minZ) * row) / cells;
    for (let column = 0; column <= cells; column += 1) {
      const x = bounds.minX + ((bounds.maxX - bounds.minX) * column) / cells;
      positions.push(x, 0, z);
    }
  }

  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      const topLeft = row * columns + column;
      const bottomLeft = (row + 1) * columns + column;
      const topRight = topLeft + 1;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, bottomLeft, topRight);
      indices.push(topRight, bottomLeft, bottomRight);
    }
  }

  return { positions, indices };
}

/** 轴对齐盒体（底部略低于地面，避免与地面共面产生缝隙）。 */
export function createBoxGeometry(spec: BoxObstacleSpec): MeshGeometry {
  const halfWidth = spec.width / 2;
  const halfDepth = spec.depth / 2;
  const bottom = -0.25;
  const top = spec.height;
  const { x, z } = spec;

  const corners: Vec3Tuple[] = [
    [x - halfWidth, bottom, z - halfDepth],
    [x + halfWidth, bottom, z - halfDepth],
    [x + halfWidth, bottom, z + halfDepth],
    [x - halfWidth, bottom, z + halfDepth],
    [x - halfWidth, top, z - halfDepth],
    [x + halfWidth, top, z - halfDepth],
    [x + halfWidth, top, z + halfDepth],
    [x - halfWidth, top, z + halfDepth],
  ];

  const positions = corners.flat();
  const indices = [
    // bottom (-Y)
    0, 1, 2, 0, 2, 3,
    // top (+Y)
    4, 7, 6, 4, 6, 5,
    // front (+Z)
    3, 2, 6, 3, 6, 7,
    // back (-Z)
    1, 0, 4, 1, 4, 5,
    // right (+X)
    2, 1, 5, 2, 5, 6,
    // left (-X)
    0, 3, 7, 0, 7, 4,
  ];

  return { positions, indices };
}

export function mergeGeometries(geometries: readonly MeshGeometry[]): MeshGeometry {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const geometry of geometries) {
    const vertexOffset = positions.length / 3;
    positions.push(...geometry.positions);
    for (const index of geometry.indices) {
      indices.push(index + vertexOffset);
    }
  }

  return { positions, indices };
}

export function createRegionGeometry(
  bounds: Bounds2D,
  obstacles: readonly BoxObstacleSpec[],
  subdivisions = 4,
): MeshGeometry {
  return mergeGeometries([
    createGroundGeometry(bounds, subdivisions),
    ...obstacles.map((obstacle) => createBoxGeometry(obstacle)),
  ]);
}

export function boundsSize(bounds: Bounds2D): { width: number; depth: number; area: number } {
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  return { width, depth, area: width * depth };
}
