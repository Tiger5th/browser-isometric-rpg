import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { createEntity } from "./entity";
import { GameSession } from "./game-session";
import { appendModifiers, createModifiers } from "./modifier";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";
const SLIME_ID = "enemy:slime";

/** 最小战斗内容集：玩家与一只默认站在 (1.5, 0, 0) 的史莱姆。 */
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
        drops: [{ itemId: "item:slime_gel", chance: 1, min: 1, max: 2 }],
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

/** 随机数固定，命中/掉落判定可复现。 */
function createSession(roll = 0, options: { respawnDelayMs?: number } = {}): GameSession {
  const session = new GameSession({ random: () => roll, ...options });
  session.loadRegion(combatBundle(), REGION_ID);
  return session;
}

function entityOf(session: GameSession, id: string) {
  const entity = session.snapshot().entities.find((candidate) => candidate.id === id);
  if (!entity) {
    throw new Error(`快照中缺少实体 ${id}`);
  }
  return entity;
}

describe("GameSession 战斗：攻击意图与伤害", () => {
  it("攻击范围内的敌人立即结算，伤害 = 攻击 - 防御", () => {
    const session = createSession();

    session.attack(PLAYER_ID, SLIME_ID);

    const slime = entityOf(session, SLIME_ID);
    expect(slime.combat.hp).toBe(13); // 24 - (12 - 1)
    expect(slime.combat.alive).toBe(true);
  });

  it("事件流记录命中、伤害与目标剩余生命", () => {
    const session = createSession();

    session.attack(PLAYER_ID, SLIME_ID);

    expect(session.drainEvents()).toEqual([
      {
        type: "attack",
        at: 0,
        attackerId: PLAYER_ID,
        targetId: SLIME_ID,
        hit: true,
        damage: 11,
        targetHp: 13,
        targetMaxHp: 24,
      },
    ]);
    expect(session.drainEvents()).toEqual([]); // 取走后清空
  });

  it("命中判定失败时不掉血，但仍消耗一次攻击回合", () => {
    const session = createSession(0.95); // 命中率 0.9，roll 0.95 → 未命中

    session.attack(PLAYER_ID, SLIME_ID);

    expect(entityOf(session, SLIME_ID).combat.hp).toBe(24);
    expect(session.drainEvents()).toEqual([
      expect.objectContaining({ type: "attack", hit: false, damage: 0, targetHp: 24 }),
    ]);
  });

  it("冷却期间重复攻击不结算，推进到冷却结束才进行下一回合", () => {
    const session = createSession();

    session.attack(PLAYER_ID, SLIME_ID); // 11 伤害 → 13
    session.attack(PLAYER_ID, SLIME_ID); // 冷却中，无效果
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(13);

    session.advance(500);
    session.attack(PLAYER_ID, SLIME_ID); // 冷却还剩 500ms
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(13);

    session.advance(500); // 冷却归零，自动打出一回合 → 2
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(2);
  });

  it("射程外的攻击意图会让玩家自动接近，进入射程后结算", () => {
    const bundle = combatBundle();
    bundle.enemies[0].position = { x: 5, y: 0, z: 0 };
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    session.attack(PLAYER_ID, SLIME_ID);
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(24); // 尚未进入射程

    session.advance(1000);

    const player = entityOf(session, PLAYER_ID);
    expect(player.position.x).toBeGreaterThan(0);
    expect(entityOf(session, SLIME_ID).combat.hp).toBeLessThan(24);
  });

  it("未知实体、自攻击和死亡目标会显式报错", () => {
    const session = createSession();

    expect(() => session.attack(PLAYER_ID, "enemy:missing")).toThrow(/未知实体/);
    expect(() => session.attack(PLAYER_ID, PLAYER_ID)).toThrow(/自己/);
    expect(() => session.stopAttack("entity:missing")).toThrow(/未知实体/);
  });

  it("玩家只能攻击敌人，敌人只能攻击玩家", () => {
    const session = new GameSession({ random: () => 0 });
    session.addEntity(
      createEntity({
        id: PLAYER_ID,
        type: "player",
        templateId: "hero",
        displayName: "主角",
        baseAttributes: { maxHp: 10, hp: 10, attack: 1, defense: 0 },
      }),
    );
    session.addEntity(
      createEntity({
        id: "npc:helper",
        type: "npc",
        templateId: "npc_template:helper",
        displayName: "帮手",
        baseAttributes: { maxHp: 10, hp: 10 },
      }),
    );
    session.addEntity(
      createEntity({
        id: SLIME_ID,
        type: "enemy",
        templateId: "enemy_template:slime",
        displayName: "史莱姆",
        baseAttributes: { maxHp: 10, hp: 10, attack: 1, defense: 0 },
        tags: ["enemy"],
      }),
    );

    expect(() => session.attack(PLAYER_ID, "npc:helper")).toThrow(/只能攻击敌人/);
    expect(() => session.attack(SLIME_ID, "npc:helper")).toThrow(/只能攻击玩家/);
  });

  it("取消攻击会停止自动接近", () => {
    const bundle = combatBundle();
    bundle.enemies[0].position = { x: 6, y: 0, z: 0 };
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    session.attack(PLAYER_ID, SLIME_ID);
    session.advance(100);
    expect(entityOf(session, PLAYER_ID).movement).not.toBeNull();

    session.stopAttack(PLAYER_ID);
    expect(entityOf(session, PLAYER_ID).movement).toBeNull();
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(24); // 没有进入射程，未受伤害
  });
});

