/**
 * 票 34：经验入账 → 跨阈值 → 升级 → 属性入账 → 事件发射。
 *
 * 接缝 = GameSession 的公开面：loadRegion（带等级曲线）+ attack（战斗结算）
 * + subscribe（升级事件）。逻辑层是唯一入口，测试不碰内部字段。
 */

import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import type { EntitySnapshot, GameSessionSnapshot } from "./game-session";
import type { GameSessionEvent } from "./game-events";
import { GameSession } from "./game-session";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";
const SLIME_ID = "enemy:slime";

/**
 * 合同曲线：L2=100、L3=250、L4=450；每级 +2 攻 +2 防 +10 maxHp。
 * 史莱姆 24 血、玩家 12 攻 4 防 → 普攻 11 伤害，两击必杀，每杀给 25 经验。
 */
function arenaBundle(): ContentBundle {
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
          maxHp: 24,
          hp: 24,
          attack: 0,
          defense: 1,
          moveSpeed: 3,
          aggroRadius: 0,
          patrolRadius: 0,
          xp: 25,
        },
        tags: ["enemy", "slime"],
      },
    ],
    // P1 的敌人死后不自动刷新：多摆几只，够连续拿经验。
    enemies: Array.from({ length: 16 }, (_, index) => ({
      id: index === 0 ? SLIME_ID : `enemy:slime_${index}`,
      templateId: "enemy_template:slime",
      displayName: "草原史莱姆",
      regionId: REGION_ID,
      position: { x: 1.5, y: 0, z: 0 },
    })),
    items: [],
    quests: [],
    levelCurves: [
      {
        id: "level_curve:standard",
        displayName: "标准曲线",
        defaultModifiers: [
          { attribute: "attack", operation: "add", value: 2 },
          { attribute: "defense", operation: "add", value: 2 },
          { attribute: "maxHp", operation: "add", value: 10 },
        ],
        levels: [
          { level: 1, xpRequired: 0 },
          { level: 2, xpRequired: 100 },
          { level: 3, xpRequired: 250 },
          { level: 4, xpRequired: 450 },
        ],
      },
    ],
  };
}

interface Harness {
  session: GameSession;
  events: GameSessionEvent[];
  snapshot: () => GameSessionSnapshot;
  enemyIds: () => string[];
  alive: (enemyId: string) => boolean;
  player: () => EntitySnapshot;
}

function createSession(bundle: ContentBundle = arenaBundle()): Harness {
  const session = new GameSession({ random: () => 0 });
  const events: GameSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  session.loadRegion(bundle, REGION_ID);
  return {
    session,
    events,
    snapshot: () => session.snapshot(),
    enemyIds: () =>
      session
        .snapshot()
        .entities.filter((entity) => entity.identity.type === "enemy")
        .map((entity) => entity.id),
    alive: (enemyId: string) =>
      session.snapshot().entities.find((entity) => entity.id === enemyId)?.combat.alive ?? false,
    player: () => {
      const found = session.snapshot().entities.find((entity) => entity.id === PLAYER_ID);
      if (!found) {
        throw new Error("快照里没有玩家");
      }
      return found;
    },
  };
}

/**
 * 一击 11 伤害：24 → 13 → 2 → 0 致死，一只史莱姆三击、25 经验。
 * 普攻间隔 1s（DEFAULT_ATTACK_INTERVAL_MS），每击之间推进时钟等冷却。
 */
function killSlime(harness: Harness, enemyId: string): void {
  for (let hit = 0; hit < 3; hit += 1) {
    if (!harness.alive(enemyId)) {
      return;
    }
    harness.session.attack(PLAYER_ID, enemyId);
    // 普攻间隔 1s：推进时钟等冷却。战斗循环也可能在这段时间里把致死一击打出来。
    harness.session.advance(1_000);
  }
}

/** 一次杀 4 只 → 100 经验，刚好摸到 L2 阈值。只打还活着的（P1 死掉的敌人不刷新）。 */
function killFourSlimes(harness: Harness): void {
  let killed = 0;
  for (const enemyId of harness.enemyIds()) {
    if (killed >= 4) {
      return;
    }
    if (!harness.alive(enemyId)) {
      continue;
    }
    killSlime(harness, enemyId);
    killed += 1;
  }
}

