/**
 * 探索回报 L1（票 37）：宝箱开启 / 收集计数聚合 / 全收集奖励 / 快照往返。
 *
 * 验收口径（见 .scratch/.../37-exploration-rewards.md）：
 * - 开箱 → loot 入包 → worldState 记开启 → 快照往返后不重开；
 * - 收集计数由 worldState 聚合，全收集自动发一件饰品且只发一次；
 * - 读档后进度不回退。
 */

import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import type { GameSessionEvent } from "./game-events";
import { GameSession } from "./game-session";
import { collectProgress, isChestOpened, isCollectibleCollected } from "./exploration";

/**
 * 最小探索内容集（测试自造，不依赖真实 content/ 数据）：
 * 一个区域 + 一个宝箱（两件 loot）+ 三株同集的收集品 + 一件饰品全收集奖励。
 */
const REGION_ID = "region:test_valley";
const PLAYER = "entity:player";
const CHEST = "chest:test_chest";
const COLLECT = "collectible:test_moss_1";
const SET_ID = "collect_set:test_moss";
const CHARM_ID = "item:test_charm";
const MOSS_ID = "item:test_moss";
const COIN_ID = "item:test_coin";
const HERB_ID = "item:test_herb";

const BUNDLE: ContentBundle = {
  regions: [
    {
      id: REGION_ID,
      displayName: "试炼谷",
      asset: { model: "assets/regions/test_valley.glb" },
      player: {
        id: PLAYER,
        templateId: "player_template:hero",
        displayName: "旅人",
        spawn: { position: { x: 0, "y": 0, "z": 0 } },
        baseAttributes: { maxHp: 100, hp: 100, attack: 12, defense: 4, moveSpeed: 5.5 },
        startingItems: [{ itemId: COIN_ID, quantity: 5 }],
      },
    },
  ],
  npcs: [],
  enemyTemplates: [],
  enemies: [],
  quests: [],
  items: [
    {
      id: COIN_ID,
      displayName: "试炼币",
      kind: "misc",
      description: "测试用货币。",
      maxStack: 999,
    },
    {
      id: HERB_ID,
      displayName: "试炼草",
      kind: "consumable",
      description: "测试用消耗品。",
      maxStack: 99,
      consumable: { effects: [{ type: "restore", attribute: "hp", amount: 10 }] },
    },
    { id: MOSS_ID, displayName: "试炼草", kind: "misc", description: "收集品本体。", maxStack: 99 },
    {
      id: CHARM_ID,
      displayName: "试炼坠饰",
      kind: "equipment",
      description: "全收集奖励。",
      maxStack: 1,
      equipment: {
        slot: "accessory",
        modifiers: [{ attribute: "maxHp", operation: "add", value: 15 }],
      },
    },
  ],
  chests: [
    {
      id: CHEST,
      displayName: "试炼箱",
      regionId: REGION_ID,
      position: { x: 6, y: 0, z: 0 },
      loot: [
        { itemId: COIN_ID, quantity: 8 },
        { itemId: HERB_ID, quantity: 2 },
      ],
    },
  ],
  collectibles: [
    {
      id: COLLECT,
      displayName: "试炼草",
      regionId: REGION_ID,
      position: { x: -6, y: 0, z: 0 },
      itemId: MOSS_ID,
      quantity: 1,
      setId: SET_ID,
    },
    {
      id: "collectible:test_moss_2",
      displayName: "试炼草",
      regionId: REGION_ID,
      position: { x: 0, y: 0, z: 6 },
      itemId: MOSS_ID,
      quantity: 1,
      setId: SET_ID,
    },
    {
      id: "collectible:test_moss_3",
      displayName: "试炼草",
      regionId: REGION_ID,
      position: { x: 0, y: 0, z: -6 },
      itemId: MOSS_ID,
      quantity: 1,
      setId: SET_ID,
    },
  ],
  collectSets: [{ id: SET_ID, displayName: "试炼草", rewardItemId: CHARM_ID, rewardQuantity: 1 }],
};


function loadedSession(): GameSession {
  const session = new GameSession();
  session.loadRegion(BUNDLE, REGION_ID);
  return session;
}

/** 传送玩家（探索交互要求距离内；测试不跑寻路）。 */
function teleportTo(session: GameSession, position: { x: number; y: number; z: number }): void {
  session.moveTo(PLAYER, position);
  // moveTo 只是意图；这里直接推进一次把玩家挪到目标点（测试世界没有障碍）。
  session.advance(10_000);
}

const CHEST_POSITION = BUNDLE.chests![0].position;
const COLLECT_POSITION = BUNDLE.collectibles![0].position;

