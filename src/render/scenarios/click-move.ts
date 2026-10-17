import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { NavMeshQuery, type NavMesh } from "recast-navigation";

import { createEntity } from "../../logic/entity";
import {
  GameSession,
  type EntitySnapshot,
  type GameSessionSnapshot,
} from "../../logic/game-session";
import {
  createBoxObstacleSpecs,
  createRegionGeometry,
  type Bounds2D,
} from "../../logic/navmesh-geometry";
import type { Metric } from "../../logic/report";
import { DEFAULT_CAMERA_VERTICAL_SPAN } from "../camera";
import {
  CHARACTER_ANIMATION_FRAMES,
  createCharacterAnimations,
  createCharacterMaterial,
  createCharacterPrototype,
  createCharacterSkeleton,
} from "../character-proto";
import {
  AGENT_HEIGHT,
  attachClickToMove,
  createClickMarker,
  createCrowdRuntime,
  setAgentTarget,
  updateCrowdRuntime,
  type CrowdRuntime,
} from "../crowd-utils";
import type { ScenarioContext, ScenarioDefinition } from "../harness";
import { buildNavMesh, initializeNavigation } from "../navigation";
import {
  createGroundVisual,
  createObstacleMaterial,
  createObstacleVisuals,
  setCameraSpan,
  setGreyboxEnabled,
} from "../navmesh-scene";

const SCENARIO_NAME = "click-move";
const PLAYER_ID = "entity:player";
const REGION_SIZE = 40;
const REGION_BOUNDS: Bounds2D = {
  minX: -REGION_SIZE / 2,
  maxX: REGION_SIZE / 2,
  minZ: -REGION_SIZE / 2,
  maxZ: REGION_SIZE / 2,
};
const CAMERA_VERTICAL_SPAN = 30;
/** measure 阶段脚本化验证的移动目标与超时。 */
const MEASURE_TARGET = { x: 10, y: 0, z: 6 } as const;
const ARRIVAL_TIMEOUT_MS = 6000;

interface ClickMoveState {
  root: TransformNode;
  navMesh: NavMesh;
  crowd: CrowdRuntime;
  skeleton: Skeleton;
  session: GameSession;
  observer: Observer<Scene> | null;
  detachClick: () => void;
  /** 最近一次下发给 Crowd 的目标，避免每帧重复 requestMoveTarget。 */
  commandedTarget: { x: number; z: number } | null;
}

/** ego-browser 手动/自动验证入口：只经 snapshot 读取、只经意图写入。 */
export interface P0GameSessionDebugApi {
  scenario: string;
  getSnapshot(): GameSessionSnapshot;
  moveTo(x: number, z: number): void;
  getPlayer(): EntitySnapshot | null;
}

declare global {
  interface Window {
    P0GameSessionDebug?: P0GameSessionDebugApi;
  }
}

const states = new WeakMap<ScenarioContext, ClickMoveState>();

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function playerSnapshot(session: GameSession): EntitySnapshot | null {
  return session.snapshot().entities.find((entity) => entity.id === PLAYER_ID) ?? null;
}

function sameTarget(
  left: { x: number; z: number } | null,
  right: { x: number; z: number } | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return Math.abs(left.x - right.x) < 1e-6 && Math.abs(left.z - right.z) < 1e-6;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function waitForArrival(
  session: GameSession,
  timeoutMs: number,
): Promise<number> {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= timeoutMs) {
    const player = playerSnapshot(session);
    if (!player || player.movement === null) {
      return performance.now() - startedAt;
    }
    await nextFrame();
  }
  return performance.now() - startedAt;
}

function installDebugApi(state: ClickMoveState): void {
  window.P0GameSessionDebug = {
    scenario: SCENARIO_NAME,
    getSnapshot: () => state.session.snapshot(),
    moveTo: (x, z) => state.session.moveTo(PLAYER_ID, { x, y: 0, z }),
    getPlayer: () => playerSnapshot(state.session),
  };
}

/**
 * GameSession + 点击移动：逻辑层持有玩家实体与时钟，
 * 点击地面只提交 moveTo 意图；渲染层从快照读取目标并驱动 Crowd V2/角色视觉。
 */
