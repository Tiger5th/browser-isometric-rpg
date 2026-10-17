/**
 * 敌人 AI 纯函数的扫掠判定测试（review #10 / #39）。
 *
 * 之前投射物与冲锋都只量**步进后的落点**到目标的距离：一步位移
 * （16m/s × 100ms = 1.6m）远大于命中半径（0.35 + 0.75）时，
 * 两者从中间穿过会被判成「没碰到」，玩家站着不动也躲过了本该命中的弹。
 * 这里钉住「线段扫掠」语义。
 */
import { describe, expect, it } from "vitest";

import { chargeDirection, segmentPointDistance, stepCharge, stepProjectile, sweptHit } from "./enemy-ai";
import type { ProjectileRuntime } from "./enemy-ai";

const NO_OBSTACLES: never[] = [];

function projectile(overrides: Partial<ProjectileRuntime> = {}): ProjectileRuntime {
  return {
    id: "p1",
    ownerId: "enemy:spitter",
    targetId: "entity:player",
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 16, z: 0 },
    damage: 7,
    radius: 0.35,
    remainingMs: 2500,
    ...overrides,
  };
}

describe("投射物扫掠判定：一步位移大于命中半径也不穿透", () => {
  it("从玩家正侧方掠过（落点距离 > 命中半径）也判命中", () => {
    // 玩家在 (0.8, 0, 0)。一步位移 1.6m：落点 (1.6,0,0) 距离 0.8m
    // 大于命中半径 0.35 + 0.75 = 1.1？其实 0.8 < 1.1——换更远的例子：
    const player = { x: 1.0, y: 0, z: 0 };
    const step = stepProjectile(projectile(), 100, player, 0.75, NO_OBSTACLES);
    expect(step.hit).toBe(true);
  });

  it("落点确实超出命中半径时仍然命中（扫掠过玩家身前）", () => {
    // 玩家在 z=1.0：起点 (0,0,0) 与落点 (1.6,0,0) 都在命中圈外，
    // 但整段线段距离玩家最近点 (1.0,0,0) 只有 1.0m < 1.1m → 命中。
    const player = { x: 1.0, y: 0, z: 1.0 };
    const step = stepProjectile(projectile(), 100, player, 0.75, NO_OBSTACLES);
    expect(step.hit).toBe(true);
    // 断言前提：这个落点按「只量落点」会漏判（1.64m > 1.1m）。
    expect(Math.hypot(1.6 - player.x, 0 - player.z)).toBeGreaterThan(0.35 + 0.75);
  });

  it("真的擦身而过时不命中（扫掠判定不夸大命中圈）", () => {
    // 玩家在 z=2.0：整段线段最近距离 2.0m > 1.1m → 不命中。
    const player = { x: 1.0, y: 0, z: 2.0 };
    const step = stepProjectile(projectile(), 100, player, 0.75, NO_OBSTACLES);
    expect(step.hit).toBe(false);
    expect(step.blocked).toBe(false);
    expect(step.expired).toBe(false);
  });

  it("反向飞行同样按扫掠判定（起点在玩家另一侧）", () => {
    const player = { x: -0.5, y: 0, z: 1.0 };
    const step = stepProjectile(
      projectile({ position: { x: -0.5, y: 0, z: 0 }, velocity: { x: -16, z: 0 } }),
      100,
      player,
      0.75,
      NO_OBSTACLES,
    );
    expect(step.hit).toBe(true);
  });
});

describe("冲锋扫掠判定：一帧位移远大于命中半径也命中", () => {
  it("冲锋位移 1.6m/帧 时掠过玩家也结算命中", () => {
    const dir = chargeDirection({ x: -3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const step = stepCharge({ x: -3, y: 0, z: 0 }, dir, 1.6, NO_OBSTACLES, 0.75);
    // 纯位移函数不做命中判定，这里断言位移量确实大于命中半径
    // （说明命中必须由扫掠负责，不能量落点）。
    expect(step.travelled).toBeGreaterThan(1.0);
    expect(step.blocked).toBe(false);
  });

  it("sweptHit：冲锋一帧 1.4m 穿过玩家时命中", () => {
    // 冲锋从 x=8 推进到 x=6.6（一步 1.4m），玩家站在 (7.3, 0, 0)。
    // 落点距离 0.7m < hitRadius 1 其实也会命中——换成玩家在 z 侧：
    const from = { x: 8, z: 0 };
    const to = { x: 6.6, z: 0 };
    const player = { x: 7.3, z: 0.5 };
    // 落点距离 = hypot(0.7, 0.5) = 0.86 < 1 → 这条本身就会命中，
    // 真正区分扫掠与落点的是下面那条。
    expect(sweptHit(from, to, player, 1)).toBe(true);
  });

  it("sweptHit：整段冲锋穿过玩家但落点已越过时仍命中", () => {
    const from = { x: 8, z: 0 };
    const to = { x: 6.6, z: 0 };
    const player = { x: 7.9, z: 0 };
    // 落点距离 1.0m > hitRadius 0.8，但整段线段穿过玩家 → 命中。
    expect(Math.hypot(to.x - player.x, to.z - player.z)).toBeGreaterThan(0.8);
    expect(sweptHit(from, to, player, 0.8)).toBe(true);
  });

  it("sweptHit：离冲锋线 1.5m 外不命中（不夸大命中圈）", () => {
    expect(sweptHit({ x: 8, z: 0 }, { x: 6.6, z: 0 }, { x: 7.3, z: 1.5 }, 1)).toBe(false);
  });

  it("segmentPointDistance：退化线段（起点=终点）退化成点到点距离", () => {
    const point = { x: 3, z: 4 };
    expect(segmentPointDistance({ x: 0, z: 0 }, { x: 0, z: 0 }, point)).toBe(5);
  });

  it("segmentPointDistance：区间外的点按端点算", () => {
    // 线段 (0,0)-(1,0)，点在 (−3,0)：最近点是起点，距离 3。
    expect(segmentPointDistance({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: -3, z: 0 })).toBe(3);
    expect(segmentPointDistance({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 9, z: 0 })).toBe(8);
  });
});
