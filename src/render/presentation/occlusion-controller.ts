/**
 * 遮挡描边控制器（票 25，复用 P0 票 13 方案）。
 *
 * 每帧从等距相机方向对每个角色发一条射线，与场景遮挡盒做零分配
 * 射线-OBB 判定；只给被遮挡的角色加 HighlightLayer 描边。
 * 与 P0 场景的区别：遮挡盒来自正式区域布局（树/墙/灌木/billboard）。
 */
import type { HighlightLayer } from "@babylonjs/core/Layers/highlightLayer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import {
  rayIntersectsOccluder,
  type OccluderBox,
  type Vec3Like,
} from "../occlusion/ray-obb";

export interface OcclusionTarget {
  id: string;
  /** 用于 HighlightLayer 的网格（玩家为 glb 网格）。 */
  mesh: Mesh;
  /** 提供世界坐标的节点（玩家为 glb 根节点）。 */
  anchor: Vec3Like;
  /** 射线瞄准的角色高度（髋部附近）。 */
  targetY: number;
}

export interface OcclusionStats {
  occluded: readonly string[];
  outlined: number;
  detectionMs: number;
}

const RAY_BACKOFF = 30;
const HIGHLIGHT_COLOR = new Color3(1.0, 0.62, 0.16);

export class OcclusionOutlineController {
  private readonly occludedEntityIds = new Set<string>();
  private readonly outlinedMeshes = new Map<string, Mesh>();
  private forward: Vec3Like;
  private enabled: boolean;
  private latestDetectionMs = 0;

  constructor(
    private readonly layer: HighlightLayer,
    private readonly occluders: readonly OccluderBox[],
    forward: Vec3Like,
  ) {
    this.forward = forward;
    this.enabled = true;
  }

  setForward(forward: Vec3Like): void {
    this.forward = forward;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.layer.isEnabled = enabled;
    if (!enabled) {
      this.clear();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  get outlinedCount(): number {
    return this.outlinedMeshes.size;
  }

  get detectionMs(): number {
    return this.latestDetectionMs;
  }

  /** 当前被遮挡的实体 id（复用 Set；不要保留引用）。 */
  get occludedIds(): ReadonlySet<string> {
    return this.occludedEntityIds;
  }

  /** 每帧调用；targets 数量很小（角色级），遮挡盒为 billboard/墙体。 */
  update(targets: readonly OcclusionTarget[]): void {
    const startedAt = performance.now();
    const forward = this.forward;
    const dirX = forward.x;
    const dirY = forward.y;
    const dirZ = forward.z;
    const backoffX = dirX * RAY_BACKOFF;
    const backoffY = dirY * RAY_BACKOFF;
    const backoffZ = dirZ * RAY_BACKOFF;

    this.occludedEntityIds.clear();
    if (this.enabled) {
      for (const target of targets) {
        const originX = target.anchor.x - backoffX;
        const originY = target.anchor.y + target.targetY - backoffY;
        const originZ = target.anchor.z - backoffZ;

        for (const box of this.occluders) {
          if (
            rayIntersectsOccluder(
              originX,
              originY,
              originZ,
              dirX,
              dirY,
              dirZ,
              RAY_BACKOFF,
              box,
            )
          ) {
            this.occludedEntityIds.add(target.id);
            break;
          }
        }
      }
    }

    // 只统计射线检测本身；addMesh/removeMesh 是状态切换成本，不计入每帧检测预算。
    this.latestDetectionMs = performance.now() - startedAt;
    this.sync(targets);
  }

  /** 只处理状态变化，避免每帧 addMesh/removeMesh 触发重建。 */
  private sync(targets: readonly OcclusionTarget[]): void {
    const meshesById = new Map<string, Mesh>();
    for (const target of targets) {
      meshesById.set(target.id, target.mesh);
    }

    for (const [id, mesh] of [...this.outlinedMeshes]) {
      if (!this.occludedIds.has(id)) {
        this.layer.removeMesh(mesh);
        this.outlinedMeshes.delete(id);
      }
    }
    for (const id of this.occludedIds) {
      if (!this.outlinedMeshes.has(id)) {
        const mesh = meshesById.get(id);
        if (mesh) {
          this.layer.addMesh(mesh, HIGHLIGHT_COLOR);
          this.outlinedMeshes.set(id, mesh);
        }
      }
    }
  }

  private clear(): void {
    for (const mesh of this.outlinedMeshes.values()) {
      this.layer.removeMesh(mesh);
    }
    this.outlinedMeshes.clear();
  }

  dispose(): void {
    this.clear();
    this.occludedEntityIds.clear();
  }
}
