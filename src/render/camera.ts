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

/* ------------------------------------------------------------------ */
/* 相机跟随（票 37 验收修复）                                          */
/* ------------------------------------------------------------------ */

/**
 * 每帧跟随的插值系数（1 = 瞬移，0 = 不动）。
 *
 * 正交相机下 target 移动 = 平移视野：0.08 在 60fps 下约 0.3s 收敛到 95%，
 * 玩家跑出画面前相机已经跟上，又不会像硬跟随那样晕。
 */
export const CAMERA_FOLLOW_LERP = 0.08;

/**
 * 相机跟随状态：当前 target（世界坐标）与阻尼。
 *
 * 为什么不直接每帧 `camera.setTarget(player)`：ArcRotateCamera 会把
 * `setTarget` 当成「换焦点」的重建式操作（重算 alpha/beta 的反解），
 * 在正交 + 自定义 alpha/beta 下会把玩家拖到与旋转语义打架的机位。
 * 直接写 `camera.target` 才是「保持机位、平移视野」。
 */
export interface CameraFollowState {
  /** 当前相机 target（世界坐标）。 */
  x: number;
  z: number;
}

export function createCameraFollow(x = 0, z = 0): CameraFollowState {
  return { x, z };
}

/**
 * 推进跟随：把 target 向目标点阻尼插值一步。
 *
 * 返回是否发生了变化（没变就不必回写相机，省掉每帧的脏标记）。
 * 目标点为 null 时保持不动（玩家死亡/读档中）。
 */
export function advanceCameraFollow(
  state: CameraFollowState,
  target: { x: number; z: number } | null,
  lerp = CAMERA_FOLLOW_LERP,
): boolean {
  if (target === null || !Number.isFinite(target.x) || !Number.isFinite(target.z)) {
    return false;
  }
  const nx = state.x + (target.x - state.x) * lerp;
  const nz = state.z + (target.z - state.z) * lerp;
  if (Math.abs(nx - state.x) < 1e-5 && Math.abs(nz - state.z) < 1e-5) {
    state.x = nx;
    state.z = nz;
    return false;
  }
  state.x = nx;
  state.z = nz;
  return true;
}

/**
 * 把跟随状态**立刻**对齐目标（传送/切区/读档后用）。
 *
 * 跟着瞬移走：玩家 teleportTo 到区域另一端后，相机必须直接在那儿，
 * 不然会看到一段十几秒的「长镜头飞过去」。
 */
export function snapCameraFollow(
  state: CameraFollowState,
  target: { x: number; z: number },
): void {
  state.x = target.x;
  state.z = target.z;
}

/** 把跟随状态写进相机 target（保持 alpha/beta/radius 不变，只平移视野）。 */
export function applyCameraFollow(camera: ArcRotateCamera, state: CameraFollowState): void {
  camera.setTarget(new Vector3(state.x, 0, state.z));
}
