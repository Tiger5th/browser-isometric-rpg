/**
 * NPC 巡逻路线（票 33，user stories 14/15/16）。
 *
 * 纯状态机 + 纯位置采样，零引擎依赖：
 * - 路线 = 点位列表（content 的 npc.patrol.waypoints）。走→停留张望→下一点。
 * - 推进由 GameSession 在固定步长里调（`stepPatrol`），产出的是
 *   「走到哪个点、还差多久开始走」这类**进度**，不直接改实体位置；
 * - 位置由 `patrolSample` 按进度算出，表现层每帧插值到该位置。
 *
 * 为什么不把巡逻塞进移动意图（NPC 的移动意图语义上属于玩家/敌人）：
 * NPC 位置是**世界事实**（要进快照、读档要恢复），但巡逻的节奏（走多久、
 * 停多久）是演出。这里让逻辑层持有进度事实、表现层持有插值，两边不重叠。
 *
 * 对话时暂停（setPaused）：NPC 停下面向玩家，结束后继续。
 * 换锚点（re-anchor，user story 16）：任务状态变化时逻辑层把 NPC 的路线
 * 换到新锚点并重置进度，是「世界因你而变」的最小实现。
 */

import type { Vec3 } from "./entity";

/** 内容层的巡逻定义（npc.patrol 的运行时代码形态）。 */
export interface PatrolDefinition {
  /** 至少 2 个点位；首点建议等于 NPC 的初始位置。 */
  waypoints: Vec3[];
  /** 到点后停留张望的毫秒数；缺省 2500。 */
  dwellMs?: number;
}

export const DEFAULT_PATROL_DWELL_MS = 2500;
/** 巡逻走位速度（m/s）：比玩家慢，视觉上是「散步」而不是赶路。 */
export const NPC_PATROL_SPEED = 1.1;
/** 点位间距离小于该值视为已到达，避免零距离导致索引卡死。 */
const ARRIVE_EPSILON = 0.15;

export type PatrolPhase = "walk" | "dwell";

/** 巡逻运行时进度。进 EntitySnapshot 的只有 waypointIndex。 */
export interface PatrolState {
  /** 当前目标点位在 waypoints 里的索引。 */
  waypointIndex: number;
  /** dwell = 已到点正在张望；walk = 正在走向下一点。 */
  phase: PatrolPhase;
  /** dwell 剩余毫秒。 */
  dwellRemainingMs: number;
  /** 对话/过场暂停：进度不再推进。 */
  paused: boolean;
  /** 上一帧实际位置（采样用；换锚点/读档时重置为锚点）。 */
  position: Vec3;
}

export function createPatrolState(
  waypoints: readonly Vec3[],
  home: Vec3,
  dwellMs = DEFAULT_PATROL_DWELL_MS,
): PatrolState {
  const first = waypoints[0] ?? home;
  return {
    // 索引语义：waypointIndex = NPC 当前所在（或正在走向）的点位。
    // 出生即在首点，故初始为张望态，张望结束才走向下一点。
    waypointIndex: 0,
    phase: "dwell",
    dwellRemainingMs: Math.max(0, dwellMs),
    paused: false,
    position: { ...first },
  };
}

/** 从快照恢复进度（读档）：只恢复索引与阶段，位置由采样函数从路径重建。 */
export function restorePatrolState(
  source: Pick<PatrolState, "waypointIndex" | "phase">,
  waypoints: readonly Vec3[],
  dwellMs: number,
  position?: Vec3,
): PatrolState {
  const maxIndex = Math.max(0, waypoints.length - 1);
  const index = Math.min(Math.max(0, Math.floor(source.waypointIndex)), maxIndex);
  return {
    waypointIndex: index,
    phase: source.phase === "dwell" ? "dwell" : "walk",
    dwellRemainingMs: Math.max(0, dwellMs),
    paused: false,
    // position 由快照的实体位置恢复（比重建路径更准：换锚点后的落点也会带上）。
    position: { ...(position ?? waypoints[index] ?? { x: 0, y: 0, z: 0 }) },
  };
}

