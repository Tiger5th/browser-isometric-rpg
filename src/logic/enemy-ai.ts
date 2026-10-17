/**
 * 敌人 AI 档案与纯逻辑求解（票 36）。
 *
 * 与 game-session.ts 的分工：
 * - 本模块只放**数据形状 + 纯函数**（档案解释、直线冲锋位移、kiting 位移、
 *   投射物步进），零引擎依赖、可在 vitest 中直测；
 * - GameSession 负责把档案接进状态机（idle/patrol/chase/attack + 本票新增的
 *   windup-charge/charge/recovery/kite），并在一等事件里广播事实。
 *
 * 硬碰撞：这里只声明逻辑层需要的**最小障碍形状**（id/shape/x/z/radius/halfDepth），
 * 与表现层票 28 的 `PropCollider`（world-physics.buildPropColliders）结构兼容，
 * 因此场景把同一份 collider 清单交给 GameSession.setWorldObstacles() 即可，
 * navmesh 也仍由 colliderObstacleSpecs 从同一数据源生成——碰撞与寻路不会漂移。
 */

import type { Vec3 } from "./entity";

/** AI 档案种类：chaser = 既有近战追击；其余两种是票 36 的新行为。 */
export type AiProfileKind = "chaser" | "windup-charge" | "ranged-kite";

/** 冲锋型：前摇（可走位躲）→ 直线高速冲锋（路径命中一次）→ recovery 硬直。 */
export interface WindupChargeAiProfile {
  kind: "windup-charge";
  /** 前摇时长（毫秒）；默认 600，明显长于敌人普攻的 300。 */
  windupMs: number;
  /** 冲锋速度（米/秒），远高于 moveSpeed。 */
  chargeSpeed: number;
  /** 单次冲锋的最长直线距离（米）。 */
  chargeDistance: number;
  /** 冲锋结束后的硬直（毫秒）：走位躲开后可以白打。 */
  recoveryMs: number;
  /** 进入这个距离就起手前摇（0 = 一进仇恨就冲锋）。 */
  triggerRange: number;
  /** 冲锋路径上的命中半径（米）；一次冲锋最多结算一次伤害。 */
  hitRadius: number;
}

/** 吐弹型：保持攻击距离，玩家接近则后撤，远程发射投射物。 */
export interface RangedKiteAiProfile {
  kind: "ranged-kite";
  /** 期望交战距离（米）：比这个远就追近。 */
  preferredRange: number;
  /** 玩家进入这个距离就后撤（米）。 */
  retreatRange: number;
  /** 开火间隔（毫秒）。 */
  fireIntervalMs: number;
  /** 投射物速度（米/秒）。 */
  projectileSpeed: number;
  /** 投射物伤害（固定值，不走攻防公式——吐弹的威胁来自距离与走位）。 */
  projectileDamage: number;
  /** 投射物碰撞半径（米）。 */
  projectileRadius: number;
  /** 投射物存活时限（毫秒），超时消失。 */
  projectileLifetimeMs: number;
}

export type EnemyAiProfile = WindupChargeAiProfile | RangedKiteAiProfile;

export const DEFAULT_WINDUP_CHARGE_PROFILE: WindupChargeAiProfile = {
  kind: "windup-charge",
  windupMs: 600,
  chargeSpeed: 14,
  chargeDistance: 8,
  recoveryMs: 900,
  triggerRange: 6,
  hitRadius: 1,
};

export const DEFAULT_RANGED_KITE_PROFILE: RangedKiteAiProfile = {
  kind: "ranged-kite",
  preferredRange: 8,
  retreatRange: 5,
  fireIntervalMs: 2000,
  projectileSpeed: 16,
  projectileDamage: 7,
  projectileRadius: 0.35,
  projectileLifetimeMs: 2500,
};

