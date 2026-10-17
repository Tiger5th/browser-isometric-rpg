/**
 * 标题画面（票 32，DOM/CSS 层）。
 *
 * 与区域切换共用 loadingGate 黑场基建：进入游戏时 `transitionOut()` 先把
 * 遮罩拉黑、摘掉标题层、再淡出黑场，转场不生硬。
 *
 * 所有「显示哪个入口 / 要不要选槽 / 要不要二次确认」的判定都在
 * `src/logic/title-menu.ts`（纯函数），这里只负责把结论画成 DOM：
 * logo 演出（淡入 + 雾气/粒子，2–3 秒可跳过）、入口按钮、选槽列表、
 * 新游戏二次确认弹层、版本号。
 */

import { getLoadingGate } from "../loadingGate";
import {
  TITLE_INTRO_MS,
  titleIntroState,
  type TitleEntry,
  type TitleIntroState,
  type TitleMenuState,
} from "../../logic/title-menu";
import type { SaveSlotId } from "../../logic/save-slots";
import { formatSlotRow, type SaveSlotEntryView } from "../../logic/save-slot-view";

const ROOT_ID = "title-screen";
const STYLE_ID = "title-screen-style";

/** 菜单里的「读档」子流程。 */
type MenuView = "root" | "slots" | "confirm-new-game";

export interface TitleScreenOptions {
  mount: HTMLElement;
  /** 显示在右下角的版本号（package.json version）。 */
  version: string;
  /** logo 图片 URL；缺失时退化为纯文字标题。 */
  logoUrl?: string;
  /** 氛围背景图 URL；缺失时用 CSS 渐变兜底。 */
  backgroundUrl?: string;
}

export interface TitleScreenHandlers {
  /** 继续游戏：调用方读档（读 auto 或用户选的槽）。 */
  onContinue(slotId: SaveSlotId): void | Promise<void>;
  /** 新游戏：调用方重置到初始进度（走黑场过场）。 */
  onNewGame(): void | Promise<void>;
  /** 读档失败提示（保留在标题画面，不进游戏）。 */
  onError?(message: string): void;
}

export interface TitleScreen {
  /** 按判定结论渲染入口并开始入场演出。 */
  present(menu: TitleMenuState, entries: readonly SaveSlotEntryView[], handlers: TitleScreenHandlers): void;
  /** 当前是否可见（L4 断言用）。 */
  isVisible(): boolean;
  /** 入口测试钩子：当前可见的入口与子流程。 */
  debugState(): {
    visible: boolean;
    introState: TitleIntroState;
    view: MenuView;
    entries: TitleEntry[];
    requireNewGameConfirm: boolean;
    occupiedSlotIds: SaveSlotId[];
    error: string | null;
  };
  /** 点击跳过入场演出。 */
  skipIntro(): void;
  /** 黑场过场：拉黑 → 摘掉标题层 → 淡出，返回实际耗时（ms）。 */
  transitionOut(): Promise<number>;
  dispose(): void;
}

