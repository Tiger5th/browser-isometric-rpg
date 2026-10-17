/**
 * 标题画面 → 游戏的入场意图（票 32）。
 *
 * 标题流程只决定「从哪个槽进来 / 是不是新游戏」，真正的场景重建由 harness
 * 跑 p1-world 完成。这个小模块是两者之间唯一的交接点：标题流程写入，
 * p1-world setup 读一次并清空，因此「无标题直达」（harness、L4 脚本）与
 * 「经标题进入」走同一段场景构建代码。
 */

import type { SaveSlotId } from "../logic/save-slots";

export type TitleEntryIntent =
  | { kind: "continue"; slotId: SaveSlotId }
  | { kind: "new-game" }
  /** 无标题直达：沿用旧行为（有默认档就读，没有就全新开始）。 */
  | { kind: "direct" };

let pending: TitleEntryIntent = { kind: "direct" };

/** 记录标题画面的选择，供下一次 p1-world setup 消费。 */
export function setTitleEntryIntent(intent: TitleEntryIntent): void {
  pending = intent;
}

export function peekTitleEntryIntent(): TitleEntryIntent {
  return pending;
}

/** 取出并复位成「无标题直达」，保证只生效一次。 */
export function takeTitleEntryIntent(): TitleEntryIntent {
  const intent = pending;
  pending = { kind: "direct" };
  return intent;
}
