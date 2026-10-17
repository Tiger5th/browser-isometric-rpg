import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { NavMeshQuery, type NavMesh } from "recast-navigation";

import {
  createBoxObstacleSpecs,
  createRegionGeometry,
  createSeededRandom,
  type Bounds2D,
  type BoxObstacleSpec,
} from "../../logic/navmesh-geometry";
import { summarizeFrameTimes } from "../../logic/perf";
import type { Metric } from "../../logic/report";
import { DEFAULT_CAMERA_VERTICAL_SPAN } from "../camera";
import {
  countMovingAgents,
  countOverlappingPairs,
  countReachedTargets,
  createAgentMaterial,
  createClickMarker,
  createCrowdRuntime,
  attachClickToMove,
  minimumPairDistance,
  setAgentTarget,
  updateCrowdRuntime,
  type CrowdRuntime,
} from "../crowd-utils";
import type { ScenarioContext, ScenarioDefinition } from "../harness";
import {
  collectFrameTimes,
  createNavMeshOverlay,
  buildNavMesh,
  initializeNavigation,
  isJsHeapApiAvailable,
  NAV_MESH_CONFIG,
  waitFrames,
} from "../navigation";
import {
  createGroundVisual,
  createObstacleMaterial,
  createObstacleVisuals,
  setCameraSpan,
  setGreyboxEnabled,
} from "../navmesh-scene";

const SCENARIO_NAME = "crowd-nav";
const REGION_SIZE = 200;
const REGION_BOUNDS: Bounds2D = {
  minX: -REGION_SIZE / 2,
  maxX: REGION_SIZE / 2,
  minZ: -REGION_SIZE / 2,
  maxZ: REGION_SIZE / 2,
};
/** 用于推导区域规模上限的对比尺寸（正方形、中心在原点）。 */
const BENCHMARK_SIZES = [50, 100, 200, 300] as const;
const AGENT_COUNT = 50;
const AGENTS_PER_GROUP = AGENT_COUNT / 2;
const CROWD_CAMERA_SPAN = 55;
const CROSSING_CENTER = 12;
const CROSSING_RADIUS = 6;
const SAMPLE_DURATION_MS = 5000;
const AUTO_DEMO_INTERVAL_SECONDS = 6;
const MIB = 1024 * 1024;

interface BenchmarkEntry {
  size: number;
  obstacleCount: number;
  generationMs: number;
  bytes: number;
  triangleCount: number;
  wasmHeapDeltaBytes: number;
  jsHeapDeltaBytes: number;
}

interface CrowdNavState {
  root: TransformNode;
  navMesh: NavMesh;
  crowd: CrowdRuntime;
  observer: Observer<Scene> | null;
  detachClick: () => void;
  benchmark: BenchmarkEntry[];
  updateCosts: number[];
  autoDemo: boolean;
  autoDemoElapsed: number;
}

const states = new WeakMap<ScenarioContext, CrowdNavState>();

function boundsForSize(size: number): Bounds2D {
  const half = size / 2;
  return { minX: -half, maxX: half, minZ: -half, maxZ: half };
}

function subdivisionsForSize(size: number): number {
  return Math.max(2, Math.min(8, Math.round(size / 25)));
}