describe("宝箱（票 37）", () => {
  it("开箱：loot 入包 + worldState 记开启 + 发 chest-opened", () => {
    const session = loadedSession();
    teleportTo(session, CHEST_POSITION);
    const before = quantityOf(session, COIN_ID);

    const result = session.tryOpenChest(PLAYER, CHEST);

    expect(result.ok).toBe(true);
    expect(quantityOf(session, COIN_ID)).toBe(before + 8);
    expect(quantityOf(session, HERB_ID)).toBe(2);
    expect(session.isChestOpened(CHEST)).toBe(true);
    expect(session.getWorldState()[`chest:${CHEST.replace("chest:", "")}`]).toEqual({ opened: true });
  });

  it("同一 tick 内 loot 先发 item-gained 再发 chest-opened（反馈层顺序确定）", () => {
    const session = loadedSession();
    teleportTo(session, CHEST_POSITION);
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    session.openChest(PLAYER, CHEST);

    const gained = events.filter((event) => event.type === "item-gained");
    const opened = events.find((event) => event.type === "chest-opened");
    expect(gained).toHaveLength(2);
    expect(opened).toBeDefined();
    expect(events.indexOf(gained[1])).toBeLessThan(events.indexOf(opened!));
  });

  it("一次性：已开的宝箱再开被拒，不重复发 loot", () => {
    const session = loadedSession();
    teleportTo(session, CHEST_POSITION);
    session.openChest(PLAYER, CHEST);
    const afterFirst = quantityOf(session, COIN_ID);

    const result = session.tryOpenChest(PLAYER, CHEST);

    expect(result.ok).toBe(false);
    expect(quantityOf(session, COIN_ID)).toBe(afterFirst);
  });

  it("距离太远 / 未知宝箱被拒", () => {
    const session = loadedSession();
    const far = session.tryOpenChest(PLAYER, CHEST);
    expect(far.ok).toBe(false);
    expect(session.isChestOpened(CHEST)).toBe(false);

    teleportTo(session, CHEST_POSITION);
    expect(session.tryOpenChest(PLAYER, "chest:nope").ok).toBe(false);
  });

  it("快照往返后不重开：读档后仍是已开、loot 不再进包", () => {
    const session = loadedSession();
    teleportTo(session, CHEST_POSITION);
    session.openChest(PLAYER, CHEST);
    const saved = session.snapshot();
    const coinAfterOpen = quantityOf(session, COIN_ID);

    const loaded = new GameSession();
    loaded.loadRegion(BUNDLE, REGION_ID);
    loaded.restoreSnapshot(saved);

    expect(loaded.isChestOpened(CHEST)).toBe(true);
    teleportTo(loaded, CHEST_POSITION);
    expect(loaded.tryOpenChest(PLAYER, CHEST).ok).toBe(false);
    expect(quantityOf(loaded, COIN_ID)).toBe(coinAfterOpen);
  });

  it("serialize → restore 后同样不重开", () => {
    const session = loadedSession();
    teleportTo(session, CHEST_POSITION);
    session.openChest(PLAYER, CHEST);
    const restored = new GameSession();
    restored.loadRegion(BUNDLE, REGION_ID);
    restored.restoreSnapshot(JSON.parse(session.serialize()));

    expect(restored.isChestOpened(CHEST)).toBe(true);
  });

  it("worldState 是深拷贝：调用方改动不穿透会话", () => {
    const session = loadedSession();
    teleportTo(session, CHEST_POSITION);
    session.openChest(PLAYER, CHEST);

    const leaked = session.getWorldState();
    (leaked[`chest:${CHEST.replace("chest:", "")}`] as Record<string, unknown>).opened = false;

    expect(session.isChestOpened(CHEST)).toBe(true);
  });
});

