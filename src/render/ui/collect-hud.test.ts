/**
 * 票 37：探索 HUD 的显示口径。接缝 = collectHudView()（纯函数，DOM 之外的换算层）。
 */

import { describe, expect, it } from "vitest";

import type { CollectProgress } from "../../logic/exploration";
import { collectHudView } from "./collect-hud";

const SET_ID = "collect_set:glow_moss";
const NAMES = new Map([[SET_ID, "萤光草"]]);

function progress(collected: number, total = 8, granted = false): CollectProgress {
  return {
    setId: SET_ID,
    collected,
    total,
    ratio: total === 0 ? 0 : collected / total,
    complete: total > 0 && collected >= total,
    rewardGranted: granted,
  };
}

describe("collectHudView", () => {
  it("零进度显示 0/8，比值 0", () => {
    const [view] = collectHudView({ displayNames: NAMES, progress: [progress(0)] });
    expect(view.text).toBe("萤光草 0 / 8");
    expect(view.ratio).toBe(0);
    expect(view.complete).toBe(false);
    expect(view.rewardText).toBe("");
  });

  it("进行中：计数与比值正确", () => {
    const [view] = collectHudView({ displayNames: NAMES, progress: [progress(3)] });
    expect(view.text).toBe("萤光草 3 / 8");
    expect(view.ratio).toBeCloseTo(0.375, 10);
    expect(view.complete).toBe(false);
  });

  it("全收集但奖励未发：提示达成", () => {
    const [view] = collectHudView({ displayNames: NAMES, progress: [progress(8, 8, false)] });
    expect(view.complete).toBe(true);
    expect(view.ratio).toBe(1);
    expect(view.rewardText).toBe("全收集达成");
  });

  it("奖励已入包：提示已入包（读档后不会闪回「达成」）", () => {
    const [view] = collectHudView({ displayNames: NAMES, progress: [progress(8, 8, true)] });
    expect(view.rewardText).toBe("全收集奖励已入包");
  });

  it("缺显示名时回落到集 id", () => {
    const [view] = collectHudView({ displayNames: new Map(), progress: [progress(1)] });
    expect(view.text).toBe(`${SET_ID} 1 / 8`);
  });

  it("越界计数被夹住（不会显示 9/8 之类）", () => {
    const [view] = collectHudView({ displayNames: NAMES, progress: [progress(12)] });
    expect(view.text).toBe("萤光草 8 / 8");
    expect(view.ratio).toBe(1);
  });

  it("空集（total 0）不炸，比值 0", () => {
    const [view] = collectHudView({ displayNames: NAMES, progress: [progress(0, 0)] });
    expect(view.ratio).toBe(0);
    expect(view.complete).toBe(false);
  });

  it("多个收集集按输入顺序各出一条", () => {
    const views = collectHudView({
      displayNames: new Map([
        [SET_ID, "萤光草"],
        ["collect_set:shell", "贝壳"],
      ]),
      progress: [progress(3), { ...progress(1, 4), setId: "collect_set:shell" }],
    });
    expect(views.map((view) => view.text)).toEqual(["萤光草 3 / 8", "贝壳 1 / 4"]);
  });
});