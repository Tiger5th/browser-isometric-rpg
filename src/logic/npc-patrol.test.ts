import { describe, expect, it } from "vitest";

import type { Vec3 } from "./entity";
import {
  DEFAULT_PATROL_DWELL_MS,
  NPC_PATROL_SPEED,
  createPatrolState,
  patrolSample,
  reanchorPatrol,
  restorePatrolState,
  setPatrolPaused,
  stepPatrol,
  type PatrolState,
} from "./npc-patrol";

/** 直线巡逻：两点相距 2m，来回往返。 */
const WAYPOINTS = [
  { x: 0, y: 0, z: 0 },
  { x: 2, y: 0, z: 0 },
];
const DWELL = 1000;

function run(
  state: PatrolState,
  steps: number,
  stepMs = 100,
  waypoints: readonly Vec3[] = WAYPOINTS,
): PatrolState {
  let next = state;
  for (let i = 0; i < steps; i += 1) {
    next = stepPatrol(next, waypoints, stepMs, DWELL);
  }
  return next;
}

/** 从出生点出发、张望时长 = 测试用的 DWELL。 */
function patrolAtHome(waypoints: readonly Vec3[] = WAYPOINTS): PatrolState {
  return createPatrolState(waypoints, waypoints[0], DWELL);
}

describe("NPC 巡逻（票 33）", () => {
  it("初始状态站在首点、先张望再出发（不是站桩但也不夺路而出）", () => {
    const state = patrolAtHome();
    expect(state).toMatchObject({ waypointIndex: 0, phase: "dwell" });
    expect(state.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("张望结束后走到下一个点位并停在那里", () => {
    // 张望 1s + 走 2m/1.1m/s≈1.82s，跑 3.5s 必然到点。
    const state = run(patrolAtHome(), 35);
    expect(state.waypointIndex).toBe(1);
    expect(state.phase).toBe("dwell");
    expect(state.position).toEqual({ x: 2, y: 0, z: 0 });
  });

  it("继续张望到时后回到首点，索引循环", () => {
    const atFar = run(patrolAtHome(), 35);
    const back = run(atFar, 30);
    expect(back.waypointIndex).toBe(0);
    expect(back.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("巡逻速度是散步速度而不是玩家速度", () => {
    expect(NPC_PATROL_SPEED).toBeGreaterThan(0);
    expect(NPC_PATROL_SPEED).toBeLessThan(5.5);
    const walking = run(patrolAtHome(), 10);
    expect(walking.phase).toBe("walk");
    const oneSecond = stepPatrol(walking, WAYPOINTS, 1000, DWELL);
    expect(oneSecond.position.x).toBeGreaterThan(walking.position.x);
    expect(oneSecond.position.x).toBeLessThan(walking.position.x + 5.5);
  });

  it("对话暂停时进度冻结，恢复后从原处继续", () => {
    const walking = run(patrolAtHome(), 12);
    expect(walking.phase).toBe("walk");
    const paused = setPatrolPaused(walking, true);
    const frozen = run(paused, 50);
    expect(frozen.position).toEqual(paused.position);
    expect(frozen.waypointIndex).toBe(paused.waypointIndex);

    const resumed = run(setPatrolPaused(frozen, false), 10);
    expect(resumed.position.x).toBeGreaterThan(paused.position.x);
  });

  it("采样给出朝向：行走时朝下一点的方向（+X 为 π/2）", () => {
    const walking = run(patrolAtHome(), 12);
    const sample = patrolSample(walking, WAYPOINTS);
    expect(sample.yaw).toBeCloseTo(Math.PI / 2, 5);
    expect(sample.moving).toBe(true);
  });

  it("单点路线等价于站桩：永不移动", () => {
    const single = [{ x: 5, y: 0, z: 5 }];
    const state = run(createPatrolState(single, { x: 5, y: 0, z: 5 }, DWELL), 100, 100, single);
    expect(state.position).toEqual({ x: 5, y: 0, z: 5 });
  });

  it("恢复时可带上快照里的实时位置（读档后 NPC 站在它当时站的地方）", () => {
    const restored = restorePatrolState(
      { waypointIndex: 0, phase: "walk" },
      WAYPOINTS,
      DWELL,
      { x: 0.37, y: 0, z: 0 },
    );
    expect(restored.position).toEqual({ x: 0.37, y: 0, z: 0 });
  });

  it("缺省停留时长是 2.5 秒", () => {
    expect(DEFAULT_PATROL_DWELL_MS).toBe(2500);
  });
});

describe("巡逻进度往返（票 33）", () => {
  it("从快照恢复索引与阶段，读档后不回到起点重来", () => {
    const restored = restorePatrolState({ waypointIndex: 1, phase: "dwell" }, WAYPOINTS, DWELL);
    expect(restored).toMatchObject({ waypointIndex: 1, phase: "dwell", paused: false });
    expect(restored.position).toEqual({ x: 2, y: 0, z: 0 });
  });

  it("恢复时索引越界被夹到有效范围", () => {
    const restored = restorePatrolState({ waypointIndex: 99, phase: "walk" }, WAYPOINTS, DWELL);
    expect(restored.waypointIndex).toBe(1);
  });
});

describe("换锚点（票 33）", () => {
  it("换锚点后 NPC 站到新路线首点，进度归零", () => {
    const before = run(patrolAtHome(), 35);
    expect(before.waypointIndex).toBe(1);

    const moved = reanchorPatrol(before, [
      { x: -6, y: 0, z: 6 },
      { x: -8, y: 0, z: 6 },
    ]);
    expect(moved.position).toEqual({ x: -6, y: 0, z: 6 });
    expect(moved.waypointIndex).toBe(0);
    expect(moved.phase).toBe("dwell");
  });

  it("换锚点保留对话暂停状态", () => {
    const paused = setPatrolPaused(patrolAtHome(), true);
    const moved = reanchorPatrol(paused, [{ x: -6, y: 0, z: 6 }, { x: -8, y: 0, z: 6 }]);
    expect(moved.paused).toBe(true);
  });
});
