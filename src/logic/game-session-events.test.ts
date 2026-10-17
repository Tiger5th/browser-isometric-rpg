/**
 * 票 27 地基：GameSession 一等订阅事件。
 *
 * 接缝 = `GameSession.subscribe()`：反馈层只经这条通道观察结算事实
 * （damage-dealt / health-changed / item-gained / player-level-up），
 * 不得读会话内部状态。`drainEvents()` 战斗日志保持不废弃。
 */

import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { GameSession } from "./game-session";
import type { GameSessionEvent } from "./game-events";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";
const SLIME_ID = "enemy:slime";

/** 玩家 12 攻 / 4 防，史莱姆 24 血 6 攻 1 防：普攻固定 11 伤害。 */
function combatBundle(): ContentBundle {
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
        id: "enemy_template:slime",
        displayName: "史莱姆",
        aiProfileId: "ai:melee_chaser",
        baseAttributes: {
          maxHp: 30,
          hp: 30,
          attack: 6,
          defense: 1,
          moveSpeed: 3,
          xp: 10,
        },
        drops: [{ itemId: "item:slime_gel", chance: 1, min: 1, max: 1 }],
        tags: ["enemy", "slime"],
      },
    ],
    enemies: [
      {
        id: SLIME_ID,
        templateId: "enemy_template:slime",
        displayName: "草原史莱姆",
        regionId: REGION_ID,
        position: { x: 1.5, y: 0, z: 0 },
        overrides: { baseAttributes: { maxHp: 24, hp: 24 } },
      },
    ],
    items: [
      {
        id: "item:slime_gel",
        displayName: "史莱姆凝胶",
        kind: "misc",
        description: "半透明的黏稠凝胶。",
        maxStack: 99,
      },
    ],
    quests: [],
  };
}

function createSession(roll = 0): GameSession {
  const session = new GameSession({ random: () => roll });
  session.loadRegion(combatBundle(), REGION_ID);
  return session;
}

function collectEvents(session: GameSession): GameSessionEvent[] {
  const seen: GameSessionEvent[] = [];
  session.subscribe((event) => seen.push(event));
  return seen;
}

/**
 * 让史莱姆彻底安静：overrides 与模板属性逐键合并，需显式覆盖
 * attack/moveSpeed/aggroRadius，否则敌人照常仇恨与反击，事件序列里
 * 会混进敌人的 damage-dealt。
 */
function pacify(bundle: ContentBundle): void {
  bundle.enemies[0].overrides = {
    baseAttributes: {
      maxHp: 24,
      hp: 24,
      attack: 0,
      defense: 1,
      moveSpeed: 0,
      aggroRadius: 0,
    },
  };
}

describe("GameSession 一等订阅事件：damage-dealt", () => {
  it("普攻命中广播 damage-dealt：含攻击者/目标/数值/是否重击", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.attack(PLAYER_ID, SLIME_ID);

    const damage = events.filter((event) => event.type === "damage-dealt");
    expect(damage).toEqual([
      {
        type: "damage-dealt",
        attackerId: PLAYER_ID,
        targetId: SLIME_ID,
        amount: 11,
        targetHp: 13,
        targetMaxHp: 24,
        heavy: false,
        lethal: false,
        at: 0,
      },
    ]);
  });

  it("击杀的那一击 damage-dealt 带 lethal，并同时广播 health-changed/enemy-killed", () => {
    const bundle = combatBundle();
    pacify(bundle); // 敌人不反击也不移动，事件序列只含玩家动作。
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);
    const events = collectEvents(session);

    session.attack(PLAYER_ID, SLIME_ID); // 24 → 13
    session.advance(1000); // 13 → 2
    session.advance(1000); // 2 → 0，致死一击

    const damage = events.filter((event) => event.type === "damage-dealt");
    expect(damage).toHaveLength(3);
    expect(damage[2]).toMatchObject({
      type: "damage-dealt",
      attackerId: PLAYER_ID,
      targetId: SLIME_ID,
      amount: 11,
      targetHp: 0,
      lethal: true,
      heavy: false,
    });
    expect(events.map((event) => event.type)).toEqual([
      "damage-dealt",
      "health-changed",
      "damage-dealt",
      "health-changed",
      "damage-dealt",
      "health-changed",
      "item-gained",
      "enemy-killed",
    ]);
  });

  it("未命中不广播 damage-dealt，也不广播 health-changed", () => {
    const session = createSession(0.95); // 命中率 0.9 → 未命中
    const events = collectEvents(session);

    session.attack(PLAYER_ID, SLIME_ID);

    expect(events).toEqual([]);
  });
});

