import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { HighlightLayer } from "@babylonjs/core/Layers/highlightLayer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

import { summarizeFrameTimes, type FrameTimeSummary } from "../../logic/perf";
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

export const OCCLUSION_SCENARIO_NAME = "occlusion-outline";
export const OCCLUSION_CHARACTER_COUNT = 30;

const PREFIX = "occlusion.";
const CHARACTER_PREFIX = `${PREFIX}character.`;
const WALL_PREFIX = `${PREFIX}wall.`;
const TOWER_PREFIX = `${PREFIX}tower.`;
const GROUND_NAME = `${PREFIX}ground`;

/** 固定渲染宽度，避免窗口尺寸/DPR 变化把帧率对比带偏；实际分辨率写入报告。 */
const TARGET_RENDER_WIDTH = 2560;
/** 射线瞄准的角色高度（髋部）；低于矮墙顶部即判定被遮挡。 */
const TARGET_POINT_Y = 0.55;
/** 射线从相机一侧回退的距离（角色在射线上恰好位于末端）。 */
const RAY_BACKOFF = 25;
const WALL_HEIGHT = 1.55;
const WALL_THICKNESS = 0.35;
/** 墙体在角色前方（朝相机方向）的水平距离。 */
const WALL_CAMERA_OFFSET = 1.3;
const WALL_LENGTH = 9.2;
const CLUSTER_CHARACTERS = 8;
const CLUSTER_P_COORDINATES = [-10, 0, 10] as const;
/** 开阔地（无遮挡）角色：沿 P 排列、位于所有墙体的相机一侧。 */
const OPEN_CHARACTER_P = [-9, -6, -3, 0, 3, 6] as const;
const OPEN_CHARACTER_D = -4.2;
const CHARACTER_SPACING = 1.15;
const TOWER_POSITIONS = [
  { p: -6, d: 5.5, height: 5.2 },
  { p: 4.5, d: 6.5, height: 4.4 },
] as const;

const WARMUP_MS = 2_500;
const BASELINE_MS = 4_000;
const DETECTION_ONLY_MS = 4_000;
const OUTLINE_PREWARM_MS = 1_500;
const OUTLINE_MS = 5_000;
const BASE_CAMERA_VERTICAL_SPAN = 20;
const REQUIRED_HALF_WIDTH = 16;
const FPS_BUDGET = 60;
/** 描边可用性判定：60fps 预算的 95%，容忍 vsync 抖动带来的个别长帧。 */
const MIN_VIABLE_FPS = FPS_BUDGET * 0.95;

/**
 * 相机地面朝向：等距视角 alpha=-45° 时，相机→场景的水平方向。
 * P 与其垂直（屏幕水平方向），用于把角色排成横向队列、墙放在相机一侧。
 */
const VIEW_DIR = new Vector3(-1 / Math.SQRT2, 0, 1 / Math.SQRT2);
const ROW_DIR = new Vector3(1 / Math.SQRT2, 0, 1 / Math.SQRT2);
const TOWARD_CAMERA = VIEW_DIR.scale(-1);
const HIGHLIGHT_COLOR = new Color3(1.0, 0.62, 0.16);
const CAMERA_FORWARD_LOCAL = new Vector3(0, 0, 1);

interface CharacterEntry {
  mesh: Mesh;
  skeleton: ReturnType<typeof createCharacterSkeleton>;
}

/** 墙体 OBB：用于零分配的射线-包围盒遮挡判定。 */
interface OccluderBox {
  center: Vector3;
  axisX: Vector3;
  axisY: Vector3;
  axisZ: Vector3;
  halfX: number;
  halfY: number;
  halfZ: number;
}

interface OccluderEntry {
  mesh: Mesh;
  box: OccluderBox;
}

interface FrameSample {
  dtMs: number;
  drawCalls: number;
  sceneRenderMs: number;
  detectionMs: number;
  highlightMs: number;
  spineRotationZ: number;
}

