/**
 * 选槽界面的展示规则（票 31）。纯函数：DOM 面板只负责排版，
 * 「一行槽位该显示什么文字」在这里定，vitest 无 jsdom 也锁得住。
 */

import type { SaveSlotId, SaveSlotMeta } from "./save-slots";

export interface SaveSlotEntryView {
  slotId: SaveSlotId;
  /** UI 上的槽位名：「自动存档」/「存档 1..3」。 */
  label: string;
  meta: SaveSlotMeta | null;
  snapshot: unknown;
}

export interface SaveSlotRow {
  /** 左列：槽位名 + 等级。 */
  primary: string;
  /** 右列：游戏时长 + 存档时间（或「空」）。 */
  secondary: string;
  isEmpty: boolean;
}

const SLOT_LABELS: Record<SaveSlotId, string> = {
  auto: "自动存档",
  "slot-1": "存档 1",
  "slot-2": "存档 2",
  "slot-3": "存档 3",
};

export function slotLabel(slotId: SaveSlotId): string {
  return SLOT_LABELS[slotId] ?? slotId;
}

/** 毫秒 → `H:MM:SS`（不足一小时 `MM:SS`）。 */
export function formatPlayTime(playTimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(playTimeMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** 时间戳 → `YYYY-MM-DD HH:mm`；0（未知时间）返回 null。 */
export function formatSavedAt(savedAtMs: number): string | null {
  if (!Number.isFinite(savedAtMs) || savedAtMs <= 0) {
    return null;
  }
  const date = new Date(savedAtMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatSlotRow(entry: SaveSlotEntryView): SaveSlotRow {
  if (entry.meta === null) {
    return { primary: entry.label, secondary: "空", isEmpty: true };
  }
  const parts = [`游玩 ${formatPlayTime(entry.meta.playTimeMs)}`];
  const savedAt = formatSavedAt(entry.meta.savedAtMs);
  if (savedAt !== null) {
    parts.push(savedAt);
  }
  return {
    primary: `${entry.label} · Lv.${entry.meta.playerLevel}`,
    secondary: parts.join(" · "),
    isEmpty: false,
  };
}