import { describe, expect, it } from "vitest";

import {
  CAMERA_FOLLOW_LERP,
  advanceCameraFollow,
  createCameraFollow,
  snapCameraFollow,
} from "./camera";

/**
 * 票 37 验收修复：相机 target 硬编码 Vector3.Zero()，玩家跑到区域边缘就出画。
 *
 * 修法：每帧把 target 阻尼插值到玩家位置（正交下 = 平移视野），
 * 保留 alpha/beta/radius（票 37 的缩放/旋转/复位）与震屏（票 27）。
 */

describe("相机跟随（正交 target 平移）", () => {
  it("每帧向玩家位置阻尼逼近，不瞬移", () => {
    const follow = createCameraFollow(0, 0);

    advanceCameraFollow(follow, { x: 10, z: 0 });

    expect(follow.x).toBeCloseTo(10 * CAMERA_FOLLOW_LERP, 6);
    expect(follow.x).toBeGreaterThan(0);
    expect(follow.x).toBeLessThan(10);
  });

  it("连续推进 60 帧能追上玩家（0.3s 内到 95%，玩家跑不出画面）", () => {
    const follow = createCameraFollow(0, 0);
    const target = { x: 18, z: -6 };

    for (let frame = 0; frame < 60; frame += 1) {
      advanceCameraFollow(follow, target);
    }

    // 1 - 0.92^60 ≈ 0.992
    expect(follow.x / target.x).toBeGreaterThan(0.95);
    expect(follow.z / target.z).toBeGreaterThan(0.95);
  });

  it("收敛后不再抖动（无脏标记）", () => {
    const follow = createCameraFollow(0, 0);
    snapCameraFollow(follow, { x: 5, z: 5 });

    expect(advanceCameraFollow(follow, { x: 5, z: 5 })).toBe(false);
    expect(follow.x).toBe(5);
  });

  it("玩家在移动时持续跟随（每帧返回 true）", () => {
    const follow = createCameraFollow(0, 0);
    let changes = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      if (advanceCameraFollow(follow, { x: frame, z: 0 })) {
        changes += 1;
      }
    }
    expect(changes).toBeGreaterThan(25);
  });

  it("目标为 null 或非法值时保持不动（读档/死亡帧不跳镜）", () => {
    const follow = createCameraFollow(1, 2);

    expect(advanceCameraFollow(follow, null)).toBe(false);
    expect(advanceCameraFollow(follow, { x: Number.NaN, z: 0 })).toBe(false);
    expect(advanceCameraFollow(follow, { x: 0, z: Number.POSITIVE_INFINITY })).toBe(false);
    expect(follow).toEqual({ x: 1, z: 2 });
  });

  it("snapCameraFollow 让传送/切区后相机立即就位（不留长镜头）", () => {
    const follow = createCameraFollow(0, 0);

    snapCameraFollow(follow, { x: 0, z: 19 });

    expect(follow).toEqual({ x: 0, z: 19 });
    expect(advanceCameraFollow(follow, { x: 0, z: 19 })).toBe(false);
  });

  it("lerp=1 即瞬移（复位/对齐时可显式传 1）", () => {
    const follow = createCameraFollow(0, 0);

    advanceCameraFollow(follow, { x: 7, z: -3 }, 1);

    expect(follow).toEqual({ x: 7, z: -3 });
  });
});
