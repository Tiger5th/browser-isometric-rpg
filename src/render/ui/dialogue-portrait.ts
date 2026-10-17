/**
 * 两段式对话 UI（票 29）：NPC 头顶气泡按钮 + galgame 全屏立绘 + 对话框。
 *
 * 纯 DOM，不碰 Babylon：位置由调用方用场景投影算好后再 setAnchor()。
 * 设计要点（specs/p2-gameplay.md 用户故事 23/26/27）：
 * - 气泡：NPC 头顶浮动按钮，无任务显示「对话」，有可接任务显示「！」；
 * - 立绘：屏幕左右两侧全屏立绘，说话方亮、听话方微暗；
 * - 对话框：半透明深底 + 说话角色主色边 + 主色名牌；
 * - 立绘缺失时用角色主色程序化色块占位（不阻塞结构，待生图补资源）。
 */

import {
  DIALOGUE_ZOOM_DURATION_MS,
  dialogueDimStrength,
  dialogueZoomSpan,
  portraitLayout,
  type PortraitSpeaker,
  type SpeakerVisual,
} from "./portrait-layout";

export interface DialogueUiCharacter {
  id: string;
  displayName: string;
  /** 角色主色（色板卡 primary），用于名牌与对话框描边。 */
  primaryColor: string;
  /** 立绘图片 URL；缺失时用主色色块占位。 */
  portraitUrl?: string;
}

export interface DialogueUiOptions {
  mount: HTMLElement;
  characters: readonly DialogueUiCharacter[];
  /** 点击 NPC 头顶气泡（第二段交互）。 */
  onActivateBubble(npcId: string): void;
  /** 选择对话选项。 */
  onChoose(index: number): void;
}

export interface BubbleAnchor {
  npcId: string;
  kind: "talk" | "quest";
  /** 屏幕坐标（CSS 像素）。 */
  x: number;
  y: number;
}

export interface DialogueUi {
  /** 每帧刷新气泡位置/显隐；bubble 为 null 表示隐藏。 */
  setBubble(bubble: BubbleAnchor | null): void;
  /** 打开对话：npcId 为对话对象，playerId 为玩家实体。 */
  openDialogue(npcId: string, playerId: string, text: string, choices: readonly string[]): void;
  /** 刷新对话内容（说话方/文本/选项变化时调用）。 */
  updateDialogue(text: string, choices: readonly string[], activeSpeakerId: string): void;
  /** 关闭对话。 */
  closeDialogue(): void;
  /** 对话是否打开。 */
  isOpen(): boolean;
  /** 当前说话方 id（立绘高亮用）。 */
  activeSpeakerId(): string | null;
  dispose(): void;
}

const BUBBLE_STYLE = [
  "position:absolute;transform:translate(-50%,-100%);pointer-events:auto",
  "display:flex;align-items:center;gap:6px",
  "padding:6px 12px;border-radius:999px;cursor:pointer",
  "font:inherit;font-size:13px;font-weight:600;color:#0f172a",
  "border:1px solid rgba(15,23,42,0.35);background:#fde68a",
  "box-shadow:0 8px 20px rgba(0,0,0,0.35);white-space:nowrap",
].join(";");

const QUEST_BUBBLE_STYLE = [
  "position:absolute;transform:translate(-50%,-100%);pointer-events:auto",
  "display:flex;align-items:center;justify-content:center",
  "width:34px;height:34px;border-radius:999px;cursor:pointer",
  "font:inherit;font-size:19px;font-weight:800;color:#fefce8",
  "border:2px solid #fbbf24;background:#dc2626",
  "box-shadow:0 8px 22px rgba(220,38,38,0.45)",
].join(";");

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

