/**
 * 票 32 标题画面的入口路由判定（纯函数）。
 *
 * 标题画面的所有分支都在这里定：哪些入口可见、「继续游戏」是直接读自动档
 * 还是先出选槽列表、「新游戏」要不要二次确认。DOM 层只负责把这些结论
 * 画出来，因此 vitest（无 jsdom）能锁住全部有档/无档组合。
 *
 * 判据只用槽位占用情况（有没有档），不读存档内容——存档内容由
 * `save-slot-view.ts` 负责展示。
 */

import { SAVE_SLOT_IDS, type SaveSlotId } from "./save-slots";

/** 标题画面可以出现的入口。 */
export type TitleEntry = "continue" | "new-game";

/**
 * 「继续游戏」的落点：
 * - `hidden`：一个档都没有，入口不显示；
 * - `direct`：只有一个档且就是自动档，直接读它（无档首启的反面）；
 * - `pick-slot`：多个档（或只有手动档），先出选槽列表再读。
 */
export type ContinueFlow = "hidden" | "direct" | "pick-slot";

export interface TitleSlotOccupancy {
  slotId: SaveSlotId;
  /** 该槽是否有档（meta 为空即空槽）。 */
  occupied: boolean;
}

export interface TitleMenuState {
  /** 入口列表，按渲染顺序。 */
  entries: TitleEntry[];
  continueFlow: ContinueFlow;
  /** 有档的槽位，按固定槽位顺序（auto 在前）。 */
  occupiedSlotIds: SaveSlotId[];
  /** 有档时「新游戏」需要二次确认（不二次确认就会覆盖自动档进度）。 */
  requireNewGameConfirm: boolean;
  /** 「继续游戏」在 direct 流程下直接读的槽；pick-slot 下是列表默认高亮项。 */
  defaultSlotId: SaveSlotId | null;
}

/** 入场演出时长（规格：2–3 秒）。 */
export const TITLE_INTRO_MS = 2400;

/** 演出阶段：演出中入口不可点，ready 后才可操作。 */
export type TitleIntroState = "playing" | "ready";

/** 判断入场演出是否结束。点击跳过（`skipped`）立刻视为结束。 */
export function titleIntroState(
  elapsedMs: number,
  options: { skipped?: boolean } = {},
): TitleIntroState {
  if (options.skipped === true) {
    return "ready";
  }
  // 时钟回拨时 elapsedMs 可能是负的；一律按「刚开始」处理。
  return elapsedMs >= TITLE_INTRO_MS ? "ready" : "playing";
}

/** 标题画面的门控：读 URL 参数即可判定，不必碰 DOM。 */
export interface TitleScreenParams {
  /** `?title=`；`0` 显式跳过。 */
  title?: string | null;
  /** `?harness=1`：调试面板模式，标题画面会挡住 harness，直接跳过。 */
  harness?: string | null;
  /** `?scenario=`：显式点名场景时同样跳过（harness/L4 脚本按场景进）。 */
  scenario?: string | null;
}

/**
 * 是否显示标题画面。缺省显示——规格要求「打开游戏先见标题画面」。
 * 两种例外都是调试/自动化通道：`?title=0` 显式跳过，`?harness=1` 或
 * `?scenario=<name>` 说明调用方要直接进某个场景。
 */
export function shouldShowTitleScreen(params: TitleScreenParams): boolean {
  if (params.title === "0") {
    return false;
  }
  if (params.harness === "1") {
    return false;
  }
  const scenario = params.scenario;
  return scenario === undefined || scenario === null || scenario === "";
}

export function resolveTitleMenu(
  slots: readonly TitleSlotOccupancy[],
): TitleMenuState {
  // 槽位展示顺序按固定槽位序（auto 在前），与传入顺序无关。
  const occupied = new Set(slots.filter((slot) => slot.occupied).map((slot) => slot.slotId));
  const occupiedSlotIds = SAVE_SLOT_IDS.filter((slotId) => occupied.has(slotId));
  if (occupiedSlotIds.length === 0) {
    return {
      entries: ["new-game"],
      continueFlow: "hidden",
      occupiedSlotIds,
      requireNewGameConfirm: false,
      defaultSlotId: null,
    };
  }

  const continueFlow: ContinueFlow =
    occupiedSlotIds.length === 1 && occupiedSlotIds[0] === "auto" ? "direct" : "pick-slot";

  return {
    entries: ["continue", "new-game"],
    continueFlow,
    occupiedSlotIds,
    requireNewGameConfirm: true,
    // 有自动档时默认落在自动档上——它是最新的进度点。
    defaultSlotId: occupiedSlotIds.includes("auto") ? "auto" : occupiedSlotIds[0],
  };
}
