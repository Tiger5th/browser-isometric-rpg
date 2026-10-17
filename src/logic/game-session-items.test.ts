import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { GameSession, type GameSessionSnapshot } from "./game-session";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";
const LOOTER_ID = "enemy:looter";
const TANK_ID = "enemy:tank";

const SWORD_ID = "item:traveler_sword";
const HERB_ID = "item:healing_herb";
const ARMOR_ID = "item:iron_armor";
const MIXED_ID = "item:mixed_elixir";
const BOOTS_ID = "item:swift_boots";

/**
 * 最小内容集：一只一击必杀的掉落怪，一只耐打的高攻怪（用来让玩家掉血）。
 * 掉落必定命中且数量固定，测试不依赖随机序列。
 */
function itemsBundle(): ContentBundle {
  return {
    regions: [
      {
        id: REGION_ID,
        displayName: "竞技场",
        asset: { model: "assets/regions/arena.glb" },
        player: {
          id: PLAYER_ID,
          templateId: "player_template:hero",
          displayName: "旅人",
          spawn: { position: { x: 0, y: 0, z: 0 } },
          baseAttributes: {
            maxHp: 100,
            hp: 100,
            attack: 12,
            defense: 4,
            moveSpeed: 5.5,
          },
        },
      },
    ],
    npcs: [],
    enemyTemplates: [
      {
        id: "enemy_template:looter",
        displayName: "掉落怪",
        aiProfileId: "ai:melee_chaser",
        baseAttributes: {
          maxHp: 5,
          hp: 5,
          attack: 0,
          defense: 0,
          moveSpeed: 0,
          xp: 10,
        },
        drops: [
          { itemId: SWORD_ID, chance: 1, min: 2, max: 2 },
          { itemId: HERB_ID, chance: 1, min: 2, max: 2 },
          { itemId: ARMOR_ID, chance: 1, min: 1, max: 1 },
          { itemId: MIXED_ID, chance: 1, min: 1, max: 1 },
          { itemId: BOOTS_ID, chance: 1, min: 1, max: 1 },
        ],
      },
      {
        id: "enemy_template:tank",
        displayName: "高攻怪",
        aiProfileId: "ai:melee_chaser",
        baseAttributes: {
          maxHp: 1000,
          hp: 1000,
          attack: 10,
          defense: 0,
          moveSpeed: 3,
          xp: 0,
        },
      },
    ],
    enemies: [
      {
        id: LOOTER_ID,
        templateId: "enemy_template:looter",
        displayName: "掉落怪",
        regionId: REGION_ID,
        position: { x: 1.5, y: 0, z: 0 },
      },
      {
        id: TANK_ID,
        templateId: "enemy_template:tank",
        displayName: "高攻怪",
        regionId: REGION_ID,
        position: { x: 3, y: 0, z: 0 },
      },
    ],
    items: [
      {
        id: SWORD_ID,
        displayName: "旅人短剑",
        kind: "equipment",
        description: "轻便的短剑。",
        maxStack: 1,
        equipment: {
          slot: "weapon",
          modifiers: [{ attribute: "attack", operation: "add", value: 5 }],
        },
      },
      {
        id: HERB_ID,
        displayName: "疗伤草",
        kind: "consumable",
        description: "恢复生命。",
        maxStack: 9,
        consumable: {
          effects: [{ type: "restore", attribute: "hp", amount: 30 }],
        },
      },
      {
        id: BOOTS_ID,
        displayName: "疾行靴",
        kind: "equipment",
        description: "提高移动速度。",
        maxStack: 1,
        equipment: {
          slot: "accessory",
          modifiers: [{ attribute: "moveSpeed", operation: "add", value: 5.5 }],
        },
      },
      {
        id: MIXED_ID,
        displayName: "混合药水",
        kind: "consumable",
        description: "同时恢复生命与法力（法力暂不支持）。",
        maxStack: 9,
        consumable: {
          effects: [
            { type: "restore", attribute: "hp", amount: 30 },
            { type: "restore", attribute: "mp", amount: 30 },
          ],
        },
      },
      {
        id: ARMOR_ID,
        displayName: "铁甲",
        kind: "equipment",
        description: "结实的护甲。",
        maxStack: 1,
        equipment: {
          slot: "armor",
          modifiers: [{ attribute: "maxHp", operation: "add", value: 10 }],
        },
      },
    ],
    quests: [],
  };
}

function createSession(): GameSession {
  const session = new GameSession({ random: () => 0 });
  session.loadRegion(itemsBundle(), REGION_ID);
  return session;
}

