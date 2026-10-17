import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import {
  Raw,
  exportNavMesh,
  getNavMeshPositionsAndIndices,
  init,
  type CrowdAgentParams,
  type NavMesh,
} from "recast-navigation";
import {
  generateSoloNavMesh,
  type NavMeshGeneratorConfig,
} from "recast-navigation/generators";

import type { MeshGeometry } from "../logic/navmesh-geometry";

/**
 * Recast/Detour navmesh 的运行期参数（Crowd Navigation V2 路径）。
 *
 * 注意：Babylon core 自带的 RecastJSPlugin 属于 V1（依赖旧 recast.js 注入），
 * 这里的 V2 直接使用 recast-navigation 0.43.1 的 WASM 生成器与 Detour Crowd。
 *
 * 体素尺寸 0.5m：200×200 区域对应 400×400 高度场，兼顾精度与生成耗时。
 * walkableHeight / walkableClimb / walkableRadius 的单位是体素数。
 */
export const NAV_MESH_CONFIG: NavMeshGeneratorConfig = {
  cs: 0.5,
  ch: 0.2,
  walkableSlopeAngle: 45,
  walkableHeight: 9, // 1.8m / 0.2
  walkableClimb: 3, // 0.6m / 0.2
  walkableRadius: 1, // 0.5m / 0.5
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
  buildBvTree: true,
};

/** crowd 代理参数：半径 0.4m、速度 5.5m/s、较强分离权重。 */
export const CROWD_AGENT_PARAMS: Partial<CrowdAgentParams> = {
  radius: 0.4,
  height: 1.6,
  maxAcceleration: 12,
  maxSpeed: 5.5,
  collisionQueryRange: 3,
  pathOptimizationRange: 1,
  separationWeight: 2.5,
  updateFlags: 7,
  obstacleAvoidanceType: 3,
  queryFilterType: 0,
  userData: 0,
};

export interface NavMeshBuildStats {
  navMesh: NavMesh;
  generationMs: number;
  /** Detour navmesh 序列化后的字节数（区域常驻内存的主要部分）。 */
  bytes: number;
  triangleCount: number;
  wasmHeapDeltaBytes: number;
  jsHeapDeltaBytes: number;
}

let navigationInit: Promise<void> | null = null;

/** recast-navigation 的 WASM 初始化是异步的，全进程只执行一次。 */
export function initializeNavigation(): Promise<void> {
  navigationInit ??= init().catch((error: unknown) => {
    navigationInit = null;
    throw error;
  });
  return navigationInit;
}

export function isNavigationReady(): boolean {
  return Raw.Module !== undefined && Raw.Module !== null;
}

interface ChromePerformance extends Performance {
  memory?: { usedJSHeapSize: number };
}

export function jsHeapBytes(): number {
  return (performance as ChromePerformance).memory?.usedJSHeapSize ?? 0;
}

export function isJsHeapApiAvailable(): boolean {
  return (performance as ChromePerformance).memory !== undefined;
}

export function wasmHeapBytes(): number {
  const module = Raw.Module as unknown as
    | { HEAPU8?: Uint8Array; wasmMemory?: WebAssembly.Memory }
    | undefined;
  return module?.wasmMemory?.buffer.byteLength ?? module?.HEAPU8?.buffer.byteLength ?? 0;
}

/**
 * 从纯几何数据生成 solo navmesh，并采集耗时与内存。
 * 生成耗时只覆盖 generateSoloNavMesh 本身；序列化与统计在其后执行。
 */
export function buildNavMesh(
  geometry: MeshGeometry,
  config: NavMeshGeneratorConfig = NAV_MESH_CONFIG,
): NavMeshBuildStats {
  if (!isNavigationReady()) {
    throw new Error("recast-navigation 尚未初始化，请先 await initializeNavigation()");
  }

  const jsHeapBefore = jsHeapBytes();
  const wasmHeapBefore = wasmHeapBytes();
  const startedAt = performance.now();
  const result = generateSoloNavMesh(geometry.positions, geometry.indices, config);
  const generationMs = performance.now() - startedAt;

  if (!result.success || !result.navMesh) {
    throw new Error(`navmesh 生成失败：${result.error ?? "未知错误"}`);
  }

  const [, navIndices] = getNavMeshPositionsAndIndices(result.navMesh);
  const bytes = exportNavMesh(result.navMesh).byteLength;

  return {
    navMesh: result.navMesh,
    generationMs,
    bytes,
    triangleCount: navIndices.length / 3,
    wasmHeapDeltaBytes: wasmHeapBytes() - wasmHeapBefore,
    jsHeapDeltaBytes: jsHeapBytes() - jsHeapBefore,
  };
}

/** 用半透明材质把 Detour navmesh 多边形叠加到场景里，便于演示与截图。 */
export function createNavMeshOverlay(
  navMesh: NavMesh,
  scene: Scene,
  name: string,
  color: Color3,
  parent?: TransformNode,
): Mesh {
  const [positions, indices] = getNavMeshPositionsAndIndices(navMesh);
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);

  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;

  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh);
  mesh.position.y = 0.04;
  mesh.isPickable = false;
  if (parent) {
    mesh.parent = parent;
  }

  const material = new StandardMaterial(`${name}.material`, scene);
  material.diffuseColor = color;
  material.emissiveColor = color.scale(0.6);
  material.specularColor = Color3.Black();
  material.alpha = 0.28;
  material.backFaceCulling = false;
  material.disableLighting = true;
  mesh.material = material;

  return mesh;
}

/**
 * 采集一段时间内的帧间隔。首帧只用于建立基线，不计入结果。
 * onFrame 在记录当前帧间隔之后调用，因此 onFrame 里的同步工作会体现在下一帧。
 */
export async function collectFrameTimes(
  durationMs: number,
  onFrame?: (frameIndex: number, now: number) => void,
): Promise<number[]> {
  const frameTimes: number[] = [];
  const startedAt = performance.now();
  let last = startedAt;
  let frame = 0;

  await new Promise<void>((resolve) => {
    const tick = (now: number): void => {
      if (frame > 0) {
        frameTimes.push(now - last);
      }
      last = now;
      onFrame?.(frame, now);
      frame += 1;

      if (now - startedAt >= durationMs) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });

  return frameTimes;
}

/** 等待若干渲染帧，用于让 Babylon 完成材质/矩阵更新后再采样。 */
export async function waitFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
