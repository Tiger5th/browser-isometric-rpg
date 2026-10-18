/**
 * 世界坐标 → DOM 的屏幕投影（票 37 验收修复）。
 *
 * 诊断：气泡投影用的是 `engine.getRenderWidth/Height()`（**渲染像素**，
 * 含 renderScale × devicePixelRatio），而 `dialogue-portrait` 的
 * `setBubble` 用 CSS 像素写 `left/top`（DOM 层坐标）。两者在高画质
 * （renderScale 1 + dpr 2）下差 2 倍以上——气泡飘到屏幕外/贴错位置。
 *
 * 修法不在这里「乘回一个系数」糊过去，而是让投影**直接以 CSS 像素**为
 * 目标视口：投影数学不变（同一个 scene.getTransformMatrix），只是把
 * viewport 的宽高换成 canvas 的 clientWidth/clientHeight。这样
 * 「DOM 用什么坐标，投影就用什么坐标」是同一条事实。
 */

import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

/** 投影所需的视口信息：渲染像素视口 + 对应的 CSS 像素视口。 */
export interface ProjectionViewport {
  /** engine.getRenderWidth()：渲染像素。 */
  renderWidth: number;
  /** engine.getRenderHeight()：渲染像素。 */
  renderHeight: number;
  /** canvas.clientWidth：DOM/CSS 像素。 */
  cssWidth: number;
  /** canvas.clientHeight：DOM/CSS 像素。 */
  cssHeight: number;
}

/**
 * 渲染像素视口 → CSS 像素视口的换算系数。
 *
 * 取值来自 `viewportInfo(scene)` 与 canvas 的 clientWidth/Height。
 * 两者任一为 0（画布尚未布局）时回退到 1，表现为「不缩放」而不是 NaN。
 */
export function cssViewportScale(viewport: ProjectionViewport): { x: number; y: number } {
  const sx =
    viewport.cssWidth > 0 && viewport.renderWidth > 0 ? viewport.cssWidth / viewport.renderWidth : 1;
  const sy =
    viewport.cssHeight > 0 && viewport.renderHeight > 0
      ? viewport.cssHeight / viewport.renderHeight
      : 1;
  return { x: sx, y: sy };
}

/**
 * 把渲染像素坐标换算成 CSS 像素（DOM 层直接用）。
 *
 * 这是「拿渲染投影结果也能用」的兼容入口：调用方若只能用
 * renderWidth/Height 做投影（如 Vector3.Project 到 global 视口），
 * 就在返回值上乘这一层。高画质下系数约 1/(renderScale×dpr)，
 * 修掉了原先的 2 倍飘移。
 */
export function renderToCss(
  point: { x: number; y: number },
  viewport: ProjectionViewport,
): { x: number; y: number } {
  const scale = cssViewportScale(viewport);
  return { x: point.x * scale.x, y: point.y * scale.y };
}

/**
 * 世界坐标 → CSS 像素屏幕坐标（直接按 CSS 视口投影，推荐路径）。
 *
 * transformMatrix 必须是 `scene.getTransformMatrix()`（含相机视图投影）。
 */
export function projectWorldToCss(
  world: Vector3,
  transformMatrix: Matrix,
  viewport: ProjectionViewport,
): { x: number; y: number } {
  const projected = Vector3.Project(
    world,
    Matrix.Identity(),
    transformMatrix,
    // 目标视口直接给 CSS 像素：投影出的 x/y 就已经是 DOM 坐标。
    new Viewport(0, 0, viewport.cssWidth, viewport.cssHeight),
  );
  return { x: projected.x, y: projected.y };
}

/**
 * 从画布与引擎读出投影视口。
 *
 * 画布 clientWidth 为 0（隐藏/未布局）时回退到引擎尺寸，
 * 此时系数退化成 1：气泡位置会偏，但不会变成 NaN 或 0。
 */
export function projectionViewportOf(
  engine: { getRenderWidth(): number; getRenderHeight(): number },
  canvas: { clientWidth: number; clientHeight: number } | null,
): ProjectionViewport {
  const renderWidth = engine.getRenderWidth();
  const renderHeight = engine.getRenderHeight();
  return {
    renderWidth,
    renderHeight,
    cssWidth: canvas !== null && canvas.clientWidth > 0 ? canvas.clientWidth : renderWidth,
    cssHeight: canvas !== null && canvas.clientHeight > 0 ? canvas.clientHeight : renderHeight,
  };
}
