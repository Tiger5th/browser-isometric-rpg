/**
 * 票 27：快照 v2→v3（重击冷却剩余进快照）+ 迁移链。
 *
 * 接缝 = GAME_SESSION_SNAPSHOT_VERSION / snapshot() / restoreSnapshot() /
 * migrateSave()。v3 只新增「重击冷却剩余」一个实体级字段（与普攻冷却并列），
 * 结构上为票 31 的等级/经验/worldState 预留顶层扩展位（不提前实现）。
 */

import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { GAME_SESSION_SNAPSHOT_VERSION, GameSession } from "./game-session";
import type { GameSessionSnapshot } from "./game-session";
import { migrateSave, readSessionSnapshot, type SaveFile } from "./save";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";
const SLIME_ID = "enemy:slime";

function bundle(): ContentBundle {
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
          attack: 0,
          defense: 1,
          moveSpeed: 0.001, // 读档校验要求移动速度为正
          xp: 0,
          aggroRadius: 0,
        },
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
        overrides: { baseAttributes: { maxHp: 200, hp: 200 } },
      },
    ],
    items: [],
    quests: [],
  };
}

function createSession(): GameSession {
  const session = new GameSession({ random: () => 0 });
  session.loadRegion(bundle(), REGION_ID);
  return session;
}

function playerOf(snapshot: GameSessionSnapshot) {
  const player = snapshot.entities.find((entity) => entity.id === PLAYER_ID);
  if (player === undefined) {
    throw new Error("快照中缺少玩家");
  }
  return player;
}

describe("GameSession 快照 v3：重击冷却进快照", () => {
  it("快照版本是 3，combat 暴露 heavyCooldownMs", () => {
    const session = createSession();

    session.heavyAttack(PLAYER_ID, SLIME_ID);
    session.advance(3000); // 冷却剩 5000

    const snapshot = session.snapshot();
    expect(GAME_SESSION_SNAPSHOT_VERSION).toBe(3);
    expect(snapshot.version).toBe(3);
    expect(playerOf(snapshot).combat.heavyCooldownMs).toBe(5000);
  });

  it("读档后重击冷却按存档点恢复，冷却中不能再重击", () => {
    const saved = createSession();
    saved.heavyAttack(PLAYER_ID, SLIME_ID); // 起手即锁 8000 重击冷却
    saved.advance(3000); // 前摇 600ms 后第一击落地；冷却剩 5000
    const savepoint = saved.snapshot();

    const loaded = createSession();
    loaded.restoreSnapshot(savepoint);

    expect(playerOf(loaded.snapshot()).combat.heavyCooldownMs).toBe(5000);
    expect(loaded.tryHeavyAttack(PLAYER_ID, SLIME_ID).ok).toBe(false); // 冷却中拒绝

    loaded.advance(5000); // t=8000 冷却归零
    expect(playerOf(loaded.snapshot()).combat.heavyCooldownMs).toBe(0);
    loaded.heavyAttack(PLAYER_ID, SLIME_ID); // 起前摇（等普攻回合结束）
    loaded.advance(1000);
    loaded.advance(600); // 第二击
    const slime = loaded.snapshot().entities.find((e) => e.id === SLIME_ID)!;
    expect(slime.combat.hp).toBe(78); // 200 - 17 - 8×11 - 17
  });

  it("重击冷却与普攻冷却各自推进：重击冷却 8000 而自动回合按普攻间隔继续", () => {
    const session = createSession();

    session.heavyAttack(PLAYER_ID, SLIME_ID); // 起手
    expect(playerOf(session.snapshot()).combat.heavyCooldownMs).toBe(8000);
    expect(playerOf(session.snapshot()).combat.attackCooldownMs).toBe(1000);

    session.advance(1000); // 普攻先打一回合（-11），重击冷却继续走
    expect(session.snapshot().entities.find((e) => e.id === SLIME_ID)!.combat.hp).toBe(172);
    expect(playerOf(session.snapshot()).combat.heavyCooldownMs).toBe(7000);
    expect(playerOf(session.snapshot()).combat.attackCooldownMs).toBe(1000);

    session.advance(7000); // 重击冷却归零；期间普攻继续按 1s 间隔
    expect(playerOf(session.snapshot()).combat.heavyCooldownMs).toBe(0);
    expect(session.snapshot().entities.find((e) => e.id === SLIME_ID)!.combat.hp).toBe(95);
  });

  it("负向：heavyCooldownMs 非法（负数/非数/字符串）整体拒绝读档", () => {
    const session = createSession();
    const savepoint = session.snapshot();

    for (const bad of [-1, Number.NaN, "5000", null]) {
      const corrupted = structuredClone(savepoint);
      (corrupted.entities[0].combat as unknown as Record<string, unknown>).heavyCooldownMs =
        bad;
      expect(() => session.restoreSnapshot(corrupted)).toThrow(/heavyCooldownMs/);
    }
    expect(session.snapshot()).toEqual(savepoint);
  });
});

