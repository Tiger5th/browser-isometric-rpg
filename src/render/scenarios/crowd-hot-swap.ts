import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { Crowd, NavMeshQuery, type NavMesh } from "recast-navigation";

import {
  createBoxObstacleSpecs,
  createRegionGeometry,
  createSeededRandom,
  type Bounds2D,
} from "../../logic/navmesh-geometry";
import { summarizeFrameTimes } from "../../logic/perf";
import type { Metric } from "../../logic/report";
import { DEFAULT_CAMERA_VERTICAL_SPAN } from "../camera";
import {
  attachClickToMove,
  commandAgents,
  createAgentMaterial,
  createClickMarker,
  createCrowdRuntime,
  setAgentTarget,
  updateCrowdRuntime,
  type AgentRuntime,
  type CrowdRuntime,
} from "../crowd-utils";
import type { ScenarioContext, ScenarioDefinition } from "../harness";
import {
  CROWD_AGENT_PARAMS,
  buildNavMesh,
  collectFrameTimes,
  createNavMeshOverlay,
  initializeNavigation,
  NAV_MESH_CONFIG,
  waitFrames,
  type NavMeshBuildStats,
} from "../navigation";
import {
  createGroundVisual,
  createObstacleMaterial,
  createObstacleVisuals,
  setCameraSpan,
  setGreyboxEnabled,
} from "../navmesh-scene";

const SCENARIO_NAME = "crowd-hot-swap";
const AGENT_COUNT = 50;
const CROWD_CAMERA_SPAN = 90;
const SWITCH_AT_MS = 3000;
const SAMPLE_DURATION_MS = 5500;
const AUTO_DEMO_INTERVAL_SECONDS = 6;
const CROWD_MAX_RADIUS = 0.6;
const MIB = 1024 * 1024;

/** 两个相邻区域在 x=0 处衔接；导航网格各向外延伸 12m 作为加载门重叠带。 */
const REGION_A_NAV: Bounds2D = { minX: -100, maxX: 12, minZ: -50, maxZ: 50 };
const REGION_B_NAV: Bounds2D = { minX: -12, maxX: 100, minZ: -50, maxZ: 50 };
const REGION_A_VISUAL: Bounds2D = { minX: -100, maxX: 0, minZ: -50, maxZ: 50 };
const REGION_B_VISUAL: Bounds2D = { minX: 0, maxX: 100, minZ: -50, maxZ: 50 };
const GATE_EXCLUSION_A: Bounds2D = { minX: -16, maxX: 12, minZ: -50, maxZ: 50 };
const GATE_EXCLUSION_B: Bounds2D = { minX: -12, maxX: 16, minZ: -50, maxZ: 50 };

interface HotSwapState {
  root: TransformNode;
  navMeshA: NavMesh;
  navMeshB: NavMesh;
  crowdA: CrowdRuntime;
  crowdB: Crowd;
  queryB: NavMeshQuery;
  activeCrowd: CrowdRuntime;
  activeRegion: "A" | "B";
  aReleased: boolean;
  statsA: NavMeshBuildStats;
  statsB: NavMeshBuildStats;
  observer: Observer<Scene> | null;
  detachClick: () => void;
  updateCosts: number[];
  autoDemo: boolean;
  autoDemoElapsed: number;
}

const states = new WeakMap<ScenarioContext, HotSwapState>();

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
  for (let index = 0; index < count; index += 1) {
    const result = query.findRandomPointAroundCircle(center, radius, {
      halfExtents: { x: radius + 6, y: 6, z: radius + 6 },
    });
    if (result.success) {
      points.push(new Vector3(result.randomPoint.x, 0, result.randomPoint.z));
      continue;
    }
    const fallback = query.findClosestPoint(center, {
      halfExtents: { x: radius + 6, y: 6, z: radius + 6 },
    });
    if (fallback.success) {
      points.push(new Vector3(fallback.point.x, 0, fallback.point.z));
    }
  }
  return points;
}