interface OcclusionState {
  characters: CharacterEntry[];
  occluders: OccluderEntry[];
  decorations: Mesh[];
  ground: Mesh | null;
  materials: StandardMaterial[];
  hiddenMeshes: Array<{ mesh: AbstractMesh; isEnabled: boolean }>;
  layer: HighlightLayer | null;
  detectionObserver: Observer<Scene> | null;
  detectionEnabled: boolean;
  highlightSyncEnabled: boolean;
  occludedIds: Set<string>;
  outlinedIds: Set<string>;
  latestDetectionMs: number;
  latestHighlightMs: number;
  highlightStartedAt: number;
  addTransitions: number;
  removeTransitions: number;
  previousHardwareScaling: number | null;
  forward: Vector3 | null;
}

const state: OcclusionState = {
  characters: [],
  occluders: [],
  decorations: [],
  ground: null,
  materials: [],
  hiddenMeshes: [],
  layer: null,
  detectionObserver: null,
  detectionEnabled: false,
  highlightSyncEnabled: false,
  occludedIds: new Set(),
  outlinedIds: new Set(),
  latestDetectionMs: 0,
  latestHighlightMs: 0,
  highlightStartedAt: 0,
  addTransitions: 0,
  removeTransitions: 0,
  previousHardwareScaling: null,
  forward: null,
};

interface PhaseStats {
  summary: FrameTimeSummary;
  drawCallsAverage: number;
  drawCallsMax: number;
  sceneRenderMsAverage: number;
  detectionMsAverage: number;
  detectionMsMax: number;
  highlightMsAverage: number;
  highlightMsMax: number;
}

interface OcclusionDebugState {
  occluded: number;
  outlined: number;
  detectionMs: number;
  highlightMs: number;
  highlightEnabled: boolean;
  renderWidth: number;
  renderHeight: number;
}

interface OcclusionDebugApi {
  scenario: string;
  characterCount: number;
  occluderCount: number;
  getState: () => OcclusionDebugState;
  occludedNames: () => string[];
  /** 演示/截图用：开关描边，射线检测保持运行。 */
  setOutline: (enabled: boolean) => void;
}