/** 逻辑层需要的最小障碍形状；与表现层 PropCollider 结构兼容。 */
export interface WorldObstacle {
  id: string;
  shape: "cylinder" | "box";
  x: number;
  z: number;
  /** 圆柱半径或盒子半宽（米）。 */
  radius: number;
  /** 盒子半深（米）；圆柱为 0。 */
  halfDepth: number;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 解释内容里的 aiProfile：缺省/未知 kind → null（走既有 chaser 状态机）。
 * 字段缺失一律回落到档案默认值，让内容只需写想改的键。
 */
export function resolveEnemyAiProfile(
  raw: unknown,
): EnemyAiProfile | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const data = raw as Record<string, unknown>;
  if (data.kind === "windup-charge") {
    return {
      kind: "windup-charge",
      windupMs: Math.round(positive(data.windupMs, DEFAULT_WINDUP_CHARGE_PROFILE.windupMs)),
      chargeSpeed: positive(data.chargeSpeed, DEFAULT_WINDUP_CHARGE_PROFILE.chargeSpeed),
      chargeDistance: positive(data.chargeDistance, DEFAULT_WINDUP_CHARGE_PROFILE.chargeDistance),
      recoveryMs: Math.round(nonNegative(data.recoveryMs, DEFAULT_WINDUP_CHARGE_PROFILE.recoveryMs)),
      triggerRange: nonNegative(data.triggerRange, DEFAULT_WINDUP_CHARGE_PROFILE.triggerRange),
      hitRadius: positive(data.hitRadius, DEFAULT_WINDUP_CHARGE_PROFILE.hitRadius),
    };
  }
  if (data.kind === "ranged-kite") {
    return {
      kind: "ranged-kite",
      preferredRange: positive(data.preferredRange, DEFAULT_RANGED_KITE_PROFILE.preferredRange),
      retreatRange: nonNegative(data.retreatRange, DEFAULT_RANGED_KITE_PROFILE.retreatRange),
      fireIntervalMs: Math.round(positive(data.fireIntervalMs, DEFAULT_RANGED_KITE_PROFILE.fireIntervalMs)),
      projectileSpeed: positive(data.projectileSpeed, DEFAULT_RANGED_KITE_PROFILE.projectileSpeed),
      projectileDamage: positive(data.projectileDamage, DEFAULT_RANGED_KITE_PROFILE.projectileDamage),
      projectileRadius: positive(data.projectileRadius, DEFAULT_RANGED_KITE_PROFILE.projectileRadius),
      projectileLifetimeMs: Math.round(
        positive(data.projectileLifetimeMs, DEFAULT_RANGED_KITE_PROFILE.projectileLifetimeMs),
      ),
    };
  }
  return null;
}

/** 位置是否落在障碍（含冲锋体半径）内。 */
export function isInsideObstacle(
  obstacle: WorldObstacle,
  x: number,
  z: number,
  bodyRadius: number,
): boolean {
  const dx = Math.abs(x - obstacle.x) - obstacle.radius - bodyRadius;
  if (obstacle.shape === "cylinder") {
    const distance = Math.hypot(x - obstacle.x, z - obstacle.z);
    return distance < obstacle.radius + bodyRadius;
  }
  const dz = Math.abs(z - obstacle.z) - obstacle.halfDepth - bodyRadius;
  return dx < 0 && dz < 0;
}

/** 直线冲锋的落点：被硬碰撞挡住时停在障碍前（不穿模）。 */
export interface ChargeStep {
  position: Vec3;
  /** 是否被硬碰撞挡停。 */
  blocked: boolean;
  /** 命中的障碍 id。 */
  blockedBy: string | null;
  /** 本步实际前进的距离（米）。 */
  travelled: number;
}

/**
 * 冲锋位移：从 from 沿单位方向 dir 前进 distance 米。
 * 逐轴求解（X 后 Z）让冲锋沿障碍边缘滑过；两轴都被挡则判为 blocked。
 */
export function stepCharge(
  from: Vec3,
  dir: { x: number; z: number },
  distance: number,
  obstacles: readonly WorldObstacle[],
  bodyRadius: number,
): ChargeStep {
  let x = from.x;
  let z = from.z;
  let blockedBy: string | null = null;

  const advanceAxis = (targetX: number, targetZ: number): { x: number; z: number } => {
    const hit = obstacles.find((obstacle) =>
      isInsideObstacle(obstacle, targetX, targetZ, bodyRadius),
    );
    if (hit === undefined) {
      return { x: targetX, z: targetZ };
    }
    blockedBy ??= hit.id;
    return { x, z }; // 被挡：本轴不前进（冲锋不贴边滑行，宁可停下）。
  };

  const remainingX = dir.x * distance;
  if (Math.abs(remainingX) > 1e-9) {
    const next = advanceAxis(x + remainingX, z);
    x = next.x;
    z = next.z;
  }
  const remainingZ = dir.z * distance;
  if (Math.abs(remainingZ) > 1e-9) {
    const next = advanceAxis(x, z + remainingZ);
    x = next.x;
    z = next.z;
  }

  const travelled = Math.hypot(x - from.x, z - from.z);
  return { position: { x, y: from.y, z }, blocked: blockedBy !== null, blockedBy, travelled };
}

/** 冲锋方向：由冲锋者指向目标，单位化。 */
export function chargeDirection(from: Vec3, to: Vec3): { x: number; z: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length <= 1e-9) {
    return { x: 0, z: 0 };
  }
  return { x: dx / length, z: dz / length };
}

