/**
 * 票 32 标题画面的入口路由与开屏演出时序（纯函数，不碰 DOM）。
 *
 * DOM 层（`src/render/ui/title-screen.ts`）只把这些结论画成按钮与动画，
 * 因此这里能在 vitest 的 node 环境里锁住全部有档/无档分支。
 */

import { describe, expect, it } from "vitest";

import {
  TITLE_INTRO_MS,
  resolveTitleMenu,
  shouldShowTitleScreen,
  titleIntroState,
  type TitleSlotOccupancy,
} from "./title-menu";
import type { SaveSlotId } from "./save-slots";

function occupancy(...occupied: SaveSlotId[]): TitleSlotOccupancy[] {
  return (["auto", "slot-1", "slot-2", "slot-3"] as const).map((slotId) => ({
    slotId,
    occupied: occupied.includes(slotId),
  }));
}

describe("标题入口：无档首启", () => {
  it("四个槽全空时只显示「新游戏」", () => {
    const state = resolveTitleMenu(occupancy());

    expect(state.entries).toEqual(["new-game"]);
    expect(state.continueFlow).toBe("hidden");
    expect(state.occupiedSlotIds).toEqual([]);
  });

  it("无档首启不需要二次确认（没有可覆盖的进度）", () => {
    expect(resolveTitleMenu(occupancy()).requireNewGameConfirm).toBe(false);
  });
});

describe("标题入口：只有自动档", () => {
  it("「继续游戏」直接读自动档，不出选槽列表", () => {
    const state = resolveTitleMenu(occupancy("auto"));

    expect(state.entries).toEqual(["continue", "new-game"]);
    expect(state.continueFlow).toBe("direct");
    expect(state.defaultSlotId).toBe("auto");
  });

  it("已有自动档时「新游戏」需要二次确认", () => {
    expect(resolveTitleMenu(occupancy("auto")).requireNewGameConfirm).toBe(true);
  });
});

describe("标题入口：多个档 / 只有手动档", () => {
  it("自动档 + 手动档并存时先出选槽列表", () => {
    const state = resolveTitleMenu(occupancy("auto", "slot-2"));

    expect(state.continueFlow).toBe("pick-slot");
    expect(state.occupiedSlotIds).toEqual(["auto", "slot-2"]);
  });

  it("只有手动档时也出选槽列表", () => {
    const state = resolveTitleMenu(occupancy("slot-3"));

    expect(state.continueFlow).toBe("pick-slot");
    expect(state.defaultSlotId).toBe("slot-3");
  });

  it("有档时默认落在自动档上（最新进度点）", () => {
    expect(resolveTitleMenu(occupancy("slot-1", "auto")).defaultSlotId).toBe("auto");
  });

  it("槽位顺序按固定槽位序（auto 在前），不受传入顺序影响", () => {
    const shuffled: TitleSlotOccupancy[] = [
      { slotId: "slot-3", occupied: true },
      { slotId: "auto", occupied: true },
    ];

    expect(resolveTitleMenu(shuffled).occupiedSlotIds).toEqual(["auto", "slot-3"]);
  });

  it("手动档有档时「新游戏」同样需要二次确认", () => {
    expect(resolveTitleMenu(occupancy("slot-1")).requireNewGameConfirm).toBe(true);
  });
});

describe("开屏演出时序", () => {
  it("入场演出时长在 2–3 秒区间内", () => {
    expect(TITLE_INTRO_MS).toBeGreaterThanOrEqual(2000);
    expect(TITLE_INTRO_MS).toBeLessThanOrEqual(3000);
  });

  it("演出期间入场按钮不可用，时间到后开放", () => {
    expect(titleIntroState(0)).toBe("playing");
    expect(titleIntroState(TITLE_INTRO_MS - 1)).toBe("playing");
    expect(titleIntroState(TITLE_INTRO_MS)).toBe("ready");
  });

  it("点击跳过立刻把演出推到 ready", () => {
    expect(titleIntroState(0, { skipped: true })).toBe("ready");
  });

  it("负的经过时间（时钟回拨）按 0 处理，不误判为可操作", () => {
    expect(titleIntroState(-500)).toBe("playing");
  });
});

describe("是否显示标题画面", () => {
  it("缺省（无参数）显示标题画面", () => {
    expect(shouldShowTitleScreen({})).toBe(true);
  });

  it("?title=0 跳过标题（harness / L4 脚本直入游戏）", () => {
    expect(shouldShowTitleScreen({ title: "0" })).toBe(false);
  });

  it("?harness=1 跳过标题（调试面板模式）", () => {
    expect(shouldShowTitleScreen({ harness: "1" })).toBe(false);
  });

  it("?scenario=p1-world 跳过标题（按场景直入）", () => {
    expect(shouldShowTitleScreen({ scenario: "p1-world" })).toBe(false);
  });

  it("?title=1 仍显示标题画面", () => {
    expect(shouldShowTitleScreen({ title: "1" })).toBe(true);
  });
});
