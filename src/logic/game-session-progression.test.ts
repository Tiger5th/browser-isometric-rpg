/**
 * 票 31：快照 v3 追加玩家成长字段（playerLevel / cumulativeXp）与 worldState
 * 通用容器。等级结算本体是票 34，本票只负责「字段存在 + 默认值 + 往返」。
 *
 * 接缝 = GameSession.snapshot() / restoreSnapshot() + 读档校验。
 */

import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { GameSession } from "./game-session";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";

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
    enemyTemplates: [],
    enemies: [],
    items: [],
    quests: [],
  };
}

function createSession(): GameSession {
  const session = new GameSession({ random: () => 0 });
  session.loadRegion(bundle(), REGION_ID);
  return session;
}

describe("快照 v3：玩家成长字段", () => {
  it("新会话默认 1 级、0 累计经验、空世界状态", () => {
    const snapshot = createSession().snapshot();

    expect(snapshot.playerLevel).toBe(1);
    expect(snapshot.cumulativeXp).toBe(0);
    expect(snapshot.worldState).toEqual({});
  });

  it("读档后等级与累计经验按存档点恢复（升级进度不丢）", () => {
    const saved = createSession();
    const savepoint = structuredClone(saved.snapshot());
    savepoint.playerLevel = 4;
    savepoint.cumulativeXp = 1370;

    const loaded = createSession();
    loaded.restoreSnapshot(savepoint);

    const restored = loaded.snapshot();
    expect(restored.playerLevel).toBe(4);
    expect(restored.cumulativeXp).toBe(1370);
  });

  it("负向：非整数等级 / 负经验 / 非对象世界状态整体拒绝读档", () => {
    const session = createSession();
    const savepoint = session.snapshot();

    const badLevel = structuredClone(savepoint);
    badLevel.playerLevel = 0;
    expect(() => session.restoreSnapshot(badLevel)).toThrow(/playerLevel/);

    const badXp = structuredClone(savepoint);
    badXp.cumulativeXp = -1;
    expect(() => session.restoreSnapshot(badXp)).toThrow(/cumulativeXp/);

    const badWorld = structuredClone(savepoint);
    (badWorld as unknown as Record<string, unknown>).worldState = [];
    expect(() => session.restoreSnapshot(badWorld)).toThrow(/worldState/);

    expect(session.snapshot()).toEqual(savepoint);
  });
});

describe("快照 v3：worldState 通用容器只透传不解释", () => {
  it("任意 JsonValue 结构原样往返（宝箱开启/收集计数/机关状态等）", () => {
    const session = createSession();
    const savepoint = structuredClone(session.snapshot());
    savepoint.worldState = {
      "chest:cave_01": { opened: true, openedAtMs: 4200 },
      "collect:glow_moss": 3,
      "gate:main_door": "unlocked",
      "flags": { tutorialDone: true, deaths: 2 },
      "disabledEnemies": ["enemy:slime_meadow", "enemy:slime_cave"],
    };

    const loaded = createSession();
    loaded.restoreSnapshot(savepoint);

    expect(loaded.snapshot().worldState).toEqual(savepoint.worldState);
  });

  it("读档时 worldState 里的可变对象不被会话内部持有（改动不影响快照）", () => {
    const session = createSession();
    const savepoint = structuredClone(session.snapshot());
    savepoint.worldState = { "chest:cave_01": { opened: true } };

    session.restoreSnapshot(savepoint);
    const world = session.snapshot().worldState as Record<string, { opened: boolean }>;
    world["chest:cave_01"].opened = false;

    expect(session.snapshot().worldState).toEqual({ "chest:cave_01": { opened: true } });
  });

  it("负向：世界状态里的非 JSON 值（函数/undefined）被拒绝", () => {
    const session = createSession();
    const savepoint = structuredClone(session.snapshot());
    (savepoint.worldState as Record<string, unknown>).bad = () => 0;

    expect(() => session.restoreSnapshot(savepoint)).toThrow(/worldState/);
  });
});