import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import { serializeMeasurementReport, type MeasurementReport } from "../logic/report";
import {
  DEFAULT_CAMERA_VERTICAL_SPAN,
  cameraVerticalSpan,
  createIsometricCamera,
  updateOrthographicFrustum,
} from "./camera";
import { collectEnvironmentInfo } from "./environment";
import { createGreyboxRegion } from "./greybox";
import { P0Harness, type ScenarioSummary } from "./harness";
import { registerBuiltinScenarios } from "./scenarios";

export type RenderPath = "webgl2" | "webgpu";

export interface P0HarnessApi {
  listScenarios(): ScenarioSummary[];
  runScenario(name: string): Promise<MeasurementReport>;
  disposeActiveScenario(): Promise<void>;
  getLastReport(): MeasurementReport | null;
  serialize(report: MeasurementReport): string;
  getEnvironment(): ReturnType<typeof collectEnvironmentInfo>;
}

declare global {
  interface Window {
    P0Harness?: P0HarnessApi;
    P0HarnessReady?: boolean;
    P0HarnessError?: string;
    P0HarnessLastReport?: MeasurementReport;
    /** 当前正在运行的 scenario；用于浏览器驱动时判断采样窗口。 */
    P0HarnessRunningScenario?: string;
    /** 诊断入口：浏览器驱动时可直接检查场景状态（如骨骼动画是否推进）。 */
    P0HarnessDebug?: { scene: Scene; engine: AbstractEngine };
  }
}

const CAMERA_VERTICAL_SPAN = DEFAULT_CAMERA_VERTICAL_SPAN;

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`缺少页面元素：#${id}`);
  }
  return element as T;
}

function resolveRenderPath(): RenderPath {
  const requested = new URLSearchParams(window.location.search).get("backend");
  return requested === "webgpu" ? "webgpu" : "webgl2";
}

/**
 * 正式场景默认不挂 P0Harness DOM（票 27，user story 36）：
 * 只有 `?harness=1` 时才把调试面板插入页面。`window.P0Harness*` 调试 API
 * 不受影响——ego-browser 冒烟与 L5 采样仍走 API 通道。
 */
function harnessPanelEnabled(): boolean {
  return new URLSearchParams(window.location.search).get("harness") === "1";
}

