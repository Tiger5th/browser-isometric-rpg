/**
 * 票 31：v2 → v3 迁移在补 heavyCooldownMs 之外，一并补齐成长字段与
 * worldState 容器默认值——老档永远能读，且不需要玩家手动迁移。
 */

import { describe, expect, it } from "vitest";

import { migrateSave, readSessionSnapshot, type SaveFile } from "./save";

const REGION_ID = "region:arena";

/** 一份票 27 时代的 v2 存档：没有 playerLevel / cumulativeXp / worldState。 */
function v2Save(): SaveFile {
  return {
    version: 2,
    sections: {
      session: {
        version: 2,
        regionId: REGION_ID,
        elapsedMs: 4200,
        nextItemInstanceId: 1,
        respawnAtMs: null,
        entities: [
          {
            id: "entity:player",
            identity: {
              type: "player",
              templateId: "player_template:hero",
              displayName: "旅人",
            },
            position: { x: 1, y: 0, z: 2 },
            rotation: { x: 0, y: 0, z: 0 },
            tags: [],
            movement: null,
            baseAttributes: { maxHp: 100, hp: 90, attack: 12, defense: 4, xp: 250 },
            attributes: { maxHp: 100, hp: 90, attack: 12, defense: 4, xp: 250 },
            modifiers: [],
            combat: {
              hp: 90,
              maxHp: 100,
              attack: 12,
              defense: 4,
              alive: true,
              aiState: null,
              targetId: null,
              attackCooldownMs: 0,
            },
            container: { items: [] },
            claimedRewardIds: [],
          },
        ],
        dialogue: null,
        quests: [],
      },
    },
  };
}

describe("迁移链 v2 → v3：成长字段与 worldState 默认值", () => {
  it("老 v2 档升级后得到 1 级 / 0 经验 / 空世界状态", () => {
    const migrated = migrateSave(v2Save());
    expect(migrated.version).toBe(3);

    const snapshot = readSessionSnapshot(migrated);
    expect(snapshot.playerLevel).toBe(1);
    expect(snapshot.cumulativeXp).toBe(0);
    expect(snapshot.worldState).toEqual({});
  });

  it("老 v2 档里的实体 xp 属性不被迁移成累计经验（字段分层明确）", () => {
    const snapshot = readSessionSnapshot(migrateSave(v2Save()));
    const player = snapshot.entities[0];
    expect(player.baseAttributes.xp).toBe(250);
    expect(snapshot.cumulativeXp).toBe(0);
  });

  it("v2 档里已存在的 worldState 结构原样保留", () => {
    const save = v2Save();
    const session = save.sections.session as Record<string, unknown>;
    session.worldState = { "chest:cave_01": { opened: true } };

    const snapshot = readSessionSnapshot(migrateSave(save));
    expect(snapshot.worldState).toEqual({ "chest:cave_01": { opened: true } });
  });

  it("负向：已带 playerLevel 的伪 v2 档被覆盖为迁移默认值（迁移是唯一写入口）", () => {
    const save = v2Save();
    const session = save.sections.session as Record<string, unknown>;
    session.playerLevel = 99;

    const snapshot = readSessionSnapshot(migrateSave(save));
    expect(snapshot.playerLevel).toBe(1);
  });
});