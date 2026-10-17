import { describe, expect, it } from "vitest";

import type { VendorDefinition } from "./content/types";
import {
  COIN_ITEM_ID,
  quoteBuy,
  quoteSell,
  tradeRows,
  type TradeContext,
} from "./trade";

const GEL = "item:slime_gel";
const HERB = "item:healing_herb";

const VENDOR: VendorDefinition = {
  sell: { [GEL]: 3 },
  buy: { [HERB]: 15 },
};

function context(inventory: Record<string, number>, coins: number): TradeContext {
  return { vendor: VENDOR, inventory: new Map(Object.entries(inventory)), coins };
}

describe("商人报价（票 33）", () => {
  it("卖凝胶换金币：单价来自价格表", () => {
    const quote = quoteSell(context({ [GEL]: 5 }, 0), GEL, 2);
    expect(quote).toMatchObject({ ok: true, quantity: 2, coinDelta: 6 });
  });

  it("卖出数量超过持有量时按持有量成交，不凭空造凝胶", () => {
    const quote = quoteSell(context({ [GEL]: 1 }, 0), GEL, 9);
    expect(quote).toMatchObject({ ok: true, quantity: 1, coinDelta: 3 });
  });

  it("背包里没有该物品或价格表不收时拒绝", () => {
    expect(quoteSell(context({}, 0), GEL, 1).ok).toBe(false);
    expect(quoteSell(context({ [GEL]: 3 }, 0), HERB, 1).ok).toBe(false);
  });

  it("数量为 0 或负数时拒绝（不产生 0 元成交）", () => {
    expect(quoteSell(context({ [GEL]: 3 }, 0), GEL, 0).ok).toBe(false);
    expect(quoteSell(context({ [GEL]: 3 }, 0), GEL, -3).ok).toBe(false);
  });

  it("买草药扣金币：按价格表单价扣", () => {
    const quote = quoteBuy(context({}, 40), HERB, 2, 9);
    expect(quote).toMatchObject({ ok: true, quantity: 2, coinDelta: -30 });
  });

  it("金币不足时按能负担的件数下调，而不是让金币变负", () => {
    const quote = quoteBuy(context({}, 37), HERB, 5, 9);
    expect(quote).toMatchObject({ ok: true, quantity: 2, coinDelta: -30 });
    expect(quote.message).toContain("金币只够买 2 件");
  });

  it("一枚都买不起时拒绝（金币为 0）", () => {
    const quote = quoteBuy(context({}, 0), HERB, 1, 9);
    expect(quote).toMatchObject({ ok: false, quantity: 0, coinDelta: 0 });
    expect(quote.message).toBe("金币不够");
  });

  it("背包该物品堆叠已满时买不进", () => {
    const quote = quoteBuy(context({ [HERB]: 9 }, 999), HERB, 1, 9);
    expect(quote.ok).toBe(false);
    expect(quote.message).toBe("背包里这件东西已经满了");
  });

  it("买价上限受堆叠余量约束：不会超过 maxStack", () => {
    const quote = quoteBuy(context({ [HERB]: 8 }, 999), HERB, 5, 9);
    expect(quote.quantity).toBe(1);
  });

  it("卖不出的物品买价缺失时拒绝", () => {
    expect(quoteBuy(context({}, 999), GEL, 1, 9).ok).toBe(false);
  });
});

describe("交易面板数据源（票 33）", () => {
  it("买卖两栏分别给出价格与可操作数量，金币不足标记为 broke", () => {
    const rows = tradeRows(
      context({ [GEL]: 4, [HERB]: 9 }, 10),
      (id) => (id === GEL ? "史莱姆凝胶" : "疗伤草"),
      () => 9,
    );
    const sell = rows.find((row) => row.kind === "sell");
    const buy = rows.find((row) => row.kind === "buy");
    expect(sell).toMatchObject({
      itemId: GEL,
      displayName: "史莱姆凝胶",
      unitPrice: 3,
      maxSellQuantity: 4,
      maxBuyQuantity: 0,
    });
    expect(buy).toMatchObject({ itemId: HERB, unitPrice: 15, atMaxStack: true });
  });

  it("金币不够但背包有空间时标记 broke（面板据此禁用按钮）", () => {
    const rows = tradeRows(
      context({}, 5),
      () => "疗伤草",
      () => 9,
    );
    expect(rows.find((row) => row.kind === "buy")).toMatchObject({
      maxBuyQuantity: 9,
      broke: true,
    });
  });

  it("金币本身是物品（item:old_coin），报价不把金币当商品", () => {
    const rows = tradeRows(context({ [COIN_ITEM_ID]: 30 }, 30), () => "旧铜币", () => 999);
    expect(rows.map((row) => row.itemId)).not.toContain(COIN_ITEM_ID);
  });
});