async function createEngine(canvas: HTMLCanvasElement, renderPath: RenderPath): Promise<AbstractEngine> {
  if (renderPath === "webgpu") {
    if (!("gpu" in navigator)) {
      throw new Error("当前浏览器不支持 WebGPU（navigator.gpu 缺失）");
    }
    return WebGPUEngine.CreateAsync(canvas, {
      antialias: true,
      stencil: true,
      adaptToDeviceRatio: true,
    });
  }

  return new Engine(
    canvas,
    true,
    { preserveDrawingBuffer: true, stencil: true, antialias: true },
    true,
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function bootstrap(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>("p0-canvas");
  const harnessPanel = document.getElementById("harness-panel");
  const harnessEnabled = harnessPanelEnabled();
  // 面板默认隐藏：正式游玩入口画面干净。?harness=1 时才显示并绑定控件。
  if (harnessPanel !== null) {
    harnessPanel.style.display = harnessEnabled ? "flex" : "none";
  }
  const scenarioSelect = harnessEnabled
    ? requireElement<HTMLSelectElement>("scenario-select")
    : null;
  const backendSelect = harnessEnabled
    ? requireElement<HTMLSelectElement>("backend-select")
    : null;
  const runButton = harnessEnabled
    ? requireElement<HTMLButtonElement>("run-scenario")
    : null;
  const downloadButton = harnessEnabled
    ? requireElement<HTMLButtonElement>("download-report")
    : null;
  const statusLabel = harnessEnabled
    ? requireElement<HTMLSpanElement>("harness-status")
    : null;
  const reportOutput = harnessEnabled
    ? requireElement<HTMLPreElement>("report-output")
    : null;

  const renderPath = resolveRenderPath();
  if (backendSelect !== null) {
    backendSelect.value = renderPath;
    backendSelect.addEventListener("change", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("backend", backendSelect.value);
      window.location.assign(url.toString());
    });
  }

  // 页面重载期间保持当前选中的 scenario。
  const requestedScenario = new URLSearchParams(window.location.search).get("scenario");
  if (scenarioSelect !== null) {
    scenarioSelect.addEventListener("change", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("scenario", scenarioSelect.value);
      window.history.replaceState(null, "", url.toString());
    });
  }

  const engine = await createEngine(canvas, renderPath);

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.055, 0.065, 0.085, 1);

  const hemiLight = new HemisphericLight("light.ambient", new Vector3(0, 1, 0), scene);
  hemiLight.intensity = 0.65;
  hemiLight.groundColor = new Color3(0.12, 0.13, 0.16);

  const sunLight = new DirectionalLight("light.sun", new Vector3(-0.7, -1, -0.45), scene);
  sunLight.intensity = 1.15;

  const region = createGreyboxRegion(scene);
  const camera = createIsometricCamera(scene, CAMERA_VERTICAL_SPAN);

  const resize = (): void => {
    engine.resize();
    const height = engine.getRenderHeight();
    updateOrthographicFrustum(
      camera,
      height > 0 ? engine.getRenderWidth() / height : 1,
      // 场景可能通过 setCameraSpan 改了可视高度；resize 必须沿用当前值。
      cameraVerticalSpan(camera, CAMERA_VERTICAL_SPAN),
    );
  };
  window.addEventListener("resize", resize);
  resize();

  const harness = new P0Harness(scene, engine);
  registerBuiltinScenarios(harness);

  let lastReport: MeasurementReport | null = null;

  const showReport = (report: MeasurementReport): void => {
    lastReport = report;
    if (statusLabel !== null) {
      statusLabel.textContent = `${report.scenario} · ${report.environment.renderBackend} · ${report.status} · ${report.durationMs} ms`;
      statusLabel.dataset.status = report.status;
    }
    if (reportOutput !== null) {
      reportOutput.textContent = harness.serialize(report);
    }
    if (downloadButton !== null) {
      downloadButton.disabled = false;
    }
    window.P0HarnessLastReport = report;
    window.dispatchEvent(new CustomEvent("p0:report", { detail: report }));
  };

  const runScenario = async (name: string): Promise<MeasurementReport> => {
    if (statusLabel !== null) {
      statusLabel.textContent = `${name} · 运行中…`;
    }
    window.P0HarnessRunningScenario = name;
    try {
      const report = await harness.runScenario(name);
      showReport(report);
      return report;
    } finally {
      delete window.P0HarnessRunningScenario;
    }
  };

  // 面板控件只在 ?harness=1 时存在/绑定。
  if (scenarioSelect !== null) {
    for (const scenario of harness.listScenarios()) {
      const option = document.createElement("option");
      option.value = scenario.name;
      option.textContent = scenario.name;
      option.title = scenario.description;
      scenarioSelect.append(option);
    }
    if (
      requestedScenario &&
      harness.listScenarios().some((s) => s.name === requestedScenario)
    ) {
      scenarioSelect.value = requestedScenario;
    }
  }

  if (runButton !== null && scenarioSelect !== null) {
    runButton.addEventListener("click", () => {
      void runScenario(scenarioSelect.value).catch((error: unknown) => {
        if (statusLabel !== null) {
          statusLabel.textContent = `失败：${String(error)}`;
          statusLabel.dataset.status = "failed";
        }
        if (reportOutput !== null) {
          reportOutput.textContent = String(error);
        }
      });
    });
  }

  if (downloadButton !== null) {
    downloadButton.addEventListener("click", () => {
      if (!lastReport) {
        return;
      }
      const json = serializeMeasurementReport(lastReport);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `p0-${lastReport.scenario}-${lastReport.environment.renderBackend}-${lastReport.finishedAt.replace(/[:.]/g, "-")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }

  window.P0Harness = {
    listScenarios: () => harness.listScenarios(),
    runScenario: (name) => runScenario(name),
    disposeActiveScenario: () => harness.disposeActiveScenario(),
    getLastReport: () => harness.getLastReport(),
    serialize: (report) => harness.serialize(report),
    getEnvironment: () => collectEnvironmentInfo(engine),
  };
  window.P0HarnessDebug = { scene, engine };

  engine.runRenderLoop(() => {
    scene.render();
  });

  await scene.whenReadyAsync();
  // 等两帧，确保 activeMeshes 等渲染态指标已建立。
  await nextFrame();
  await nextFrame();

  try {
    await runScenario("hello");
    window.P0HarnessReady = true;

    if (requestedScenario && requestedScenario !== "hello") {
      await runScenario(requestedScenario);
    }
  } catch (error) {
    window.P0HarnessError = String(error);
    if (statusLabel !== null) {
      statusLabel.textContent = `Harness 启动失败：${String(error)}`;
      statusLabel.dataset.status = "failed";
    }
    if (reportOutput !== null) {
      reportOutput.textContent = String(error);
    }
    throw error;
  }

  window.addEventListener("beforeunload", () => {
    void harness.disposeActiveScenario();
    region.dispose();
    scene.dispose();
    engine.dispose();
  });
}

void bootstrap().catch((error: unknown) => {
  window.P0HarnessError = String(error);
  console.error("[P0Harness] bootstrap failed", error);
});
