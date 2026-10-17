import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

import type { EnvironmentInfo, RenderBackend } from "../logic/report";

interface GlInfoProvider {
  getGlInfo?: () => { vendor: string; renderer: string; version: string };
}

function detectRenderBackend(engine: AbstractEngine): RenderBackend {
  if (engine.isWebGPU) {
    return "webgpu";
  }

  const webGLVersion = (engine as AbstractEngine & { webGLVersion?: number }).webGLVersion;
  if (webGLVersion === 2) {
    return "webgl2";
  }
  if (webGLVersion === 1) {
    return "webgl1";
  }
  return "unknown";
}

/** 采集报告所需的浏览器与渲染环境信息。 */
export function collectEnvironmentInfo(engine: AbstractEngine): EnvironmentInfo {
  const glInfo = (engine as AbstractEngine & GlInfoProvider).getGlInfo?.() ?? null;

  return {
    userAgent: navigator.userAgent,
    renderBackend: detectRenderBackend(engine),
    gpuRenderer: glInfo?.renderer ?? null,
    capturedAt: new Date().toISOString(),
    devicePixelRatio: window.devicePixelRatio || 1,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
  };
}