function commandToGate(state: HotSwapState, random: () => number): number {
  let commanded = 0;
  for (const runtime of state.crowdA.agents) {
    const target = new Vector3(random() * 4 - 2, 0, random() * 20 - 10);
    if (setAgentTarget(state.crowdA.query, runtime, target)) {
      commanded += 1;
    }
  }
  return commanded;
}

function commandWithinRegionB(state: HotSwapState, random: () => number): number {
  const targets: Vector3[] = state.activeCrowd.agents.map(
    () => new Vector3(18 + random() * 32, 0, random() * 30 - 15),
  );
  return commandAgents(state.activeCrowd.query, state.activeCrowd.agents, targets);
}

function installDebugApi(state: HotSwapState): void {
  const random = createSeededRandom(0x5a9b);
  window.P0CrowdDebug = {
    scenario: SCENARIO_NAME,
    agentCount: AGENT_COUNT,
    getAgents: () =>
      state.activeCrowd.agents.map((runtime) => ({
        x: runtime.mesh.position.x,
        z: runtime.mesh.position.z,
        targetX: runtime.target?.x ?? null,
        targetZ: runtime.target?.z ?? null,
      })),
    commandTo: (x: number, z: number) => {
      const targets: Vector3[] = state.activeCrowd.agents.map(
        () => new Vector3(x + random() * 6 - 3, 0, z + random() * 6 - 3),
      );
      return commandAgents(state.activeCrowd.query, state.activeCrowd.agents, targets);
    },
    getActiveRegion: () => state.activeRegion,
  };
}

/**
 * 把 crowd 从区域 A 迁移到预加载的 B：
 * 位置投影到 B 的 navmesh，复用视觉体，重新下发 B 内的目标。
 */
function migrateCrowdToRegionB(state: HotSwapState): {
  migrated: number;
  maxSnap: number;
} {
  const random = createSeededRandom(0xb0b);
  const migratedAgents: AgentRuntime[] = [];
  let maxSnap = 0;

  for (const runtime of state.crowdA.agents) {
    const position = runtime.agent.position();
    const nearest = state.queryB.findClosestPoint(position, {
      halfExtents: { x: 16, y: 6, z: 16 },
    });
    const destination = nearest.success
      ? { x: nearest.point.x, y: nearest.point.y, z: nearest.point.z }
      : { x: 0, y: 0, z: position.z };
    maxSnap = Math.max(maxSnap, Math.hypot(destination.x - position.x, destination.z - position.z));

    const agent = state.crowdB.addAgent(destination, CROWD_AGENT_PARAMS);
    const migrated: AgentRuntime = {
      agent,
      mesh: runtime.mesh,
      target: null,
      group: 0,
    };
    setAgentTarget(
      state.queryB,
      migrated,
      new Vector3(18 + random() * 30, 0, random() * 24 - 12),
    );
    migratedAgents.push(migrated);
    state.crowdA.crowd.removeAgent(runtime.agent);
  }

  state.activeCrowd = {
    crowd: state.crowdB,
    query: state.queryB,
    agents: migratedAgents,
  };
  state.activeRegion = "B";

  state.crowdA.crowd.destroy();
  state.crowdA.query.destroy();
  state.navMeshA.destroy();
  state.aReleased = true;

  return { migrated: migratedAgents.length, maxSnap };
}

