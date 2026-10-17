import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { Metric } from "../../logic/report";
import { updateOrthographicFrustum } from "../camera";
import {
  CHARACTER_ANIMATION_FRAMES,
  CHARACTER_BONE_SPINE,
  createCharacterAnimations,
  createCharacterMaterial,
  createCharacterPrototype,
  createCharacterSkeleton,
  mulberry32,
} from "../character-proto";
import type { ScenarioDefinition } from "../harness";

export const CHARACTER_SCENARIO_NAME = "characters-300";
export const CHARACTER_COUNT = 300;

const CHARACTER_PREFIX = "character.";
const GRID_COLUMNS = 20;
const GRID_SPACING = 1.0;
const WARMUP_MS = 3_000;
const SAMPLE_MS = 10_000;
const BASE_CAMERA_VERTICAL_SPAN = 20;
/** 20×15 网格投影后的水平半径约 11.7，留一点余量。 */
const REQUIRED_HALF_WIDTH = 13;
const JS_HEAP_BUDGET_MB = 1_536;
const FPS_BUDGET = 60;
const DRAW_CALL_BUDGET = 300;

interface FrameSample {
  /** 与上一帧的间隔（毫秒）。 */
  dtMs: number;
  drawCalls: number;
  activeMeshes: number;
  animationMs: number;
  drawPhaseMs: number;
  /** scene.render() 的整段 JS 耗时（含动画、剔除、骨骼准备与提交）。 */
  sceneRenderMs: number;
  /** 抽样骨骼的旋转角，用于确认骨骼动画确实在推进。 */
  spineRotationZ: number;
}

interface PerformanceMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
}

interface CharacterScenarioState {
  meshes: Mesh[];
  skeletons: Skeleton[];
  materials: StandardMaterial[];
  hiddenMeshes: Array<{ mesh: AbstractMesh; isEnabled: boolean }>;
}

const state: CharacterScenarioState = {
  meshes: [],
  skeletons: [],
  materials: [],
  hiddenMeshes: [],
};

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 预热后按固定时长采样：帧间隔、draw calls、active meshes
 * 以及 Babylon 动画求值 / draw phase 的 CPU 耗时。
 */
