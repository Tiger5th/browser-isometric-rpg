/**
 * 入场意图的一次性交接（票 32）。
 *
 * 标题流程只决定「读哪个槽 / 是不是新游戏」，场景重建仍由 harness 跑
 * p1-world 完成。本模块是两者之间唯一的接缝：写入方是标题流程
 * （`ui/title-flow.ts`），读取方是 p1-world setup。
 */

import { describe, expect, it } from "vitest";

import { peekTitleEntryIntent, setTitleEntryIntent, takeTitleEntryIntent } from "./title-entry";

describe("入场意图交接", () => {
  it("缺省是无标题直达", () => {
    expect(peekTitleEntryIntent()).toEqual({ kind: "direct" });
  });

  it("写入的意图可被取出", () => {
    setTitleEntryIntent({ kind: "continue", slotId: "slot-2" });

    expect(takeTitleEntryIntent()).toEqual({ kind: "continue", slotId: "slot-2" });
  });

  it("取出后复位：同一次选择不会被下一次 setup 重放", () => {
    setTitleEntryIntent({ kind: "new-game" });
    takeTitleEntryIntent();

    expect(takeTitleEntryIntent()).toEqual({ kind: "direct" });
  });

  it("peek 不消费意图", () => {
    setTitleEntryIntent({ kind: "continue", slotId: "auto" });

    expect(peekTitleEntryIntent()).toEqual({ kind: "continue", slotId: "auto" });
    expect(peekTitleEntryIntent()).toEqual({ kind: "continue", slotId: "auto" });
    expect(takeTitleEntryIntent()).toEqual({ kind: "continue", slotId: "auto" });
  });

  it("新游戏意图不带槽位", () => {
    setTitleEntryIntent({ kind: "new-game" });

    expect(takeTitleEntryIntent()).toEqual({ kind: "new-game" });
  });
});