/**
 * 推进一个模拟步。返回新的状态（不可变更新）。
 *
 * 规则：
 * - walk：按 NPC_PATROL_SPEED 沿上一段路径推进；到点 → dwell；
 * - dwell：dwellRemainingMs 归零 → 下一个点位 → walk；
 * - 单点路线：永远 dwell（不移动），等价于站桩。
 * - paused：原地不动（对话中）。
 */
export function stepPatrol(
  state: PatrolState,
  waypoints: readonly Vec3[],
  stepMs: number,
  dwellMs = DEFAULT_PATROL_DWELL_MS,
): PatrolState {
  if (state.paused || waypoints.length < 2) {
    return state;
  }
  const dwell = Math.max(0, dwellMs);
  const next: PatrolState = {
    ...state,
    position: { ...state.position },
    dwellRemainingMs: state.dwellRemainingMs,
  };

  if (next.phase === "dwell") {
    next.dwellRemainingMs -= stepMs;
    if (next.dwellRemainingMs > 0) {
      return next;
    }
    next.waypointIndex = (next.waypointIndex + 1) % waypoints.length;
    next.phase = "walk";
    next.dwellRemainingMs = dwell;
    return next;
  }

  // walk：一律朝 waypointIndex 直走（当前点→下一点）。
  // 位置可能略偏离目标（读档/换锚点/表现层插值），直走即可自然收敛。
  const target = waypoints[next.waypointIndex];
  if (target === undefined) {
    return next;
  }
  const dx = target.x - next.position.x;
  const dz = target.z - next.position.z;
  const distance = Math.hypot(dx, dz);
  const step = (NPC_PATROL_SPEED * stepMs) / 1000;
  if (distance <= step || distance <= ARRIVE_EPSILON) {
    next.position = { ...target };
    next.phase = "dwell";
    next.dwellRemainingMs = dwell;
    return next;
  }
  next.position = {
    x: next.position.x + (dx / distance) * step,
    y: target.y,
    z: next.position.z + (dz / distance) * step,
  };
  return next;
}

/** 对话时暂停/恢复。返回新状态（保持进度）。 */
export function setPatrolPaused(state: PatrolState, paused: boolean): PatrolState {
  return state.paused === paused ? state : { ...state, paused };
}

/**
 * 表现层用的位置采样：返回当前巡逻位置与朝向（yaw）。
 * 朝向约定与全项目一致（+Z 为 0，朝 +X 为 π/2，见 GameSession.moveEntities）。
 */
export function patrolSample(state: PatrolState, waypoints: readonly Vec3[]): {
  position: Vec3;
  yaw: number;
  moving: boolean;
} {
  // 张望时朝向 = 从上一段走来的方向（回望自己来的路），由下一目标点反推；
  // 站桩（单点/暂停）时朝向保持为 0（面朝 +Z，与快照缺省一致）。
  const previous =
    waypoints[(state.waypointIndex - 1 + waypoints.length) % waypoints.length] ??
    state.position;
  const target =
    state.phase === "walk" ? (waypoints[state.waypointIndex] ?? state.position) : previous;
  const moving = state.phase === "walk" && !state.paused && waypoints.length > 1;
  const yaw =
    moving || (target.x !== state.position.x || target.z !== state.position.z)
      ? Math.atan2(target.x - state.position.x, target.z - state.position.z)
      : 0;
  return { position: { ...state.position }, yaw, moving };
}

/**
 * 换锚点（user story 16）：任务状态变化时把 NPC 的巡逻换到新路线。
 * 新路线第一点即新锚点，进度归零。逻辑层直接落位（世界事实），
 * 走向新锚点的过渡演出由表现层插值承担。
 */
export function reanchorPatrol(
  state: PatrolState,
  waypoints: readonly Vec3[],
  dwellMs = DEFAULT_PATROL_DWELL_MS,
): PatrolState {
  const fresh = createPatrolState(waypoints, waypoints[0] ?? state.position, dwellMs);
  return { ...fresh, paused: state.paused };
}

/** 内容里的换锚点声明（npc.reanchors 的运行时代码形态）。 */
export interface ReanchorDefinition {
  /** 触发换锚点的任务 id。 */
  questId: string;
  /** 换锚点后的巡逻路线（第一点 = 新位置）。 */
  waypoints: Vec3[];
  /** dwellMs 可选覆盖。 */
  dwellMs?: number;
}