export const clickMoveScenario: ScenarioDefinition = {
  name: SCENARIO_NAME,
  description:
    "GameSession 点击移动：P0 角色经 Crowd V2 在灰盒区域走到点击点；渲染层只读快照 + 提交意图",
  interactive: true,

  async setup(context) {
    await initializeNavigation();

    const { scene } = context;
    setGreyboxEnabled(scene, false);
    setCameraSpan(scene, CAMERA_VERTICAL_SPAN);

    const root = new TransformNode("scenario.click-move", scene);
    const obstacles = createBoxObstacleSpecs(REGION_BOUNDS, 8, 0x19c1, {
      margin: 4,
      clearance: 2,
      exclusionZones: [{ minX: -6, maxX: 6, minZ: -6, maxZ: 6 }],
    });

    createGroundVisual(
      scene,
      root,
      REGION_BOUNDS,
      "region.click-move.ground",
      Color3.FromHexString("#8fa3b8"),
    );
    createObstacleVisuals(scene, root, obstacles, [
      createObstacleMaterial(scene, "material.click-move.stone", Color3.FromHexString("#5b6472")),
      createObstacleMaterial(scene, "material.click-move.crate", Color3.FromHexString("#7a6247")),
    ]);

    const geometry = createRegionGeometry(REGION_BOUNDS, obstacles, 6);
    const { navMesh } = buildNavMesh(geometry);

    const spawnQuery = new NavMeshQuery(navMesh);
    const nearest = spawnQuery.findClosestPoint(new Vector3(0, 0, 0), {
      halfExtents: { x: 4, y: 4, z: 4 },
    });
    spawnQuery.destroy();
    if (!nearest.success) {
      navMesh.destroy();
      root.dispose(false, true);
      throw new Error("点击移动场景无法在 navmesh 上找到出生点");
    }
    const spawn = new Vector3(nearest.point.x, 0, nearest.point.z);

    // 逻辑层：实体进入 GameSession，位置由逻辑时钟推进。
    const session = new GameSession();
    session.addEntity(
      createEntity({
        id: PLAYER_ID,
        type: "player",
        templateId: "hero",
        displayName: "主角",
        position: { x: spawn.x, y: 0, z: spawn.z },
      }),
    );

    // 表现层：Crowd V2 胶囊负责寻路，P0 角色网格挂在胶囊下（等比下移使脚落地）。
    const crowd = createCrowdRuntime(
      scene,
      root,
      navMesh,
      [spawn],
      [createCharacterMaterial(scene, "material.click-move.capsule", Color3.White())],
      () => 0,
    );
    const runtime = crowd.agents[0];
    runtime.mesh.isVisible = false;

    const character = createCharacterPrototype(scene, "character.player.");
    character.name = "character.player.mesh";
    character.material = createCharacterMaterial(
      scene,
      "material.click-move.player",
      Color3.FromHexString("#38bdf8"),
    );
    character.isPickable = false;
    character.parent = runtime.mesh;
    character.position.y = -AGENT_HEIGHT / 2;

    const skeleton = createCharacterSkeleton(
      scene,
      "character.player.",
      0,
      createCharacterAnimations(),
    );
    character.skeleton = skeleton;
    scene.beginAnimation(skeleton, 0, CHARACTER_ANIMATION_FRAMES, true, 1);

    const state: ClickMoveState = {
      root,
      navMesh,
      crowd,
      skeleton,
      session,
      observer: null,
      detachClick: () => undefined,
      commandedTarget: null,
    };
    states.set(context, state);

    state.detachClick = attachClickToMove(scene, (point) => {
      session.moveTo(PLAYER_ID, { x: point.x, y: 0, z: point.z });
      const marker = createClickMarker(
        scene,
        root,
        point,
        Color3.FromHexString("#7dd3fc"),
      );
      window.setTimeout(() => marker.dispose(false, true), 1500);
    });

    let lastFrameAt = performance.now();
    state.observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const deltaSeconds = Math.min(Math.max((now - lastFrameAt) / 1000, 0), 0.1);
      lastFrameAt = now;

      // 只推进逻辑时钟；位置变化由 GameSession 内部完成。
      session.advance(deltaSeconds * 1000);

      const player = playerSnapshot(session);
      const target = player?.movement?.target ?? null;
      if (target && !sameTarget(state.commandedTarget, target)) {
        setAgentTarget(crowd.query, runtime, new Vector3(target.x, 0, target.z));
        state.commandedTarget = { x: target.x, z: target.z };
      } else if (!target) {
        state.commandedTarget = null;
      }

      updateCrowdRuntime(crowd, deltaSeconds);
    });

    context.registerRegion("region.click-move");
    context.registerEntity(PLAYER_ID);
    installDebugApi(state);

    await nextFrame();
  },

  async measure(context) {
    const state = states.get(context);
    if (!state) {
      throw new Error("click-move state 未初始化");
    }

    const before = playerSnapshot(state.session);
    const startPosition = before ? { ...before.position } : { x: 0, y: 0, z: 0 };

    state.session.moveTo(PLAYER_ID, MEASURE_TARGET);
    const arrivalMs = await waitForArrival(state.session, ARRIVAL_TIMEOUT_MS);

    const player = playerSnapshot(state.session);
    const finalPosition = player?.position ?? startPosition;
    const movedDistance = Math.hypot(
      finalPosition.x - startPosition.x,
      finalPosition.z - startPosition.z,
    );
    const distanceToTarget = Math.hypot(
      finalPosition.x - MEASURE_TARGET.x,
      finalPosition.z - MEASURE_TARGET.z,
    );
    const reachedTarget = player?.movement === null && distanceToTarget <= 0.01;
    const snapshot = state.session.snapshot();

    const metrics: Metric[] = [
      { name: "gameSession.entityCount", value: snapshot.entities.length, unit: "entities", threshold: 1, comparison: "eq" },
      { name: "gameSession.snapshotVersion", value: snapshot.version, unit: "version" },
      { name: "gameSession.elapsedMs", value: round(snapshot.elapsedMs, 0), unit: "ms" },
      { name: "gameSession.playerMovedDistance", value: round(movedDistance), unit: "units", threshold: 0.01, comparison: "gte" },
      { name: "gameSession.playerDistanceToTarget", value: round(distanceToTarget), unit: "units", threshold: 0.01, comparison: "lte" },
      { name: "gameSession.reachedTarget", value: reachedTarget ? 1 : 0, unit: "boolean", threshold: 1, comparison: "eq" },
      { name: "gameSession.arrivalMs", value: round(arrivalMs, 0), unit: "ms" },
      { name: "crowd.agentCount", value: state.crowd.agents.length, unit: "agents", threshold: 1, comparison: "eq" },
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
    context.scene.stopAnimation(state.skeleton);
    state.skeleton.dispose();
    state.crowd.crowd.destroy();
    state.navMesh.destroy();
    state.root.dispose(false, true);

    setGreyboxEnabled(context.scene, true);
    setCameraSpan(context.scene, DEFAULT_CAMERA_VERTICAL_SPAN);
    delete window.P0GameSessionDebug;
  },
};
