/**
 * 对话 + 任务 HUD（纯 DOM，挂在 Harness 页面上）。
 *
 * 只消费 GameSession.snapshot()：任务目标/进度、背包摘要、当前对话文本与选项。
 * 选择按钮把意图回调给场景，由场景提交 chooseDialogueOption。
 */

import type { ContentBundle } from "../../logic/content/types";
import type { GameSessionSnapshot } from "../../logic/game-session";
import type { QuestStatus } from "../../logic/quest";

export interface QuestLoopUiOptions {
  mount: HTMLElement;
  bundle: ContentBundle;
  /** 玩家点击对话选项。 */
  onChoose(choiceIndex: number): void;
  /** 票 21 合并前的临时战斗入口；未提供时不渲染调试按钮。 */
  onDebugKill?(): void;
}

export interface QuestLoopUi {
  update(snapshot: GameSessionSnapshot): void;
  dispose(): void;
}

const STATUS_LABEL: Record<QuestStatus, string> = {
  available: "可接取",
  active: "进行中",
  ready_to_turn_in: "可交付",
  completed: "已完成",
};

const STATUS_COLOR: Record<QuestStatus, string> = {
  available: "#94a3b8",
  active: "#7dd3fc",
  ready_to_turn_in: "#fbbf24",
  completed: "#4ade80",
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export function createQuestLoopUi(options: QuestLoopUiOptions): QuestLoopUi {
  const { mount, bundle } = options;
  const enemyNames = new Map(
    bundle.enemyTemplates.map((template) => [template.id, template.displayName]),
  );
  const itemNames = new Map(bundle.items.map((item) => [item.id, item.displayName]));

  const root = element(
    "div",
    "position:fixed;inset:0;pointer-events:none;z-index:10;font-family:ui-sans-serif,system-ui,sans-serif;",
  );

  const hud = element(
    "aside",
    [
      "position:absolute;top:16px;right:16px;width:min(320px,calc(100vw - 32px))",
      "max-height:calc(100vh - 32px);overflow:auto;pointer-events:auto",
      "padding:14px 16px;border:1px solid rgba(148,163,184,0.28);border-radius:12px",
      "background:rgba(15,20,28,0.9);backdrop-filter:blur(10px);color:#e6e9ef",
      "box-shadow:0 18px 48px rgba(0,0,0,0.45);font-size:12px;line-height:1.55",
    ].join(";"),
  );

  const dialogue = element(
    "section",
    [
      "position:absolute;left:50%;bottom:28px;transform:translateX(-50%)",
      "width:min(680px,calc(100vw - 32px));pointer-events:auto;display:none",
      "padding:16px 18px;border:1px solid rgba(125,211,252,0.35);border-radius:14px",
      "background:rgba(12,18,26,0.94);backdrop-filter:blur(12px);color:#e6e9ef",
      "box-shadow:0 22px 60px rgba(0,0,0,0.55);font-size:14px;line-height:1.6",
    ].join(";"),
  );

  root.append(hud, dialogue);
  mount.append(root);

  let lastKey = "";

  const renderHud = (snapshot: GameSessionSnapshot): void => {
    hud.replaceChildren();
    hud.append(
      element(
        "div",
        "font-size:13px;font-weight:700;letter-spacing:0.04em;color:#7dd3fc;margin-bottom:8px;",
        "任务",
      ),
    );

    const visible = snapshot.quests.filter((quest) => quest.status !== "available");
    if (visible.length === 0) {
      hud.append(
        element("div", "color:#94a3b8;", "暂无进行中的任务。去和马婆婆聊聊吧。"),
      );
    } else {
      for (const quest of visible) {
        const item = element("div", "margin-bottom:10px;");
        const titleRow = element("div", "display:flex;justify-content:space-between;gap:8px;");
        titleRow.append(
          element("strong", "font-weight:600;", quest.title),
          element(
            "span",
            `color:${STATUS_COLOR[quest.status]};font-size:11px;white-space:nowrap;`,
            STATUS_LABEL[quest.status],
          ),
        );
        item.append(titleRow);
        for (const objective of quest.objectives) {
          const enemyName =
            enemyNames.get(objective.enemyTemplateId) ?? objective.enemyTemplateId;
          item.append(
            element(
              "div",
              "color:#cbd5e1;padding-left:2px;",
              `· 击杀${enemyName} ${objective.current}/${objective.required}`,
            ),
          );
        }
        hud.append(item);
      }
    }

    const player = snapshot.entities.find(
      (entity) => entity.identity.type === "player",
    );
    if (player !== undefined) {
      const counts = new Map<string, number>();
      for (const item of player.container.items) {
        counts.set(item.templateId, (counts.get(item.templateId) ?? 0) + item.quantity);
      }
      const inventory =
        counts.size === 0
          ? "空"
          : [...counts.entries()]
              .map(([templateId, quantity]) => {
                const name = itemNames.get(templateId) ?? templateId;
                return `${name} ×${quantity}`;
              })
              .join("，");
      hud.append(
        element(
          "div",
          "margin-top:10px;padding-top:8px;border-top:1px solid rgba(148,163,184,0.18);color:#94a3b8;",
          `背包：${inventory}`,
        ),
      );
    }

    if (options.onDebugKill !== undefined) {
      const button = element(
        "button",
        [
          "margin-top:10px;width:100%;cursor:pointer;font:inherit;font-size:11px",
          "color:#e6e9ef;border:1px solid rgba(148,163,184,0.35);border-radius:8px",
          "background:#1a2230;padding:6px 8px;",
        ].join(";"),
        "调试：击杀一只史莱姆（票 21 合并前的临时入口）",
      );
      button.type = "button";
      button.addEventListener("click", () => options.onDebugKill?.());
      hud.append(button);
    }
  };

  const renderDialogue = (snapshot: GameSessionSnapshot): void => {
    dialogue.replaceChildren();
    const active = snapshot.dialogue;
    if (active === null) {
      dialogue.style.display = "none";
      return;
    }
    dialogue.style.display = "block";

    const speaker =
      snapshot.entities.find((entity) => entity.id === active.npcId)?.identity
        .displayName ?? active.npcId;
    dialogue.append(
      element("div", "font-weight:700;color:#7dd3fc;margin-bottom:6px;", speaker),
      element("div", "white-space:pre-wrap;margin-bottom:12px;", active.text),
    );

    if (active.choices.length > 0) {
      const list = element("div", "display:flex;flex-direction:column;gap:6px;");
      active.choices.forEach((choice, index) => {
        const button = element(
          "button",
          [
            "text-align:left;cursor:pointer;font:inherit;font-size:13px",
            "color:#e6e9ef;border:1px solid rgba(125,211,252,0.3);border-radius:8px",
            "background:#16202e;padding:8px 10px;",
          ].join(";"),
          choice,
        );
        button.type = "button";
        button.dataset.choiceIndex = String(index);
        button.addEventListener("click", () => options.onChoose(index));
        list.append(button);
      });
      dialogue.append(list);
    }
  };

  return {
    update(snapshot) {
      const player = snapshot.entities.find(
        (entity) => entity.identity.type === "player",
      );
      const key = JSON.stringify({
        text: snapshot.dialogue?.text ?? null,
        choices: snapshot.dialogue?.choices ?? null,
        npcId: snapshot.dialogue?.npcId ?? null,
        quests: snapshot.quests,
        items: player?.container.items ?? [],
      });
      if (key === lastKey) {
        return;
      }
      lastKey = key;
      renderHud(snapshot);
      renderDialogue(snapshot);
    },

    dispose() {
      root.remove();
    },
  };
}