export function createDialogueUi(options: DialogueUiOptions): DialogueUi {
  const { mount, characters } = options;
  const characterById = new Map(characters.map((entry) => [entry.id, entry]));

  const root = element(
    "div",
    "position:fixed;inset:0;pointer-events:none;z-index:20;font-family:ui-sans-serif,system-ui,sans-serif;",
  );
  root.dataset.testid = "dialogue-ui";

  const bubble = element("button", BUBBLE_STYLE, "对话");
  bubble.type = "button";
  bubble.dataset.testid = "npc-bubble";
  bubble.style.display = "none";

  const stage = element("div", "position:absolute;inset:0;display:none;");
  stage.dataset.testid = "dialogue-stage";

  // 背景压暗（仅表现层）：对话期间把 3D 场景压暗，突出立绘与对话框。
  const dim = element(
    "div",
    "position:absolute;inset:0;background:rgba(4,6,12,0.55);pointer-events:none;",
  );
  dim.dataset.testid = "dialogue-dim";

  // galgame 全屏立绘：左右两个全高画格，底部对齐（立绘从屏幕底部长出）。
  const portraits = element(
    "div",
    [
      "position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:space-between",
      "pointer-events:none",
    ].join(";"),
  );
  portraits.dataset.testid = "dialogue-portraits";

  const box = element(
    "section",
    [
      "position:absolute;left:50%;bottom:28px;transform:translateX(-50%)",
      "width:min(760px,calc(100vw - 48px));pointer-events:auto",
      "padding:18px 22px;border-radius:16px",
      "background:rgba(10,15,24,0.82);backdrop-filter:blur(10px)",
      "color:#e8edf5;font-size:15px;line-height:1.7",
      "box-shadow:0 24px 60px rgba(0,0,0,0.55)",
    ].join(";"),
  );
  box.dataset.testid = "dialogue-panel";

  const namePlate = element("div", "");
  namePlate.dataset.testid = "dialogue-name";

  const textNode = element("div", "white-space:pre-wrap;min-height:3.4em;");
  textNode.dataset.testid = "dialogue-text";

  const choiceList = element("div", "display:flex;flex-direction:column;gap:8px;margin-top:12px;");
  choiceList.dataset.testid = "dialogue-choices";

  box.append(namePlate, textNode, choiceList);
  stage.append(dim, portraits, box);
  root.append(bubble, stage);
  mount.append(root);

  let open = false;
  let activeSpeaker: string | null = null;
  let npcId: string | null = null;
  let playerId: string | null = null;

  const characterColor = (id: string): string =>
    characterById.get(id)?.primaryColor ?? "#7dd3fc";

  const renderPortraits = (activeSpeakerId: string): void => {
    if (npcId === null || playerId === null) {
      return;
    }
    const speakers: PortraitSpeaker[] = [
      { id: npcId, displayName: characterById.get(npcId)?.displayName ?? npcId, side: "left", hasPortrait: true },
      { id: playerId, displayName: characterById.get(playerId)?.displayName ?? playerId, side: "right", hasPortrait: true },
    ];
    const visuals: SpeakerVisual[] = portraitLayout(speakers, activeSpeakerId);
    portraits.replaceChildren();
    for (const visual of visuals) {
      const character = characterById.get(visual.id);
      const color = characterColor(visual.id);
      const frame = element(
        "div",
        [
          "position:relative;flex:1;height:100%;overflow:hidden",
          `opacity:${visual.brightness};transition:opacity 180ms ease`,
        ].join(";"),
      );
      frame.dataset.testid = "dialogue-portrait";
      frame.dataset.entityId = visual.id;
      frame.dataset.speaking = visual.speaking ? "true" : "false";
      frame.dataset.brightness = String(visual.brightness);

      if (character?.portraitUrl !== undefined) {
        const image = element(
          "img",
          [
            "position:absolute;left:50%;bottom:0;transform:translateX(-50%)",
            "height:100%;width:auto;max-width:100%;object-fit:contain",
          ].join(";"),
        );
        image.setAttribute("src", character.portraitUrl);
        image.setAttribute("alt", visual.displayName);
        frame.append(image);
      } else {
        // 占位：角色主色全幅剪影（从屏幕底部长出）+ 名字，
        // 等待 Gemini 生图资源（见票 29 遗留：立绘待生成）。
        frame.append(
          element(
            "div",
            [
              "position:absolute;left:50%;bottom:0;transform:translateX(-50%)",
              "width:min(46vw,520px);height:100%;border-radius:26px 26px 0 0",
              `background:linear-gradient(180deg,${color}dd 0%,${color}66 55%,${color}11 100%)`,
              "border:1px solid rgba(255,255,255,0.16);border-bottom:none",
              "display:flex;align-items:flex-end;justify-content:center",
              "padding-bottom:26px;color:#f8fafc;font-size:26px;font-weight:800",
              "letter-spacing:0.08em;text-shadow:0 2px 10px rgba(0,0,0,0.65)",
            ].join(";"),
            visual.displayName,
          ),
        );
      }
      portraits.append(frame);
    }
  };

  const renderDialogueBox = (text: string, choices: readonly string[], activeSpeakerId: string): void => {
    const color = characterColor(activeSpeakerId);
    const name = characterById.get(activeSpeakerId)?.displayName ?? activeSpeakerId;
    namePlate.textContent = name;
    namePlate.style.cssText = [
      "display:inline-block;margin-bottom:10px;padding:3px 12px;border-radius:8px",
      `background:${color};color:#0b1120;font-weight:800;letter-spacing:0.03em`,
    ].join(";");
    box.style.border = `2px solid ${color}`;
    textNode.textContent = text;

    choiceList.replaceChildren();
    choices.forEach((choice, index) => {
      const node = element(
        "button",
        [
          "text-align:left;cursor:pointer;font:inherit;font-size:14px",
          "color:#e8edf5;border-radius:10px;padding:9px 12px",
          `border:1px solid ${color}66;background:rgba(20,28,42,0.9)`,
        ].join(";"),
        choice,
      );
      node.type = "button";
      node.dataset.testid = "dialogue-choice";
      node.dataset.choiceIndex = String(index);
      node.addEventListener("click", () => options.onChoose(index));
      choiceList.append(node);
    });
  };

  return {
    setBubble(next) {
      if (next === null) {
        bubble.style.display = "none";
        return;
      }
      const isQuest = next.kind === "quest";
      bubble.style.cssText = isQuest ? QUEST_BUBBLE_STYLE : BUBBLE_STYLE;
      bubble.style.left = `${next.x}px`;
      bubble.style.top = `${next.y}px`;
      bubble.textContent = isQuest ? "！" : "对话";
      bubble.dataset.npcId = next.npcId;
      bubble.dataset.kind = next.kind;
      bubble.style.display = isQuest ? "flex" : "inline-flex";
      bubble.onclick = () => options.onActivateBubble(next.npcId);
    },

    openDialogue(nextNpcId, nextPlayerId, text, choices) {
      open = true;
      npcId = nextNpcId;
      playerId = nextPlayerId;
      activeSpeaker = nextNpcId;
      bubble.style.display = "none";
      stage.style.display = "block";
      stage.dataset.open = "true";
      renderPortraits(activeSpeaker);
      renderDialogueBox(text, choices, activeSpeaker);
    },

    updateDialogue(text, choices, activeSpeakerId) {
      if (!open) {
        return;
      }
      activeSpeaker = activeSpeakerId;
      renderPortraits(activeSpeakerId);
      renderDialogueBox(text, choices, activeSpeakerId);
    },

    closeDialogue() {
      open = false;
      npcId = null;
      playerId = null;
      activeSpeaker = null;
      stage.style.display = "none";
      delete stage.dataset.open;
      dim.style.background = "";
      portraits.replaceChildren();
      choiceList.replaceChildren();
    },

    isOpen: () => open,
    activeSpeakerId: () => activeSpeaker,

    dispose() {
      bubble.remove();
      stage.remove();
      root.remove();
    },
  };
}

/** 供 ego-browser 断言：当前立绘布局与镜头进度。 */
export function dialoguePresentation(
  baseSpan: number,
  progress: number,
): { span: number; dim: number } {
  return { span: dialogueZoomSpan(baseSpan, progress), dim: dialogueDimStrength(progress) };
}

export { DIALOGUE_ZOOM_DURATION_MS };