describe("等级系统：经验入账结算升级", () => {
  it("未跨阈值只加经验、不升级", () => {
    const harness = createSession();
    killSlime(harness, harness.enemyIds()[0]);

    expect(harness.player().baseAttributes.xp).toBe(25);
    expect(harness.events.filter((event) => event.type === "player-level-up")).toHaveLength(0);
  });

  it("累计经验跨过 100 即升到 2 级：攻击/防御/maxHp 各 +2/+2/+10 并发射事件", () => {
    const harness = createSession();
    killFourSlimes(harness);

    expect(harness.player().baseAttributes.xp).toBe(100);
    const levelUps = harness.events.filter((event) => event.type === "player-level-up");
    expect(levelUps).toHaveLength(1);
    expect(levelUps[0]).toMatchObject({
      type: "player-level-up",
      entityId: PLAYER_ID,
      level: 2,
    });
    expect(harness.player().attributes.attack).toBe(14);
    expect(harness.player().attributes.defense).toBe(6);
    expect(harness.player().combat.maxHp).toBe(110);
  });

  it("一次入账跨过多级时逐级结算，每级各发一个事件", () => {
    const bundle = arenaBundle();
    bundle.enemyTemplates[0].baseAttributes.xp = 80; // 四只 = 320，越过 L2 与 L3
    const harness = createSession(bundle);
    killFourSlimes(harness);

    const levelUps = harness.events.filter((event) => event.type === "player-level-up");
    expect(levelUps.map((event) => (event.type === "player-level-up" ? event.level : null))).toEqual([
      2, 3,
    ]);
    expect(harness.player().attributes.attack).toBe(16);
    expect(harness.player().combat.maxHp).toBe(120);
  });

  it("升级加成的属性变化逐项列在事件里，供 HUD 飘字消费", () => {
    const harness = createSession();
    killFourSlimes(harness);

    const levelUp = harness.events.find(
      (event): event is Extract<GameSessionEvent, { type: "player-level-up" }> =>
        event.type === "player-level-up",
    );
    expect(levelUp).toBeDefined();
    expect(levelUp?.attributesGained).toEqual(
      expect.arrayContaining([
        { attribute: "attack", delta: 2 },
        { attribute: "defense", delta: 2 },
        { attribute: "maxHp", delta: 10 },
      ]),
    );
  });

  it("没带等级曲线的会话仍然只加经验、不崩（成长系统可选接入）", () => {
    const bundle = arenaBundle();
    delete bundle.levelCurves;
    const harness = createSession(bundle);
    killFourSlimes(harness);

    expect(harness.player().baseAttributes.xp).toBe(100);
    expect(harness.events.filter((event) => event.type === "player-level-up")).toHaveLength(0);
    expect(harness.player().attributes.attack).toBe(12);
  });
});

describe("等级系统：升级状态快照往返", () => {
  it("读档后等级与累计经验不丢、属性加成不重复入账", () => {
    const harness = createSession();
    killFourSlimes(harness);
    const saved = JSON.parse(JSON.stringify(harness.snapshot()));

    const reloaded = createSession();
    reloaded.session.restoreSnapshot(saved);
    const player = reloaded.player();

    // 等级与经验随快照往返（字段由票 31 的快照 v3 承载；此处断言表现层可见的事实）。
    expect(player.baseAttributes.xp).toBe(100);
    expect(player.attributes.attack).toBe(14);
    expect(player.combat.maxHp).toBe(110);

    // 读档后再拿经验，升级从存档点继续，而不是从头叠一遍。
    killFourSlimes(reloaded);
    expect(reloaded.player().baseAttributes.xp).toBe(200);
    // 仍停在 L2：200 < 250，属性不能因为读档被重算成 L3。
    expect(reloaded.player().attributes.attack).toBe(14);
    expect(reloaded.player().combat.maxHp).toBe(110);
  });
});