describe("存档迁移链：v2 → v3", () => {
  /** 构造一份 v2 存档（没有 heavyCooldownMs 字段）。 */
  function v2Save(): SaveFile {
    const v2Snapshot: GameSessionSnapshot = {
      version: 2,
      regionId: REGION_ID,
      elapsedMs: 1000,
      nextItemInstanceId: 1,
      respawnAtMs: null,
      entities: [
        {
          id: PLAYER_ID as GameSessionSnapshot["entities"][number]["id"],
          identity: {
            type: "player",
            templateId: "player_template:hero",
            displayName: "旅人",
          },
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          tags: [],
          movement: null,
          baseAttributes: { maxHp: 100, hp: 100, attack: 12, defense: 4 },
          attributes: { maxHp: 100, hp: 100, attack: 12, defense: 4 },
          modifiers: [],
          combat: {
            hp: 100,
            maxHp: 100,
            attack: 12,
            defense: 4,
            alive: true,
            aiState: null,
            targetId: null,
            attackCooldownMs: 0,
            heavyCooldownMs: 0,
          },
          container: { items: [] },
          claimedRewardIds: [],
        },
      ],
      dialogue: null,
      quests: [],
    };
    return {
      version: 2,
      sections: { session: v2Snapshot as unknown as Record<string, unknown> },
    };
  }

  it("v2 存档经 migrateSave 升级到 v3 并补齐 heavyCooldownMs=0", () => {
    const migrated = migrateSave(v2Save());
    expect(migrated.version).toBe(3);
    const session = readSessionSnapshot(migrated);
    expect(session.version).toBe(3);
    expect(playerOf(session).combat.heavyCooldownMs).toBe(0);
  });

  it("迁移后的存档可直接恢复进会话，且结构逐字段一致", () => {
    const migrated = readSessionSnapshot(migrateSave(v2Save()));
    const session = createSession();
    session.restoreSnapshot(migrated);

    const restored = session.snapshot();
    expect(restored.version).toBe(3);
    expect(playerOf(restored).combat.hp).toBe(100);
    expect(playerOf(restored).combat.heavyCooldownMs).toBe(0);
    expect(restored.elapsedMs).toBe(1000);
  });

  it("v1 → v2 → v3 链式迁移后同样补齐新字段", () => {
    const legacy: SaveFile = {
      version: 1,
      sections: {
        world: { regionId: REGION_ID, elapsedMs: 500 },
        player: {
          attributes: { maxHp: 100, hp: 80, attack: 12, defense: 4 },
          inventory: [],
        },
        quests: [],
      },
    };

    const migrated = migrateSave(legacy);
    expect(migrated.version).toBe(3);
    const session = readSessionSnapshot(migrated);
    expect(session.version).toBe(3);
    expect(playerOf(session).combat.heavyCooldownMs).toBe(0);

    const game = createSession();
    game.restoreSnapshot(session);
    expect(playerOf(game.snapshot()).combat.hp).toBe(80);
  });

  it("负向：未来版本（v4）存档被拒绝，绝不静默降级", () => {
    const future = v2Save();
    future.version = 4;
    expect(() => migrateSave(future)).toThrow(/高于当前支持版本/);
  });

  it("负向：v3 存档缺 heavyCooldownMs 时读档报错而不是默认放行", () => {
    const session = createSession();
    const savepoint = session.snapshot();
    const stripped = structuredClone(savepoint);
    delete (stripped.entities[0].combat as unknown as Record<string, unknown>)
      .heavyCooldownMs;

    expect(() => session.restoreSnapshot(stripped)).toThrow(/heavyCooldownMs/);
  });
});
