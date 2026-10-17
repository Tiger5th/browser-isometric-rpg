import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

import { ISOMETRIC_ALPHA, ISOMETRIC_BETA, updateOrthographicFrustum } from "../camera";
import { GREYBOX_REGION_ID } from "../greybox";
import { REGION_CONTENT_WIDTH } from "./regionAsset";

/** 区域四周留一点余量，避免最外侧地形贴边被裁。 */
const REGION_VIEW_MARGIN = 1.04;
/** 兜底 aspect：极端窄屏也不至于把 span 拉到无穷大。 */
const MIN_ASPECT = 0.5;

declare global {
  interface Window {
    /** 区域已进入场景且加载门已淡出，供 ego-browser 截图同步。 */
    __P0RegionVisible?: boolean;
    __P0RegionLabel?: string;
  }
}

/** 发布区域可见状态，外部（ego-browser）据此在 hold 窗口内截图。 */
export function setRegionVisible(visible: boolean, label?: string): void {
  window.__P0RegionVisible = visible;
  window.__P0RegionLabel = label;
}

export interface RegionDemoCameraSnapshot {
  camera: ArcRotateCamera;
  alpha: number;
  beta: number;
  radius: number;
  target: Vector3;
  orthoTop: number | null;
  orthoBottom: number | null;
  orthoLeft: number | null;
  orthoRight: number | null;
}

/**
 * 区域演示期间：隐藏灰盒区域，把正交相机拉远以框住整个程序化区域。
 * 返回的快照用于 teardown 恢复原视角。
 */
export function enterRegionDemo(scene: Scene, verticalSpan: number): RegionDemoCameraSnapshot | null {
  scene.getTransformNodeByName(GREYBOX_REGION_ID)?.setEnabled(false);

  const camera = scene.activeCamera;
  if (!(camera instanceof ArcRotateCamera)) {
    return null;
  }

  const snapshot: RegionDemoCameraSnapshot = {
    camera,
    alpha: camera.alpha,
    beta: camera.beta,
    radius: camera.radius,
    target: camera.target.clone(),
    orthoTop: camera.orthoTop,
    orthoBottom: camera.orthoBottom,
    orthoLeft: camera.orthoLeft,
    orthoRight: camera.orthoRight,
  };

  const engine = scene.getEngine();
  const aspect =
    engine.getRenderHeight() > 0 ? engine.getRenderWidth() / engine.getRenderHeight() : 1;
  // 区域水平范围在等距投影下接近世界宽度；aspect 不足时固定竖向 span 会裁掉左右两侧。
  const effectiveSpan = Math.max(
    verticalSpan,
    (REGION_CONTENT_WIDTH * REGION_VIEW_MARGIN) / Math.max(aspect, MIN_ASPECT),
  );

  camera.setTarget(Vector3.Zero());
  camera.alpha = ISOMETRIC_ALPHA;
  camera.beta = ISOMETRIC_BETA;
  updateOrthographicFrustum(camera, aspect, effectiveSpan);

  return snapshot;
}

export function exitRegionDemo(scene: Scene, snapshot: RegionDemoCameraSnapshot | null): void {
  scene.getTransformNodeByName(GREYBOX_REGION_ID)?.setEnabled(true);

  if (!snapshot) {
    return;
  }

  const { camera } = snapshot;
  camera.alpha = snapshot.alpha;
  camera.beta = snapshot.beta;
  camera.radius = snapshot.radius;
  camera.setTarget(snapshot.target);
  camera.orthoTop = snapshot.orthoTop;
  camera.orthoBottom = snapshot.orthoBottom;
  camera.orthoLeft = snapshot.orthoLeft;
  camera.orthoRight = snapshot.orthoRight;
}

export function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** 等到场景真正完成一次渲染（用于把 GPU 上传/首帧卡顿藏在遮罩后面）。 */
export function nextRenderedFrame(scene: Scene): Promise<void> {
  return new Promise((resolve) => {
    scene.onAfterRenderObservable.addOnce(() => resolve());
  });
}

/** 统计某段窗口内的渲染帧数与最长帧间隔，用于评估加载门切换是否卡顿。 */
export class FrameMonitor {
  private readonly deltas: number[] = [];
  private lastFrameAt = 0;
  private observer: Observer<Scene> | null = null;

  constructor(private readonly scene: Scene) {}

  start(): void {
    this.stop();
    this.deltas.length = 0;
    this.lastFrameAt = performance.now();
    this.observer = this.scene.onAfterRenderObservable.add(() => {
      const now = performance.now();
      this.deltas.push(now - this.lastFrameAt);
      this.lastFrameAt = now;
    });
  }

  stop(): { frameCount: number; maxFrameMs: number; averageFrameMs: number } {
    if (this.observer) {
      this.scene.onAfterRenderObservable.remove(this.observer);
      this.observer = null;
    }
    const frameCount = this.deltas.length;
    const maxFrameMs = frameCount > 0 ? Math.max(...this.deltas) : 0;
    const averageFrameMs =
      frameCount > 0 ? this.deltas.reduce((sum, delta) => sum + delta, 0) / frameCount : 0;
    return { frameCount, maxFrameMs, averageFrameMs };
  }
}

interface ChromeHeapMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface ChromePerformance extends Performance {
  memory?: ChromeHeapMemory;
}

function readHeap(): ChromeHeapMemory | null {
  return (performance as ChromePerformance).memory ?? null;
}

export interface HeapSampleResult {
  available: boolean;
  sampleCount: number;
  baselineBytes: number;
  peakBytes: number;
  afterBytes: number;
  peakDeltaBytes: number;
}

/**
 * 采样 Chrome performance.memory 的 usedJSHeapSize。
 * 这是 JS 堆近似值（粗粒度、受 GC 影响），作为内存峰值趋势证据而非进程 RSS。
 */
export class HeapSampler {
  private timer: number | null = null;
  private samples: number[] = [];

  start(): void {
    this.stop();
    this.samples = [];
    this.sample();
    this.timer = window.setInterval(() => this.sample(), 50);
  }

  stop(): HeapSampleResult {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.sample();

    const available = readHeap() !== null;
    const baselineBytes = this.samples[0] ?? 0;
    const peakBytes = this.samples.length > 0 ? Math.max(...this.samples) : 0;
    const afterBytes = this.samples.at(-1) ?? 0;

    return {
      available,
      sampleCount: this.samples.length,
      baselineBytes,
      peakBytes,
      afterBytes,
      peakDeltaBytes: Math.max(0, peakBytes - baselineBytes),
    };
  }

  private sample(): void {
    const heap = readHeap();
    if (heap) {
      this.samples.push(heap.usedJSHeapSize);
    }
  }
}

const BYTES_PER_MB = 1_000_000;
const BYTES_PER_MIB = 1024 * 1024;

export function toMegabytes(bytes: number): number {
  return bytes / BYTES_PER_MB;
}

export function toMebibytes(bytes: number): number {
  return bytes / BYTES_PER_MIB;
}
