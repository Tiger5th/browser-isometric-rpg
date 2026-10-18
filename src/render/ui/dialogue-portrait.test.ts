import { describe, expect, it } from "vitest";

import {
  DIM_BACKGROUND_OFF,
  DIM_BACKGROUND_ON,
  dimBackgroundFor,
} from "./dialogue-portrait";

/**
 * 票 37 验收修复（诊断发现项）：对话压暗层。
 *
 * 复现：原实现把 `dimInitialBackground` 记成元素建出来时的背景，但那个值
 * 就是压暗本身（0.55），closeDialogue 再原样赋回去——语义上写着「还原」，
 * 实际值没变。于是：① 关掉对话后场景一直暗着；② 二次对话的压暗表现不对。
 *
 * 这里锁住 on/off 是两个**显式不同**的值（纯逻辑，可在 node 下直测；
 * 本仓库的 vitest 是 node 环境，没有 jsdom）。
 */

describe("对话压暗层背景", () => {
  it("打开时压暗、关闭时透明，两个值必须不同", () => {
    expect(dimBackgroundFor(true)).toBe(DIM_BACKGROUND_ON);
    expect(dimBackgroundFor(false)).toBe(DIM_BACKGROUND_OFF);
    // 回归点：若这两个值相等，closeDialogue 就退化成恒等赋值。
    expect(dimBackgroundFor(false)).not.toBe(dimBackgroundFor(true));
  });

  it("关闭值是完全透明（alpha = 0）", () => {
    expect(DIM_BACKGROUND_OFF).toMatch(/,\s*0\s*\)$/);
  });

  it("开启值有可见压暗强度（alpha = 0.55，与 DIALOGUE_DIM_STRENGTH 一致）", () => {
    expect(DIM_BACKGROUND_ON).toMatch(/0\.55\s*\)$/);
  });

  it("多次开关不漂移（纯函数，无内部状态）", () => {
    for (let round = 0; round < 3; round += 1) {
      expect(dimBackgroundFor(true)).toBe(DIM_BACKGROUND_ON);
      expect(dimBackgroundFor(false)).toBe(DIM_BACKGROUND_OFF);
    }
  });
});