describe("收集品计数聚合（票 37）", () => {
  it("计数是聚合出来的：每捡一件 +1，全部捡齐才 complete", () => {
    const session = loadedSession();
    const members = session.collectibleDefinitions();
    expect(members).toHaveLength(3);

    expect(session.collectProgress(SET_ID).collected).toBe(0);
    for (const member of members) {
      teleportTo(session, member.position);
      session.collectCollectible(PLAYER, member.id);
      const progress = session.collectProgress(SET_ID);
      expect(progress.collected).toBe(members.indexOf(member) + 1);
      expect(progress.complete).toBe(member === members[members.length - 1]);
    }
  });

  it("全收集自动把奖励饰品发进背包（修饰器走现有装备槽）", () => {
    const session = loadedSession();
    for (const member of session.collectibleDefinitions()) {
      teleportTo(session, member.position);
      session.collectCollectible(PLAYER, member.id);
    }

    expect(quantityOf(session, MOSS_ID)).toBe(3);
    expect(quantityOf(session, CHARM_ID)).toBe(1);
    expect(session.collectProgress(SET_ID).rewardGranted).toBe(true);
  });

  it("奖励饰品可装备并生效（modifier 系统不加新分支）", () => {
    const session = loadedSession();
    for (const member of session.collectibleDefinitions()) {
      teleportTo(session, member.position);
      session.collectCollectible(PLAYER, member.id);
    }
    const instance = session
      .snapshot()
      .entities.find((entity) => entity.id === PLAYER)!
      .container.items.find((item) => item.templateId === CHARM_ID)!;

    expect(session.tryEquip(PLAYER, instance.instanceId).ok).toBe(true);
    const player = session.snapshot().entities.find((entity) => entity.id === PLAYER)!;
    expect(player.combat.maxHp).toBeGreaterThan(session.snapshot().entities.find((e) => e.id === PLAYER)!.baseAttributes.maxHp ?? 0);
  });

  it("collect-set-completed 只发一次：读档后不再发", () => {
    const session = loadedSession();
    for (const member of session.collectibleDefinitions()) {
      teleportTo(session, member.position);
      session.collectCollectible(PLAYER, member.id);
    }
    const saved = session.snapshot();

    const loaded = new GameSession();
    loaded.loadRegion(BUNDLE, REGION_ID);
    loaded.restoreSnapshot(saved);

    expect(loaded.collectProgress(SET_ID).collected).toBe(3);
    expect(loaded.collectProgress(SET_ID).rewardGranted).toBe(true);
    expect(quantityOf(loaded, CHARM_ID)).toBe(1);
  });

  it("拾取事件带上进度与「本件是否让集合满」", () => {
    const session = loadedSession();
    const members = session.collectibleDefinitions();
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    // 前两件不该触发奖励，最后一件才让集合满。
    for (const member of [members[0], members[1], members[2]]) {
      teleportTo(session, member.position);
      session.collectCollectible(PLAYER, member.id);
    }

    const collected = events.filter(
      (event): event is Extract<GameSessionEvent, { type: "collectible-collected" }> =>
        event.type === "collectible-collected",
    );
    expect(collected).toHaveLength(3);
    expect(collected[0].collected).toBe(1);
    expect(collected[0].setCompleted).toBe(false);
    expect(collected[1].setCompleted).toBe(false);
    expect(collected[2].setCompleted).toBe(true);
    expect(events.some((event) => event.type === "collect-set-completed")).toBe(true);
  });

  it("收集品一次性：捡过再捡被拒", () => {
    const session = loadedSession();
    const first = session.collectibleDefinitions()[0];
    teleportTo(session, first.position);
    session.collectCollectible(PLAYER, first.id);
    const moss = quantityOf(session, MOSS_ID);

    expect(session.tryCollectCollectible(PLAYER, first.id).ok).toBe(false);
    expect(quantityOf(session, MOSS_ID)).toBe(moss);
    expect(session.isCollectibleCollected(first.id)).toBe(true);
  });

  it("距离太远 / 未知收集品被拒", () => {
    const session = loadedSession();
    expect(session.tryCollectCollectible(PLAYER, COLLECT).ok).toBe(false);
    teleportTo(session, COLLECT_POSITION);
    expect(session.tryCollectCollectible(PLAYER, "collectible:nope").ok).toBe(false);
  });

  it("快照往返后收集进度不回退", () => {
    const session = loadedSession();
    const members = session.collectibleDefinitions();
    teleportTo(session, members[0].position);
    session.collectCollectible(PLAYER, members[0].id);
    const saved = session.snapshot();

    const loaded = new GameSession();
    loaded.loadRegion(BUNDLE, REGION_ID);
    loaded.restoreSnapshot(saved);

    expect(loaded.collectProgress(SET_ID).collected).toBe(1);
    expect(loaded.collectProgress(SET_ID).complete).toBe(false);
  });

  it("allCollectProgress 覆盖内容包里所有收集集", () => {
    const session = loadedSession();
    expect(session.allCollectProgress().map((entry) => entry.setId)).toEqual([SET_ID]);
  });
});

describe("exploration 纯函数（worldState 键约定）", () => {
  it("键名与读取只认 worldState，不依赖内容", () => {
    const world = {
      "chest:test_chest": { opened: true },
      "collectible:test_moss_1": { collected: true },
      "collect_reward:collect_set:test_moss": { granted: true },
    };
    expect(isChestOpened(world, "chest:test_chest")).toBe(true);
    expect(isCollectibleCollected(world, "collectible:test_moss_1")).toBe(true);
    expect(collectProgress(world, "collect_set:test_moss", BUNDLE.collectibles!).collected).toBe(1);
    expect(isChestOpened(world, "chest:other")).toBe(false);
    expect(isChestOpened({}, "chest:test_chest")).toBe(false);
  });

  it("progress 比值：未捡为 0，全捡为 1", () => {
    const members = BUNDLE.collectibles!;
    expect(collectProgress({}, members[0].setId!, members).ratio).toBe(0);
    const world = Object.fromEntries(
      members.map((member) => [`collectible:${member.id.replace("collectible:", "")}`, { collected: true }]),
    );
    expect(collectProgress(world, members[0].setId!, members).ratio).toBe(1);
  });
});

function quantityOf(session: GameSession, itemId: string): number {
  const player = session.snapshot().entities.find((entity) => entity.id === PLAYER);
  return (player?.container.items ?? [])
    .filter((item) => item.templateId === itemId)
    .reduce((sum, item) => sum + item.quantity, 0);
}