declare global {
  interface Window {
    P0OcclusionDebug?: OcclusionDebugApi;
  }
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** 等 HighlightLayer 至少渲染过一帧（首次 shader 编译/后处理分配可能很慢）。 */
async function waitForHighlightFrame(timeoutMs: number): Promise<number> {
  const startedAt = performance.now();
  while (state.latestHighlightMs <= 0 && performance.now() - startedAt < timeoutMs) {
    await nextAnimationFrame();
  }
  return performance.now() - startedAt;
}

/** 把 P（屏幕水平）/ D（景深）坐标映射到世界地面坐标。 */
function groundPosition(p: number, d: number): Vector3 {
  return new Vector3(
    ROW_DIR.x * p + VIEW_DIR.x * d,
    0,
    ROW_DIR.z * p + VIEW_DIR.z * d,
  );
}

function createMaterial(scene: Scene, name: string, diffuse: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse;
  material.specularColor = Color3.Black();
  return material;
}

function createGround(scene: Scene, material: StandardMaterial): Mesh {
  const ground = MeshBuilder.CreateGround(GROUND_NAME, { width: 44, height: 40 }, scene);
  ground.material = material;
  ground.isPickable = false;
  return ground;
}

/**
 * 遮挡墙：长边沿屏幕水平方向 P，厚度沿景深 D，放在角色朝相机一侧，
 * 高度刚好遮住角色胸口以下（头部可见，便于观察描边）。
 */
function createWall(
  scene: Scene,
  index: number,
  center: Vector3,
  material: StandardMaterial,
): OccluderEntry {
  const wall = MeshBuilder.CreateBox(
    `${WALL_PREFIX}${index}`,
    { width: WALL_LENGTH, height: WALL_HEIGHT, depth: WALL_THICKNESS },
    scene,
  );
  const wallPosition = center.add(TOWARD_CAMERA.scale(WALL_CAMERA_OFFSET));
  wall.position.set(wallPosition.x, WALL_HEIGHT / 2, wallPosition.z);
  wall.rotation.y = -Math.PI / 4;
  wall.material = material;
  // 遮挡走自建射线-OBB，不参与 scene.pick，避免每帧拾取整场景。
  wall.isPickable = false;

  return {
    mesh: wall,
    box: {
      center: new Vector3(wallPosition.x, WALL_HEIGHT / 2, wallPosition.z),
      axisX: ROW_DIR,
      axisY: new Vector3(0, 1, 0),
      axisZ: VIEW_DIR,
      halfX: WALL_LENGTH / 2,
      halfY: WALL_HEIGHT / 2,
      halfZ: WALL_THICKNESS / 2,
    },
  };
}

function createTower(
  scene: Scene,
  index: number,
  p: number,
  d: number,
  height: number,
  material: StandardMaterial,
): Mesh {
  const position = groundPosition(p, d);
  const tower = MeshBuilder.CreateBox(
    `${TOWER_PREFIX}${index}`,
    { width: 2.2, height, depth: 2.2 },
    scene,
  );
  tower.position.set(position.x, height / 2, position.z);
  tower.material = material;
  // 纯背景装饰：不可拾取，避免影响遮挡射线成本。
  tower.isPickable = false;
  return tower;
}

/**
 * 射线-OBB 相交（slab 法），标量实现、零对象分配。
 * 返回射线在 [0, maxDistance] 内是否穿过盒子。
 */
function rayIntersectsOccluder(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDistance: number,
  box: OccluderBox,
): boolean {
  const offsetX = originX - box.center.x;
  const offsetY = originY - box.center.y;
  const offsetZ = originZ - box.center.z;
  let tMin = 0;
  let tMax = maxDistance;

  let axis = box.axisX;
  let offset = offsetX * axis.x + offsetY * axis.y + offsetZ * axis.z;
  let direction = dirX * axis.x + dirY * axis.y + dirZ * axis.z;
  if (Math.abs(direction) < 1e-8) {
    if (Math.abs(offset) > box.halfX) {
      return false;
    }
  } else {
    let t1 = (-box.halfX - offset) / direction;
    let t2 = (box.halfX - offset) / direction;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
    if (tMin > tMax) {
      return false;
    }
  }

  axis = box.axisY;
  offset = offsetX * axis.x + offsetY * axis.y + offsetZ * axis.z;
  direction = dirX * axis.x + dirY * axis.y + dirZ * axis.z;
  if (Math.abs(direction) < 1e-8) {
    if (Math.abs(offset) > box.halfY) {
      return false;
    }
  } else {
    let t1 = (-box.halfY - offset) / direction;
    let t2 = (box.halfY - offset) / direction;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
    if (tMin > tMax) {
      return false;
    }
  }

  axis = box.axisZ;
  offset = offsetX * axis.x + offsetY * axis.y + offsetZ * axis.z;
  direction = dirX * axis.x + dirY * axis.y + dirZ * axis.z;
  if (Math.abs(direction) < 1e-8) {
    if (Math.abs(offset) > box.halfZ) {
      return false;
    }
  } else {
    let t1 = (-box.halfZ - offset) / direction;
    let t2 = (box.halfZ - offset) / direction;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
    if (tMin > tMax) {
      return false;
    }
  }

  return true;
}

function hideBaseScene(scene: Scene): void {
  for (const mesh of scene.meshes) {
    if (mesh.name.startsWith(PREFIX)) {
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
  const engine = scene.getEngine();
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

/**
 * 固定渲染宽度：同一台机器上窗口/DPR 不同也能得到可对比的分辨率。
 * Babylon 的 renderWidth = canvas.clientWidth / hardwareScalingLevel。
 * teardown 恢复原 hardware scaling。
 */
function pinRenderResolution(engine: AbstractEngine): void {
  const canvas = engine.getRenderingCanvas();
  if (!canvas || canvas.clientWidth <= 0) {
    return;
  }
  state.previousHardwareScaling = engine.getHardwareScalingLevel();
  engine.setHardwareScalingLevel(canvas.clientWidth / TARGET_RENDER_WIDTH);
  engine.resize();
}

function restoreRenderResolution(engine: AbstractEngine): void {
  if (state.previousHardwareScaling === null) {
    return;
  }
  engine.setHardwareScalingLevel(state.previousHardwareScaling);
  engine.resize();
  state.previousHardwareScaling = null;
}

/** 只描边当前被遮挡的角色；状态未变化时不调用 addMesh/removeMesh。 */
function syncOutline(): void {
  const layer = state.layer;
  if (!layer) {
    return;
  }
  for (const { mesh } of state.characters) {
    const name = mesh.name;
    const occluded = state.occludedIds.has(name);
    const outlined = state.outlinedIds.has(name);
    if (occluded && !outlined) {
      layer.addMesh(mesh, HIGHLIGHT_COLOR);
      state.outlinedIds.add(name);
      state.addTransitions += 1;
    } else if (!occluded && outlined) {
      layer.removeMesh(mesh);
      state.outlinedIds.delete(name);
      state.removeTransitions += 1;
    }
  }
}

/**
 * 从等距相机方向对每个角色发射线（射线-OBB，零分配）；
 * 命中遮挡墙即加入描边列表。正交相机下所有射线方向一致。
 */
function detectOcclusion(): void {
  const forward = state.forward;
  if (!forward) {
    return;
  }

  const detectionStart = performance.now();
  const dirX = forward.x;
  const dirY = forward.y;
  const dirZ = forward.z;
  const backoffX = dirX * RAY_BACKOFF;
  const backoffY = dirY * RAY_BACKOFF;
  const backoffZ = dirZ * RAY_BACKOFF;

  for (const { mesh } of state.characters) {
    const originX = mesh.position.x - backoffX;
    const originY = mesh.position.y + TARGET_POINT_Y - backoffY;
    const originZ = mesh.position.z - backoffZ;

    let occluded = false;
    for (const occluder of state.occluders) {
      if (
        rayIntersectsOccluder(
          originX,
          originY,
          originZ,
          dirX,
          dirY,
          dirZ,
          RAY_BACKOFF,
          occluder.box,
        )
      ) {
        occluded = true;
        break;
      }
    }

    if (occluded) {
      state.occludedIds.add(mesh.name);
    } else {
      state.occludedIds.delete(mesh.name);
    }
  }

  const detectionMs = performance.now() - detectionStart;
  state.latestDetectionMs = detectionMs;

  if (state.highlightSyncEnabled) {
    syncOutline();
  }
}

function setMode(detect: boolean, outline: boolean): void {
  state.detectionEnabled = detect;
  state.highlightSyncEnabled = outline;
  if (!detect) {
    state.latestDetectionMs = 0;
  }
  if (!outline) {
    state.latestHighlightMs = 0;
  }
  if (state.layer) {
    state.layer.isEnabled = outline;
  }
  if (outline) {
    syncOutline();
  }
}

function collectPhase(
  scene: Scene,
  instrumentation: SceneInstrumentation,
  durationMs: number,
): Promise<FrameSample[]> {
  return new Promise((resolve) => {
    const samples: FrameSample[] = [];
    const startedAt = performance.now();
    let lastFrameAt = startedAt;
    let sceneRenderStart = startedAt;

    const beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
      sceneRenderStart = performance.now();
    });
    const afterRenderObserver = scene.onAfterRenderObservable.add(() => {
      const now = performance.now();
      samples.push({
        dtMs: now - lastFrameAt,
        drawCalls: instrumentation.drawCallsCounter.current,
        sceneRenderMs: now - sceneRenderStart,
        detectionMs: state.latestDetectionMs,
        highlightMs: state.latestHighlightMs,
        spineRotationZ: state.characters[0]?.skeleton.bones[CHARACTER_BONE_SPINE]?.rotation.z ?? 0,
      });
      lastFrameAt = now;

      if (now - startedAt >= durationMs) {
        scene.onBeforeRenderObservable.remove(beforeRenderObserver);
        scene.onAfterRenderObservable.remove(afterRenderObserver);
        resolve(samples);
      }
    });
  });
}

function buildPhaseStats(samples: readonly FrameSample[]): PhaseStats {
  const summary = summarizeFrameTimes(samples.map((sample) => sample.dtMs));
  return {
    summary,
    drawCallsAverage: average(samples.map((sample) => sample.drawCalls)),
    drawCallsMax: maxOf(samples.map((sample) => sample.drawCalls)),
    sceneRenderMsAverage: average(samples.map((sample) => sample.sceneRenderMs)),
    detectionMsAverage: average(samples.map((sample) => sample.detectionMs)),
    detectionMsMax: maxOf(samples.map((sample) => sample.detectionMs)),
    highlightMsAverage: average(samples.map((sample) => sample.highlightMs)),
    highlightMsMax: maxOf(samples.map((sample) => sample.highlightMs)),
  };
}

function phaseMetrics(prefix: string, stats: PhaseStats): Metric[] {
  return [
    { name: `${prefix}.fps`, value: round(stats.summary.fps), unit: "fps" },
    {
      name: `${prefix}.fpsMin`,
      value: round(stats.summary.maxMs > 0 ? 1_000 / stats.summary.maxMs : 0),
      unit: "fps",
    },
    { name: `${prefix}.frameTimeAvgMs`, value: round(stats.summary.avgMs), unit: "ms" },
    { name: `${prefix}.frameTimeP95Ms`, value: round(stats.summary.p95Ms), unit: "ms" },
    { name: `${prefix}.longFrames`, value: stats.summary.longFrames, unit: "frames" },
    { name: `${prefix}.sampledFrames`, value: stats.summary.count, unit: "frames" },
    { name: `${prefix}.drawCallsAverage`, value: round(stats.drawCallsAverage), unit: "calls" },
    { name: `${prefix}.drawCallsMax`, value: stats.drawCallsMax, unit: "calls" },
    {
      name: `${prefix}.sceneRenderMsAverage`,
      value: round(stats.sceneRenderMsAverage, 2),
      unit: "ms/frame",
    },
    {
      name: `${prefix}.detectionMsAverage`,
      value: round(stats.detectionMsAverage, 3),
      unit: "ms/frame",
    },
    { name: `${prefix}.detectionMsMax`, value: round(stats.detectionMsMax, 3), unit: "ms" },
    {
      name: `${prefix}.highlightMsAverage`,
      value: round(stats.highlightMsAverage, 3),
      unit: "ms/frame",
    },
    { name: `${prefix}.highlightMsMax`, value: round(stats.highlightMsMax, 3), unit: "ms" },
  ];
}

function installDebugApi(scene: Scene): void {
  window.P0OcclusionDebug = {
    scenario: OCCLUSION_SCENARIO_NAME,
    characterCount: state.characters.length,
    occluderCount: state.occluders.length,
    getState: () => ({
      occluded: state.occludedIds.size,
      outlined: state.outlinedIds.size,
      detectionMs: round(state.latestDetectionMs, 3),
      highlightMs: round(state.latestHighlightMs, 3),
      highlightEnabled: state.layer?.isEnabled ?? false,
      renderWidth: scene.getEngine().getRenderWidth(),
      renderHeight: scene.getEngine().getRenderHeight(),
    }),
    occludedNames: () => [...state.occludedIds],
    setOutline: (enabled) => {
      state.highlightSyncEnabled = enabled;
      if (state.layer) {
        state.layer.isEnabled = enabled;
      }
      if (enabled) {
        syncOutline();
      }
    },
  };
}

function disposeScenario(scene: Scene): void {
  if (state.detectionObserver) {
    scene.onBeforeRenderObservable.remove(state.detectionObserver);
    state.detectionObserver = null;
  }

  state.layer?.dispose();
  state.layer = null;

  for (const { skeleton } of state.characters) {
    scene.stopAnimation(skeleton);
    skeleton.dispose();
  }
  for (const { mesh } of state.characters) {
    mesh.dispose();
  }
  for (const { mesh } of state.occluders) {
    mesh.dispose();
  }
  for (const mesh of state.decorations) {
    mesh.dispose();
  }
  state.ground?.dispose();
  for (const material of state.materials) {
    material.dispose();
  }

  state.characters = [];
  state.occluders = [];
  state.decorations = [];
  state.ground = null;
  state.materials = [];
  state.occludedIds.clear();
  state.outlinedIds.clear();
  state.latestDetectionMs = 0;
  state.latestHighlightMs = 0;
  state.addTransitions = 0;
  state.removeTransitions = 0;
  state.detectionEnabled = false;
  state.highlightSyncEnabled = false;
  state.forward = null;
  delete window.P0OcclusionDebug;
}

/**
 * 遮挡描边验证：30 个程序化骨骼角色 + 3 段矮墙（真正遮挡胸口以下）。
 * 相机方向逐角色射线检测，只给被遮挡角色加 HighlightLayer 描边；
 * 依次采样「无描边基线 / 仅射线检测 / 检测+描边」三段，对照帧率与 draw calls。
 */
export const occlusionOutlineScenario: ScenarioDefinition = {
  name: OCCLUSION_SCENARIO_NAME,
  description:
    "遮挡描边验证：30 角色 + 墙体遮挡，射线检测 + HighlightLayer 描边；无描边/描边两组帧率与开销对照，运行后可继续观察描边",

  interactive: true,

  async setup(context) {
    const { scene, engine } = context;
    disposeScenario(scene);
    hideBaseScene(scene);
    pinRenderResolution(engine);
    fitCamera(scene);

    const camera = scene.activeCamera;
    state.forward = camera
      ? camera.getDirection(CAMERA_FORWARD_LOCAL).normalize()
      : null;

    const groundMaterial = createMaterial(scene, `${PREFIX}material-ground`, new Color3(0.12, 0.15, 0.2));
    const wallMaterial = createMaterial(scene, `${PREFIX}material-wall`, new Color3(0.42, 0.45, 0.5));
    const towerMaterial = createMaterial(scene, `${PREFIX}material-tower`, new Color3(0.28, 0.32, 0.4));
    state.materials.push(groundMaterial, wallMaterial, towerMaterial);

    state.ground = createGround(scene, groundMaterial);

    let wallIndex = 0;
    const random = mulberry32(0x0cc1);
    for (const clusterP of CLUSTER_P_COORDINATES) {
      const wallCenter = groundPosition(clusterP, 0);
      const wall = createWall(scene, wallIndex, wallCenter, wallMaterial);
      wallIndex += 1;
      state.occluders.push(wall);
    }

    for (const [index, tower] of TOWER_POSITIONS.entries()) {
      state.decorations.push(
        createTower(scene, index, tower.p, tower.d, tower.height, towerMaterial),
      );
    }

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
    const characterMaterials = state.materials.slice(-colors.length);

    const prototype = createCharacterPrototype(scene, CHARACTER_PREFIX);
    const animations = createCharacterAnimations();

    const spawn = (p: number, d: number): void => {
      const index = state.characters.length;
      const position = groundPosition(p, d);
      const mesh = prototype.clone(`${CHARACTER_PREFIX}${index}`, null, true);
      mesh.position.copyFrom(position);
      mesh.material = characterMaterials[index % characterMaterials.length];
      mesh.isPickable = false;

      const skeleton = createCharacterSkeleton(scene, CHARACTER_PREFIX, index, animations);
      mesh.skeleton = skeleton;
      state.characters.push({ mesh, skeleton });

      const animatable = scene.beginAnimation(
        skeleton,
        0,
        CHARACTER_ANIMATION_FRAMES,
        true,
        0.85 + random() * 0.3,
      );
      animatable.goToFrame(random() * CHARACTER_ANIMATION_FRAMES);
    };

    // 每簇 8 个角色排在墙后（沿屏幕水平方向），共 24 个可被遮挡。
    for (const clusterP of CLUSTER_P_COORDINATES) {
      for (let index = 0; index < CLUSTER_CHARACTERS; index += 1) {
        const offset = (index - (CLUSTER_CHARACTERS - 1) / 2) * CHARACTER_SPACING;
        spawn(clusterP + offset, 0);
      }
    }
    // 6 个角色站在开阔地（相机一侧、墙前面），用于验证「只描边被遮挡者」。
    for (const p of OPEN_CHARACTER_P) {
      spawn(p, OPEN_CHARACTER_D);
    }

    prototype.dispose();

    const layer = new HighlightLayer(`${PREFIX}highlight`, scene, {
      isStroke: true,
      mainTextureRatio: 0.5,
      blurTextureSizeRatio: 0.5,
      blurHorizontalSize: 1.5,
      blurVerticalSize: 1.5,
    });
    layer.innerGlow = false;
    layer.outerGlow = true;
    layer.isEnabled = false;
    layer.onBeforeRenderMainTextureObservable.add(() => {
      state.highlightStartedAt = performance.now();
    });
    layer.onAfterComposeObservable.add(() => {
      if (state.highlightStartedAt > 0) {
        state.latestHighlightMs = performance.now() - state.highlightStartedAt;
        state.highlightStartedAt = 0;
      }
    });
    state.layer = layer;

    state.detectionObserver = scene.onBeforeRenderObservable.add(() => {
      if (!state.detectionEnabled) {
        return;
      }
      detectOcclusion();
    });

    context.registerRegion("region.occlusion-outline");
    for (const { mesh } of state.characters) {
      context.registerEntity(mesh.name);
    }
    for (const { mesh: wallMesh } of state.occluders) {
      context.registerEntity(wallMesh.name);
    }

    installDebugApi(scene);
  },

  async measure(context) {
    const { scene } = context;
    const instrumentation = new SceneInstrumentation(scene);

    try {
      // 预热：shader 编译、骨骼矩阵纹理与 JIT 稳定。
      setMode(false, false);
      await delay(WARMUP_MS);

      const baselineSamples = await collectPhase(scene, instrumentation, BASELINE_MS);
      if (baselineSamples.length === 0) {
        throw new Error("遮挡场景基线阶段未采集到帧");
      }

      setMode(true, false);
      await delay(100);
      const detectionSamples = await collectPhase(scene, instrumentation, DETECTION_ONLY_MS);

      // 打开描边并预热，避免首次 shader 编译污染测量窗口。
      setMode(true, true);
      state.addTransitions = 0;
      state.removeTransitions = 0;
      const outlineWarmupMs = await waitForHighlightFrame(8_000);
      await delay(OUTLINE_PREWARM_MS);
      state.addTransitions = 0;
      state.removeTransitions = 0;

      const outlineSamples = await collectPhase(scene, instrumentation, OUTLINE_MS);
      if (outlineSamples.length === 0) {
        throw new Error("遮挡场景描边阶段未采集到帧");
      }

      const baseline = buildPhaseStats(baselineSamples);
      const detection = buildPhaseStats(detectionSamples);
      const outline = buildPhaseStats(outlineSamples);

      const engine = scene.getEngine();
      const renderWidth = engine.getRenderWidth();
      const renderHeight = engine.getRenderHeight();
      const occludedCount = state.occludedIds.size;
      const outlinedCount = state.outlinedIds.size;
      const spineRotations = outlineSamples.map((sample) => sample.spineRotationZ);
      const spineRotationRange =
        maxOf(spineRotations) -
        spineRotations.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);

      const metrics: Metric[] = [
        {
          name: "occlusion.characterCount",
          value: state.characters.length,
          unit: "characters",
          threshold: OCCLUSION_CHARACTER_COUNT,
          comparison: "eq",
        },
        { name: "occlusion.skeletonCount", value: state.characters.length, unit: "skeletons" },
        {
          name: "occlusion.boneCount",
          value: state.characters.reduce((sum, entry) => sum + entry.skeleton.bones.length, 0),
          unit: "bones",
        },
        { name: "occlusion.occluderCount", value: state.occluders.length, unit: "occluders" },
        {
          name: "occlusion.occludedCharacters",
          value: occludedCount,
          unit: "characters",
          threshold: 10,
          comparison: "gte",
        },
        {
          name: "occlusion.outlinedCharacters",
          value: outlinedCount,
          unit: "characters",
          threshold: 10,
          comparison: "gte",
        },
        {
          name: "occlusion.highlightLayerEnabled",
          value: state.layer?.isEnabled ? 1 : 0,
          unit: "boolean",
          threshold: 1,
          comparison: "eq",
        },
        {
          name: "occlusion.outlineAddTransitionsDuringMeasure",
          value: state.addTransitions,
          unit: "transitions",
        },
        {
          name: "occlusion.outlineRemoveTransitionsDuringMeasure",
          value: state.removeTransitions,
          unit: "transitions",
        },
        {
          name: "occlusion.spineRotationRangeRad",
          value: round(spineRotationRange, 3),
          unit: "rad",
          threshold: 0.1,
          comparison: "gte",
        },
        {
          name: "occlusion.outlineWarmupMs",
          value: round(outlineWarmupMs),
          unit: "ms",
        },
        { name: "occlusion.rayBackoff", value: RAY_BACKOFF, unit: "units" },
        { name: "occlusion.targetPointY", value: TARGET_POINT_Y, unit: "units" },
        { name: "occlusion.wallHeight", value: WALL_HEIGHT, unit: "units" },
        { name: "occlusion.wallCameraOffset", value: WALL_CAMERA_OFFSET, unit: "units" },
        {
          name: "occlusion.outlineViable",
          value: outline.summary.fps >= MIN_VIABLE_FPS ? 1 : 0,
          unit: "boolean",
          threshold: 1,
          comparison: "eq",
        },
        { name: "occlusion.minViableFps", value: round(MIN_VIABLE_FPS), unit: "fps" },
        { name: "renderWidth", value: renderWidth, unit: "px" },
        { name: "renderHeight", value: renderHeight, unit: "px" },
        {
          name: "renderPixelsMP",
          value: round((renderWidth * renderHeight) / 1_000_000, 2),
          unit: "MP",
        },
        { name: "renderWidthPinned", value: TARGET_RENDER_WIDTH, unit: "px" },
      ];

      metrics.push(
        ...phaseMetrics("baseline", baseline),
        ...phaseMetrics("detectionOnly", detection),
        ...phaseMetrics("outline", outline),
      );

      metrics.push(
        {
          name: "comparison.frameTimeDeltaMs",
          value: round(outline.summary.avgMs - baseline.summary.avgMs),
          unit: "ms",
        },
        {
          name: "comparison.highlightMarginalFrameTimeMs",
          value: round(outline.summary.avgMs - detection.summary.avgMs),
          unit: "ms",
        },
        {
          name: "comparison.drawCallsDelta",
          value: round(outline.drawCallsAverage - baseline.drawCallsAverage),
          unit: "calls",
        },
        {
          name: "comparison.fpsDelta",
          value: round(outline.summary.fps - baseline.summary.fps),
          unit: "fps",
        },
      );

      // measure 结束后维持「检测 + 描边」状态，便于截图与人工观察。
      return metrics;
    } finally {
      instrumentation.dispose();
    }
  },

  teardown(context) {
    const { scene, engine } = context;
    disposeScenario(scene);
    restoreCamera(scene);
    restoreRenderResolution(engine);
    restoreBaseScene();
  },
};