describe("GameSession 战斗：修饰器参与公式", () => {
  function sessionWithPlayer(options: {
    playerModifiers?: Parameters<typeof appendModifiers>[1];
    enemyModifiers?: Parameters<typeof appendModifiers>[1];
  }) {
    const base = createEntity({
      id: PLAYER_ID,
      type: "player",
      templateId: "hero",
      displayName: "主角",
      baseAttributes: { maxHp: 100, hp: 100, attack: 10, defense: 2 },
      position: { x: 0, y: 0, z: 0 },
    });
    const player = appendModifiers(base, options.playerModifiers ?? []);
    const enemyBase = createEntity({
      id: SLIME_ID,
      type: "enemy",
      templateId: "enemy_template:slime",
      displayName: "史莱姆",
      baseAttributes: { maxHp: 50, hp: 50, attack: 1, defense: 4 },
      position: { x: 1.5, y: 0, z: 0 },
      tags: ["enemy"],
    });
    const enemy = appendModifiers(enemyBase, options.enemyModifiers ?? []);
    const session = new GameSession({ random: () => 0 });
    session.addEntity(player);
    session.addEntity(enemy);
    return session;
  }

  it("攻击属性按 (base + Σadd) × (1 + Σmultiply) 参与伤害", () => {
    const session = sessionWithPlayer({
      playerModifiers: createModifiers(
        [
          { attribute: "attack", operation: "add", value: 5 },
          { attribute: "attack", operation: "multiply", value: 0.2 },
        ],
        { kind: "equipment", id: "sword" },
      ),
    });

    session.attack(PLAYER_ID, SLIME_ID);

    // (10 + 5) × 1.2 = 18；18 - 4 = 14
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(36);
  });

  it("防御修饰器参与减伤", () => {
    const session = sessionWithPlayer({
      enemyModifiers: createModifiers(
        [{ attribute: "defense", operation: "add", value: 3 }],
        { kind: "buff", id: "stoneskin" },
      ),
    });

    session.attack(PLAYER_ID, SLIME_ID);

    // 攻击方 10；目标防御 4 + 3 = 7 → 3
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(47);
  });
});

