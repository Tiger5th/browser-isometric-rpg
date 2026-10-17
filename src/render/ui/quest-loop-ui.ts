/**
 * 游戏 HUD + 背包/装备面板（纯 DOM，挂在 Harness 页面上）。
 *
 * 只消费 GameSession.snapshot()：HP/经验/攻击/防御、任务进度、背包物品与装备栏。
 * 使用/装备/对话选择都通过回调提交意图，UI 不持有也不修改任何游戏逻辑状态。
 * 唯一由 UI 自己保存的是面板开关（inventoryOpen）这类纯展示状态。
 */

import type { ContentBundle, ItemDefinition } from "../../logic/content/types";
import type { LevelCurveDefinition } from "../../logic/leveling";
import { levelHudView } from "./level-hud";
import type {
  GameSessionSnapshot,
  IntentResult,
} from "../../logic/game-session";
import type { QuestStatus } from "../../logic/quest";

export interface QuestLoopUiOptions {
  mount: HTMLElement;
  bundle: ContentBundle;
  /** 玩家点击对话选项。 */
  onChoose(choiceIndex: number): IntentResult | void;
  /** 使用消耗品（提交 useItem 意图）。 */
  onUseItem?(instanceId: string): IntentResult | void;
  /** 装备物品（提交 equip 意图）。 */
  onEquipItem?(instanceId: string): IntentResult | void;
  /** 卸下装备（提交 unequip 意图）。 */
  onUnequipItem?(instanceId: string): IntentResult | void;
  /** 调试战斗入口：用真实战斗攻击最近的敌人（方便手动验证任务进度）。 */
  onDebugKill?(): IntentResult | void;
  /**
   * 票 29：对话改由 galgame 立绘 UI（dialogue-portrait.ts）呈现时为 true；
   * 旧对话框面板不再渲染，避免两套 UI 叠加。
   */
  usePortraitDialogue?: boolean;
  /**
   * 等级曲线（票 34）。HUD 只用它换算等级徽标与经验条，不持有任何逻辑状态；
   * 缺省时回退到玩家实体属性上的 level / xpToNext。
   */
  levelCurve?: LevelCurveDefinition;
  /**
   * 重击技能（票 27）：对当前选中/最近敌人发起重击意图。
   * HUD 只负责把冷却剩余显示成转圈，不持有任何逻辑状态。
   */
  onHeavyAttack?(): IntentResult | void;
  /** 手动存档。 */
  onSave?(): void;
  /** 手动读档。 */
  onLoad?(): void;
  /** 删除存档。 */
  onClearSave?(): void;
  /**
   * 票 32：返回标题画面。
   * HUD 只抛出意图——黑场过场与标题重挂由 main.ts 的标题流程负责。
   */
  onBackToTitle?(): void;
}

export type SaveStatusKind = "idle" | "ok" | "error";

export interface QuestLoopUi {
  update(snapshot: GameSessionSnapshot): void;
  /** 存档/读档结果反馈（右下角 HUD 的持久化状态行）。 */
  setSaveStatus(text: string, kind?: SaveStatusKind): void;
  dispose(): void;
}

const SAVE_STATUS_COLOR: Record<SaveStatusKind, string> = {
  idle: "#94a3b8",
  ok: "#4ade80",
  error: "#f87171",
};

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

const KIND_LABEL: Record<ItemDefinition["kind"], string> = {
  equipment: "装备",
  consumable: "消耗品",
  misc: "杂项",
};

const SLOT_LABEL: Record<"weapon" | "armor" | "accessory", string> = {
  weapon: "武器",
  armor: "护甲",
  accessory: "饰品",
};