export const crowdHotSwapScenario: ScenarioDefinition = {
  name: SCENARIO_NAME,
  description:
    "跨区域 navmesh 热替换：两个相邻区域、加载门处迁移 50 个 crowd agent，记录切换前后帧时间",
  interactive: true,

  async setup(context) {
    await initializeNavigation();

    const { scene } = context;
    setGreyboxEnabled(scene, false);
    setCameraSpan(scene, CROWD_CAMERA_SPAN);

    const root = new TransformNode("scenario.crowd-hot-swap", scene);
    const obstaclesA = createBoxObstacleSpecs(REGION_A_VISUAL, 16, 0xa001, {
      margin: 8,
      clearance: 3,
      exclusionZones: [GATE_EXCLUSION_A],
    });
    const obstaclesB = createBoxObstacleSpecs(REGION_B_VISUAL, 16, 0xb001, {
      margin: 8,
      clearance: 3,
      exclusionZones: [GATE_EXCLUSION_B],
    });

    createGroundVisual(
      scene,
      root,
      REGION_A_VISUAL,
      "region.gate-a.ground",
      Color3.FromHexString("#7f95ad"),
    );
    createGroundVisual(
      scene,
      root,
      REGION_B_VISUAL,
      "region.gate-b.ground",
      Color3.FromHexString("#839b86"),
    );
    const obstacleMaterials = [
      createObstacleMaterial(scene, "material.gate-obstacle-a", Color3.FromHexString("#596273")),
      createObstacleMaterial(scene, "material.gate-obstacle-b", Color3.FromHexString("#6b6350")),
    ];
    createObstacleVisuals(scene, root, obstaclesA, obstacleMaterials);
    createObstacleVisuals(scene, root, obstaclesB, obstacleMaterials);

    // 加载门视觉标识：x=0 处的发光带。
    const gate = MeshBuilder.CreateBox(
      "region.gate.marker",
      { width: 0.8, height: 0.06, depth: 100 },
      scene,
    );
    gate.position.set(0, 0.05, 0);
    gate.isPickable = false;
    gate.parent = root;
    const gateMaterial = new StandardMaterial("material.gate", scene);
    gateMaterial.diffuseColor = Color3.FromHexString("#f59e0b");
    gateMaterial.emissiveColor = Color3.FromHexString("#b45309");
    gateMaterial.specularColor = Color3.Black();
    gate.material = gateMaterial;

    const statsA = buildNavMesh(
      createRegionGeometry(REGION_A_NAV, obstaclesA, 6),
    );
    const statsB = buildNavMesh(
      createRegionGeometry(REGION_B_NAV, obstaclesB, 6),
    );
    createNavMeshOverlay(
      statsA.navMesh,
      scene,
      "region.gate-a.overlay",
      Color3.FromHexString("#38bdf8"),
      root,
    );
    createNavMeshOverlay(
      statsB.navMesh,
      scene,
      "region.gate-b.overlay",
      Color3.FromHexString("#34d399"),
      root,
    );

    const queryA = new NavMeshQuery(statsA.navMesh);
    const spawnPoints = sampleSpawnPoints(
      queryA,
      new Vector3(-12, 0, 0),
      7,
      AGENT_COUNT,
    );
    queryA.destroy();
    const agentMaterial = createAgentMaterial(
      scene,
      "material.gate-agent",
      Color3.FromHexString("#2dd4bf"),
      Color3.FromHexString("#0f766e"),
    );
    const crowdA = createCrowdRuntime(
      scene,
      root,
      statsA.navMesh,
      spawnPoints,
      [agentMaterial],
      () => 0,
    );
    const crowdB = new Crowd(statsB.navMesh, {
      maxAgents: AGENT_COUNT,
      maxAgentRadius: CROWD_MAX_RADIUS,
    });
    const queryB = new NavMeshQuery(statsB.navMesh);

    context.registerRegion("region.gate-a");
    context.registerRegion("region.gate-b");
    for (const runtime of crowdA.agents) {
      context.registerEntity(runtime.mesh.name);
    }

    const state: HotSwapState = {
      root,
      navMeshA: statsA.navMesh,
      navMeshB: statsB.navMesh,
      crowdA,
      crowdB,
      queryB,
      activeCrowd: crowdA,
      activeRegion: "A",
      aReleased: false,
      statsA,
      statsB,
      observer: null,
      detachClick: () => undefined,
      updateCosts: [],
      autoDemo: false,
      autoDemoElapsed: 0,
    };
    states.set(context, state);

    const clickRandom = createSeededRandom(0xc1c1);
    state.detachClick = attachClickToMove(scene, (point) => {
      const marker = createClickMarker(scene, root, point, Color3.FromHexString("#7dd3fc"));
      window.setTimeout(() => marker.dispose(false, true), 1500);
      const targets: Vector3[] = state.activeCrowd.agents.map(
        () => new Vector3(
          point.x + clickRandom() * 6 - 3,
          0,
          point.z + clickRandom() * 6 - 3,
        ),
      );
      commandAgents(state.activeCrowd.query, state.activeCrowd.agents, targets);
    });

    let lastFrameAt = performance.now();
    state.observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const delta = Math.min((now - lastFrameAt) / 1000, 0.1);
      lastFrameAt = now;

      const updateCost = updateCrowdRuntime(state.activeCrowd, delta);
      state.updateCosts.push(updateCost);
      if (state.updateCosts.length > 900) {
        state.updateCosts.shift();
      }

      if (state.autoDemo) {
        state.autoDemoElapsed += delta;
        if (state.autoDemoElapsed >= AUTO_DEMO_INTERVAL_SECONDS) {
          state.autoDemoElapsed = 0;
          commandWithinRegionB(state, createSeededRandom((Math.random() * 0xffffffff) >>> 0));
        }
      }
    });

    installDebugApi(state);
    await waitFrames(2);
  },

  async measure(context) {
    const state = states.get(context);
    if (!state) {
      throw new Error("crowd-hot-swap state 未初始化");
    }

    const random = createSeededRandom(0x900d);
    const commanded = commandToGate(state, random);
    // 额外预热，避开 WASM 生成后的首次大 GC，并让 agent 更靠近加载门。
    await waitFrames(8);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
    state.updateCosts.length = 0;

    let switched = false;
    let switchFrameIndex = -1;
    let switchWorkMs = 0;
    let migrated = 0;
    let maxSnap = 0;
    const samplingStartedAt = performance.now();

    const frameTimes = await collectFrameTimes(SAMPLE_DURATION_MS, (frameIndex, now) => {
      if (switched || now - samplingStartedAt < SWITCH_AT_MS) {
        return;
      }

      // onFrame 记录完当前帧后调用；下一帧的间隔才会包含这次同步迁移的耗时。
      switchFrameIndex = frameIndex;
      const switchStartedAt = performance.now();
      const result = migrateCrowdToRegionB(state);
      switchWorkMs = performance.now() - switchStartedAt;
      migrated = result.migrated;
      maxSnap = result.maxSnap;
      switched = true;
    });

    const before = switchFrameIndex > 0 ? frameTimes.slice(0, switchFrameIndex) : [];
    const switchFrameMs =
      switchFrameIndex >= 0 && switchFrameIndex < frameTimes.length
        ? frameTimes[switchFrameIndex]
        : 0;
    const after =
      switchFrameIndex >= 0 ? frameTimes.slice(switchFrameIndex + 1) : frameTimes;

    const beforeSummary = summarizeFrameTimes(before);
    const afterSummary = summarizeFrameTimes(after);
    const updateSummary = summarizeFrameTimes(state.updateCosts);
    const spikeRatio =
      switchFrameMs > 0 ? switchFrameMs / Math.max(beforeSummary.p95Ms, 1) : 0;
    const longFrameRatioBefore =
      beforeSummary.count > 0 ? beforeSummary.longFrames / beforeSummary.count : 0;
    const longFrameRatioAfter =
      afterSummary.count > 0 ? afterSummary.longFrames / afterSummary.count : 0;

    state.autoDemo = true;
    state.autoDemoElapsed = 0;

    const metrics: Metric[] = [
      { name: "hotSwap.success", value: switched ? 1 : 0, unit: "boolean", threshold: 1, comparison: "eq" },
      { name: "hotSwap.preloadedNextRegion", value: 1, unit: "boolean", threshold: 1, comparison: "eq" },
      { name: "hotSwap.agentCount", value: state.activeCrowd.agents.length, unit: "agents", threshold: AGENT_COUNT, comparison: "eq" },
      { name: "hotSwap.migratedAgents", value: migrated, unit: "agents", threshold: AGENT_COUNT, comparison: "eq" },
      { name: "hotSwap.activeRegionB", value: state.activeRegion === "B" ? 1 : 0, unit: "boolean", threshold: 1, comparison: "eq" },
      { name: "hotSwap.commandedAgents", value: commanded, unit: "agents" },
      { name: "hotSwap.sampledFrames", value: frameTimes.length, unit: "frames" },
      { name: "hotSwap.switchAtMs", value: SWITCH_AT_MS, unit: "ms" },
      { name: "hotSwap.switchWorkMs", value: round(switchWorkMs, 3), unit: "ms" },
      { name: "hotSwap.switchFrameMs", value: round(switchFrameMs), unit: "ms" },
      { name: "hotSwap.spikeRatio", value: round(spikeRatio), unit: "ratio" },
      { name: "hotSwap.maxPositionSnap", value: round(maxSnap), unit: "units" },
      { name: "hotSwap.frameTimeBeforeAvgMs", value: round(beforeSummary.avgMs), unit: "ms" },
      { name: "hotSwap.frameTimeBeforeP95Ms", value: round(beforeSummary.p95Ms), unit: "ms" },
      { name: "hotSwap.frameTimeBeforeMaxMs", value: round(beforeSummary.maxMs), unit: "ms" },
      { name: "hotSwap.longFramesBefore", value: beforeSummary.longFrames, unit: "frames" },
      { name: "hotSwap.longFrameRatioBefore", value: round(longFrameRatioBefore, 3), unit: "ratio" },
      { name: "hotSwap.frameTimeAfterAvgMs", value: round(afterSummary.avgMs), unit: "ms" },
      { name: "hotSwap.frameTimeAfterP95Ms", value: round(afterSummary.p95Ms), unit: "ms" },
      { name: "hotSwap.frameTimeAfterMaxMs", value: round(afterSummary.maxMs), unit: "ms" },
      { name: "hotSwap.longFramesAfter", value: afterSummary.longFrames, unit: "frames" },
      { name: "hotSwap.longFrameRatioAfter", value: round(longFrameRatioAfter, 3), unit: "ratio" },
      { name: "hotSwap.fpsBefore", value: round(beforeSummary.fps), unit: "fps" },
      { name: "hotSwap.fpsAfter", value: round(afterSummary.fps), unit: "fps" },
      { name: "hotSwap.updateAvgMs", value: round(updateSummary.avgMs, 3), unit: "ms" },
      { name: "hotSwap.updateMaxMs", value: round(updateSummary.maxMs, 3), unit: "ms" },
      { name: "hotSwap.navmeshGenMs.a", value: round(state.statsA.generationMs), unit: "ms" },
      { name: "hotSwap.navmeshGenMs.b", value: round(state.statsB.generationMs), unit: "ms" },
      { name: "hotSwap.navmeshBytes.a", value: state.statsA.bytes, unit: "bytes" },
      { name: "hotSwap.navmeshBytes.b", value: state.statsB.bytes, unit: "bytes" },
      { name: "hotSwap.navmeshTriangles.a", value: state.statsA.triangleCount, unit: "triangles" },
      { name: "hotSwap.navmeshTriangles.b", value: state.statsB.triangleCount, unit: "triangles" },
      { name: "hotSwap.navmeshWasmHeapDeltaMB.a", value: round(state.statsA.wasmHeapDeltaBytes / MIB, 3), unit: "MB" },
      { name: "hotSwap.navmeshWasmHeapDeltaMB.b", value: round(state.statsB.wasmHeapDeltaBytes / MIB, 3), unit: "MB" },
      { name: "hotSwap.navmeshCs", value: NAV_MESH_CONFIG.cs ?? 0, unit: "units" },
    ];

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

    if (!state.aReleased) {
      state.crowdA.crowd.destroy();
      state.crowdA.query.destroy();
      state.navMeshA.destroy();
    }
    state.crowdB.destroy();
    state.queryB.destroy();
    state.navMeshB.destroy();
    state.root.dispose(false, true);

    setGreyboxEnabled(context.scene, true);
    setCameraSpan(context.scene, DEFAULT_CAMERA_VERTICAL_SPAN);
    delete window.P0CrowdDebug;
  },
};
