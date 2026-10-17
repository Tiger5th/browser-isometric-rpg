import { Animation } from "@babylonjs/core/Animations/animation";
// 注册 Scene.beginAnimation 等动画副作用（Babylon 9 按需加载）。
import "@babylonjs/core/Animations/animatable";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";

import type { Metric } from "../../logic/report";
import { updateOrthographicFrustum } from "../camera";
import type { ScenarioDefinition } from "../harness";

export const CHARACTER_SCENARIO_NAME = "characters-300";
export const CHARACTER_COUNT = 300;

const CHARACTER_PREFIX = "character.";
const GRID_COLUMNS = 20;
const GRID_SPACING = 1.0;
const WARMUP_MS = 3_000;
const SAMPLE_MS = 10_000;
const ANIMATION_FRAMES = 30;
const ANIMATION_FPS = 30;
const BASE_CAMERA_VERTICAL_SPAN = 20;
/** 20×15 网格投影后的水平半径约 11.7，留一点余量。 */
const REQUIRED_HALF_WIDTH = 13;
const JS_HEAP_BUDGET_MB = 1_536;
const FPS_BUDGET = 60;
const DRAW_CALL_BUDGET = 300;

const BONE_ROOT = 0;
const BONE_SPINE = 1;
const BONE_HEAD = 2;

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

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 按顶点高度分配三根骨骼的蒙皮权重：
 * 脚部 → root，腰部 → spine，头部 → head，中间线性过渡。
 */
function computeSkinWeights(y: number): [number, number, number] {
  const rootToSpine = clamp01((y - 0.2) / 0.35);
  const spineToHead = clamp01((y - 0.82) / 0.28);
  if (y < 0.2) {
    return [1, 0, 0];
  }
  if (y < 0.82) {
    return [1 - rootToSpine, rootToSpine, 0];
  }
  if (y < 1.1) {
    return [0, 1 - spineToHead, spineToHead];
  }
  return [0, 0, 1];
}

function applySkinWeights(mesh: Mesh): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) {
    throw new Error("角色原型缺少顶点位置数据");
  }

  const vertexCount = positions.length / 3;
  const matricesIndices = new Float32Array(vertexCount * 4);
  const matricesWeights = new Float32Array(vertexCount * 4);

  for (let index = 0; index < vertexCount; index += 1) {
    const weights = computeSkinWeights(positions[index * 3 + 1]);
    const offset = index * 4;
    matricesIndices[offset] = BONE_ROOT;
    matricesIndices[offset + 1] = BONE_SPINE;
    matricesIndices[offset + 2] = BONE_HEAD;
    matricesIndices[offset + 3] = 0;
    matricesWeights[offset] = weights[0];
    matricesWeights[offset + 1] = weights[1];
    matricesWeights[offset + 2] = weights[2];
    matricesWeights[offset + 3] = 0;
  }

  mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, matricesIndices, false);
  mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, matricesWeights, false);
}

/** 程序化占位角色：胶囊身体 + 球形头部合并为单个 skinned mesh。 */
function createPrototype(scene: Scene): Mesh {
  const body = MeshBuilder.CreateCapsule(
    `${CHARACTER_PREFIX}proto-body`,
    { radius: 0.24, height: 0.95, tessellation: 8, subdivisions: 2, capSubdivisions: 2 },
    scene,
  );
  body.position.y = 0.475;

  const head = MeshBuilder.CreateSphere(
    `${CHARACTER_PREFIX}proto-head`,
    { diameter: 0.44, segments: 8 },
    scene,
  );
  head.position.y = 1.12;

  const merged = Mesh.MergeMeshes([body, head], true, true, undefined, false, false);
  if (!merged) {
    throw new Error("角色原型合并网格失败");
  }
  merged.name = `${CHARACTER_PREFIX}proto`;
  applySkinWeights(merged);
  return merged;
}

/**
 * Bone.rotation 的 getter 返回临时 Vector3，动画必须走 rotationQuaternion
 * （setter 会写回 _localRotation），否则关键帧值会被丢弃。
 */
function createQuaternionAnimation(
  name: string,
  axis: Vector3,
  keys: Array<{ frame: number; angle: number }>,
): Animation {
  const animation = new Animation(
    name,
    "rotationQuaternion",
    ANIMATION_FPS,
    Animation.ANIMATIONTYPE_QUATERNION,
    Animation.ANIMATIONLOOPMODE_CYCLE,
  );
  animation.setKeys(
    keys.map((key) => ({ frame: key.frame, value: Quaternion.RotationAxis(axis, key.angle) })),
  );
  return animation;
}

function createSkeleton(
  scene: Scene,
  index: number,
  sway: Animation,
  nod: Animation,
): Skeleton {
  const skeleton = new Skeleton(
    `${CHARACTER_PREFIX}${index}.skeleton`,
    `${CHARACTER_PREFIX}${index}.skeleton`,
    scene,
  );

  const root = new Bone("root", skeleton, null, Matrix.Identity());
  const spine = new Bone("spine", skeleton, root, Matrix.Translation(0, 0.5, 0));
  new Bone("head", skeleton, spine, Matrix.Translation(0, 0.42, 0));

  spine.animations = [sway];
  skeleton.bones[BONE_HEAD].animations = [nod];
  return skeleton;
}

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
        spineRotationZ: state.skeletons[0]?.bones[BONE_SPINE]?.rotation.z ?? 0,
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
    const swayAxis = new Vector3(0, 0, 1);
    const nodAxis = new Vector3(1, 0, 0);
    const sway = createQuaternionAnimation("character.sway", swayAxis, [
      { frame: 0, angle: -0.16 },
      { frame: ANIMATION_FRAMES / 2, angle: 0.16 },
      { frame: ANIMATION_FRAMES, angle: -0.16 },
    ]);
    const nod = createQuaternionAnimation("character.nod", nodAxis, [
      { frame: 0, angle: 0.1 },
      { frame: ANIMATION_FRAMES / 2, angle: -0.08 },
      { frame: ANIMATION_FRAMES, angle: 0.1 },
    ]);

    const colors = [
      new Color3(0.3, 0.75, 0.7),
      new Color3(0.85, 0.55, 0.3),
      new Color3(0.55, 0.5, 0.85),
      new Color3(0.65, 0.75, 0.4),
    ];
    for (let index = 0; index < colors.length; index += 1) {
      const material = new StandardMaterial(`${CHARACTER_PREFIX}material-${index}`, scene);
      material.diffuseColor = colors[index];
      material.specularColor = Color3.Black();
      state.materials.push(material);
    }

    const prototype = createPrototype(scene);
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

      const skeleton = createSkeleton(scene, index, sway, nod);
      mesh.skeleton = skeleton;
      state.skeletons.push(skeleton);
      state.meshes.push(mesh);

      const animatable = scene.beginAnimation(
        skeleton,
        0,
        ANIMATION_FRAMES,
        true,
        0.85 + random() * 0.3,
      );
      animatable.goToFrame(random() * ANIMATION_FRAMES);
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