const BUTTON_STYLE = [
  "cursor:pointer;font:inherit;font-size:11px",
  "color:#e6e9ef;border:1px solid rgba(148,163,184,0.35);border-radius:8px",
  "background:#1a2230;padding:6px 8px;",
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

function button(label: string, action: string, handler: () => void): HTMLButtonElement {
  const node = element("button", BUTTON_STYLE, label);
  node.type = "button";
  node.dataset.action = action;
  node.addEventListener("click", handler);
  return node;
}

function modifierSummary(definition: ItemDefinition): string {
  if (definition.kind !== "equipment") {
    return "";
  }
  return definition.equipment.modifiers
    .map((modifier) => {
      if (modifier.operation === "add") {
        return `${modifier.attribute} +${modifier.value}`;
      }
      return `${modifier.attribute} +${Math.round(modifier.value * 100)}%`;
    })
    .join("，");
}

export function createQuestLoopUi(options: QuestLoopUiOptions): QuestLoopUi {
  const { mount, bundle } = options;
  const enemyNames = new Map(
    bundle.enemyTemplates.map((template) => [template.id, template.displayName]),
  );
  const itemDefinitions = new Map(bundle.items.map((item) => [item.id, item]));

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
  hud.dataset.testid = "quest-hud";

  const inventory = element(
    "section",
    [
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)",
      "width:min(480px,calc(100vw - 32px));max-height:min(72vh,640px);overflow:auto",
      "pointer-events:auto;display:none",
      "padding:16px 18px;border:1px solid rgba(251,191,36,0.4);border-radius:14px",
      "background:rgba(12,18,26,0.96);backdrop-filter:blur(12px);color:#e6e9ef",
      "box-shadow:0 24px 64px rgba(0,0,0,0.6);font-size:13px;line-height:1.55",
    ].join(";"),
  );
  inventory.dataset.testid = "inventory-panel";

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
  dialogue.dataset.testid = "dialogue-panel";

  root.append(hud, inventory, dialogue);
  mount.append(root);

  const saveStatus = element(
    "div",
    "margin-top:8px;font-size:11px;line-height:1.45;color:#94a3b8;",
    "存档：未检查",
  );
  saveStatus.dataset.testid = "save-status";
  saveStatus.dataset.state = "idle";

  let lastKey = "";
  let inventoryOpen = false;
  let currentSnapshot: GameSessionSnapshot | null = null;

  const setSaveStatus = (text: string, kind: SaveStatusKind = "idle"): void => {
    saveStatus.textContent = text;
    saveStatus.dataset.state = kind;
    saveStatus.style.color = SAVE_STATUS_COLOR[kind];
  };

  /**
   * 统一包装 UI 意图提交：
   * - DOM 事件处理器里绝不让异常逃逸成 uncaught error；
   * - 意图层返回 IntentResult 时，把友好拒绝显示到状态行；
   * - 10Hz 快照过期导致的「物品已用完 / 对话已结束」也走同一条提示路径。
   */
  const submit = (action: () => IntentResult | void): void => {
    try {
      const result = action();
      if (result !== undefined && !result.ok) {
        setSaveStatus(`操作未生效：${result.message ?? "未知原因"}`, "error");
      }
    } catch (error) {
      setSaveStatus(
        `操作失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const renderInventory = (snapshot: GameSessionSnapshot): void => {
    inventory.style.display = inventoryOpen ? "block" : "none";
    if (!inventoryOpen) {
      return;
    }
    inventory.replaceChildren();

    const header = element(
      "div",
      "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;",
    );
    header.append(
      element("strong", "font-size:14px;color:#fbbf24;letter-spacing:0.04em;", "背包"),
      element("span", "font-size:11px;color:#94a3b8;", "按 I 或 Esc 关闭"),
    );
    const closeButton = button("关闭", "close-inventory", () => toggleInventory());
    closeButton.dataset.testid = "inventory-close";
    header.append(closeButton);
    inventory.append(header);

    const player = snapshot.entities.find(
      (entity) => entity.identity.type === "player",
    );
    if (player === undefined) {
      inventory.append(element("div", "color:#94a3b8;", "没有玩家实体。"));
      return;
    }

    // 装备栏：三个槽位常驻，已装备的显示名称与修饰器摘要。
    const slots = element("div", "display:flex;gap:6px;margin-bottom:12px;");
    slots.dataset.testid = "equipment-slots";
    for (const slot of ["weapon", "armor", "accessory"] as const) {
      const equipped = player.container.items.find((item) => {
        if (!item.equipped) {
          return false;
        }
        const definition = itemDefinitions.get(item.templateId);
        return definition?.kind === "equipment" && definition.equipment.slot === slot;
      });
      const definition =
        equipped === undefined ? undefined : itemDefinitions.get(equipped.templateId);
      const cell = element(
        "div",
        [
          "flex:1;min-width:0;padding:7px 8px;border-radius:8px",
          "border:1px solid rgba(148,163,184,0.22);background:#141c28;",
        ].join(";"),
      );
      cell.dataset.testid = "equipment-slot";
      cell.dataset.slot = slot;
      cell.dataset.itemId = equipped?.templateId ?? "";
      cell.append(
        element("div", "font-size:10px;color:#94a3b8;", SLOT_LABEL[slot]),
        element(
          "div",
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
          definition?.displayName ?? "—",
        ),
      );
      if (definition !== undefined) {
        cell.title = modifierSummary(definition);
        cell.append(
          element("div", "font-size:10px;color:#7dd3fc;", modifierSummary(definition)),
        );
      }
      slots.append(cell);
    }
    inventory.append(slots);

    const count = element(
      "div",
      "font-size:11px;color:#94a3b8;margin-bottom:6px;",
      `物品 ${player.container.items.length} 组`,
    );
    count.dataset.testid = "inventory-count";
    count.dataset.count = String(player.container.items.length);
    inventory.append(count);

    if (player.container.items.length === 0) {
      const empty = element(
        "div",
        "padding:16px 0;color:#94a3b8;text-align:center;",
        "背包是空的。",
      );
      empty.dataset.testid = "inventory-empty";
      inventory.append(empty);
      return;
    }

    const list = element("div", "display:flex;flex-direction:column;gap:6px;");
    list.dataset.testid = "inventory-list";
    for (const item of player.container.items) {
      const definition = itemDefinitions.get(item.templateId);
      const row = element(
        "div",
        [
          "display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:9px",
          "border:1px solid rgba(148,163,184,0.2);background:#141c28;",
        ].join(";"),
      );
      row.dataset.testid = "inventory-item";
      row.dataset.instanceId = item.instanceId;
      row.dataset.templateId = item.templateId;
      row.dataset.kind = definition?.kind ?? "unknown";
      row.dataset.equipped = item.equipped ? "true" : "false";

      const info = element("div", "flex:1;min-width:0;");
      const title = element(
        "div",
        "display:flex;align-items:center;gap:6px;font-weight:600;",
      );
      title.append(
        element("span", "", definition?.displayName ?? item.templateId),
        element("span", "color:#94a3b8;font-weight:400;", `×${item.quantity}`),
      );
      if (item.equipped) {
        title.append(
          element(
            "span",
            "font-size:10px;color:#4ade80;border:1px solid rgba(74,222,128,0.4);border-radius:6px;padding:0 4px;",
            "已装备",
          ),
        );
      }
      const meta =
        definition === undefined
          ? "未知物品定义"
          : [
              KIND_LABEL[definition.kind],
              definition.kind === "equipment"
                ? `${SLOT_LABEL[definition.equipment.slot]} · ${modifierSummary(definition)}`
                : definition.description,
            ].join(" · ");
      info.append(title, element("div", "font-size:11px;color:#94a3b8;", meta));
      row.append(info);

      if (definition?.kind === "consumable" && options.onUseItem !== undefined) {
        const useButton = button("使用", "use", () =>
          submit(() => options.onUseItem?.(item.instanceId)),
        );
        useButton.dataset.instanceId = item.instanceId;
        useButton.dataset.testid = "inventory-use";
        row.append(useButton);
      }
      if (definition?.kind === "equipment") {
        if (item.equipped && options.onUnequipItem !== undefined) {
          const unequipButton = button("卸下", "unequip", () =>
            submit(() => options.onUnequipItem?.(item.instanceId)),
          );
          unequipButton.dataset.instanceId = item.instanceId;
          unequipButton.dataset.testid = "inventory-unequip";
          row.append(unequipButton);
        } else if (!item.equipped && options.onEquipItem !== undefined) {
          const equipButton = button("装备", "equip", () =>
            submit(() => options.onEquipItem?.(item.instanceId)),
          );
          equipButton.dataset.instanceId = item.instanceId;
          equipButton.dataset.testid = "inventory-equip";
          row.append(equipButton);
        }
      }
      list.append(row);
    }
    inventory.append(list);
  };

  const renderHud = (snapshot: GameSessionSnapshot): void => {
    hud.replaceChildren();
    hud.append(
      element(
        "div",
        "font-size:13px;font-weight:700;letter-spacing:0.04em;color:#7dd3fc;margin-bottom:8px;",
        "状态",
      ),
    );

    const player = snapshot.entities.find(
      (entity) => entity.identity.type === "player",
    );

    if (player !== undefined) {
      const hp = Math.round(player.combat.hp);
      const maxHp = Math.round(player.combat.maxHp);
      const hpRatio = maxHp > 0 ? Math.min(1, Math.max(0, hp / maxHp)) : 0;
      // 票 34：等级/经验条的换算收敛到 levelHudView，HUD 只负责搭 DOM。
      const level = levelHudView(
        {
          xp: player.attributes.xp ?? player.baseAttributes.xp ?? 0,
          level: player.baseAttributes.level,
          xpToNext: player.attributes.xpToNext ?? player.baseAttributes.xpToNext,
        },
        options.levelCurve,
      );

      const stats = element("div", "");
      stats.dataset.testid = "hud-attributes";

      const hpRow = element(
        "div",
        "display:flex;justify-content:space-between;font-weight:600;",
      );
      const hpText = element("span", "", `HP ${hp} / ${maxHp}`);
      hpText.dataset.testid = "hud-hp";
      hpText.dataset.hp = String(hp);
      hpText.dataset.maxHp = String(maxHp);
      const levelBadge = element(
        "span",
        "color:#fbbf24;font-weight:700;margin-right:8px;",
        level.badge,
      );
      levelBadge.dataset.testid = "hud-level";
      levelBadge.dataset.level = String(level.level);
      const xpText = element("span", "color:#fbbf24;", level.xpText);
      xpText.dataset.testid = "hud-xp";
      xpText.dataset.xp = String(level.xp);
      if (level.xpToNext !== null) {
        xpText.dataset.xpToNext = String(level.xpToNext);
      }
      hpRow.append(hpText, levelBadge, xpText);

      const bar = element(
        "div",
        "height:7px;margin:5px 0 8px;border-radius:999px;background:rgba(148,163,184,0.22);overflow:hidden;",
      );
      const fill = element(
        "div",
        `height:100%;width:${(hpRatio * 100).toFixed(1)}%;border-radius:999px;background:linear-gradient(90deg,#ef4444,#f59e0b);transition:width 120ms linear;`,
      );
      fill.dataset.testid = "hud-hp-fill";
      bar.append(fill);

      const xpBar = element(
        "div",
        "height:5px;margin-bottom:8px;border-radius:999px;background:rgba(148,163,184,0.22);overflow:hidden;",
      );
      xpBar.dataset.testid = "hud-xp-bar";
      const xpFill = element(
        "div",
        `height:100%;width:${(level.xpRatio * 100).toFixed(1)}%;border-radius:999px;background:linear-gradient(90deg,#38bdf8,#a78bfa);transition:width 120ms linear;`,
      );
      xpFill.dataset.testid = "hud-xp-fill";
      xpBar.append(xpFill);

      const attack = Math.round(player.attributes.attack ?? 0);
      const defense = Math.round(player.attributes.defense ?? 0);
      const combatRow = element("div", "display:flex;gap:12px;color:#cbd5e1;");
      const attackText = element("span", "", `攻击 ${attack}`);
      attackText.dataset.testid = "hud-attack";
      attackText.dataset.attack = String(attack);
      const defenseText = element("span", "", `防御 ${defense}`);
      defenseText.dataset.testid = "hud-defense";
      defenseText.dataset.defense = String(defense);
      combatRow.append(attackText, defenseText);

      stats.append(hpRow, bar, xpBar, combatRow);
      hud.append(stats);
    }

    hud.append(
      element(
        "div",
        "font-size:13px;font-weight:700;letter-spacing:0.04em;color:#7dd3fc;margin:12px 0 8px;",
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

    const toggleRow = element("div", "display:flex;margin-top:10px;");
    const toggle = button("背包 (I)", "toggle-inventory", () => toggleInventory());
    toggle.dataset.testid = "inventory-toggle";
    toggle.style.width = "100%";
    toggle.style.background = "#233044";
    toggle.style.borderColor = "rgba(251,191,36,0.45)";
    toggleRow.append(toggle);
    hud.append(toggleRow);

    if (options.onSave !== undefined || options.onLoad !== undefined) {
      const row = element("div", "display:flex;gap:6px;margin-top:8px;");
      const addSaveButton = (
        label: string,
        action: string,
        handler: (() => void) | undefined,
      ): void => {
        if (handler === undefined) {
          return;
        }
        const node = button(label, action, () => submit(handler));
        node.style.flex = "1";
        row.append(node);
      };
      addSaveButton("存档", "save", options.onSave);
      addSaveButton("读档", "load", options.onLoad);
      addSaveButton("删除存档", "clear-save", options.onClearSave);
      hud.append(row);
    }

    // 票 32：返回标题画面（黑场过场由标题流程做，这里只抛意图）。
    if (options.onBackToTitle !== undefined) {
      const backButton = button("返回标题", "back-to-title", () => {
        submit(options.onBackToTitle ?? (() => undefined));
      });
      backButton.dataset.testid = "back-to-title-button";
      backButton.style.cssText += "width:100%;margin-top:8px;background:#233044;";
      hud.append(backButton);
    }

    if (options.onHeavyAttack !== undefined) {
      // 重击技能按钮：冷却转圈 + 剩余秒数。数据全部来自快照，
      // 冷却状态由逻辑层的重击冷却推进，UI 不自行计时。
      const heavyCooldownMs = Math.max(0, Math.round(player?.combat.heavyCooldownMs ?? 0));
      const ready = heavyCooldownMs <= 0;
      const skillRow = element(
        "div",
        "display:flex;align-items:center;gap:8px;margin-top:8px;",
      );
      const skillButton = button(
        ready ? "重击 (1.5×)" : `重击 ${(heavyCooldownMs / 1000).toFixed(1)}s`,
        "heavy-attack",
        () => submit(() => options.onHeavyAttack?.()),
      );
      skillButton.dataset.testid = "heavy-attack-button";
      skillButton.dataset.ready = ready ? "true" : "false";
      skillButton.dataset.cooldownMs = String(heavyCooldownMs);
      skillButton.disabled = !ready;
      if (!ready) {
        skillButton.style.opacity = "0.55";
      }
      skillButton.style.flex = "1";
      skillButton.style.background = "#2a1f3d";
      skillButton.style.borderColor = ready
        ? "rgba(167,139,250,0.65)"
        : "rgba(148,163,184,0.3)";
      skillRow.append(skillButton);

      // 冷却转圈：conic-gradient 覆盖层，按剩余比例遮住底部。
      const dial = element(
        "div",
        [
          "position:relative;width:26px;height:26px;border-radius:999px;flex:none",
          "background:conic-gradient(#a78bfa 0turn, #a78bfa var(--ready-turn,0turn),",
          "rgba(148,163,184,0.25) var(--ready-turn,0turn))",
        ].join(" "),
      );
      dial.dataset.testid = "heavy-attack-dial";
      dial.style.setProperty(
        "--ready-turn",
        `${(Math.min(1, heavyCooldownMs / 8000) * 1).toFixed(3)}turn`,
      );
      dial.style.opacity = ready ? "0.35" : "1";
      skillRow.append(dial);
      hud.append(skillRow);
    }

    if (options.onDebugKill !== undefined) {
      const debugButton = button(
        "调试：攻击最近的史莱姆（走真实战斗）",
        "debug-kill",
        () => submit(() => options.onDebugKill?.()),
      );
      debugButton.style.marginTop = "10px";
      debugButton.style.width = "100%";
      hud.append(debugButton);
    }

    hud.append(saveStatus);
  };

  const renderDialogue = (snapshot: GameSessionSnapshot): void => {
    // 票 29：galgame 立绘 UI（dialogue-portrait.ts）接管对话呈现，
    // 这里只在不使用立绘的场景（dialogue-quest 等验证场景）渲染旧面板，
    // 避免两套对话框叠加。
    if (options.usePortraitDialogue === true) {
      dialogue.style.display = "none";
      return;
    }
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
        const choiceButton = element(
          "button",
          [
            "text-align:left;cursor:pointer;font:inherit;font-size:13px",
            "color:#e6e9ef;border:1px solid rgba(125,211,252,0.3);border-radius:8px",
            "background:#16202e;padding:8px 10px;",
          ].join(";"),
          choice,
        );
        choiceButton.type = "button";
        choiceButton.dataset.choiceIndex = String(index);
        choiceButton.addEventListener("click", () =>
          submit(() => options.onChoose(index)),
        );
        list.append(choiceButton);
      });
      dialogue.append(list);
    }
  };

  const renderAll = (snapshot: GameSessionSnapshot): void => {
    currentSnapshot = snapshot;
    renderHud(snapshot);
    renderInventory(snapshot);
    renderDialogue(snapshot);
  };

  const toggleInventory = (): void => {
    inventoryOpen = !inventoryOpen;
    lastKey = "";
    if (currentSnapshot !== null) {
      renderAll(currentSnapshot);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "i" || event.key === "I") {
      event.preventDefault();
      toggleInventory();
      return;
    }
    if (event.key === "Escape" && inventoryOpen) {
      event.preventDefault();
      toggleInventory();
    }
  };
  window.addEventListener("keydown", onKeyDown);

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
        hp: player?.combat.hp ?? null,
        maxHp: player?.combat.maxHp ?? null,
        attack: player?.attributes.attack ?? null,
        defense: player?.attributes.defense ?? null,
        xp: player?.attributes.xp ?? null,
        items: player?.container.items ?? [],
        inventoryOpen,
      });
      if (key === lastKey) {
        return;
      }
      lastKey = key;
      renderAll(snapshot);
    },

    setSaveStatus,

    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
