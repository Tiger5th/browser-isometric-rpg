import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
// scene.createPickingRay 依赖 Ray 的副作用注册。
import "@babylonjs/core/Culling/ray";
import {
  Crowd,
  NavMeshQuery,
  type CrowdAgent,
  type NavMesh,
} from "recast-navigation";

import { CROWD_AGENT_PARAMS } from "./navigation";

/** 胶囊视觉体的总高度，与 crowd agent 参数保持一致。 */
export const AGENT_HEIGHT = 1.6;
export const AGENT_VISUAL_RADIUS = 0.35;
/** crowd 的 maxAgentRadius，留出余量。 */
const CROWD_MAX_RADIUS = 0.6;
const FIXED_STEP_SECONDS = 1 / 60;
const MAX_SUB_STEPS = 4;
const MAX_FRAME_DELTA_SECONDS = 0.1;

export interface CrowdDebugAgent {
  x: number;
  z: number;
  targetX: number | null;
  targetZ: number | null;
}

/** ego-browser 驱动演示/验证用的最小调试接口。 */
export interface P0CrowdDebugApi {
  scenario: string;
  agentCount: number;
  getAgents(): CrowdDebugAgent[];
  /** 返回成功接受移动指令的 agent 数。 */
  commandTo(x: number, z: number): number;
  getActiveRegion?(): string;
}

declare global {
  interface Window {
    P0CrowdDebug?: P0CrowdDebugApi;
  }
}

export interface AgentRuntime {
  agent: CrowdAgent;
  mesh: Mesh;
  /** 最近一次下发的最终目标（不等于 path corridor 的下一拐点）。 */
  target: Vector3 | null;
  group: number;
}

export interface CrowdRuntime {
  crowd: Crowd;
  query: NavMeshQuery;
  agents: AgentRuntime[];
}

export function createAgentMaterial(
  scene: Scene,
  name: string,
  diffuse: Color3,
  emissive: Color3,
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse;
  material.emissiveColor = emissive;
  material.specularColor = Color3.Black();
  return material;
}

export function createAgentMesh(
  scene: Scene,
  root: TransformNode,
  material: StandardMaterial,
  index: number,
): Mesh {
  const mesh = MeshBuilder.CreateCapsule(
    `crowd.agent.${index.toString().padStart(3, "0")}`,
    { radius: AGENT_VISUAL_RADIUS, height: AGENT_HEIGHT, tessellation: 8 },
    scene,
  );
  mesh.material = material;
  mesh.isPickable = false;
  mesh.parent = root;
  return mesh;
}

/**
 * 在 navmesh 上创建 crowd 与对应的胶囊视觉体。
 * spawnPoints 必须已经投影到 navmesh 上。
 */
export function createCrowdRuntime(
  scene: Scene,
  root: TransformNode,
  navMesh: NavMesh,
  spawnPoints: readonly Vector3[],
  materials: readonly StandardMaterial[],
  groupOf: (index: number) => number,
): CrowdRuntime {
  const crowd = new Crowd(navMesh, {
    maxAgents: Math.max(1, spawnPoints.length),
    maxAgentRadius: CROWD_MAX_RADIUS,
  });
  const query = new NavMeshQuery(navMesh);
  const agents: AgentRuntime[] = [];

  spawnPoints.forEach((point, index) => {
    const group = groupOf(index);
    const agent = crowd.addAgent(point, CROWD_AGENT_PARAMS);
    const mesh = createAgentMesh(
      scene,
      root,
      materials[group] ?? materials[0],
      index,
    );
    mesh.position.set(point.x, AGENT_HEIGHT / 2, point.z);
    agents.push({ agent, mesh, target: null, group });
  });

  return { crowd, query, agents };
}

/** 以固定步长 + 插值推进 crowd，并把插值位置同步到视觉体。返回本次更新耗时（ms）。 */
export function updateCrowdRuntime(
  crowdRuntime: CrowdRuntime,
  deltaSeconds: number,
): number {
  const startedAt = performance.now();
  const clampedDelta = Math.min(Math.max(deltaSeconds, 0), MAX_FRAME_DELTA_SECONDS);
  crowdRuntime.crowd.update(FIXED_STEP_SECONDS, clampedDelta, MAX_SUB_STEPS);

  for (const runtime of crowdRuntime.agents) {
    const position = runtime.agent.interpolatedPosition;
    runtime.mesh.position.set(position.x, AGENT_HEIGHT / 2, position.z);

    const velocity = runtime.agent.velocity();
    if (velocity.x * velocity.x + velocity.z * velocity.z > 0.01) {
      runtime.mesh.rotation.y = Math.atan2(velocity.x, velocity.z);
    }
  }

  return performance.now() - startedAt;
}

