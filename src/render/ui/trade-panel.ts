/**
 * 商人交易面板（票 33，user story 13）。
 *
 * 纯 DOM，与 quest-loop-ui.ts 完全独立（那张表被多票同时动，这里不碰）。
 * 风格沿用票 29 的对话面板：半透明深底 + 角色主色描边 + 主色名牌。
 *
 * 价格不在这里算：面板只渲染 `TradeOfferView.rows`（由 GameSession 的
 * vendorOffer 提供），显示价与结算价因此共用同一条报价路径。
 */

import type { TradeOfferView } from "../../logic/game-session";
import type { TradeRow } from "../../logic/trade";

export interface TradeUiOptions {
  mount: HTMLElement;
  /** NPC 主色（色板卡 primary），用于面板描边与名牌。 */
  primaryColor: string;
  /** 卖出：把背包里的东西换成金币。 */
  onSell(itemId: string, quantity: number): void;
  /** 买入：花金币买东西。 */
  onBuy(itemId: string, quantity: number): void;
  /** 关闭面板（结束对话后调用）。 */
  onClose(): void;
}

export interface TradeUi {
  /** 打开（或刷新）面板；offer 为 null 表示无商人。 */
  open(offer: TradeOfferView): void;
  /** 刷新数据（买卖后金币/持有量会变）。 */
  refresh(offer: TradeOfferView): void;
  /** 关闭面板。 */
  close(): void;
  isOpen(): boolean;
  /** 最近一次操作反馈（"卖出了 2 个…" / "金币不够"），供 L4 断言。 */
  lastMessage(): string;
  /** 由调用方写入操作反馈（成交数量/拒绝原因都走这里）。 */
  setMessage(text: string): void;
  dispose(): void;
}

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

const PANEL_STYLE = [
  "position:absolute;left:50%;bottom:12%;transform:translateX(-50%)",
  "display:none;min-width:340px;max-width:460px;pointer-events:auto",
  "padding:14px 18px;border-radius:14px;font:inherit;color:#f8fafc",
  "background:rgba(15,23,42,0.94);border:2px solid currentColor",
  "box-shadow:0 18px 44px rgba(0,0,0,0.5);z-index:2",
].join(";");

const TITLE_STYLE =
  "margin:0 0 4px;font-size:15px;font-weight:700;letter-spacing:0.03em";
const HINT_STYLE = "margin:0 0 10px;font-size:12px;color:#94a3b8";
const COINS_STYLE = "margin:0 0 8px;font-size:13px;color:#fde68a;font-weight:600";
const SECTION_STYLE =
  "margin:8px 0 4px;font-size:12px;font-weight:700;color:#94a3b8;letter-spacing:0.08em";
const ROW_STYLE =
  "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0";
const NAME_STYLE = "font-size:13px";
const PRICE_STYLE = "font-size:12px;color:#cbd5e1";
const MESSAGE_STYLE = "margin:8px 0 0;font-size:12px;color:#94a3b8;min-height:14px";

function buttonStyle(disabled: boolean, color: string): string {
  return [
    "font:inherit;font-size:12px;font-weight:700;padding:4px 12px;border-radius:999px",
    "cursor:pointer;border:1px solid rgba(15,23,42,0.4)",
    disabled ? "opacity:0.45;cursor:not-allowed" : `background:${color};color:#0f172a`,
  ].join(";");
}

function rowKey(row: TradeRow): string {
  return `${row.kind}:${row.itemId}`;
}

export function createTradeUi(options: TradeUiOptions): TradeUi {
  const { mount, primaryColor } = options;

  const panel = element("div", PANEL_STYLE);
  panel.dataset.testid = "trade-panel";
  panel.style.color = primaryColor;

  const title = element("h3", TITLE_STYLE);
  title.dataset.testid = "trade-title";
  const hint = element("p", HINT_STYLE, "卖给商人换金币，或花金币买补给。");
  const coins = element("p", COINS_STYLE);
  coins.dataset.testid = "trade-coins";

  const sellSection = element("div", SECTION_STYLE, "卖出");
  const sellList = element("div", "");
  sellList.dataset.testid = "trade-sell-list";
  const buySection = element("div", SECTION_STYLE, "买入");
  const buyList = element("div", "");
  buyList.dataset.testid = "trade-buy-list";

  const message = element("p", MESSAGE_STYLE);
  message.dataset.testid = "trade-message";

  const close = element(
    "button",
    buttonStyle(false, "#e2e8f0"),
    "离开摊位",
  );
  close.type = "button";
  close.dataset.testid = "trade-close";
  close.style.marginTop = "10px";
  close.addEventListener("click", () => options.onClose());

  panel.append(title, hint, coins, sellSection, sellList, buySection, buyList, message, close);
  mount.append(panel);

  let latest: TradeOfferView | null = null;
  let lastMessage = "";

  const setMessage = (text: string): void => {
    lastMessage = text;
    message.textContent = text;
  };

  const renderList = (container: HTMLElement, rows: TradeRow[], kind: "sell" | "buy"): void => {
    container.textContent = "";
    if (rows.length === 0) {
      container.append(element("p", PRICE_STYLE, "（没有可交易的东西）"));
      return;
    }
    for (const row of rows) {
      const line = element("div", ROW_STYLE, undefined);
      line.dataset.testid = `trade-row-${rowKey(row)}`;
      const label = element("span", NAME_STYLE, row.displayName);
      const price = element(
        "span",
        PRICE_STYLE,
        `${row.unitPrice} 铜币/个${kind === "sell" ? ` · 有 ${row.maxSellQuantity}` : ""}`,
      );
      const disabled = kind === "sell" ? row.maxSellQuantity === 0 : row.maxBuyQuantity === 0;
      const button = element(
        "button",
        buttonStyle(disabled, primaryColor),
        kind === "sell" ? "全卖" : "买 1",
      );
      button.type = "button";
      button.dataset.testid = `trade-button-${rowKey(row)}`;
      button.disabled = disabled;
      button.addEventListener("click", () => {
        // 卖：一次清仓（战利品全卖是最常见意图）；买：一次一件。
        if (kind === "sell") {
          options.onSell(row.itemId, row.maxSellQuantity);
        } else {
          options.onBuy(row.itemId, 1);
        }
      });
      line.append(label, price, button);
      container.append(line);
    }
  };

  const render = (offer: TradeOfferView): void => {
    latest = offer;
    title.textContent = `${offer.displayName} 的摊位`;
    coins.textContent = `你的铜币：${offer.coins}`;
    renderList(
      sellList,
      offer.rows.filter((row) => row.kind === "sell"),
      "sell",
    );
    renderList(
      buyList,
      offer.rows.filter((row) => row.kind === "buy"),
      "buy",
    );
  };

  return {
    open(offer) {
      setMessage("");
      render(offer);
      panel.style.display = "block";
    },
    refresh(offer) {
      if (latest === null || panel.style.display === "none") {
        return;
      }
      render(offer);
    },
    close() {
      panel.style.display = "none";
      latest = null;
    },
    isOpen() {
      return panel.style.display !== "none";
    },
    lastMessage() {
      return lastMessage;
    },
    // 面板不持有金额/价格状态：反馈由调用方（会话结算结果）写进来。
    setMessage,
    dispose() {
      panel.remove();
      latest = null;
    },
  };
}