describe("GameSession 一等订阅事件：health-changed", () => {
  it("玩家受击时广播 health-changed（含前后血量与来源）", () => {
    const bundle = combatBundle();
    bundle.regions[0].player.baseAttributes.defense = 4;
    const session = new GameSession({ random: () => 0, respawnDelayMs: 10_000 });
    session.loadRegion(bundle, REGION_ID);
    const events = collectEvents(session);

    session.advance(1000); // 敌人 6 - 玩家 4 = 2 伤害

    const health = events.filter((event) => event.type === "health-changed");
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({
      type: "health-changed",
      entityId: PLAYER_ID,
      hp: 98,
      maxHp: 100,
      previousHp: 100,
      cause: "damage",
    });
  });

  it("使用消耗品治疗时广播 health-changed（cause=heal）", () => {
    const bundle = combatBundle();
    bundle.regions[0].player.baseAttributes.hp = 10;
    bundle.regions[0].player.baseAttributes.maxHp = 100;
    pacify(bundle);
    bundle.enemyTemplates[0].drops = [
      { itemId: "item:healing_herb", chance: 1, min: 1, max: 1 },
    ];
    bundle.items.push({
      id: "item:healing_herb",
      displayName: "疗伤草",
      kind: "consumable",
      description: "恢复生命。",
      maxStack: 9,
      consumable: { effects: [{ type: "restore", attribute: "hp", amount: 30 }] },
    } as unknown as ContentBundle["items"][number]);
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    // 先击杀一次拿到疗伤草（玩家 12 攻 vs 24 血需要三刀；敌人不反击）。
    session.attack(PLAYER_ID, SLIME_ID);
    session.advance(1000);
    session.advance(1000);
    const events = collectEvents(session);
    session.tryUseItem(PLAYER_ID, "item:healing_herb@1");

    expect(events.filter((event) => event.type === "health-changed")).toEqual([
      {
        type: "health-changed",
        entityId: PLAYER_ID,
        hp: 40,
        maxHp: 100,
        previousHp: 10,
        cause: "heal",
      },
    ]);
  });
});

describe("GameSession 一等订阅事件：item-gained 与 player-level-up", () => {
  it("击杀掉落广播 item-gained（含物品/数量）", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.attack(PLAYER_ID, SLIME_ID);
    session.advance(1000);
    session.advance(1000);

    expect(events.filter((event) => event.type === "item-gained")).toEqual([
      {
        type: "item-gained",
        entityId: PLAYER_ID,
        itemId: "item:slime_gel",
        quantity: 1,
      },
    ]);
  });

  it("player-level-up 目前只随升级事件发布；纯击杀不掉血也不升级", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.attack(PLAYER_ID, SLIME_ID);

    expect(events.some((event) => event.type === "player-level-up")).toBe(false);
  });
});

describe("GameSession 攻击前摇事件（走位窗口）", () => {
  it("敌人普攻先广播 attack-windup-started（300ms），伤害在前摇结束后才落地", () => {
    const bundle = combatBundle();
    bundle.regions[0].player.baseAttributes.defense = 4;
    const session = new GameSession({ random: () => 0, respawnDelayMs: 10_000 });
    session.loadRegion(bundle, REGION_ID);
    const events = collectEvents(session);

    session.advance(100); // 第一次模拟步：进入射程，起前摇
    const windup = events.filter((event) => event.type === "attack-windup-started");
    expect(windup).toEqual([
      expect.objectContaining({
        attackerId: SLIME_ID,
        targetId: PLAYER_ID,
        heavy: false,
        durationMs: 300,
      }),
    ]);
    expect(events.some((event) => event.type === "damage-dealt")).toBe(false);

    session.advance(300); // 前摇走完，伤害落地
    expect(
      events.some(
        (event) => event.type === "damage-dealt" && event.attackerId === SLIME_ID,
      ),
    ).toBe(true);
  });

  it("重击前摇 600ms 且 heavy=true", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.heavyAttack(PLAYER_ID, SLIME_ID);

    expect(events.filter((event) => event.type === "attack-windup-started")).toEqual([
      expect.objectContaining({
        attackerId: PLAYER_ID,
        targetId: SLIME_ID,
        heavy: true,
        durationMs: 600,
      }),
    ]);
  });

  it("前摇中目标走出射程 = 走位躲开，伤害不落地", () => {
    const bundle = combatBundle();
    bundle.enemies[0].overrides = {
      baseAttributes: { maxHp: 24, hp: 24, attack: 6, moveSpeed: 0, aggroRadius: 8 },
    };
    const session = new GameSession({ random: () => 0, respawnDelayMs: 10_000 });
    session.loadRegion(bundle, REGION_ID);
    const events = collectEvents(session);

    session.advance(100); // 敌人起前摇
    expect(events.some((event) => event.type === "attack-windup-started")).toBe(true);

    // 玩家在 300ms 前摇结束前向反方向跑出射程（模拟走位）。
    session.moveTo(PLAYER_ID, { x: -12, y: 0, z: 0 });
    session.advance(400);

    expect(
      events.some(
        (event) => event.type === "damage-dealt" && event.attackerId === SLIME_ID,
      ),
    ).toBe(false);
  });
});