function snapshotOf(session: GameSession): GameSessionSnapshot {
  return session.snapshot();
}

function playerOf(session: GameSession) {
  const player = snapshotOf(session).entities.find(
    (entity) => entity.identity.type === "player",
  );
  if (player === undefined) {
    throw new Error("快照中缺少玩家");
  }
  return player;
}

function killLooter(session: GameSession): void {
  session.attack(PLAYER_ID, LOOTER_ID);
  const looter = snapshotOf(session).entities.find((entity) => entity.id === LOOTER_ID);
  expect(looter?.combat.alive).toBe(false);
}

function inventoryOf(session: GameSession) {
  return playerOf(session).container.items;
}

function itemOf(session: GameSession, templateId: string, index = 0) {
  const matches = inventoryOf(session).filter((item) => item.templateId === templateId);
  const item = matches[index];
  if (item === undefined) {
    throw new Error(`背包中缺少 ${templateId}[${index}]`);
  }
  return item;
}

describe("GameSession 背包：useItem", () => {
  it("使用消耗品恢复生命（不超过上限）并减少数量", () => {
    const session = createSession();
    killLooter(session);

    // 高攻怪靠近并攻击，玩家掉血后才能观察治疗。
    session.advance(1500);
    const damaged = playerOf(session).combat.hp;
    expect(damaged).toBeLessThan(playerOf(session).combat.maxHp);

    const herb = itemOf(session, HERB_ID);
    expect(herb.quantity).toBe(2);

    session.useItem(PLAYER_ID, herb.instanceId);

    const healed = playerOf(session);
    expect(healed.combat.hp).toBe(healed.combat.maxHp);
    expect(itemOf(session, HERB_ID).quantity).toBe(1);
  });

  it("使用最后一件消耗品后实例从背包移除", () => {
    const session = createSession();
    killLooter(session);

    const instanceId = itemOf(session, HERB_ID).instanceId;
    session.useItem(PLAYER_ID, instanceId);
    session.useItem(PLAYER_ID, instanceId);

    expect(inventoryOf(session).some((item) => item.templateId === HERB_ID)).toBe(false);
  });

  it("含不支持效果时整体拒绝：不消耗、不产生半生效治疗", () => {
    const session = createSession();
    killLooter(session);
    session.advance(1500);
    const hpBefore = playerOf(session).combat.hp;
    expect(hpBefore).toBeLessThan(playerOf(session).combat.maxHp);
    const mixed = itemOf(session, MIXED_ID);

    expect(() => session.useItem(PLAYER_ID, mixed.instanceId)).toThrow(
      /暂不支持恢复属性/,
    );

    expect(playerOf(session).combat.hp).toBe(hpBefore);
    expect(itemOf(session, MIXED_ID).quantity).toBe(1);
  });

  it("tryUseItem 对过期/重复点击的实例返回友好失败而不是裸异常", () => {
    const session = createSession();
    killLooter(session);
    const herb = itemOf(session, HERB_ID);
    session.useItem(PLAYER_ID, herb.instanceId);
    session.useItem(PLAYER_ID, herb.instanceId);

    const result = session.tryUseItem(PLAYER_ID, herb.instanceId);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/未知物品实例/);
  });

  it("非消耗品不可使用", () => {
    const session = createSession();
    killLooter(session);

    const sword = itemOf(session, SWORD_ID);

    expect(() => session.useItem(PLAYER_ID, sword.instanceId)).toThrow(/不可使用/);
    expect(inventoryOf(session).filter((item) => item.templateId === SWORD_ID)).toHaveLength(2);
  });

  it("未知实例或未知实体报错", () => {
    const session = createSession();
    killLooter(session);

    expect(() => session.useItem(PLAYER_ID, "item:missing@1")).toThrow(/未知物品实例/);
    expect(() => session.useItem("entity:missing", "item:missing@1")).toThrow(/未知实体/);
  });
});