export function setAgentTarget(
  query: NavMeshQuery,
  runtime: AgentRuntime,
  target: Vector3,
): boolean {
  const nearest = query.findClosestPoint(target, {
    halfExtents: { x: 4, y: 4, z: 4 },
  });
  if (!nearest.success) {
    return false;
  }

  const point = new Vector3(nearest.point.x, nearest.point.y, nearest.point.z);
  runtime.target = point;
  return runtime.agent.requestMoveTarget(nearest.point);
}

export function commandAgents(
  query: NavMeshQuery,
  agents: readonly AgentRuntime[],
  targets: readonly Vector3[],
): number {
  let count = 0;
  agents.forEach((agent, index) => {
    const target = targets[index % targets.length];
    if (setAgentTarget(query, agent, target)) {
      count += 1;
    }
  });
  return count;
}

export function minimumPairDistance(agents: readonly AgentRuntime[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let left = 0; left < agents.length; left += 1) {
    const a = agents[left].mesh.position;
    for (let right = left + 1; right < agents.length; right += 1) {
      const b = agents[right].mesh.position;
      const distance = Math.hypot(a.x - b.x, a.z - b.z);
      if (distance < minimum) {
        minimum = distance;
      }
    }
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

export function countOverlappingPairs(
  agents: readonly AgentRuntime[],
  threshold: number,
): number {
  let count = 0;
  for (let left = 0; left < agents.length; left += 1) {
    const a = agents[left].mesh.position;
    for (let right = left + 1; right < agents.length; right += 1) {
      const b = agents[right].mesh.position;
      if (Math.hypot(a.x - b.x, a.z - b.z) < threshold) {
        count += 1;
      }
    }
  }
  return count;
}

export function countReachedTargets(
  agents: readonly AgentRuntime[],
  tolerance: number,
): number {
  return agents.filter((runtime) => {
    if (!runtime.target) {
      return false;
    }
    const position = runtime.mesh.position;
    return Math.hypot(position.x - runtime.target.x, position.z - runtime.target.z) <= tolerance;
  }).length;
}

export function countMovingAgents(agents: readonly AgentRuntime[]): number {
  return agents.filter((runtime) => {
    const velocity = runtime.agent.velocity();
    return velocity.x * velocity.x + velocity.z * velocity.z > 0.04;
  }).length;
}

/**
 * 把画布单击投影到 y=0 平面，再沿 navmesh 约束。
 * 返回取消监听函数；场景 teardown 时必须调用。
 */
export function attachClickToMove(
  scene: Scene,
  onPick: (point: Vector3) => void,
): () => void {
  const observer = scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) {
      return;
    }

    const camera = scene.activeCamera;
    if (!camera) {
      return;
    }

    const ray = scene.createPickingRay(
      scene.pointerX,
      scene.pointerY,
      Matrix.Identity(),
      camera,
    );
    if (Math.abs(ray.direction.y) < 1e-6) {
      return;
    }

    const distance = -ray.origin.y / ray.direction.y;
    if (distance <= 0) {
      return;
    }

    onPick(ray.origin.add(ray.direction.scale(distance)));
  });

  return () => {
    scene.onPointerObservable.remove(observer);
  };
}

/** 点击位置的地面标记，便于确认“点击移动”确实发生。 */
export function createClickMarker(
  scene: Scene,
  root: TransformNode,
  point: Vector3,
  color: Color3,
): Mesh {
  const marker = MeshBuilder.CreateTorus(
    "crowd.click-marker",
    { diameter: 1.6, thickness: 0.08, tessellation: 24 },
    scene,
  );
  marker.position.set(point.x, 0.1, point.z);
  marker.isPickable = false;
  marker.parent = root;

  const material = new StandardMaterial("crowd.click-marker.material", scene);
  material.diffuseColor = color;
  material.emissiveColor = color.scale(0.8);
  material.specularColor = Color3.Black();
  material.disableLighting = true;
  marker.material = material;

  return marker;
}
