/**
 * 选槽面板（票 31，DOM 层）。
 *
 * 容器：票 31 先挂在游戏内 HUD（右上角可折叠面板），票 32 的主菜单
 * 落地后由它接管同一份数据源——面板只吃 `SaveSlotEntryView[]`，
 * 不自己读存储。
 *
 * 每行显示：槽位名 + 等级 + 游戏时长 + 存档时间，读/写/删三个按钮。
 */

import {
  formatSlotRow,
  slotLabel,
  type SaveSlotEntryView,
} from "../../logic/save-slot-view";
import type { SaveSlotId } from "../../logic/save-slots";

export interface SaveSlotPanelOptions {
  mount: HTMLElement;
  /** 刷新槽位列表（异步）。 */
  refresh(): Promise<SaveSlotEntryView[]>;
  /**
   * 读档：成功后由调用方重建场景。
   * 三个回调都可返回 Promise——面板会**等写盘完成再刷新列表**，
   * 否则刷新会先于写入读到旧数据（空槽）。
   */
  onLoad(slotId: SaveSlotId): Promise<void> | void;
  /** 写入当前进度。 */
  onSave(slotId: SaveSlotId): Promise<void> | void;
  /** 删除槽位。 */
  onDelete(slotId: SaveSlotId): Promise<void> | void;
  /** 操作结果反馈（复用 HUD 的存档状态行）。 */
  setStatus?(text: string, kind?: "idle" | "ok" | "error"): void;
}

export interface SaveSlotPanel {
  refresh(): Promise<void>;
  dispose(): void;
}

const PANEL_COLOR = "#e2e8f0";
const MUTED_COLOR = "#94a3b8";
const ERROR_COLOR = "#f87171";

function element(tag: string, style: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.style.cssText = style;
  node.textContent = text;
  return node;
}

export function createSaveSlotPanel(options: SaveSlotPanelOptions): SaveSlotPanel {
  const status = (text: string, kind: "idle" | "ok" | "error" = "idle"): void => {
    options.setStatus?.(text, kind);
  };

  const list = element("div", "display:flex;flex-direction:column;gap:6px;");
  const panel = element(
    "div",
    [
      "position:absolute",
      "top:16px",
      "left:50%",
      "transform:translateX(-50%)",
      "min-width:260px",
      "padding:10px 12px",
      `color:${PANEL_COLOR}`,
      "background:rgba(8,13,22,0.86)",
      "border:1px solid rgba(148,163,184,0.35)",
      "border-radius:8px",
      "font-size:13px",
      "z-index:30",
    ].join(";"),
  );
  panel.dataset.testid = "save-slot-panel";

  let expanded = true;
  const body = element("div", "display:flex;flex-direction:column;gap:6px;");

  const header = element("div", "display:flex;align-items:center;gap:8px;");
  const title = element("div", "flex:1;font-weight:600;", "存档");
  const toggle = document.createElement("button");
  toggle.dataset.testid = "save-slot-toggle";
  toggle.textContent = "−";
  toggle.style.cssText =
    "background:transparent;border:1px solid rgba(148,163,184,0.4);color:inherit;border-radius:4px;cursor:pointer;padding:0 6px;";
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    toggle.textContent = expanded ? "−" : "+";
    body.style.display = expanded ? "flex" : "none";
  });
  header.append(title, toggle);
  body.append(list);
  panel.append(header, body);

  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      status(`存档操作失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const renderRows = (entries: SaveSlotEntryView[]): void => {
    list.textContent = "";
    for (const entry of entries) {
      const row = formatSlotRow(entry);
      const line = element(
        "div",
        "display:flex;align-items:center;gap:8px;",
      );
      const text = element(
        "div",
        "flex:1;line-height:1.35;",
        `${row.primary}\n${row.secondary}`,
      );
      text.style.whiteSpace = "pre-line";
      text.style.color = row.isEmpty ? MUTED_COLOR : PANEL_COLOR;
      text.dataset.testid = `save-slot-${entry.slotId}`;
      text.dataset.empty = String(row.isEmpty);
      text.dataset.level = row.isEmpty ? "" : String(entry.meta?.playerLevel ?? "");

      const actions = element("div", "display:flex;gap:4px;");
      const button = (label: string, testid: string, handler: () => void): void => {
        const node = document.createElement("button");
        node.textContent = label;
        node.dataset.testid = `${testid}-${entry.slotId}`;
        node.style.cssText =
          "background:#233044;border:1px solid rgba(148,163,184,0.35);color:inherit;border-radius:4px;cursor:pointer;padding:2px 7px;font-size:12px;";
        node.addEventListener("click", handler);
        actions.append(node);
      };

      button("读", "save-slot-load", () =>
        run(async () => {
          await options.onLoad(entry.slotId);
          await options.refresh();
        }),
      );
      button("写", "save-slot-save", () =>
        run(async () => {
          await options.onSave(entry.slotId);
          await options.refresh();
        }),
      );
      // 自动槽由自动存档策略管理，手动删掉它会让「读自动档」入口消失，
      // 所以 UI 不给 auto 提供删除按钮（逻辑层 deleteSlot 仍可用）。
      if (entry.slotId !== "auto") {
        button("删", "save-slot-delete", () =>
          run(async () => {
            await options.onDelete(entry.slotId);
            await options.refresh();
          }),
        );
      }

      line.append(text, actions);
      list.append(line);
    }
  };

  const refresh = async (): Promise<void> => {
    renderRows(await options.refresh());
  };

  options.mount.append(panel);
  void refresh();

  return {
    refresh,
    dispose: () => {
      panel.remove();
    },
  };
}

export { slotLabel, ERROR_COLOR };