describe("GameSession 战斗：击杀、经验与掉落", () => {
  it("敌人死亡后进入 dead 状态，经验入属性、掉落进背包", () => {
    const session = createSession(0);

    session.attack(PLAYER_ID, SLIME_ID); // 24 → 13
    session.advance(1000); // 自动回合 #2：13 → 2
    session.advance(1000); // 自动回合 #3：2 → 0，死亡

    const slime = entityOf(session, SLIME_ID);
    expect(slime.combat.alive).toBe(false);
    expect(slime.combat.aiState).toBe("dead");
    expect(slime.combat.hp).toBe(0);

    const player = entityOf(session, PLAYER_ID);
    expect(player.attributes.xp).toBe(10);
    expect(player.container.items).toEqual([
      expect.objectContaining({ templateId: "item:slime_gel", quantity: 1, equipped: false }),
    ]);

    const events = session.drainEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "death", entityId: SLIME_ID, kind: "enemy" }),
        expect.objectContaining({ type: "xp", entityId: PLAYER_ID, amount: 10, total: 10 }),
        expect.objectContaining({
          type: "loot",
          entityId: PLAYER_ID,
          itemId: "item:slime_gel",
          quantity: 1,
        }),
      ]),
    );

    // 死亡后不再行动，也不能再被攻击。
    const before = entityOf(session, PLAYER_ID).combat.hp;
    session.advance(5000);
    expect(entityOf(session, PLAYER_ID).combat.hp).toBe(before);
    expect(() => session.attack(PLAYER_ID, SLIME_ID)).toThrow(/已死亡/);
  });

  it("掉落概率未通过时不产生物品与掉落事件", () => {
    const bundle = combatBundle();
    bundle.enemyTemplates[0].drops![0].chance = 0;
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    session.attack(PLAYER_ID, SLIME_ID);
    session.advance(1000);
    session.advance(1000);
    expect(entityOf(session, PLAYER_ID).container.items).toEqual([]);
    expect(session.drainEvents().some((event) => event.type === "loot")).toBe(false);
  });

  it("掉落按 maxStack 合并与拆栈，数量落在模板区间内", () => {
    const bundle = combatBundle();
    bundle.enemyTemplates[0].drops = [
      { itemId: "item:slime_gel", chance: 1, min: 2, max: 2 },
      { itemId: "item:slime_gel", chance: 1, min: 2, max: 2 },
    ];
    bundle.items[0].maxStack = 3;
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    session.attack(PLAYER_ID, SLIME_ID);
    session.advance(1000);
    session.advance(1000);

    // 共 4 个，maxStack=3 → 3 + 1
    expect(entityOf(session, PLAYER_ID).container.items).toEqual([
      expect.objectContaining({ templateId: "item:slime_gel", quantity: 3 }),
      expect.objectContaining({ templateId: "item:slime_gel", quantity: 1 }),
    ]);
  });
});

describe("GameSession 敌人 AI 状态机", () => {
  it("玩家在察觉范围外：idle 到时进入 patrol 并移动", () => {
    const bundle = combatBundle();
    bundle.enemies[0].position = { x: 20, y: 0, z: 0 };
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    expect(entityOf(session, SLIME_ID).combat.aiState).toBe("idle");

    session.advance(2000);
    expect(entityOf(session, SLIME_ID).combat.aiState).toBe("patrol");

    session.advance(500);
    const slime = entityOf(session, SLIME_ID);
    expect(Math.hypot(slime.position.x - 20, slime.position.z)).toBeGreaterThan(0);
  });

  it("玩家进入察觉范围：chase → attack，并持续造成伤害", () => {
    const bundle = combatBundle();
    bundle.enemies[0].position = { x: 5, y: 0, z: 0 };
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    session.advance(100);
    expect(entityOf(session, SLIME_ID).combat.aiState).toBe("chase");

    session.advance(2000);
    const slime = entityOf(session, SLIME_ID);
    expect(slime.combat.aiState).toBe("attack");
    expect(slime.combat.targetId).toBe(PLAYER_ID);
    // 敌人攻击 6 - 玩家防御 4 = 2；两秒内至少命中一次。
    expect(entityOf(session, PLAYER_ID).combat.hp).toBeLessThan(100);
  });

  it("被玩家攻击的敌人立即仇恨玩家并进入战斗", () => {
    const bundle = combatBundle();
    bundle.enemies[0].position = { x: 1.5, y: 0, z: 0 };
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    session.attack(PLAYER_ID, SLIME_ID);

    expect(entityOf(session, SLIME_ID).combat.targetId).toBe(PLAYER_ID);
    session.advance(100);
    expect(["chase", "attack"]).toContain(entityOf(session, SLIME_ID).combat.aiState);
  });
});

describe("GameSession 友好意图：死亡窗口", () => {
  it("玩家死亡等待重生时 tryAttack 返回失败而不是抛裸异常", () => {
    const session = new GameSession({ random: () => 0, respawnDelayMs: 10_000 });
    session.addEntity(
      createEntity({
        id: PLAYER_ID,
        type: "player",
        templateId: "player_template:hero",
        displayName: "旅人",
        baseAttributes: { maxHp: 1, hp: 1, attack: 1, defense: 0, moveSpeed: 0 },
      }),
    );
    session.addEntity(
      createEntity({
        id: "enemy:brute",
        type: "enemy",
        templateId: "enemy_template:brute",
        displayName: "蛮兵",
        baseAttributes: {
          maxHp: 50,
          hp: 50,
          attack: 10,
          defense: 0,
          moveSpeed: 0,
          attackRange: 2,
          aggroRadius: 100,
        },
      }),
    );

    session.attack("enemy:brute", PLAYER_ID);
    const player = entityOf(session, PLAYER_ID);
    expect(player.combat.alive).toBe(false);

    const result = session.tryAttack(PLAYER_ID, "enemy:brute");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/死亡|不能攻击/);
  });
});

