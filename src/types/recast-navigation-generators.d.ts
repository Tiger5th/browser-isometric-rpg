/**
 * recast-navigation 0.43.1 的 `recast-navigation/generators` 类型入口存在
 * 发布缺陷（index.d.ts 引用了不存在的 ./generators）。这里补齐本项目
 * 实际使用的高层生成器类型，运行时解析不受影响。
 */
declare module "recast-navigation/generators" {
  import type { NavMesh } from "recast-navigation";

  export interface NavMeshGeneratorConfig {
    /** 世界坐标包围盒，省略时从输入几何计算。 */
    bounds?: [[number, number, number], [number, number, number]];
    borderSize?: number;
    tileSize?: number;
    /** 体素在 XZ 平面的尺寸。 */
    cs?: number;
    /** 体素高度。 */
    ch?: number;
    walkableSlopeAngle?: number;
    /** 可通行高度（体素数）。 */
    walkableHeight?: number;
    /** 可跨越高度（体素数）。 */
    walkableClimb?: number;
    /** 可通行半径（体素数）。 */
    walkableRadius?: number;
    maxEdgeLen?: number;
    maxSimplificationError?: number;
    minRegionArea?: number;
    mergeRegionArea?: number;
    maxVertsPerPoly?: number;
    detailSampleDist?: number;
    detailSampleMaxError?: number;
    buildBvTree?: boolean;
    offMeshConnections?: unknown[];
  }

  export interface GenerateSoloNavMeshResult {
    success: boolean;
    navMesh?: NavMesh;
    error?: string;
    intermediates?: unknown;
  }

  export function generateSoloNavMesh(
    positions: number[],
    indices: number[],
    config?: NavMeshGeneratorConfig,
    keepIntermediates?: boolean,
  ): GenerateSoloNavMeshResult;
}
