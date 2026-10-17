import { describe, expect, it } from "vitest";

import { GameSession } from "./game-session";
import type { ContentBundle } from "./content/types";

function fixtureBundle(): ContentBundle {
  return {
    regions: [
      {
        id: "region:green_hollow",
        displayName: "翠谷",
        asset: { model: "assets/regions/green_hollow.glb" },
        player: {
          id: "entity:player",
          templateId: "player_template:hero",
          displayName: "旅人",
          spawn: { position: { x: 1, y: 0, z: 2 } },
          baseAttributes: { maxHp: 100, hp: 100, attack: 12 },
        },
      },
    ],
    npcs: [
      {
        id: "npc:elder_ma",
        displayName: "马婆婆",
        templateId: "npc_template:elder",
        regionId: "region:green_hollow",
        position: { x: 6, y: 0, z: 4 },
        dialogueId: "elder_ma",
        questIds: ["quest:cull_slimes"],
      },
    ],
    enemyTemplates: [
      {
        id: "enemy_template:slime",
        displayName: "史莱姆",
        aiProfileId: "ai:melee_chaser",
        baseAttributes: { maxHp: 30, hp: 30, attack: 6 },
        tags: ["enemy"],
      },
    ],
    enemies: [
      {
        id: "enemy:slime_meadow",
        templateId: "enemy_template:slime",
        displayName: "草原史莱姆",
        regionId: "region:green_hollow",
        position: { x: 12, y: 0, z: -4 },
      },
    ],
    items: [],
    quests: [],
  };
}

function snapshotById(session: GameSession) {
  return new Map(session.snapshot().entities.map((entity) => [entity.id as string, entity]));
}

describe("GameSession 从内容数据加载区域", () => {
  it("loadRegion 实例化玩家/NPC/敌人，并记录当前区域", () => {
    const session = new GameSession();

    session.loadRegion(fixtureBundle(), "region:green_hollow");

    expect(session.currentRegionId).toBe("region:green_hollow");
    const entities = snapshotById(session);
    expect([...entities.keys()]).toEqual([
      "enemy:slime_meadow",
      "entity:player",
      "npc:elder_ma",
    ]);
    expect(entities.get("entity:player")!.position).toEqual({ x: 1, y: 0, z: 2 });
    expect(entities.get("npc:elder_ma")!.identity.type).toBe("npc");
    expect(entities.get("enemy:slime_meadow")!.identity.templateId).toBe(
      "enemy_template:slime",
    );
  });

  it("加载后的实体可以直接接受意图", () => {
    const session = new GameSession();
    session.loadRegion(fixtureBundle(), "region:green_hollow");

    session.moveTo("npc:elder_ma", { x: 8, y: 0, z: 4 });
    session.advance(1000);

    expect(snapshotById(session).get("npc:elder_ma")!.position.x).toBeCloseTo(8);
  });

  it("重复加载或未知区域会显式报错，且不留下半加载状态", () => {
    const session = new GameSession();
    expect(() => session.loadRegion(fixtureBundle(), "region:missing")).toThrow(/未知区域/);
    expect(session.currentRegionId).toBeNull();
    expect(session.snapshot().entities).toEqual([]);

    session.loadRegion(fixtureBundle(), "region:green_hollow");
    expect(() => session.loadRegion(fixtureBundle(), "region:green_hollow")).toThrow(
      /已加载区域/,
    );
  });
});
