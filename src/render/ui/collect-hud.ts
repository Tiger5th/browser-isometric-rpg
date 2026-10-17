/**
 * 探索 HUD（票 37）：收集计数条目 + 相机复位按钮。
 *
 * 独立成文件而不是塞进 quest-loop-ui.ts：那个文件被多票改过，
 * 新增条目在这里搭 DOM、纯换算在 `collectHudView` 里，方便 L1 直测显示口径。
 *
 * 只消费 `GameSession.collectProgress()` 的结果与相机控制器的回调：
 * HUD 不读会话内部状态，也不直接改相机。
 */

import type { CollectProgress } from "../../logic/exploration";

export interface CollectHudEntryView {
  setId: string;
  displayName: string;
  collected: number;
  total: number;
  /** 计数文案，如「萤光草 3 / 8」；集满后不再加任何标记（清点本身就是句号）。 */
  text: string;
  /** 0–1 进度条比例。 */
  ratio: number;
  complete: boolean;
  /** 满集时提示奖励已入包。 */
  rewardText: string;
}

export interface CollectHudInput {
  /** 集 id → 显示名（内容里的 displayName）。 */
  displayNames: ReadonlyMap<string, string>;
  progress: readonly CollectProgress[];
}

export function collectHudView(input: CollectHudInput): CollectHudEntryView[] {
  return input.progress.map((entry) => {
    const total = Math.max(0, Math.round(entry.total));
    const collected = Math.min(total, Math.max(0, Math.round(entry.collected)));
    const displayName = input.displayNames.get(entry.setId) ?? entry.setId;
    return {
      setId: entry.setId,
      displayName,
      collected,
      total,
      text: `${displayName} ${collected} / ${total}`,
      ratio: total === 0 ? 0 : collected / total,
      complete: entry.complete,
      rewardText: entry.complete
        ? entry.rewardGranted
          ? "全收集奖励已入包"
          : "全收集达成"
        : "",
    };
  });
}

export interface CollectHudOptions {
  mount: HTMLElement;
  /** 相机复位（回出厂等距预设）。HUD 只负责把点击转出去。 */
  onResetCamera?(): void;
}

export interface CollectHud {
  update(input: CollectHudInput): void;
  dispose(): void;
}

function element(tag: "div" | "button", style: string, text?: string): HTMLElement {
  const node = document.createElement(tag) as HTMLElement;
  node.style.cssText = style;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** 收集计数 HUD。内容包没有收集集时不渲染任何条目（不占空间）。 */
export function createCollectHud(options: CollectHudOptions): CollectHud {
  const root = element(
    "div",
    "position:fixed;left:16px;bottom:16px;pointer-events:none;z-index:11;" +
      "font-family:ui-sans-serif,system-ui,sans-serif;color:#e6e9ef;",
  );
  root.dataset.testid = "exploration-hud";

  const list = element("div", "display:flex;flex-direction:column;gap:6px;");
  list.dataset.testid = "collect-list";
  root.append(list);

  const button = element(
    "button",
    [
      "margin-top:8px;pointer-events:auto;cursor:pointer;font:inherit;font-size:11px",
      "color:#e6e9ef;border:1px solid rgba(148,163,184,0.35);border-radius:8px",
      "background:rgba(15,20,28,0.9);padding:6px 10px;",
    ].join(";"),
    "复位视角",
  ) as HTMLButtonElement;
  button.type = "button";
  button.dataset.testid = "camera-reset";
  button.addEventListener("click", () => options.onResetCamera?.());
  root.append(button);

  options.mount.append(root);

  let signature = "";

  return {
    update(input: CollectHudInput): void {
      const views = collectHudView(input);
      // 只有显示值真变了才重排 DOM（每帧调用，避免无谓重绘）。
      const next = JSON.stringify(views.map((view) => [view.setId, view.text, view.rewardText]));
      if (next === signature) {
        return;
      }
      signature = next;
      list.replaceChildren();
      for (const view of views) {
        const row = element("div", "");
        row.dataset.testid = "collect-entry";
        row.dataset.setId = view.setId;
        row.dataset.collected = String(view.collected);
        row.dataset.total = String(view.total);
        row.dataset.complete = String(view.complete);

        const label = element(
          "div",
          "font-size:11px;color:#a5f3d0;text-shadow:0 1px 2px rgba(0,0,0,0.8);",
          view.text,
        );
        label.dataset.testid = "collect-count";
        label.dataset.text = view.text;
        row.append(label);

        const bar = element(
          "div",
          "height:4px;width:140px;border-radius:999px;background:rgba(148,163,184,0.25);overflow:hidden;",
        );
        const fill = element(
          "div",
          `height:100%;width:${(view.ratio * 100).toFixed(1)}%;border-radius:999px;background:linear-gradient(90deg,#34d399,#a5f3d0);transition:width 120ms linear;`,
        );
        fill.dataset.testid = "collect-fill";
        fill.dataset.ratio = view.ratio.toFixed(3);
        bar.append(fill);
        row.append(bar);

        if (view.rewardText !== "") {
          const reward = element(
            "div",
            "font-size:10px;color:#fbbf24;text-shadow:0 1px 2px rgba(0,0,0,0.8);",
            view.rewardText,
          );
          reward.dataset.testid = "collect-reward";
          row.append(reward);
        }
        list.append(row);
      }
    },
    dispose(): void {
      root.remove();
    },
  };
}