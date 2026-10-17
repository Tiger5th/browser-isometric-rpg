import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import { serializeMeasurementReport, type MeasurementReport } from "../logic/report";
import { createIsometricCamera, updateOrthographicFrustum } from "./camera";
import { collectEnvironmentInfo } from "./environment";
import { createGreyboxRegion } from "./greybox";
import { P0Harness, type ScenarioSummary } from "./harness";
import { registerBuiltinScenarios } from "./scenarios";

export interface P0HarnessApi {
  listScenarios(): ScenarioSummary[];
  runScenario(name: string): Promise<MeasurementReport>;
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
  }
}

const CAMERA_VERTICAL_SPAN = 20;

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`缺少页面元素：#${id}`);
  }
  return element as T;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function bootstrap(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>("p0-canvas");
  const scenarioSelect = requireElement<HTMLSelectElement>("scenario-select");
  const runButton = requireElement<HTMLButtonElement>("run-scenario");
  const downloadButton = requireElement<HTMLButtonElement>("download-report");
  const statusLabel = requireElement<HTMLSpanElement>("harness-status");
  const reportOutput = requireElement<HTMLPreElement>("report-output");

  const engine = new Engine(
    canvas,
    true,
    { preserveDrawingBuffer: true, stencil: true, antialias: true },
    true,
  );

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
      CAMERA_VERTICAL_SPAN,
    );
  };
  window.addEventListener("resize", resize);
  resize();

  const harness = new P0Harness(scene, engine);
  registerBuiltinScenarios(harness);

  let lastReport: MeasurementReport | null = null;

  const showReport = (report: MeasurementReport): void => {
    lastReport = report;
    statusLabel.textContent = `${report.scenario} · ${report.status} · ${report.durationMs} ms`;
    statusLabel.dataset.status = report.status;
    reportOutput.textContent = harness.serialize(report);
    downloadButton.disabled = false;
    window.P0HarnessLastReport = report;
    window.dispatchEvent(new CustomEvent("p0:report", { detail: report }));
  };

  const runScenario = async (name: string): Promise<MeasurementReport> => {
    statusLabel.textContent = `${name} · 运行中…`;
    const report = await harness.runScenario(name);
    showReport(report);
    return report;
  };

  for (const scenario of harness.listScenarios()) {
    const option = document.createElement("option");
    option.value = scenario.name;
    option.textContent = scenario.name;
    option.title = scenario.description;
    scenarioSelect.append(option);
  }

  runButton.addEventListener("click", () => {
    void runScenario(scenarioSelect.value).catch((error: unknown) => {
      statusLabel.textContent = `失败：${String(error)}`;
      statusLabel.dataset.status = "failed";
      reportOutput.textContent = String(error);
    });
  });

  downloadButton.addEventListener("click", () => {
    if (!lastReport) {
      return;
    }
    const json = serializeMeasurementReport(lastReport);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `p0-${lastReport.scenario}-${lastReport.finishedAt.replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  window.P0Harness = {
    listScenarios: () => harness.listScenarios(),
    runScenario: (name) => runScenario(name),
    getLastReport: () => harness.getLastReport(),
    serialize: (report) => harness.serialize(report),
    getEnvironment: () => collectEnvironmentInfo(engine),
  };

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
  } catch (error) {
    window.P0HarnessError = String(error);
    statusLabel.textContent = `Harness 启动失败：${String(error)}`;
    statusLabel.dataset.status = "failed";
    reportOutput.textContent = String(error);
    throw error;
  }

  window.addEventListener("beforeunload", () => {
    region.dispose();
    scene.dispose();
    engine.dispose();
  });
}

void bootstrap().catch((error: unknown) => {
  console.error("[P0Harness] bootstrap failed", error);
});
