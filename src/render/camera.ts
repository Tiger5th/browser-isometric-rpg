import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

/** 等距相机的到焦点距离；正交下不影响画面大小，只作为预设的 radius 值。 */
export const ISOMETRIC_RADIUS = 40;

/** 标准等距视角：方位 -45°，仰角 arccos(1/√3) ≈ 35.26°。 */
export const ISOMETRIC_ALPHA = -Math.PI / 4;
export const ISOMETRIC_BETA = Math.acos(1 / Math.sqrt(3));

/** 默认正交可视高度；寻路等场景可临时调整后在 teardown 恢复。 */
export const DEFAULT_CAMERA_VERTICAL_SPAN = 20;

export function updateOrthographicFrustum(
  camera: Camera,
  aspectRatio: number,
  verticalSpan: number,
): void {
  const safeAspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const halfHeight = verticalSpan / 2;
  const halfWidth = halfHeight * safeAspect;

  camera.orthoTop = halfHeight;
  camera.orthoBottom = -halfHeight;
  camera.orthoLeft = -halfWidth;
  camera.orthoRight = halfWidth;

  // 场景可临时改 span（如 p1-world 用 30）。把当前值记在相机上，
  // 让全局 resize 处理器重建视锥时沿用场景值，而不是写死默认 20。
  const metadata = (camera.metadata ?? {}) as Record<string, unknown>;
  metadata.verticalSpan = verticalSpan;
  camera.metadata = metadata;
}

/** 读取相机当前的正交可视高度；未记录时回落到默认值。 */
export function cameraVerticalSpan(
  camera: Camera,
  fallback = DEFAULT_CAMERA_VERTICAL_SPAN,
): number {
  const metadata = camera.metadata as { verticalSpan?: unknown } | null;
  const value = metadata?.verticalSpan;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * 创建正交等距相机（P0 灰盒场景基准视角）。
 *
 * 相机本身仍然 `inputs.clear()` + `detachControl()`——输入统一由票 37 的
 * 相机控制器（camera-presets.ts）接管：滚轮缩放、右键拖拽旋转、预设复位，
 * 范围都由那边夹取，而不是放开门 Babylon 的自由输入。
 */
export function createIsometricCamera(scene: Scene, verticalSpan = 20): ArcRotateCamera {
  const camera = new ArcRotateCamera(
    "camera.isometric",
    ISOMETRIC_ALPHA,
    ISOMETRIC_BETA,
    ISOMETRIC_RADIUS,
    Vector3.Zero(),
    scene,
  );

  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.1;
  camera.maxZ = 200;
  camera.inputs.clear();
  camera.detachControl();

  const engine = scene.getEngine();
  const aspectRatio =
    engine.getRenderHeight() > 0 ? engine.getRenderWidth() / engine.getRenderHeight() : 1;
  updateOrthographicFrustum(camera, aspectRatio, verticalSpan);

  return camera;
}
