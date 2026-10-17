/**
 * 商人报价与结算算术（票 33，user story 13）。
 *
 * 纯函数、零引擎依赖：把「商人 NPC 的价格表 + 玩家背包/金币」翻译成
 * 「这次买卖该发生什么」。GameSession 是唯一的写入方，它调用这里算出的
 * 报价后再改背包；表现层（交易面板）也用同一批函数渲染买卖列表，
 * 因此「面板显示的价格」与「实际结算的价格」不可能漂移。
 *
 * 金币口径（票 34）：金币 = 背包物品 item:old_coin 的数量，不是独立字段。
 */

import type { Vec3 } from "./entity";
import type { VendorDefinition } from "./content/types";

/** 金币物品 id（全项目唯一来源）。 */
export const COIN_ITEM_ID = "item:old_coin";

export interface VendorOffer {
  itemId: string;
  /** 商人从玩家手里买下的单价（金币/个）。 */
  sellPrice: number;
  /** 商人卖给玩家的单价（金币/个）。缺省表示不卖。 */
  buyPrice?: number;
}

export interface TradeContext {
  vendor: VendorDefinition;
  /** 玩家背包里每种物品的数量（itemId → 数量）。 */
  inventory: ReadonlyMap<string, number>;
  /** 玩家持有的金币数。 */
  coins: number;
}

/** 交易面板的一行：给表现层直接渲染，字段就是契约。 */
export interface TradeRow {
  itemId: string;
  displayName: string;
  kind: "sell" | "buy";
  /** 单价（金币/个）。 */
  unitPrice: number;
  /** 玩家当前最多能卖出的数量（背包里有多少）。 */
  maxSellQuantity: number;
  /** 玩家当前最多能买进的数量（金币够买几个，受背包该物品堆叠上限约束）。 */
  maxBuyQuantity: number;
  /** 背包该物品已达堆叠上限时为 true（买不进去）。 */
  atMaxStack: boolean;
  /** 是否因金币不足而买不进（maxBuyQuantity === 0 且不是堆叠满）。 */
  broke: boolean;
}

/** 一次报价的结果：ok=false 时 message 是给玩家的友好理由。 */
export interface QuoteResult {
  ok: boolean;
  message?: string;
  /** 实际成交数量（拒绝时为 0）。 */
  quantity: number;
  /** 实际结算的金币数额，正数 = 玩家收到金币，负数 = 玩家付出金币。 */
  coinDelta: number;
}

/** 数量取整：拒绝 0/负数/非有限值，返回 null。 */
function normalizeQuantity(quantity: number): number | null {
  if (!Number.isFinite(quantity)) {
    return null;
  }
  const floored = Math.floor(quantity);
  return floored > 0 ? floored : null;
}

/** 玩家背包里某物品的总量。 */
export function itemCount(inventory: ReadonlyMap<string, number>, itemId: string): number {
  return inventory.get(itemId) ?? 0;
}

/** 卖价（若商人收）。 */
export function sellPriceOf(vendor: VendorDefinition, itemId: string): number | undefined {
  return vendor.sell[itemId];
}

/** 买价（若商人有售）。 */
export function buyPriceOf(vendor: VendorDefinition, itemId: string): number | undefined {
  return vendor.buy[itemId];
}

/**
 * 卖出报价：把战利品换成金币。
 * 卖价必须为正（价格表由 L2 保证为正整数），否则拒绝。
 */
export function quoteSell(
  context: TradeContext,
  itemId: string,
  quantity: number,
): QuoteResult {
  const normalized = normalizeQuantity(quantity);
  if (normalized === null) {
    return { ok: false, message: "数量无效", quantity: 0, coinDelta: 0 };
  }
  const unitPrice = sellPriceOf(context.vendor, itemId);
  if (unitPrice === undefined || unitPrice <= 0) {
    return { ok: false, message: "商人 不收这件东西", quantity: 0, coinDelta: 0 };
  }
  const owned = itemCount(context.inventory, itemId);
  if (owned <= 0) {
    return { ok: false, message: "背包里没有这件东西", quantity: 0, coinDelta: 0 };
  }
  const sold = Math.min(normalized, owned);
  return { ok: true, quantity: sold, coinDelta: sold * unitPrice };
}

/**
 * 买入报价：花金币买东西。
 * 金币不足时按「能负担的件数」下调成交数量（金币为正时至少能买 0 件，
 * 此时 ok=false，message 说明原因）；绝不返回负金币的成交。
 */
export function quoteBuy(
  context: TradeContext,
  itemId: string,
  quantity: number,
  maxStack: number,
): QuoteResult {
  const normalized = normalizeQuantity(quantity);
  if (normalized === null) {
    return { ok: false, message: "数量无效", quantity: 0, coinDelta: 0 };
  }
  const unitPrice = buyPriceOf(context.vendor, itemId);
  if (unitPrice === undefined || unitPrice <= 0) {
    return { ok: false, message: "商人 不卖这件东西", quantity: 0, coinDelta: 0 };
  }
  const stackLimit = Math.max(1, Math.floor(maxStack));
  const owned = itemCount(context.inventory, itemId);
  const room = Math.max(0, stackLimit - owned);
  if (room === 0) {
    return { ok: false, message: "背包里这件东西已经满了", quantity: 0, coinDelta: 0 };
  }
  const wanted = Math.min(normalized, room);
  const affordable = Math.floor(context.coins / unitPrice);
  const bought = Math.min(wanted, affordable);
  if (bought <= 0) {
    return { ok: false, message: "金币不够", quantity: 0, coinDelta: 0 };
  }
  if (bought < wanted) {
    return {
      ok: true,
      quantity: bought,
      coinDelta: -bought * unitPrice,
      message: `金币只够买 ${bought} 件`,
    };
  }
  return { ok: true, quantity: bought, coinDelta: -bought * unitPrice };
}

/** 交易面板的数据源：把价格表展开成买卖两栏的行。 */
export function tradeRows(
  context: TradeContext,
  displayNameOf: (itemId: string) => string,
  maxStackOf: (itemId: string) => number,
): TradeRow[] {
  const rows: TradeRow[] = [];
  const push = (itemId: string, kind: "sell" | "buy", unitPrice: number): void => {
    const owned = itemCount(context.inventory, itemId);
    const maxStack = Math.max(1, Math.floor(maxStackOf(itemId)));
    const room = Math.max(0, maxStack - owned);
    const affordable = unitPrice > 0 ? Math.floor(context.coins / unitPrice) : 0;
    rows.push({
      itemId,
      displayName: displayNameOf(itemId),
      kind,
      unitPrice,
      maxSellQuantity: kind === "sell" ? owned : 0,
      maxBuyQuantity: kind === "buy" ? room : 0,
      atMaxStack: kind === "buy" && room === 0,
      broke: kind === "buy" && room > 0 && affordable <= 0,
    });
  };

  for (const [itemId, price] of Object.entries(context.vendor.sell)) {
    if (price > 0) {
      push(itemId, "sell", price);
    }
  }
  for (const [itemId, price] of Object.entries(context.vendor.buy)) {
    if (price > 0) {
      push(itemId, "buy", price);
    }
  }
  return rows;
}

/** 摊位相对 NPC 的站位（表现层用；对话距离与交互模块一致）。 */
export function vendorStallOffset(): Vec3 {
  return { x: 0, y: 0, z: 1.4 };
}