/**
 * kiting 位移决策：距离决定「追近 / 站桩开火 / 后撤」。
 * 返回 null 表示原地不动（保持距离）。
 */
export function kiteMoveTarget(
  self: Vec3,
  player: Vec3,
  preferredRange: number,
  retreatRange: number,
  moveDistance: number,
): Vec3 | null {
  const dx = player.x - self.x;
  const dz = player.z - self.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= 1e-9) {
    return null;
  }
  const ux = dx / distance;
  const uz = dz / distance;
  if (distance > preferredRange) {
    // 太远：追近到 preferredRange（一步最多 moveDistance，避免抖动）。
    const step = Math.min(moveDistance, distance - preferredRange);
    return { x: self.x + ux * step, y: self.y, z: self.z + uz * step };
  }
  if (distance < retreatRange) {
    // 太近：后撤一步。
    return { x: self.x - ux * moveDistance, y: self.y, z: self.z - uz * moveDistance };
  }
  return null; // 处于射程带内：站桩开火。
}

/** 逻辑层投射物：位置/速度/剩余寿命都在这里，表现层只渲染。 */
export interface ProjectileRuntime {
  id: string;
  ownerId: string;
  targetId: string;
  position: Vec3;
  velocity: { x: number; z: number };
  damage: number;
  radius: number;
  remainingMs: number;
}

export interface ProjectileSnapshot {
  id: string;
  ownerId: string;
  position: Vec3;
  radius: number;
}

/** 投射物一步推进的结果。 */
export interface ProjectileStep {
  projectile: ProjectileRuntime;
  /** 是否命中目标（命中后调用方结算伤害并移除投射物）。 */
  hit: boolean;
  /** 是否撞上硬碰撞消失。 */
  blocked: boolean;
  /** 是否超时消失。 */
  expired: boolean;
}

/**
 * 线段到点的最短距离（XZ 平面，二维）。
 * 用于「扫掠」判定：一次步进位移可能远大于命中半径，只量落点会让
 * 高速投射物/冲锋直接从玩家身上穿过去。
 */
export function segmentPointDistance(
  from: { x: number; z: number },
  to: { x: number; z: number },
  point: { x: number; z: number },
): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) {
    return Math.hypot(point.x - from.x, point.z - from.z);
  }
  const t = Math.min(
    1,
    Math.max(0, ((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared),
  );
  return Math.hypot(point.x - (from.x + dx * t), point.z - (from.z + dz * t));
}

/**
 * 一次步进是否扫掠命中目标。
 * 半径 = 目标半径 + 投射物/冲锋自身半径。
 */
export function sweptHit(
  from: { x: number; z: number },
  to: { x: number; z: number },
  target: { x: number; z: number },
  radius: number,
): boolean {
  return segmentPointDistance(from, to, target) <= radius;
}

export function stepProjectile(
  projectile: ProjectileRuntime,
  stepMs: number,
  playerPosition: Vec3,
  playerRadius: number,
  obstacles: readonly WorldObstacle[],
): ProjectileStep {
  const distance = (projectile.velocity.x * stepMs) / 1000;
  const nextX = projectile.position.x + distance;
  const nextZ = projectile.position.z + (projectile.velocity.z * stepMs) / 1000;

  const remainingMs = Math.max(0, projectile.remainingMs - stepMs);
  const moved: ProjectileRuntime = {
    ...projectile,
    position: { x: nextX, y: projectile.position.y, z: nextZ },
    remainingMs,
  };

  // 扫掠判定：整段位移 vs 玩家，而不是只看落点。16m/s × 100ms = 1.6m
  // 的一步远大于 1.1m 的命中半径，只量落点会让弹从玩家身上穿过去。
  if (sweptHit(projectile.position, moved.position, playerPosition, projectile.radius + playerRadius)) {
    return { projectile: moved, hit: true, blocked: false, expired: false };
  }
  const blocked = obstacles.some((obstacle) =>
    isInsideObstacle(obstacle, nextX, nextZ, projectile.radius),
  );
  if (blocked) {
    return { projectile: moved, hit: false, blocked: true, expired: false };
  }
  if (remainingMs === 0) {
    return { projectile: moved, hit: false, blocked: false, expired: true };
  }
  return { projectile: moved, hit: false, blocked: false, expired: false };
}

/** 死亡轻惩罚：损失 ceil(rate × 金币总量) 枚；结果为 0 表示免罚。 */
export function coinPenaltyFor(totalCoins: number, rate: number): number {
  if (totalCoins <= 0 || rate <= 0) {
    return 0;
  }
  return Math.ceil(totalCoins * rate);
}
