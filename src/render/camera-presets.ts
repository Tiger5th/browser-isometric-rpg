/**
 * 相机预设与自由化（票 37）。
 *
 * 从「锁死的等距相机」到「可缩放/可旋转 + 一键复位」：
 * - **预设位（preset）**是一组 alpha/beta/verticalSpan 常量。当前出厂只有
 *   「等距默认」一位；将来加「俯瞰」「过场」只需往 CAMERA_PRESETS 里加一条，
 *   复位按钮的语义不变。
 * - **复位**不是瞬移而是平滑插值：每帧按 RESET_DURATION_MS 推进，
 *   到位后精确落到预设值（断言 alpha/beta/radius 回预设值）。
 * - 缩放与拖拽旋转各自夹在有限范围内，避免玩家把相机转进地里。
 *
 * 相机是**正交**的，滚轮改的是可视高度 verticalSpan 而不是 radius
 * （radius 在正交下只影响裁剪深度，改它没有视觉意义）。保留 radius 字段是为了
 * 将来切透视时预设结构不必改。
 */

import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";

import {
  DEFAULT_CAMERA_VERTICAL_SPAN,
  ISOMETRIC_ALPHA,
  ISOMETRIC_BETA,
  cameraVerticalSpan,
  updateOrthographicFrustum,
} from "./camera";

export interface CameraPreset {
  id: string;
  displayName: string;
  /** ArcRotateCamera.alpha（弧度）。 */
  alpha: number;
  /** ArcRotateCamera.beta（弧度，0 = 天顶）。 */
  beta: number;
  /** 相机到焦点的距离；正交下不影响画面大小，只留作未来透视预设。 */
  radius: number;
  /** 正交可视高度（米）。 */
  verticalSpan: number;
}

/** 出厂等距预设（票 28 的锁死视角就取这一位）。 */
export const ISOMETRIC_PRESET: CameraPreset = {
  id: "isometric",
  displayName: "默认等距",
  alpha: ISOMETRIC_ALPHA,
  beta: ISOMETRIC_BETA,
  radius: 40,
  verticalSpan: DEFAULT_CAMERA_VERTICAL_SPAN,
};

/**
 * 全部预设位。当前只有出厂等距一位；结构上支持多预设位，
 * 复位到哪一位由 `resetCameraToPreset(presetId)` 的参数决定。
 */
export const CAMERA_PRESETS: Record<string, CameraPreset> = {
  [ISOMETRIC_PRESET.id]: ISOMETRIC_PRESET,
};

export function cameraPreset(presetId: string): CameraPreset {
  const preset = CAMERA_PRESETS[presetId];
  if (preset === undefined) {
    throw new Error(`未知相机预设：${presetId}`);
  }
  return preset;
}

/** 缩放（可视高度）夹取范围：14m（贴近看细节）–48m（全景）。 */
export const MIN_CAMERA_VERTICAL_SPAN = 14;
export const MAX_CAMERA_VERTICAL_SPAN = 48;
/** 每格滚轮的缩放步长（米）。 */
export const CAMERA_ZOOM_STEP = 4;

/** 旋转夹取范围：beta 0.25–1.35 rad（约 14°–77°），不会转到地平线以下。 */
export const MIN_CAMERA_BETA = 0.25;
export const MAX_CAMERA_BETA = 1.35;
/** 拖拽旋转灵敏度（弧度/像素）。 */
export const CAMERA_ROTATE_PER_PIXEL = 0.008;

/** 复位插值时长（毫秒）。 */
export const CAMERA_RESET_DURATION_MS = 420;
/** alpha 归一化到 (−π, π] 的等价值，避免复位绕远路转一整圈。 */
export function normalizeAlpha(alpha: number): number {
  const full = Math.PI * 2;
  let value = alpha % full;
  if (value > Math.PI) {
    value -= full;
  } else if (value <= -Math.PI) {
    value += full;
  }
  return value;
}

/** 两组 alpha 之间的最短角差（复位插值用）。 */
export function shortestAngleDelta(from: number, to: number): number {
  return normalizeAlpha(to - from);
}

export interface CameraFraming {
  alpha: number;
  beta: number;
  radius: number;
  verticalSpan: number;
}

export function cameraFraming(camera: ArcRotateCamera, fallbackSpan: number): CameraFraming {
  return {
    alpha: camera.alpha,
    beta: camera.beta,
    radius: camera.radius,
    verticalSpan: cameraVerticalSpan(camera, fallbackSpan),
  };
}

