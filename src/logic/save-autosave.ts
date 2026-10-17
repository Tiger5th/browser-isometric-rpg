/**
 * 自动存档（票 31）。
 *
 * 触发时机（spec「存储」节）：区域切换 + 任务状态变化 + 获得重要物品，
 * 外加 `beforeunload` 兜底。**不做定时器**——定时自动存档会让玩家
 * 在战斗中存进一个「正在挨打」的进度点，反而更迷惑。
 *
 * 逻辑层零浏览器依赖：卸载回调的注册/注销由调用方通过 `attachBeforeUnload`
 * 注入（渲染层传 `window.addEventListener`），因此本模块可被 vitest 直接测。
 *
 * 自动存档**永不抛错**：存档失败（配额满/隐私模式）不该打断游戏，
 * 错误一律交给 `onError`。
 */

import type { GameSessionSnapshot } from "./game-session";
import type { GameSessionEvent } from "./game-events";
import { AUTO_SLOT_ID } from "./save-slots";

/** 卸载监听器注册器（渲染层注入 window，测试注入捕获函数）。 */
export type BeforeUnloadRegistrar = (handler: () => void) => () => void;

export interface GameSaveAutoSaverOptions {
  /** 取当前快照；渲染层传 `() => session.snapshot()`。 */
  getSnapshot(): GameSessionSnapshot;
  /** 写自动槽；渲染层传槽位服务的 writeSlot("auto", ...)。 */
  writeAutoSlot(
    slotId: typeof AUTO_SLOT_ID,
    snapshot: GameSessionSnapshot,
  ): Promise<unknown>;
  /**
   * 读自动槽（票 37）。场景启动时必须**先读后写**：
   * 拿不到已有进度就直接 notifyRegionChanged()，会用空快照盖掉玩家的世界事实。
   * 缺省（不注入）时视为「没有自动槽」。
   */
  readAutoSlot?(): Promise<GameSessionSnapshot | null>;
  /** 把自动槽快照写回会话（渲染层传 `session.restoreSnapshot`）。 */
  restoreSnapshot?(snapshot: GameSessionSnapshot): void;
  /** 自动存档失败时的通报（默认静默吞掉）。 */
  onError?(error: unknown): void;
}

/** 触发自动存档的事件类型。 */
const TRIGGERING_EVENTS = new Set<GameSessionEvent["type"]>([
  // 任务状态变化：接取 / 达成 / 完成。
  "quest-accepted",
  "quest-ready",
  "quest-completed",
  // 获得重要物品：掉落、任务奖励、购买、宝箱 loot 都走这条事件。
  "item-gained",
]);

export class GameSaveAutoSaver {
  private readonly options: GameSaveAutoSaverOptions;
  /** 上次写档时的区域 id；null = 还没写过。 */
  private lastSavedRegionId: string | null | undefined;
  private detachUnload: (() => void) | null = null;
  /** 最近一次处理过的事件签名，用于去重。 */
  private lastEventSignature: string | null = null;

  constructor(options: GameSaveAutoSaverOptions) {
    this.options = options;
  }

  /**
   * 处理一条会话事件；触发自动存档时返回写入的 Promise（否则 null）。
   * 渲染层可 `void auto.handleEvent(event)` 挂在 `session.subscribe` 上。
   */
  handleEvent(event: GameSessionEvent): Promise<unknown> | null {
    if (!TRIGGERING_EVENTS.has(event.type)) {
      return null;
    }
    const signature = this.signatureOf(event);
    if (signature === this.lastEventSignature) {
      // 同一事件重放（读档后的事件重放、测试里重复投递）不重复写盘。
      return null;
    }
    this.lastEventSignature = signature;
    return this.saveNow();
  }

  /**
   * 区域切换后调用：只有区域与上次写档不同时才写。
   * 首次调用（从未写档）也会写一次，保证自动槽开局就有一个可用进度点。
   */
  async notifyRegionChanged(): Promise<void> {
    const regionId = this.options.getSnapshot().regionId;
    if (this.lastSavedRegionId !== undefined && this.lastSavedRegionId === regionId) {
      return;
    }
    await this.saveNow();
  }

  /** 注册卸载兜底；返回的 detach 通过 detachBeforeUnload() 调用。 */
  attachBeforeUnload(registrar: BeforeUnloadRegistrar): void {
    this.detachBeforeUnload();
    this.detachUnload = registrar(() => {
      this.saveOnUnload();
    });
  }

  detachBeforeUnload(): void {
    this.detachUnload?.();
    this.detachUnload = null;
  }

  /**
   * 卸载兜底写入。IndexedDB 的事务在页面卸载期间仍会提交，
   * 所以这里**发起**写入即可，不等它结算；任何异常就地吞掉
   * （unload 回调里抛错对玩家毫无意义，只会在控制台留噪声）。
   */
  private saveOnUnload(): void {
    try {
      void this.options.writeAutoSlot(AUTO_SLOT_ID, this.options.getSnapshot()).catch(
        () => undefined,
      );
      this.lastSavedRegionId = this.options.getSnapshot().regionId;
    } catch {
      // 会话已经拆掉（场景切换中卸载）也属正常。
    }
  }

  /**
   * 自动槽里是否已有可用进度（票 37）。
   * 读取失败按「没有进度」处理：宁可开局从零写一次，也不让脏存档卡住场景。
   */
  async hasAutoSnapshot(): Promise<boolean> {
    if (this.options.readAutoSlot === undefined) {
      return false;
    }
    try {
      return (await this.options.readAutoSlot()) !== null;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  /**
   * 把自动槽的快照恢复进会话（票 37）。
   * 返回是否真的恢复了；恢复成功后同时记住区域 id，避免紧接着的
   * notifyRegionChanged 把刚读回来的档又覆盖一遍。
   */
  async restoreAuto(): Promise<boolean> {
    const { readAutoSlot, restoreSnapshot } = this.options;
    if (readAutoSlot === undefined || restoreSnapshot === undefined) {
      return false;
    }
    try {
      const snapshot = await readAutoSlot();
      if (snapshot === null) {
        return false;
      }
      restoreSnapshot(snapshot);
      this.lastSavedRegionId = snapshot.regionId;
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private saveNow(): Promise<unknown> {
    let snapshot: GameSessionSnapshot;
    try {
      snapshot = this.options.getSnapshot();
    } catch (error) {
      this.report(error);
      return Promise.resolve();
    }
    this.lastSavedRegionId = snapshot.regionId;
    return this.options
      .writeAutoSlot(AUTO_SLOT_ID, snapshot)
      .catch((error: unknown) => this.report(error));
  }

  private report(error: unknown): void {
    const onError = this.options.onError;
    if (onError === undefined) {
      return;
    }
    try {
      onError(error);
    } catch {
      // 错误通报本身失败不再上抛。
    }
  }

  private signatureOf(event: GameSessionEvent): string {
    switch (event.type) {
      case "quest-accepted":
      case "quest-ready":
      case "quest-completed":
        return `${event.type}:${event.questId}`;
      case "item-gained":
        return `${event.type}:${event.entityId}:${event.itemId}:${event.quantity}`;
      default:
        return event.type;
    }
  }
}