describe("GameSession 玩家死亡与重生", () => {
  it("玩家死亡后延迟重生回出生点，生命回满，活着的敌人重置到出生点", () => {
    const bundle = combatBundle();
    bundle.regions[0].player.baseAttributes.hp = 5;
    bundle.regions[0].player.baseAttributes.maxHp = 5;
    bundle.regions[0].player.baseAttributes.defense = 0;
    const session = new GameSession({ random: () => 0, respawnDelayMs: 500 });
    session.loadRegion(bundle, REGION_ID);

    session.attack(PLAYER_ID, SLIME_ID); // 先打敌人一下，便于验证重生重置
    const damagedSlimeHp = entityOf(session, SLIME_ID).combat.hp;
    expect(damagedSlimeHp).toBe(13);

    session.moveTo(PLAYER_ID, { x: 3, y: 0, z: 0 });
    session.advance(600); // 敌人 6 伤害击杀 5 血玩家；重生延迟 500ms

    const events = session.drainEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "death", entityId: PLAYER_ID, kind: "player" }),
        expect.objectContaining({
          type: "respawn",
          entityId: PLAYER_ID,
          position: { x: 0, y: 0, z: 0 },
        }),
      ]),
    );

    const player = entityOf(session, PLAYER_ID);
    expect(player.combat.alive).toBe(true);
    expect(player.combat.hp).toBe(5);
    expect(player.position).toEqual({ x: 0, y: 0, z: 0 });

    const slime = entityOf(session, SLIME_ID);
    expect(slime.combat.hp).toBe(24); // 重置为满血
    expect(slime.position).toEqual({ x: 1.5, y: 0, z: 0 });
  });

  it("重生生命值使用修饰器后的 maxHp", () => {
    const base = createEntity({
      id: PLAYER_ID,
      type: "player",
      templateId: "hero",
      displayName: "主角",
      baseAttributes: { maxHp: 100, hp: 5, attack: 1, defense: 0 },
      position: { x: 0, y: 0, z: 0 },
    });
    const player = appendModifiers(
      base,
      createModifiers([{ attribute: "maxHp", operation: "add", value: 10 }], {
        kind: "quest",
        id: "reward",
      }),
    );
    const enemy = createEntity({
      id: SLIME_ID,
      type: "enemy",
      templateId: "enemy_template:slime",
      displayName: "史莱姆",
      baseAttributes: { maxHp: 50, hp: 50, attack: 6, defense: 0, moveSpeed: 3 },
      position: { x: 1.5, y: 0, z: 0 },
      tags: ["enemy"],
    });
    const session = new GameSession({ random: () => 0, respawnDelayMs: 100 });
    session.addEntity(player);
    session.addEntity(enemy);

    session.advance(200);

    const respawned = entityOf(session, PLAYER_ID);
    expect(respawned.combat.alive).toBe(true);
    expect(respawned.combat.hp).toBe(110); // (100 + 10) × 1
    expect(respawned.combat.maxHp).toBe(110);
  });
});

describe("GameSession 战斗快照", () => {
  it("快照暴露战斗状态与背包，且修改快照不穿透逻辑", () => {
    const session = createSession();
    session.attack(PLAYER_ID, SLIME_ID);

    const snapshot = session.snapshot();
    const pristine = session.snapshot();
    const slime = snapshot.entities.find((entity) => entity.id === SLIME_ID)!;
    expect(slime.combat).toEqual({
      hp: 13,
      maxHp: 24,
      attack: 6,
      defense: 1,
      alive: true,
      aiState: "chase",
      targetId: PLAYER_ID,
      attackCooldownMs: 0,
    });
    expect(slime.attributes).toMatchObject({ maxHp: 24, attack: 6, defense: 1, xp: 10 });

    slime.combat.hp = 0;
    slime.container.items.push({ instanceId: "x", templateId: "x", quantity: 1, equipped: false });

    expect(entityOf(session, SLIME_ID).combat.hp).toBe(13);
    expect(entityOf(session, SLIME_ID).container.items).toEqual([]);
    expect(JSON.parse(session.serialize())).toEqual(pristine);
  });
});