describe("GameSession 装备：equip / unequip", () => {
  it("moveTo 使用修饰器后的 moveSpeed，而不是硬编码默认值", () => {
    const session = createSession();
    killLooter(session);
    const boots = itemOf(session, BOOTS_ID);
    session.equip(PLAYER_ID, boots.instanceId);
    expect(playerOf(session).attributes.moveSpeed).toBe(11);

    session.moveTo(PLAYER_ID, { x: 100, y: 0, z: 0 });
    session.advance(1000);

    expect(playerOf(session).position.x).toBeCloseTo(11, 5);
  });

  it("装备武器后攻击属性即时变化，卸下后恢复", () => {
    const session = createSession();
    killLooter(session);
    const sword = itemOf(session, SWORD_ID);

    expect(playerOf(session).attributes.attack).toBe(12);

    session.equip(PLAYER_ID, sword.instanceId);

    const equipped = playerOf(session);
    expect(equipped.attributes.attack).toBe(17);
    expect(equipped.combat.attack).toBe(17);
    const equippedItem = equipped.container.items.find(
      (item) => item.instanceId === sword.instanceId,
    );
    expect(equippedItem?.equipped).toBe(true);
    expect(equipped.modifiers).toEqual([
      expect.objectContaining({
        attribute: "attack",
        operation: "add",
        value: 5,
        source: { kind: "equipment", id: sword.instanceId },
      }),
    ]);

    session.unequip(PLAYER_ID, sword.instanceId);

    const unequipped = playerOf(session);
    expect(unequipped.attributes.attack).toBe(12);
    expect(unequipped.modifiers).toEqual([]);
    expect(
      unequipped.container.items.find((item) => item.instanceId === sword.instanceId)
        ?.equipped,
    ).toBe(false);
  });

  it("重复装备同一件是幂等的，修饰器不会叠加", () => {
    const session = createSession();
    killLooter(session);
    const sword = itemOf(session, SWORD_ID);

    session.equip(PLAYER_ID, sword.instanceId);
    session.equip(PLAYER_ID, sword.instanceId);

    expect(playerOf(session).attributes.attack).toBe(17);
    expect(playerOf(session).modifiers).toHaveLength(1);
  });

  it("同槽位装备自动替换，旧修饰器被移除", () => {
    const session = createSession();
    killLooter(session);
    const [first, second] = inventoryOf(session).filter(
      (item) => item.templateId === SWORD_ID,
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    session.equip(PLAYER_ID, first!.instanceId);
    session.equip(PLAYER_ID, second!.instanceId);

    const player = playerOf(session);
    expect(player.attributes.attack).toBe(17);
    expect(player.container.items.find((item) => item.instanceId === first!.instanceId)?.equipped).toBe(false);
    expect(player.container.items.find((item) => item.instanceId === second!.instanceId)?.equipped).toBe(true);
    expect(player.modifiers.map((modifier) => modifier.source.id)).toEqual([
      second!.instanceId,
    ]);
  });

  it("装备 maxHp 修饰器即时生效，卸下时当前生命夹回上限", () => {
    const session = createSession();
    killLooter(session);
    session.advance(1500);
    const damagedHp = playerOf(session).combat.hp;
    expect(damagedHp).toBeLessThan(100);

    const armor = itemOf(session, ARMOR_ID);
    session.equip(PLAYER_ID, armor.instanceId);
    expect(playerOf(session).combat.maxHp).toBe(110);
    expect(playerOf(session).combat.hp).toBe(damagedHp);

    const herb = itemOf(session, HERB_ID);
    session.useItem(PLAYER_ID, herb.instanceId);
    session.useItem(PLAYER_ID, herb.instanceId);
    expect(playerOf(session).combat.hp).toBe(110);

    session.unequip(PLAYER_ID, armor.instanceId);
    const player = playerOf(session);
    expect(player.combat.maxHp).toBe(100);
    expect(player.combat.hp).toBe(100);
  });

  it("非装备物品不可装备", () => {
    const session = createSession();
    killLooter(session);
    const herb = itemOf(session, HERB_ID);

    expect(() => session.equip(PLAYER_ID, herb.instanceId)).toThrow(/不可装备/);
    expect(playerOf(session).modifiers).toEqual([]);
  });

  it("快照往返保留 equipped 标记与装备修饰器", () => {
    const session = createSession();
    killLooter(session);
    const sword = itemOf(session, SWORD_ID);
    session.equip(PLAYER_ID, sword.instanceId);

    const restored = createSession();
    restored.restoreSnapshot(session.snapshot());

    const player = playerOf(restored);
    expect(player.attributes.attack).toBe(17);
    expect(player.modifiers.map((modifier) => modifier.source.id)).toEqual([
      sword.instanceId,
    ]);
    expect(
      player.container.items.find((item) => item.instanceId === sword.instanceId)
        ?.equipped,
    ).toBe(true);

    restored.unequip(PLAYER_ID, sword.instanceId);
    expect(playerOf(restored).attributes.attack).toBe(12);
  });
});