/** 滚轮缩放：可视高度按步长增减并夹在范围内，返回是否发生变化。 */
export function applyCameraZoom(
  camera: ArcRotateCamera,
  notches: number,
  fallbackSpan: number,
  aspectRatio: number,
): boolean {
  if (notches === 0) {
    return false;
  }
  const current = cameraVerticalSpan(camera, fallbackSpan);
  // 单次事件最多算 3 格（触控板惯性滚动会一次推来很大的 notches）。
  const notchesClamped = Math.min(3, Math.abs(notches));
  // 向上滚（notches < 0）= 拉近 = 可视高度变小。
  const next = clamp(
    current + (notches > 0 ? 1 : -1) * CAMERA_ZOOM_STEP * notchesClamped,
    MIN_CAMERA_VERTICAL_SPAN,
    MAX_CAMERA_VERTICAL_SPAN,
  );
  if (next === current) {
    return false;
  }
  updateOrthographicFrustum(camera, aspectRatio, next);
  return true;
}

/** 拖拽旋转：像素位移转 alpha/beta 增量，beta 夹在范围内。 */
export function applyCameraRotate(
  camera: ArcRotateCamera,
  deltaPixelsX: number,
  deltaPixelsY: number,
): boolean {
  if (deltaPixelsX === 0 && deltaPixelsY === 0) {
    return false;
  }
  const alpha = camera.alpha + deltaPixelsX * CAMERA_ROTATE_PER_PIXEL;
  const beta = clamp(
    camera.beta - deltaPixelsY * CAMERA_ROTATE_PER_PIXEL,
    MIN_CAMERA_BETA,
    MAX_CAMERA_BETA,
  );
  if (alpha === camera.alpha && beta === camera.beta) {
    return false;
  }
  camera.alpha = normalizeAlpha(alpha);
  camera.beta = beta;
  return true;
}

/** 一次复位插值的起点（每帧快照当前机位，之后按时间线性推进）。 */
export interface CameraResetStart {
  presetId: string;
  alpha: number;
  beta: number;
  radius: number;
  verticalSpan: number;
}

/** 开始一次平滑复位：记下当前机位作为插值起点。 */
export function beginCameraReset(
  camera: ArcRotateCamera,
  preset: CameraPreset,
  fallbackSpan: number,
): CameraResetStart {
  return {
    presetId: preset.id,
    alpha: camera.alpha,
    beta: camera.beta,
    radius: camera.radius,
    verticalSpan: cameraVerticalSpan(camera, fallbackSpan),
  };
}

/**
 * 平滑复位：按已过去的时长线性插值到预设，返回是否已到位。
 *
 * 用**时间参数**（elapsedMs）而不是每帧固定比例的指数逼近：
 * 指数逼近永远差一点，要多跑好几秒才收敛，玩家会看到「复位卡在半路」。
 * 线性插值 + 到位时精确写回预设值，行为可断言（alpha/beta/radius 回预设值）。
 */
export function advanceCameraReset(
  camera: ArcRotateCamera,
  start: CameraResetStart,
  preset: CameraPreset,
  elapsedMs: number,
  aspectRatio: number,
): boolean {
  const t = clamp(elapsedMs / CAMERA_RESET_DURATION_MS, 0, 1);
  if (
    t < 1 &&
    Math.abs(shortestAngleDelta(start.alpha, preset.alpha)) < 1e-6 &&
    Math.abs(start.beta - preset.beta) < 1e-6 &&
    Math.abs(start.verticalSpan - preset.verticalSpan) < 1e-6
  ) {
    // 本来就在预设位：不需要插值，直接精确落位（复位按钮重复点也幂等）。
    applyPreset(camera, preset, aspectRatio);
    return true;
  }
  if (t >= 1) {
    applyPreset(camera, preset, aspectRatio);
    return true;
  }
  // 角度走最短路，不绕远圈。
  const alphaDelta = shortestAngleDelta(start.alpha, preset.alpha);
  camera.alpha = normalizeAlpha(start.alpha + alphaDelta * t);
  camera.beta = start.beta + (preset.beta - start.beta) * t;
  camera.radius = start.radius + (preset.radius - start.radius) * t;
  updateOrthographicFrustum(
    camera,
    aspectRatio,
    start.verticalSpan + (preset.verticalSpan - start.verticalSpan) * t,
  );
  return false;
}

/** 立即把相机放到预设位（复位的第一帧与测试断言共用）。 */
export function applyPreset(
  camera: ArcRotateCamera,
  preset: CameraPreset,
  aspectRatio: number,
): void {
  camera.alpha = preset.alpha;
  camera.beta = preset.beta;
  camera.radius = preset.radius;
  updateOrthographicFrustum(camera, aspectRatio, preset.verticalSpan);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}