function sampleFrames(scene: Scene, durationMs: number): Promise<FrameSample[]> {
  const instrumentation = new SceneInstrumentation(scene);
  const samples: FrameSample[] = [];

  return new Promise((resolve) => {
    let animationStart = 0;
    let animationMs = 0;
    let drawPhaseStart = 0;
    let drawPhaseMs = 0;
    let sceneRenderStart = 0;
    const startedAt = performance.now();
    let lastFrameAt = startedAt;

    const beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
      sceneRenderStart = performance.now();
    });
    const beforeAnimationsObserver = scene.onBeforeAnimationsObservable.add(() => {
      animationStart = performance.now();
    });
    const afterAnimationsObserver = scene.onAfterAnimationsObservable.add(() => {
      animationMs = performance.now() - animationStart;
    });
    const beforeDrawPhaseObserver = scene.onBeforeDrawPhaseObservable.add(() => {
      drawPhaseStart = performance.now();
    });
    const afterDrawPhaseObserver = scene.onAfterDrawPhaseObservable.add(() => {
      drawPhaseMs = performance.now() - drawPhaseStart;
    });
    const afterRenderObserver = scene.onAfterRenderObservable.add(() => {
      const now = performance.now();
      samples.push({
        dtMs: now - lastFrameAt,
        drawCalls: instrumentation.drawCallsCounter.current,
        activeMeshes: scene.getActiveMeshes().length,
        animationMs,
        drawPhaseMs,
        sceneRenderMs: now - sceneRenderStart,
        spineRotationZ: state.skeletons[0]?.bones[CHARACTER_BONE_SPINE]?.rotation.z ?? 0,
      });
      lastFrameAt = now;

      if (now - startedAt >= durationMs) {
        scene.onBeforeRenderObservable.remove(beforeRenderObserver);
        scene.onBeforeAnimationsObservable.remove(beforeAnimationsObserver);
        scene.onAfterAnimationsObservable.remove(afterAnimationsObserver);
        scene.onBeforeDrawPhaseObservable.remove(beforeDrawPhaseObserver);
        scene.onAfterDrawPhaseObservable.remove(afterDrawPhaseObserver);
        scene.onAfterRenderObservable.remove(afterRenderObserver);
        instrumentation.dispose();
        resolve(samples);
      }
    });
  });
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxOf(values: readonly number[]): number {
  return values.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function readPerformanceMemory(): PerformanceMemoryInfo | null {
  const memory = (performance as Performance & { memory?: PerformanceMemoryInfo }).memory;
  return memory ?? null;
}

function buildMetrics(scene: Scene, samples: readonly FrameSample[]): Metric[] {
  const intervals = samples.map((sample) => sample.dtMs).filter((dtMs) => dtMs > 0);
  const elapsedMs = intervals.reduce((sum, dtMs) => sum + dtMs, 0);
  const fpsAverage = elapsedMs > 0 ? (intervals.length * 1_000) / elapsedMs : 0;
  const fpsMin = intervals.length > 0 ? 1_000 / maxOf(intervals) : 0;
  const drawCallsAverage = average(samples.map((sample) => sample.drawCalls));
  const drawCallsMax = maxOf(samples.map((sample) => sample.drawCalls));
  const activeMeshesAverage = average(samples.map((sample) => sample.activeMeshes));
  const animationMsAverage = average(samples.map((sample) => sample.animationMs));
  const drawPhaseMsAverage = average(samples.map((sample) => sample.drawPhaseMs));
  const sceneRenderMsAverage = average(samples.map((sample) => sample.sceneRenderMs));
  const spineRotations = samples.map((sample) => sample.spineRotationZ);
  const spineRotationRange =
    maxOf(spineRotations) - spineRotations.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
  const engine = scene.getEngine();
  const renderWidth = engine.getRenderWidth();
  const renderHeight = engine.getRenderHeight();
  const memory = readPerformanceMemory();

  const metrics: Metric[] = [
    {
      name: "characterCount",
      value: state.meshes.length,
      unit: "characters",
      threshold: CHARACTER_COUNT,
      comparison: "eq",
    },
    {
      name: "skeletonCount",
      value: state.skeletons.length,
      unit: "skeletons",
    },
    {
      name: "boneCount",
      value: state.skeletons.reduce((sum, skeleton) => sum + skeleton.bones.length, 0),
      unit: "bones",
    },
    {
      name: "spineRotationRangeRad",
      value: round(spineRotationRange, 3),
      unit: "rad",
      threshold: 0.1,
      comparison: "gte",
    },
    {
      name: "fpsAverage",
      value: round(fpsAverage),
      unit: "fps",
      threshold: FPS_BUDGET,
      comparison: "gte",
    },
    {
      name: "fpsMin",
      value: round(fpsMin),
      unit: "fps",
    },
    {
      name: "frameTimeMsAverage",
      value: round(average(intervals)),
      unit: "ms",
      threshold: 1_000 / FPS_BUDGET,
      comparison: "lte",
    },
    {
      name: "drawCallsAverage",
      value: round(drawCallsAverage),
      unit: "calls",
      threshold: DRAW_CALL_BUDGET,
      comparison: "lte",
    },
    {
      name: "drawCallsMax",
      value: drawCallsMax,
      unit: "calls",
    },
    {
      name: "activeMeshesAverage",
      value: round(activeMeshesAverage),
      unit: "meshes",
    },
    {
      name: "animationUpdateMsAverage",
      value: round(animationMsAverage, 2),
      unit: "ms/frame",
    },
    {
      name: "renderSubmitMsAverage",
      value: round(drawPhaseMsAverage, 2),
      unit: "ms/frame",
    },
    {
      name: "sceneRenderMsAverage",
      value: round(sceneRenderMsAverage, 2),
      unit: "ms/frame",
    },
    {
      name: "renderWidth",
      value: renderWidth,
      unit: "px",
    },
    {
      name: "renderHeight",
      value: renderHeight,
      unit: "px",
    },
    {
      name: "renderPixelsMP",
      value: round((renderWidth * renderHeight) / 1_000_000, 2),
      unit: "MP",
    },
  ];

  if (memory) {
    metrics.push({
      name: "jsHeapUsedMB",
      value: round(memory.usedJSHeapSize / (1024 * 1024)),
      unit: "MB",
      threshold: JS_HEAP_BUDGET_MB,
      comparison: "lte",
    });
    metrics.push({
      name: "jsHeapTotalMB",
      value: round(memory.totalJSHeapSize / (1024 * 1024)),
      unit: "MB",
    });
  }

  return metrics;
}

function hideBaseScene(scene: Scene): void {
  for (const mesh of scene.meshes) {
    if (mesh.name.startsWith(CHARACTER_PREFIX)) {
      continue;
    }
    state.hiddenMeshes.push({ mesh, isEnabled: mesh.isEnabled() });
    mesh.setEnabled(false);
  }
}

function restoreBaseScene(): void {
  for (const { mesh, isEnabled } of state.hiddenMeshes) {
    mesh.setEnabled(isEnabled);
  }
  state.hiddenMeshes = [];
}

function fitCamera(scene: Scene): void {
  const camera = scene.activeCamera;
  const engine: AbstractEngine = scene.getEngine();
  if (!camera) {
    return;
  }
  const renderHeight = engine.getRenderHeight();
  const aspect = renderHeight > 0 ? engine.getRenderWidth() / renderHeight : 1;
  const verticalSpan = Math.max(BASE_CAMERA_VERTICAL_SPAN, (2 * REQUIRED_HALF_WIDTH) / aspect);
  updateOrthographicFrustum(camera, aspect, verticalSpan);
}

function restoreCamera(scene: Scene): void {
  const camera = scene.activeCamera;
  const engine = scene.getEngine();
  if (!camera) {
    return;
  }
  const renderHeight = engine.getRenderHeight();
  const aspect = renderHeight > 0 ? engine.getRenderWidth() / renderHeight : 1;
  updateOrthographicFrustum(camera, aspect, BASE_CAMERA_VERTICAL_SPAN);
}

function disposeCharacters(): void {
  for (const skeleton of state.skeletons) {
    skeleton.getScene().stopAnimation(skeleton);
    skeleton.dispose();
  }
  state.skeletons = [];

  for (const mesh of state.meshes) {
    mesh.dispose();
  }
  state.meshes = [];

  for (const material of state.materials) {
    material.dispose();
  }
  state.materials = [];
}

/**
 * 角色渲染验证：300 个程序化骨骼动画角色同屏，正交等距相机。
 * 预热 3s 后固定采样 10s；WebGL2 / WebGPU 由页面 URL 参数切换。
 */
export const charactersScenario: ScenarioDefinition = {
  name: CHARACTER_SCENARIO_NAME,
  description:
    "300 个程序化骨骼动画角色同屏：帧率、draw calls、内存采样（WebGL2 / WebGPU 可切换）",

  async setup(context) {
    const { scene } = context;
    disposeCharacters();
    hideBaseScene(scene);
    fitCamera(scene);

    const random = mulberry32(0x5eed11);
    const animations = createCharacterAnimations();

    const colors = [
      new Color3(0.3, 0.75, 0.7),
      new Color3(0.85, 0.55, 0.3),
      new Color3(0.55, 0.5, 0.85),
      new Color3(0.65, 0.75, 0.4),
    ];
    for (let index = 0; index < colors.length; index += 1) {
      state.materials.push(
        createCharacterMaterial(scene, `${CHARACTER_PREFIX}material-${index}`, colors[index]),
      );
    }

    const prototype = createCharacterPrototype(scene, CHARACTER_PREFIX);
    const rows = Math.ceil(CHARACTER_COUNT / GRID_COLUMNS);
    const offsetX = ((GRID_COLUMNS - 1) * GRID_SPACING) / 2;
    const offsetZ = ((rows - 1) * GRID_SPACING) / 2;

    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      const column = index % GRID_COLUMNS;
      const row = Math.floor(index / GRID_COLUMNS);
      const mesh = prototype.clone(`${CHARACTER_PREFIX}${index}`, null, true);
      mesh.position.set(column * GRID_SPACING - offsetX, 0, row * GRID_SPACING - offsetZ);
      mesh.material = state.materials[index % state.materials.length];
      mesh.isPickable = false;

      const skeleton = createCharacterSkeleton(scene, CHARACTER_PREFIX, index, animations);
      mesh.skeleton = skeleton;
      state.skeletons.push(skeleton);
      state.meshes.push(mesh);

      const animatable = scene.beginAnimation(
        skeleton,
        0,
        CHARACTER_ANIMATION_FRAMES,
        true,
        0.85 + random() * 0.3,
      );
      animatable.goToFrame(random() * CHARACTER_ANIMATION_FRAMES);
    }

    // 原型本身不参与渲染；几何体由 300 个角色共享。
    prototype.dispose();

    context.registerRegion("region.characters-300");
    for (const mesh of state.meshes) {
      context.registerEntity(mesh.name);
    }

    await nextFrame();
  },

  async measure(context) {
    // 预热：等 shader 编译、骨骼矩阵纹理分配与 JIT 稳定后再采样。
    await delay(WARMUP_MS);

    const samples = await sampleFrames(context.scene, SAMPLE_MS);
    if (samples.length === 0) {
      throw new Error("角色场景未采集到任何帧");
    }

    return buildMetrics(context.scene, samples);
  },

  teardown(context) {
    disposeCharacters();
    restoreCamera(context.scene);
    restoreBaseScene();
  },
};