const STYLE_TEXT = `
#${ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  overflow: hidden;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #eaf3ea;
  cursor: pointer;
}
#${ROOT_ID}[data-visible="true"] { display: flex; }
#${ROOT_ID} .t-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  background:
    radial-gradient(120% 90% at 50% 18%, rgba(190, 226, 178, 0.55), rgba(46, 74, 58, 0) 62%),
    radial-gradient(90% 70% at 22% 82%, rgba(120, 92, 140, 0.35), rgba(12, 18, 26, 0) 70%),
    linear-gradient(180deg, #16232b 0%, #101a20 45%, #070c10 100%);
  background-size: cover;
  background-position: center;
}
#${ROOT_ID} .t-bg::after {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(78% 62% at 50% 44%, rgba(0, 0, 0, 0) 40%, rgba(3, 7, 10, 0.86) 100%);
}
/* 雾气层：两层反向漂移的柔光斑，营造开屏氛围。 */
#${ROOT_ID} .t-fog {
  position: absolute;
  inset: -25%;
  z-index: 1;
  pointer-events: none;
  opacity: 0.5;
  background:
    radial-gradient(42% 26% at 30% 62%, rgba(226, 240, 226, 0.24), rgba(255, 255, 255, 0) 70%),
    radial-gradient(50% 30% at 70% 40%, rgba(198, 226, 206, 0.2), rgba(255, 255, 255, 0) 72%);
  animation: t-fog-drift 17s ease-in-out infinite alternate;
}
#${ROOT_ID} .t-fog.t-fog-b {
  animation-duration: 23s;
  animation-direction: alternate-reverse;
  opacity: 0.38;
}
@keyframes t-fog-drift {
  from { transform: translate3d(-3%, -2%, 0) scale(1); }
  to { transform: translate3d(4%, 3%, 0) scale(1.08); }
}
/* 粒子层：CSS 生成的萤光尘埃，向上飘并闪烁。 */
#${ROOT_ID} .t-motes { position: absolute; inset: 0; z-index: 2; pointer-events: none; overflow: hidden; }
#${ROOT_ID} .t-mote {
  position: absolute;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(226, 255, 214, 0.9);
  box-shadow: 0 0 8px rgba(178, 240, 160, 0.8);
  opacity: 0;
  animation: t-mote-rise linear infinite;
}
@keyframes t-mote-rise {
  0% { transform: translate3d(0, 0, 0); opacity: 0; }
  12% { opacity: 0.85; }
  70% { opacity: 0.55; }
  100% { transform: translate3d(14px, -46vh, 0); opacity: 0; }
}
#${ROOT_ID} .t-stack {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 26px;
  padding: 0 24px;
  max-width: min(560px, 92vw);
}
#${ROOT_ID} .t-logo {
  max-width: min(520px, 84vw);
  width: 62vw;
  height: auto;
  filter: drop-shadow(0 14px 34px rgba(0, 0, 0, 0.55));
  opacity: 0;
  transform: translateY(16px) scale(0.965);
  animation: t-logo-in 1100ms cubic-bezier(0.22, 0.68, 0.24, 1) 260ms forwards;
}
#${ROOT_ID} .t-title {
  font-size: clamp(38px, 8vw, 76px);
  font-weight: 800;
  letter-spacing: 0.14em;
  text-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
  opacity: 0;
  transform: translateY(14px);
  animation: t-logo-in 1100ms cubic-bezier(0.22, 0.68, 0.24, 1) 260ms forwards;
}
#${ROOT_ID} .t-sub {
  margin: -14px 0 0;
  font-size: 12px;
  letter-spacing: 0.42em;
  text-transform: uppercase;
  color: rgba(214, 234, 214, 0.62);
}
#${ROOT_ID} .t-menu {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(300px, 76vw);
  opacity: 0;
  transform: translateY(10px);
  animation: t-logo-in 760ms cubic-bezier(0.22, 0.68, 0.24, 1) 900ms forwards;
}
#${ROOT_ID} button {
  font: inherit;
  font-size: 15px;
  letter-spacing: 0.16em;
  padding: 12px 18px;
  color: #eaf3ea;
  background: rgba(16, 28, 34, 0.72);
  border: 1px solid rgba(180, 214, 176, 0.42);
  border-radius: 10px;
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
}
#${ROOT_ID} button:hover:not(:disabled) {
  background: rgba(38, 62, 52, 0.86);
  border-color: rgba(190, 240, 170, 0.85);
  transform: translateX(3px);
}
#${ROOT_ID} button:disabled { opacity: 0.4; cursor: not-allowed; }
#${ROOT_ID} .t-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(400px, 86vw);
}
#${ROOT_ID} .t-list button { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; text-align: left; letter-spacing: 0.04em; }
#${ROOT_ID} .t-list .t-line1 { font-size: 14px; font-weight: 600; }
#${ROOT_ID} .t-list .t-line2 { font-size: 11px; color: rgba(200, 220, 200, 0.72); letter-spacing: 0.02em; }
#${ROOT_ID} .t-panel {
  width: min(400px, 86vw);
  padding: 16px 18px;
  border-radius: 12px;
  background: rgba(8, 14, 18, 0.9);
  border: 1px solid rgba(180, 214, 176, 0.32);
  box-shadow: 0 20px 52px rgba(0, 0, 0, 0.55);
}
#${ROOT_ID} .t-panel h2 { margin: 0 0 8px; font-size: 15px; letter-spacing: 0.1em; }
#${ROOT_ID} .t-panel p { margin: 0 0 14px; font-size: 12.5px; line-height: 1.65; color: rgba(206, 224, 206, 0.82); }
#${ROOT_ID} .t-panel .t-actions { display: flex; gap: 10px; justify-content: flex-end; }
#${ROOT_ID} .t-back { margin-top: 10px; width: 100%; font-size: 12px; padding: 8px; letter-spacing: 0.1em; }
#${ROOT_ID} .t-error {
  position: absolute;
  z-index: 4;
  bottom: 84px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 14px;
  font-size: 12px;
  color: #ffd9d9;
  background: rgba(70, 20, 22, 0.9);
  border: 1px solid rgba(240, 140, 140, 0.5);
  border-radius: 8px;
}
#${ROOT_ID} .t-hint {
  position: absolute;
  z-index: 4;
  bottom: 22px;
  width: 100%;
  text-align: center;
  font-size: 11px;
  letter-spacing: 0.18em;
  color: rgba(200, 220, 200, 0.5);
}
#${ROOT_ID} .t-version {
  position: absolute;
  z-index: 4;
  right: 18px;
  bottom: 20px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(200, 220, 200, 0.5);
  font-variant-numeric: tabular-nums;
}
@keyframes t-logo-in { to { opacity: 1; transform: translateY(0) scale(1); } }
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .t-fog, #${ROOT_ID} .t-mote { animation: none; }
  #${ROOT_ID} .t-logo, #${ROOT_ID} .t-title, #${ROOT_ID} .t-menu { animation-duration: 1ms; }
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  document.head.append(style);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}

/** 萤光尘埃：固定数量的元素用 CSS 动画跑，避免每帧 JS 开销。 */
function createMotes(container: HTMLElement, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const mote = element("span", "t-mote");
    // 位置/时长用下标散列，确定性（同一台机器每次开屏一致，便于截图对比）。
    const left = ((index * 37) % 100) + (index % 7) * 0.13;
    const size = 2 + ((index * 13) % 5) * 0.6;
    mote.style.left = `${left}%`;
    mote.style.bottom = `${((index * 29) % 40) - 4}%`;
    mote.style.width = `${size}px`;
    mote.style.height = `${size}px`;
    mote.style.animationDuration = `${9 + ((index * 17) % 11)}s`;
    mote.style.animationDelay = `${((index * 23) % 90) / 10}s`;
    container.append(mote);
  }
}

export function createTitleScreen(options: TitleScreenOptions): TitleScreen {
  ensureStyle();

  const root = element("div");
  root.id = ROOT_ID;
  root.dataset.testid = "title-screen";
  root.dataset.visible = "false";
  root.dataset.view = "root";
  // aria：标题画面是应用外壳，屏幕阅读器直接进入。
  root.setAttribute("role", "banner");

  const background = element("div", "t-bg");
  if (options.backgroundUrl !== undefined) {
    background.style.backgroundImage = `url("${options.backgroundUrl}")`;
  }
  const fogA = element("div", "t-fog");
  const fogB = element("div", "t-fog t-fog-b");
  const motes = element("div", "t-motes");
  createMotes(motes, 28);

  const stack = element("div", "t-stack");
  if (options.logoUrl !== undefined) {
    const logo = element("img", "t-logo");
    logo.dataset.testid = "title-logo";
    logo.src = options.logoUrl;
    logo.alt = "Green Hollow";
    stack.append(logo);
  } else {
    const fallback = element("div", "t-title");
    fallback.textContent = "GREEN HOLLOW";
    fallback.dataset.testid = "title-logo";
    stack.append(fallback);
  }
  const sub = element("p", "t-sub");
  sub.textContent = "绿洼地";
  const body = element("div");
  stack.append(sub, body);

  const hint = element("div", "t-hint");
  hint.textContent = "入场演出中… 点击任意处可跳过";
  hint.dataset.testid = "title-hint";
  const version = element("div", "t-version");
  version.textContent = `v${options.version}`;
  version.dataset.testid = "title-version";
  const errorLine = element("div", "t-error");
  errorLine.dataset.testid = "title-error";
  errorLine.style.display = "none";

  root.append(background, fogA, fogB, motes, stack, errorLine, hint, version);
  options.mount.append(root);

  let view: MenuView = "root";
  let menu: TitleMenuState | null = null;
  let handlers: TitleScreenHandlers | null = null;
  let introSkipped = false;
  let introStartedAtMs = Number.NaN;
  let introTimer = 0;
  let busy = false;
  let presented = false;
  let lastError: string | null = null;

  const showError = (message: string | null): void => {
    lastError = message;
    errorLine.textContent = message ?? "";
    errorLine.style.display = message === null ? "none" : "block";
  };

  const introReady = (): boolean => {
    // present() 之前一律按未就绪：那时不存在可点的按钮。
    if (!Number.isFinite(introStartedAtMs)) {
      return false;
    }
    return (
      titleIntroState(performance.now() - introStartedAtMs, { skipped: introSkipped }) === "ready"
    );
  };

  /** 演出结束（或已跳过）时解锁全部按钮并停掉轮询。 */
  const finishIntro = (): void => {
    if (introTimer !== 0) {
      window.clearInterval(introTimer);
      introTimer = 0;
    }
    for (const button of root.querySelectorAll("button")) {
      button.disabled = false;
    }
    hint.textContent = "点击画面继续";
  };

  const lockIntro = (buttons: HTMLButtonElement[]): void => {
    const ready = introReady();
    for (const button of buttons) {
      button.disabled = !ready;
    }
    hint.textContent = ready ? "点击画面继续" : "入场演出中… 点击任意处可跳过";
  };

  const renderRoot = (): void => {
    body.textContent = "";
    const current = menu;
    if (current === null) {
      return;
    }
    // .t-menu 承载按钮组（居中列 + 入场动画）；选槽与确认各自用别的容器样式。
    const menuBox = element("div", "t-menu");
    menuBox.dataset.testid = "title-menu";
    const buttons: HTMLButtonElement[] = [];
    for (const entry of current.entries) {
      const button = element("button");
      button.dataset.testid = entry === "continue" ? "title-continue" : "title-new-game";
      button.textContent = entry === "continue" ? "继续游戏" : "新游戏";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void activateEntry(entry);
      });
      menuBox.append(button);
      buttons.push(button);
    }
    body.append(menuBox);
    lockIntro(buttons);
  };

  const renderSlots = (): void => {
    body.textContent = "";
    const list = element("div", "t-list");
    for (const slotView of entriesBySlot) {
      const row = formatSlotRow(slotView);
      const button = element("button");
      button.dataset.testid = `title-slot-${slotView.slotId}`;
      const line1 = element("span", "t-line1");
      line1.textContent = row.primary;
      const line2 = element("span", "t-line2");
      line2.textContent = row.secondary;
      button.append(line1, line2);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void run(() => handlers?.onContinue(slotView.slotId));
      });
      list.append(button);
    }
    const back = element("button", "t-back");
    back.textContent = "返回";
    back.dataset.testid = "title-slots-back";
    back.addEventListener("click", (event) => {
      event.stopPropagation();
      view = "root";
      render();
      render();
    });
    body.append(list, back);
    lockIntro([...list.querySelectorAll("button"), back]);
  };

  const renderConfirm = (): void => {
    body.textContent = "";
    const panel = element("div", "t-panel");
    panel.dataset.testid = "title-new-game-confirm";
    const heading = element("h2");
    heading.textContent = "开始新游戏？";
    const copy = element("p");
    copy.textContent =
      "新游戏会丢弃当前进度，从头开始。旧存档不会立刻删除——但自动存档会被新进度接管，手动存档一旦写入同名槽位就会被覆盖。";
    const actions = element("div", "t-actions");
    const cancel = element("button");
    cancel.textContent = "取消";
    cancel.dataset.testid = "title-new-game-cancel";
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      view = "root";
      showError(null);
      render();
    });
    const confirm = element("button");
    confirm.textContent = "开始新游戏";
    confirm.dataset.testid = "title-new-game-confirm-accept";
    confirm.addEventListener("click", (event) => {
      event.stopPropagation();
      void run(() => handlers?.onNewGame());
    });
    actions.append(cancel, confirm);
    panel.append(heading, copy, actions);
    const back = element("button", "t-back");
    back.dataset.testid = "title-confirm-back";
    back.addEventListener("click", (event) => {
      event.stopPropagation();
      view = "root";
      render();
    });
    body.append(panel, back);
    lockIntro([...body.querySelectorAll("button")]);
  };

  let entriesBySlot: SaveSlotEntryView[] = [];

  const render = (): void => {
    root.dataset.view = view;
    if (view === "root") {
      renderRoot();
    } else if (view === "slots") {
      renderSlots();
    } else {
      renderConfirm();
    }
  };

  const transitionOut = async (): Promise<number> => {
    const gate = getLoadingGate();
    const startedAt = performance.now();
    // 先黑场：场景在遮罩下重建，转场不会被看到。
    await gate.maskIn(300);
    // 标题层此刻就该让位（否则标题会盖在黑场之上，玩家看到的是静止标题）。
    // 门控在 debugState().visible 上，L4 冒烟据此判定「已进入游戏」。
    root.dataset.visible = "false";
    root.dataset.transitioning = "true";
    showError(null);
    // 场景就绪后再淡出黑场。
    await gate.maskOut(420);
    root.dataset.transitioning = "false";
    return performance.now() - startedAt;
  };

  const run = async (action: () => void | Promise<void> | undefined): Promise<void> => {
    if (busy || handlers === null || !introReady()) {
      return;
    }
    busy = true;
    showError(null);
    try {
      await action();
      await transitionOut();
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  };

  const activateEntry = async (entry: TitleEntry): Promise<void> => {
    if (menu === null) {
      return;
    }
    if (entry === "new-game") {
      if (menu.requireNewGameConfirm) {
        view = "confirm-new-game";
        render();
        return;
      }
      await run(() => handlers?.onNewGame());
      return;
    }
    // 继续游戏：只有自动档时直接读；多档时先出选槽列表。
    if (menu.continueFlow === "pick-slot") {
      view = "slots";
      render();
      return;
    }
    const slotId = menu.defaultSlotId;
    if (slotId === null) {
      showError("没有可读取的存档");
      return;
    }
    await run(() => handlers?.onContinue(slotId));
  };

  const skip = (): void => {
    if (introSkipped) {
      return;
    }
    introSkipped = true;
    finishIntro();
  };

  root.addEventListener("click", skip);
  root.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") {
      skip();
    }
  });

  return {
    present(nextMenu, entries, nextHandlers) {
      const firstPresent = !presented;
      presented = true;
      menu = nextMenu;
      handlers = nextHandlers;
      entriesBySlot = [...entries];
      view = "root";
      introSkipped = false;
      busy = false;
      showError(null);
      root.dataset.visible = "true";
      root.dataset.introMs = String(TITLE_INTRO_MS);
      introStartedAtMs = performance.now();
      // 入场演出只在首次出现时放；游戏内「返回标题」直接出菜单，不重播
      // （重播会平白把玩家再锁 2.4 秒）。
      root.dataset.introReplayed = String(!firstPresent);
      if (!firstPresent) {
        introSkipped = true;
      }
      render();
      // 演出期间按钮先禁用，避免玩家在 logo 还没出现时误点进入。
      lockIntro([...root.querySelectorAll("button")]);
      if (introTimer !== 0) {
        window.clearInterval(introTimer);
      }
      introTimer = window.setInterval(() => {
        if (introReady()) {
          finishIntro();
        }
      }, 100);
    },
    isVisible() {
      return root.dataset.visible === "true";
    },
    debugState() {
      return {
        visible: root.dataset.visible === "true",
        introState: introReady() ? "ready" : "playing",
        view,
        entries: menu?.entries ?? [],
        requireNewGameConfirm: menu?.requireNewGameConfirm ?? false,
        occupiedSlotIds: menu?.occupiedSlotIds ?? [],
        error: lastError,
      };
    },
    skipIntro: skip,
    async transitionOut() {
      return transitionOut();
    },
    dispose() {
      introStartedAtMs = Number.NaN;
      if (introTimer !== 0) {
        window.clearInterval(introTimer);
        introTimer = 0;
      }
      root.remove();
      document.getElementById(STYLE_ID)?.remove();
    },
  };
}
