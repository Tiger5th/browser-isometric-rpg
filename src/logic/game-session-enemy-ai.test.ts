import { describe, expect, it } from "vitest";

import type { ContentBundle, EnemyTemplateDefinition } from "./content/types";
import type { GameSessionEvent } from "./game-events";
import { GameSession } from "./game-session";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";
const CHARGER_ID = "enemy:charger";
const SPITTER_ID = "enemy:spitter";
const SLIME_ID = "enemy:slime_legacy";

const CHARGER_AI_PROFILE = {
  kind: "windup-charge",
  windupMs: 600,
  chargeSpeed: 14,
  chargeDistance: 8,
  recoveryMs: 900,
  triggerRange: 6,
  hitRadius: 1,
} as const;

const SPITTER_AI_PROFILE = {
  kind: "ranged-kite",
  preferredRange: 8,
  retreatRange: 5,
  fireIntervalMs: 2000,
  projectileSpeed: 16,
  projectileDamage: 7,
  projectileRadius: 0.35,
  projectileLifetimeMs: 2500,
} as const;

function enemyTemplate(
  id: string,
  displayName: string,
  aiProfileId: string,
  aiProfile?: Record<string, unknown>,
): EnemyTemplateDefinition {
  return {
    id,
    displayName,
    aiProfileId,
    ...(aiProfile === undefined ? {} : { aiProfile }),
    baseAttributes: {
      maxHp: 40,
      hp: 40,
      attack: 9,
      defense: 1,
      moveSpeed: 4,
      xp: 12,
    },
    drops: [],
    tags: ["enemy"],
  } as EnemyTemplateDefinition;
}

/** 战斗内容集：冲锋型 + 吐弹型各一只，出生点由 chargerAt/spitterAt 决定。 */
function enemyBundle(options: {
  chargerAt?: { x: number; z: number };
  spitterAt?: { x: number; z: number };
  slimeAt?: { x: number; z: number };
  playerHp?: number;
  playerDefense?: number;
  playerItems?: Array<{ itemId: string; quantity: number }>;
} = {}): ContentBundle {
  const chargerAt = options.chargerAt ?? { x: 4, z: 0 };
  const spitterAt = options.spitterAt ?? { x: 14, z: 0 };
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
            maxHp: options.playerHp ?? 100,
            hp: options.playerHp ?? 100,
            attack: 14,
            defense: options.playerDefense ?? 2,
            moveSpeed: 5.5,
          },
          startingItems: options.playerItems ?? [],
        },
      },
    ],
    npcs: [],
    enemyTemplates: [
      enemyTemplate("enemy_template:charger", "角冲兽", "ai:windup_charge", CHARGER_AI_PROFILE),
      enemyTemplate("enemy_template:spitter", "孢囊蟾", "ai:ranged_kite", SPITTER_AI_PROFILE),
      // 没有 aiProfile 的老式模板（只有 aiProfileId）→ 走既有 chaser 状态机。
      enemyTemplate("enemy_template:slime_legacy", "翠谷史莱姆", "ai:melee_chaser"),
    ],
    enemies: [
      {
        id: CHARGER_ID,
        templateId: "enemy_template:charger",
        displayName: "角冲兽",
        regionId: REGION_ID,
        position: { x: chargerAt.x, y: 0, z: chargerAt.z },
      },
      {
        id: SLIME_ID,
        templateId: "enemy_template:slime_legacy",
        displayName: "翠谷史莱姆",
        regionId: REGION_ID,
        position: { x: options.slimeAt?.x ?? 40, y: 0, z: options.slimeAt?.z ?? 4 },
      },
      {
        id: SPITTER_ID,
        templateId: "enemy_template:spitter",
        displayName: "孢囊蟾",
        regionId: REGION_ID,
        position: { x: spitterAt.x, y: 0, z: spitterAt.z },
      },
    ],
    items: [
      {
        id: "item:old_coin",
        displayName: "旧铜币",
        kind: "misc",
        description: "磨损得看不清年号的铜币。",
        maxStack: 999,
        value: 1,
      },
    ],
    quests: [],
  } as ContentBundle;
}

function createSession(
  options: Parameters<typeof enemyBundle>[0] & {
    roll?: number;
    respawnDelayMs?: number;
  } = {},
): GameSession {
  const session = new GameSession({
    random: () => options.roll ?? 0,
    respawnDelayMs: options.respawnDelayMs ?? 1000,
  });
  session.loadRegion(enemyBundle(options), REGION_ID);
  return session;
}

function entityOf(session: GameSession, id: string) {
  const entity = session.snapshot().entities.find((candidate) => candidate.id === id);
  if (!entity) {
    throw new Error(`快照中缺少实体 ${id}`);
  }
  return entity;
}

function distance(left: { x: number; z: number }, right: { x: number; z: number }): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

/** 记录订阅事件；反馈层/表现层只消费这些一等事件。 */
function recordEvents(session: GameSession): GameSessionEvent[] {
  const seen: GameSessionEvent[] = [];
  session.subscribe((event) => seen.push(event));
  return seen;
}

