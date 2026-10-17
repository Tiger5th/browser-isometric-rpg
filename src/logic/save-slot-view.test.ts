/**
 * 票 31：选槽界面的展示格式化（纯函数，不碰 DOM）。
 *
 * DOM 面板在 `src/render/ui/save-slot-panel.ts`；这里只锁住「槽位行该
 * 显示什么文字」的规则，vitest 环境无 jsdom，纯函数层才是可测接缝。
 */

import { describe, expect, it } from "vitest";

import { formatSlotRow, type SaveSlotEntryView } from "./save-slot-view";

const EMPTY_ENTRY: SaveSlotEntryView = {
  slotId: "slot-1",
  label: "存档 1",
  meta: null,
  snapshot: null,
};

describe("选槽行：空档", () => {
  it("空槽显示为「空」而不是留白", () => {
    const row = formatSlotRow(EMPTY_ENTRY);
    expect(row.primary).toBe("存档 1");
    expect(row.secondary).toBe("空");
    expect(row.isEmpty).toBe(true);
  });
});

describe("选槽行：有档", () => {
  const entry: SaveSlotEntryView = {
    slotId: "slot-1",
    label: "存档 1",
    meta: {
      slotId: "slot-1",
      savedAtMs: Date.UTC(2026, 9, 17, 12, 30, 0),
      playTimeMs: 3_723_000,
      playerLevel: 7,
    },
    snapshot: null,
  };

  it("显示等级、游戏时长与存档时间", () => {
    const row = formatSlotRow(entry);

    expect(row.isEmpty).toBe(false);
    expect(row.primary).toContain("Lv.7");
    expect(row.primary).toContain("存档 1");
    expect(row.secondary).toContain("1:02:03"); // 3_723_000ms = 1 小时 2 分 3 秒
    expect(row.secondary).toContain("2026-10-17");
  });

  it("时长不足一小时按 分:秒 显示", () => {
    const row = formatSlotRow({ ...entry, meta: { ...entry.meta!, playTimeMs: 65_000 } });
    expect(row.secondary).toContain("01:05");
  });

  it("时长不足一分钟显示 00:00 而不是空白", () => {
    const row = formatSlotRow({ ...entry, meta: { ...entry.meta!, playTimeMs: 900 } });
    expect(row.secondary).toContain("00:00");
  });

  it("存档时间未知（旧档合成元数据）时仍显示等级与时长", () => {
    const row = formatSlotRow({ ...entry, meta: { ...entry.meta!, savedAtMs: 0 } });
    expect(row.secondary).toContain("1:02:03");
    expect(row.secondary).not.toContain("1970");
  });
});

describe("选槽行：auto 槽命名", () => {
  it("auto 槽标注为自动存档，与手动槽区分", () => {
    const row = formatSlotRow({ ...EMPTY_ENTRY, slotId: "auto", label: "自动存档" });
    expect(row.primary).toBe("自动存档");
    expect(row.secondary).toBe("空");
  });
});