function obstacleCountForSize(size: number): number {
  return Math.max(4, Math.round((size * size) / 1000));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sampleSpawnPoints(
  query: NavMeshQuery,
  center: Vector3,
  radius: number,
  count: number,
): Vector3[] {
  const points: Vector3[] = [];
  const fallback = query.findClosestPoint(center, {
    halfExtents: { x: radius + 4, y: 4, z: radius + 4 },
  });

  for (let index = 0; index < count; index += 1) {
    const result = query.findRandomPointAroundCircle(center, radius, {
      halfExtents: { x: radius + 4, y: 4, z: radius + 4 },
    });
    if (result.success) {
      points.push(new Vector3(result.randomPoint.x, 0, result.randomPoint.z));
    } else if (fallback.success) {
      points.push(new Vector3(fallback.point.x, 0, fallback.point.z));
    }
  }

  return points;
}

function commandAround(
  crowd: CrowdRuntime,
  center: Vector3,
  spread: number,
  random: () => number,
  filter?: (runtime: CrowdRuntime["agents"][number]) => boolean,
): number {
  let commanded = 0;
  for (const runtime of crowd.agents) {
    if (filter && !filter(runtime)) {
      continue;
    }
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * spread;
    const target = new Vector3(
      center.x + Math.cos(angle) * radius,
      0,
      center.z + Math.sin(angle) * radius,
    );
    if (setAgentTarget(crowd.query, runtime, target)) {
      commanded += 1;
    }
  }
  return commanded;
}

function commandCrossing(crowd: CrowdRuntime, random: () => number): number {
  let commanded = 0;
  for (const runtime of crowd.agents) {
    const targetX = runtime.group === 0 ? CROSSING_CENTER : -CROSSING_CENTER;
    const target = new Vector3(
      targetX + (random() * 8 - 4),
      0,
      random() * 10 - 5,
    );
    if (setAgentTarget(crowd.query, runtime, target)) {
      commanded += 1;
    }
  }
  return commanded;
}

function installDebugApi(state: CrowdNavState): void {
  const random = createSeededRandom(0x51c1);
  window.P0CrowdDebug = {
    scenario: SCENARIO_NAME,
    agentCount: state.crowd.agents.length,
    getAgents: () =>
      state.crowd.agents.map((runtime) => ({
        x: runtime.mesh.position.x,
        z: runtime.mesh.position.z,
        targetX: runtime.target?.x ?? null,
        targetZ: runtime.target?.z ?? null,
      })),
    commandTo: (x: number, z: number) =>
      commandAround(state.crowd, new Vector3(x, 0, z), 4, random),
  };
}

function createBenchmarkEntries(
  visualObstacles: readonly BoxObstacleSpec[],
): { entries: BenchmarkEntry[]; region200: NavMesh } {
  const entries: BenchmarkEntry[] = [];
  let region200: NavMesh | null = null;

  for (const size of BENCHMARK_SIZES) {
    const bounds = boundsForSize(size);
    const obstacles =
      size === REGION_SIZE
        ? visualObstacles
        : createBoxObstacleSpecs(bounds, obstacleCountForSize(size), 0x1000 + size, {
            margin: 6,
            clearance: 2,
          });
    const geometry = createRegionGeometry(bounds, obstacles, subdivisionsForSize(size));
    const stats = buildNavMesh(geometry);

    entries.push({
      size,
      obstacleCount: obstacles.length,
      generationMs: stats.generationMs,
      bytes: stats.bytes,
      triangleCount: stats.triangleCount,
      wasmHeapDeltaBytes: stats.wasmHeapDeltaBytes,
      jsHeapDeltaBytes: stats.jsHeapDeltaBytes,
    });

    if (size === REGION_SIZE) {
      region200 = stats.navMesh;
    } else {
      stats.navMesh.destroy();
    }
  }

  if (!region200) {
    throw new Error("未生成 200×200 区域 navmesh");
  }
  return { entries, region200 };
}

export const crowdNavScenario: ScenarioDefinition = {
  name: SCENARIO_NAME,
  description:
    "Crowd V2 寻路：200×200 navmesh 生成耗时/内存、50 agent 点击移动与避让；运行后可继续点击演示",
  interactive: true,

  async setup(context) {
    await initializeNavigation();

    const { scene } = context;
    setGreyboxEnabled(scene, false);
    setCameraSpan(scene, CROWD_CAMERA_SPAN);

    const root = new TransformNode("scenario.crowd-nav", scene);
    const visualObstacles = createBoxObstacleSpecs(REGION_BOUNDS, 40, 0x5eed, {
      margin: 8,
      clearance: 3,
      exclusionZones: [{ minX: -16, maxX: 16, minZ: -6, maxZ: 6 }],
    });

    createGroundVisual(
      scene,
      root,
      REGION_BOUNDS,
      "region.navmesh-200.ground",
      Color3.FromHexString("#93a4b8"),
    );
    createObstacleVisuals(scene, root, visualObstacles, [
      createObstacleMaterial(scene, "material.obstacle-stone", Color3.FromHexString("#5b6472")),
      createObstacleMaterial(scene, "material.obstacle-crate", Color3.FromHexString("#7a6247")),
    ]);

    const { entries, region200 } = createBenchmarkEntries(visualObstacles);
    createNavMeshOverlay(
      region200,
      scene,
      "region.navmesh-200.overlay",
      Color3.FromHexString("#34d399"),
      root,
    );

    const spawnQuery = new NavMeshQuery(region200);
    const leftSpawn = sampleSpawnPoints(
      spawnQuery,
      new Vector3(-CROSSING_CENTER, 0, 0),
      CROSSING_RADIUS,
      AGENTS_PER_GROUP,
    );
    const rightSpawn = sampleSpawnPoints(
      spawnQuery,
      new Vector3(CROSSING_CENTER, 0, 0),
      CROSSING_RADIUS,
      AGENTS_PER_GROUP,
    );
    spawnQuery.destroy();
    const spawnPoints = [...leftSpawn, ...rightSpawn];

    const materials = [
      createAgentMaterial(
        scene,
        "material.crowd-teal",
        Color3.FromHexString("#2dd4bf"),
        Color3.FromHexString("#0f766e"),
      ),
      createAgentMaterial(
        scene,
        "material.crowd-amber",
        Color3.FromHexString("#fbbf24"),
        Color3.FromHexString("#92400e"),
      ),
    ];

    const crowd = createCrowdRuntime(
      scene,
      root,
      region200,
      spawnPoints,
      materials,
      (index) => (index < AGENTS_PER_GROUP ? 0 : 1),
    );

    context.registerRegion(`region.navmesh-${REGION_SIZE}`);
    for (const runtime of crowd.agents) {
      context.registerEntity(runtime.mesh.name);
    }

    const state: CrowdNavState = {
      root,
      navMesh: region200,
      crowd,
      observer: null,
      detachClick: () => undefined,
      benchmark: entries,
      updateCosts: [],
      autoDemo: false,
      autoDemoElapsed: 0,
    };
    states.set(context, state);

    const clickRandom = createSeededRandom(0xc11c);
    state.detachClick = attachClickToMove(scene, (point) => {
      const marker = createClickMarker(scene, root, point, Color3.FromHexString("#7dd3fc"));
      window.setTimeout(() => marker.dispose(false, true), 1500);
      commandAround(
        state.crowd,
        point,
        4,
        clickRandom,
        (runtime) => runtime.group === 0,
      );
    });

    let lastFrameAt = performance.now();
    state.observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const delta = Math.min((now - lastFrameAt) / 1000, 0.1);
      lastFrameAt = now;

      const updateCost = updateCrowdRuntime(state.crowd, delta);
      state.updateCosts.push(updateCost);
      if (state.updateCosts.length > 900) {
        state.updateCosts.shift();
      }

      if (state.autoDemo) {
        state.autoDemoElapsed += delta;
        if (state.autoDemoElapsed >= AUTO_DEMO_INTERVAL_SECONDS) {
          state.autoDemoElapsed = 0;
          const random = createSeededRandom((Math.random() * 0xffffffff) >>> 0);
          commandCrossing(state.crowd, random);
        }
      }
    });

    installDebugApi(state);

    // 让首批材质/矩阵完成一次渲染，再进入测量。
    await waitFrames(2);
  },

  async measure(context) {
    const state = states.get(context);
    if (!state) {
      throw new Error("crowd-nav state 未初始化");
    }

    const random = createSeededRandom(0xc0ffee);
    const commanded = commandCrossing(state.crowd, random);
    state.updateCosts.length = 0;
    await waitFrames(2);

    let minSeparation = Number.POSITIVE_INFINITY;
    let maxOverlapPairs = 0;
    let maxMovingAgents = 0;

    const frameTimes = await collectFrameTimes(SAMPLE_DURATION_MS, () => {
      const separation = minimumPairDistance(state.crowd.agents);
      if (separation > 0) {
        minSeparation = Math.min(minSeparation, separation);
      }
      maxOverlapPairs = Math.max(
        maxOverlapPairs,
        countOverlappingPairs(state.crowd.agents, 0.5),
      );
      maxMovingAgents = Math.max(maxMovingAgents, countMovingAgents(state.crowd.agents));
    });

    const reached = countReachedTargets(state.crowd.agents, 2);
    const frameSummary = summarizeFrameTimes(frameTimes);
    const updateSummary = summarizeFrameTimes(state.updateCosts);
    const metrics: Metric[] = [
      { name: "navmesh.generated", value: 1, unit: "boolean", threshold: 1, comparison: "eq" },
      { name: "navmesh.config.cs", value: NAV_MESH_CONFIG.cs ?? 0, unit: "units" },
      { name: "navmesh.config.ch", value: NAV_MESH_CONFIG.ch ?? 0, unit: "units" },
      {
        name: "navmesh.config.walkableRadius",
        value: NAV_MESH_CONFIG.walkableRadius ?? 0,
        unit: "voxels",
      },
      { name: "crowd.agentCount", value: state.crowd.agents.length, unit: "agents", threshold: AGENT_COUNT, comparison: "eq" },
      { name: "crowd.commandedAgents", value: commanded, unit: "agents", threshold: AGENT_COUNT, comparison: "eq" },
      { name: "crowd.sampledFrames", value: frameSummary.count, unit: "frames" },
      { name: "crowd.sampleDurationMs", value: SAMPLE_DURATION_MS, unit: "ms" },
      { name: "crowd.fps", value: round(frameSummary.fps), unit: "fps" },
      { name: "crowd.frameTimeAvgMs", value: round(frameSummary.avgMs), unit: "ms" },
      { name: "crowd.frameTimeP95Ms", value: round(frameSummary.p95Ms), unit: "ms" },
      { name: "crowd.frameTimeMaxMs", value: round(frameSummary.maxMs), unit: "ms" },
      { name: "crowd.longFrames", value: frameSummary.longFrames, unit: "frames" },
      { name: "crowd.updateAvgMs", value: round(updateSummary.avgMs, 3), unit: "ms" },
      { name: "crowd.updateMaxMs", value: round(updateSummary.maxMs, 3), unit: "ms" },
      { name: "crowd.minSeparation", value: round(minSeparation === Number.POSITIVE_INFINITY ? 0 : minSeparation), unit: "units" },
      { name: "crowd.overlapPairs", value: maxOverlapPairs, unit: "pairs" },
      { name: "crowd.maxMovingAgents", value: maxMovingAgents, unit: "agents" },
      { name: "crowd.agentsReachedTarget", value: reached, unit: "agents" },
      {
        name: "navmesh.jsHeapApiAvailable",
        value: isJsHeapApiAvailable() ? 1 : 0,
        unit: "boolean",
      },
    ];

    for (const entry of state.benchmark) {
      metrics.push(
        { name: `navmesh.genMs.${entry.size}`, value: round(entry.generationMs), unit: "ms" },
        { name: `navmesh.bytes.${entry.size}`, value: entry.bytes, unit: "bytes" },
        { name: `navmesh.triangles.${entry.size}`, value: entry.triangleCount, unit: "triangles" },
        { name: `navmesh.obstacles.${entry.size}`, value: entry.obstacleCount, unit: "obstacles" },
      );
      if (entry.size === REGION_SIZE) {
        metrics.push(
          {
            name: `navmesh.wasmHeapDeltaMB.${entry.size}`,
            value: round(entry.wasmHeapDeltaBytes / MIB, 3),
            unit: "MB",
          },
          {
            name: `navmesh.jsHeapDeltaMB.${entry.size}`,
            value: round(entry.jsHeapDeltaBytes / MIB, 3),
            unit: "MB",
          },
        );
      }
    }

    // measure 结束后保留场景，自动 demo 继续运行，便于点击与截图。
    state.autoDemo = true;
    state.autoDemoElapsed = 0;

    return metrics;
  },

  teardown(context) {
    const state = states.get(context);
    if (!state) {
      return;
    }
    states.delete(context);

    state.detachClick();
    if (state.observer) {
      context.scene.onBeforeRenderObservable.remove(state.observer);
    }
    state.crowd.crowd.destroy();
    state.navMesh.destroy();
    state.root.dispose(false, true);

    setGreyboxEnabled(context.scene, true);
    setCameraSpan(context.scene, DEFAULT_CAMERA_VERTICAL_SPAN);
    delete window.P0CrowdDebug;
  },
};