describe("冲锋型敌人：windup → charge → recovery 状态机", () => {
  it("进入射程先发 600ms 前摇事件再直线冲锋，命中一次后进入 recovery 硬直", () => {
    const session = createSession({ spitterAt: { x: 40, z: 0 } });
    const events = recordEvents(session);

    // 前摇（0.6s）：只有前摇事件，没有伤害。
    session.advance(400);
    expect(entityOf(session, CHARGER_ID).combat.aiState).toBe("windup-charge");
    expect(events.filter((event) => event.type === "attack-windup-started")).toEqual([
      {
        type: "attack-windup-started",
        attackerId: CHARGER_ID,
        targetId: PLAYER_ID,
        heavy: true,
        durationMs: 600,
        at: 100,
      },
    ]);
    expect(entityOf(session, PLAYER_ID).combat.hp).toBe(100);

    // 前摇结束（t=600ms）进入 charge：14m/s 从 4m 外直冲而来，
    // 约 t=900ms 撞上玩家，一次性结算伤害并进入 recovery。
    session.advance(300);
    expect(entityOf(session, CHARGER_ID).combat.aiState).toBe("charge");
    expect(entityOf(session, PLAYER_ID).combat.hp).toBe(100);

    session.advance(600);
    expect(entityOf(session, CHARGER_ID).combat.aiState).toBe("recovery");
    const damage = events.filter((event) => event.type === "damage-dealt");
    expect(damage).toHaveLength(1);
    expect(damage[0]).toMatchObject({
      attackerId: CHARGER_ID,
      targetId: PLAYER_ID,
      amount: 7, // 9 攻击 - 2 防御
      lethal: false,
    });
    expect(entityOf(session, PLAYER_ID).combat.hp).toBe(93);

    // 硬直期间不掉血；硬直结束后回到追击。
    session.advance(800);
    expect(entityOf(session, PLAYER_ID).combat.hp).toBe(93);
    session.advance(200);
    expect(["chase", "windup-charge"]).toContain(
      entityOf(session, CHARGER_ID).combat.aiState,
    );
  });

  it("整段冲锋每轮只结算一次伤害，不会每帧蹭伤害", () => {
    const session = createSession({ spitterAt: { x: 40, z: 0 } });

    session.advance(2000);

    // 2000ms 内一轮冲锋 = 600ms 前摇 + 冲锋 + 900ms 硬直，只结算一次。
    const attacks = session
      .drainEvents()
      .filter((event) => event.type === "attack" && event.attackerId === CHARGER_ID);
    expect(attacks).toHaveLength(1);
    expect(entityOf(session, PLAYER_ID).combat.hp).toBe(93);
  });

  it("前摇期间玩家横移躲开，冲锋落空不造成伤害", () => {
    const session = createSession({ spitterAt: { x: 40, z: 0 } });
    const events = recordEvents(session);

    session.advance(400);
    // 前摇后半段侧向走位（冲锋方向在前摇结束时锁定）。
    session.moveTo(PLAYER_ID, { x: 0, y: 0, z: -6 });
    session.advance(1400);

    expect(
      events.some((event) => event.type === "damage-dealt" && event.targetId === PLAYER_ID),
    ).toBe(false);
    expect(entityOf(session, PLAYER_ID).combat.hp).toBe(100);
  });

  it("冲锋被硬碰撞挡停：不造成伤害并进入 recovery", () => {
    const session = createSession({ spitterAt: { x: 40, z: 0 } });
    const events = recordEvents(session);
    // 冲锋路径上摆一堵墙（盒状碰撞体，票 28 world-physics 的数据形状）。
    session.setWorldObstacles([
      { id: "prop:stone-wall-1", shape: "box", x: 2, z: 0, radius: 0.9, halfDepth: 0.9 },
    ]);

    session.advance(1500);

    expect(events.some((event) => event.type === "damage-dealt")).toBe(false);
    expect(entityOf(session, PLAYER_ID).combat.hp).toBe(100);
    expect(entityOf(session, CHARGER_ID).combat.aiState).toBe("recovery");
    expect(events.some((event) => event.type === "charge-blocked")).toBe(true);
  });

  it("未配置 aiProfile 的敌人（chaser 档案）不受影响：仍然走普攻前摇 + 结算", () => {
    const session = createSession({
      chargerAt: { x: 40, z: 0 },
      spitterAt: { x: 40, z: 0 },
      slimeAt: { x: 6, z: 4 },
    });
    const events = recordEvents(session);

    session.moveTo(PLAYER_ID, { x: 4, y: 0, z: 4 });
    session.advance(2000);

    expect(["chase", "attack"]).toContain(entityOf(session, SLIME_ID).combat.aiState);
    expect(
      events.some(
        (event) => event.type === "attack-windup-started" && event.attackerId === SLIME_ID,
      ),
    ).toBe(true);
  });

});

