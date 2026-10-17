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
  it("老 v2 档升级后得到 1 级 / 经验从实体属性迁上来 / 空世界状态", () => {
    const migrated = migrateSave(v2Save());
    expect(migrated.version).toBe(3);

    const snapshot = readSessionSnapshot(migrated);
    expect(snapshot.playerLevel).toBe(1);
    // 经验在老档里本来就存在（实体属性 xp=250），写成 0 会让玩家丢一半进度。
    expect(snapshot.cumulativeXp).toBe(250);
    expect(snapshot.worldState).toEqual({});
  });

  it("迁移后的经验与实体属性一致（单一真相源，读档后不分叉）", () => {
    const snapshot = readSessionSnapshot(migrateSave(v2Save()));
    expect(snapshot.entities[0].baseAttributes.xp).toBe(snapshot.cumulativeXp);
  });

  it("老 v2 档里没有 xp 属性时经验补 0", () => {
    const save = v2Save();
    const session = save.sections.session as Record<string, unknown>;
    delete (session.entities as Array<Record<string, unknown>>)[0].baseAttributes;

    const snapshot = readSessionSnapshot(migrateSave(save));
    expect(snapshot.cumulativeXp).toBe(0);
  });

  it("v2 档里已存在的 cumulativeXp 被实体属性覆盖（迁移是唯一写入口）", () => {
    const save = v2Save();
    const session = save.sections.session as Record<string, unknown>;
    session.cumulativeXp = 9999;

    const snapshot = readSessionSnapshot(migrateSave(save));
    expect(snapshot.cumulativeXp).toBe(250);
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