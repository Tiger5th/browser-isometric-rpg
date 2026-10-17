/**
 * 标题画面的流程装配（票 32）。
 *
 * 把三件事接起来：槽位数据源（票 31 的 `GameSaveSlotService` + IndexedDB）、
 * 入口路由判定（`src/logic/title-menu.ts` 纯函数）、DOM 演出
 * （`title-screen.ts`）。「读档 / 新游戏」的实际动作由调用方注入——
 * main.ts 把它接到 harness 跑 p1-world 上，因此本模块不碰 Babylon。
 */

import { GameSaveSlotService, type SaveSlotId } from "../../logic/save-slots";
import { slotLabel, type SaveSlotEntryView } from "../../logic/save-slot-view";
import { resolveTitleMenu } from "../../logic/title-menu";
import { IndexedDbSaveStorage } from "../persistence/indexed-db-save-storage";
import { createTitleScreen, type TitleScreen } from "./title-screen";

/** 版本号：构建期由 Vite 注入 `package.json` 的 version。 */
const VERSION: string =
  (import.meta.env?.APP_VERSION as string | undefined) ?? "0.0.0";

const LOGO_URLS = import.meta.glob("../../../assets/title/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function assetUrl(suffix: string, fallback: string): string {
  const entry = Object.entries(LOGO_URLS).find(([path]) => path.endsWith(`/${suffix}`));
  return entry?.[1] ?? fallback;
}

export interface TitleFlowHandlers {
  /** 继续游戏：读指定槽位后进入游戏。失败抛出，由标题画面留在原地提示。 */
  onContinue(slotId: SaveSlotId): void | Promise<void>;
  /** 新游戏：丢弃旧进度、以初始状态进入游戏。 */
  onNewGame(): void | Promise<void>;
}

export interface TitleFlow {
  /** 读槽位并渲染入口 + 开始入场演出。 */
  show(): Promise<void>;
  /** 游戏内「返回标题」：关掉游戏 HUD，重新出标题画面。 */
  hide(): void;
  /** 标题画面实例（调试/L4 冒烟直接读它的 debugState）。 */
  readonly screen: TitleScreen;
  dispose(): void;
}

/** logo/背景资源 URL（vitest/node 下无 import.meta.glob，退回相对路径）。 */
export function titleAssetUrls(): { logo: string; background: string } {
  return {
    logo: assetUrl("logo.png", "assets/title/logo.png"),
    background: assetUrl("title-background.png", ""),
  };
}

export function gameVersion(): string {
  return VERSION;
}

export function createTitleFlow(
  mount: HTMLElement,
  handlers: TitleFlowHandlers,
  service: GameSaveSlotService = new GameSaveSlotService(new IndexedDbSaveStorage()),
): TitleFlow {
  const urls = titleAssetUrls();
  const screen = createTitleScreen({
    mount,
    version: VERSION,
    logoUrl: urls.logo,
    backgroundUrl: urls.background === "" ? undefined : urls.background,
  });

  return {
    async show() {
      const entries = (await service.listSlots()).map<SaveSlotEntryView>((entry) => ({
        slotId: entry.slotId,
        label: slotLabel(entry.slotId),
        meta: entry.meta,
        snapshot: entry.snapshot,
      }));
      const menu = resolveTitleMenu(
        entries.map((entry) => ({ slotId: entry.slotId, occupied: entry.meta !== null })),
      );
      screen.present(menu, entries, {
        onContinue: (slotId) => handlers.onContinue(slotId),
        onNewGame: () => handlers.onNewGame(),
      });
    },
    hide() {
      // 标题层走黑场淡出（与进入游戏同一基建），结束后才摘掉。
      void screen.transitionOut();
    },
    screen,
    dispose() {
      screen.dispose();
    },
  };
}