describe("吐弹型敌人：ranged-kite 与投射物", () => {
  it("保持攻击距离开火，投射物飞行命中玩家并结算伤害事件", () => {
    const session = createSession({ chargerAt: { x: 40, z: 0 }, spitterAt: { x: 8, z: 0 } });
    const events = recordEvents(session);

    // 第一发在 t=0 发射，8m 外、16m/s → 约 500ms 命中；第二发要等 2000ms 冷却。
    session.advance(1200);

    const fired = events.filter((event) => event.type === "projectile-spawned");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ ownerId: SPITTER_ID, targetId: PLAYER_ID });
    expect(session.projectileSnapshots()).toEqual([]); // 命中即消失

    const damage = events.filter((event) => event.type === "damage-dealt");
    expect(damage).toHaveLength(1);
    expect(damage[0]).toMatchObject({
      attackerId: SPITTER_ID,
      targetId: PLAYER_ID,
      amount: SPITTER_AI_PROFILE.projectileDamage,
    });
    expect(
      events.some(
        (event) => event.type === "projectile-removed" && event.reason === "hit",
      ),
    ).toBe(true);
  });

  it("玩家接近到后撤距离内时吐弹怪后撤，拉开距离", () => {
    const session = createSession({ chargerAt: { x: 40, z: 0 }, spitterAt: { x: 8, z: 0 } });

    session.moveTo(PLAYER_ID, { x: 6, y: 0, z: 0 });
    session.advance(1200);

    // 玩家从 8m 逼近到 2m；吐弹怪持续后撤，距离被重新拉开。
    const spitter = entityOf(session, SPITTER_ID);
    expect(spitter.position.x).toBeGreaterThan(8);
    expect(distance(spitter.position, { x: 6, z: 0 })).toBeGreaterThan(2);
  });

  it("玩家远离到超出射程时吐弹怪追近但不贴身", () => {
    const session = createSession({ chargerAt: { x: 40, z: 0 }, spitterAt: { x: 8, z: 0 } });

    session.moveTo(PLAYER_ID, { x: 18, y: 0, z: 0 });
    session.advance(6000);

    const spitter = entityOf(session, SPITTER_ID);
    const gap = distance(spitter.position, { x: 18, z: 0 });
    expect(gap).toBeLessThanOrEqual(SPITTER_AI_PROFILE.preferredRange + 1);
    expect(gap).toBeGreaterThan(SPITTER_AI_PROFILE.retreatRange - 1);
  });
});

describe("死亡轻惩罚：回村出生点 + 扣 10% 金币", () => {
  /** 玩家血量 5，冲锋怪一击 7 伤害必致死；冲锋怪站远处，需要玩家走位进仇恨。 */
  function dyingSession(
    coins: number,
    options: { respawnDelayMs?: number; roll?: number } = {},
  ): GameSession {
    const session = new GameSession({
      random: () => options.roll ?? 0,
      respawnDelayMs: options.respawnDelayMs ?? 500,
    });
    session.loadRegion(
      enemyBundle({
        chargerAt: { x: 40, z: 0 },
        spitterAt: { x: 40, z: 0 },
        playerHp: 5,
        playerItems: [{ itemId: "item:old_coin", quantity: coins }],
      }),
      REGION_ID,
    );
    session.moveTo(PLAYER_ID, { x: 33, y: 0, z: 0 });
    return session;
  }

  it("死亡后回村出生点复活，并扣掉向上取整的 10% 金币", () => {
    const session = dyingSession(37);
    const events = recordEvents(session);

    session.advance(6000);

    const player = entityOf(session, PLAYER_ID);
    expect(player.combat.alive).toBe(true);
    expect(player.combat.hp).toBe(5); // 回满（血量上限就是 5）
    expect(player.position).toEqual({ x: 0, y: 0, z: 0 }); // 回村出生点
    // ceil(37 × 0.1) = 4
    expect(
      player.container.items.find((item) => item.templateId === "item:old_coin")?.quantity,
    ).toBe(33);
    expect(events.filter((event) => event.type === "player-death-penalty")).toEqual([
      {
        type: "player-death-penalty",
        entityId: PLAYER_ID,
        itemId: "item:old_coin",
        lostQuantity: 4,
        remainingQuantity: 33,
        at: expect.any(Number),
      },
    ]);
  });

  it("金币不足 10 枚时也向上取整扣 1 枚", () => {
    const session = dyingSession(4);

    session.advance(6000);

    expect(
      entityOf(session, PLAYER_ID).container.items.find(
        (item) => item.templateId === "item:old_coin",
      )?.quantity,
    ).toBe(3);
  });

  it("没有金币时免罚：只回出生点，不广播惩罚事件", () => {
    const session = dyingSession(0);
    const events = recordEvents(session);

    session.advance(6000);

    expect(entityOf(session, PLAYER_ID).position).toEqual({ x: 0, y: 0, z: 0 });
    expect(events.some((event) => event.type === "player-death-penalty")).toBe(false);
  });

  it("扣币结果随快照往返保持", () => {
    const session = dyingSession(37);
    session.advance(6000);

    const restored = createSession({ chargerAt: { x: 40, z: 0 }, spitterAt: { x: 40, z: 0 }, playerHp: 5 });
    restored.restoreSnapshot(JSON.parse(session.serialize()));

    expect(
      entityOf(restored, PLAYER_ID).container.items.find(
        (item) => item.templateId === "item:old_coin",
      )?.quantity,
    ).toBe(33);
  });
});
