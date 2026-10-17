import { describe, expect, it } from "vitest";

import { createContentIndex, instantiateRegionEntities } from "./region-loader";
import type { ContentBundle } from "./types";

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
          spawn: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
          },
          baseAttributes: { maxHp: 100, hp: 100, attack: 12, defense: 4 },
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
        tags: ["npc", "quest-giver"],
      },
      {
        id: "npc:scout_lin",
        displayName: "林斥候",
        templateId: "npc_template:scout",
        regionId: "region:green_hollow",
        position: { x: -6, y: 0, z: 3 },
      },
      {
        id: "npc:far_away",
        displayName: "远处的人",
        templateId: "npc_template:scout",
        regionId: "region:elsewhere",
        position: { x: 100, y: 0, z: 100 },
      },
    ],
    enemyTemplates: [
      {
        id: "enemy_template:slime",
        displayName: "翠谷史莱姆",
        aiProfileId: "ai:melee_chaser",
        baseAttributes: { maxHp: 30, hp: 30, attack: 6, defense: 1, moveSpeed: 3 },
        tags: ["enemy", "slime"],
        drops: [{ itemId: "item:slime_gel", chance: 1, min: 1, max: 2 }],
      },
    ],
    enemies: [
      {
        id: "enemy:slime_meadow",
        templateId: "enemy_template:slime",
        displayName: "草原史莱姆",
        regionId: "region:green_hollow",
        position: { x: 12, y: 0, z: -4 },
        overrides: { baseAttributes: { maxHp: 24, hp: 24 } },
      },
      {
        id: "enemy:slime_blue",
        templateId: "enemy_template:slime",
        displayName: "溪边史莱姆",
        regionId: "region:green_hollow",
        position: { x: 14, y: 0, z: -6 },
        tags: ["elite"],
      },
      {
        id: "enemy:slime_far",
        templateId: "enemy_template:slime",
        displayName: "远处的史莱姆",
        regionId: "region:elsewhere",
        position: { x: 50, y: 0, z: 50 },
      },
    ],
    items: [],
    quests: [],
  };
}

function byId(entities: ReturnType<typeof instantiateRegionEntities>) {
  return new Map(entities.map((entity) => [entity.id as string, entity]));
}

describe("从内容数据实例化区域实体", () => {
  it("只实例化本区域的玩家/NPC/敌人，位置与身份来自内容数据", () => {
    const index = createContentIndex(fixtureBundle());
    const entities = instantiateRegionEntities(index, "region:green_hollow");
    const map = byId(entities);

    expect([...map.keys()]).toEqual([
      "entity:player",
      "npc:elder_ma",
      "npc:scout_lin",
      "enemy:slime_blue",
      "enemy:slime_meadow",
    ]);

    const player = map.get("entity:player")!;
    expect(player.identity).toEqual({
      type: "player",
      templateId: "player_template:hero",
      displayName: "旅人",
    });
    expect(player.state.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(player.baseAttributes).toEqual({ maxHp: 100, hp: 100, attack: 12, defense: 4 });

    const elder = map.get("npc:elder_ma")!;
    expect(elder.identity.type).toBe("npc");
    expect(elder.state.position).toEqual({ x: 6, y: 0, z: 4 });
    expect(elder.references.dialogueId).toBe("elder_ma");
    expect(elder.references.questIds).toEqual(["quest:cull_slimes"]);
    expect(elder.state.tags).toEqual(["npc", "quest-giver"]);

    const scout = map.get("npc:scout_lin")!;
    expect(scout.state.tags).toEqual(["npc"]);
  });

  it("敌人从模板继承属性，实例覆盖优先，标签合并去重", () => {
    const index = createContentIndex(fixtureBundle());
    const map = byId(instantiateRegionEntities(index, "region:green_hollow"));

    const meadow = map.get("enemy:slime_meadow")!;
    expect(meadow.identity.type).toBe("enemy");
    expect(meadow.identity.templateId).toBe("enemy_template:slime");
    expect(meadow.baseAttributes).toEqual({
      maxHp: 24,
      hp: 24,
      attack: 6,
      defense: 1,
      moveSpeed: 3,
    });
    expect(meadow.state.tags).toEqual(["enemy", "slime"]);
    expect(meadow.references.aiProfileId).toBe("ai:melee_chaser");

    const blue = map.get("enemy:slime_blue")!;
    expect(blue.baseAttributes.maxHp).toBe(30);
    expect(blue.state.tags).toEqual(["enemy", "slime", "elite"]);
  });

  it("未知区域、重复内容 id 与重复实体 id 会显式报错", () => {
    const index = createContentIndex(fixtureBundle());
    expect(() => instantiateRegionEntities(index, "region:missing")).toThrow(/未知区域/);

    const duplicated = fixtureBundle();
    duplicated.npcs.push({ ...duplicated.npcs[0] });
    expect(() => createContentIndex(duplicated)).toThrow(/重复/);

    const conflicting = fixtureBundle();
    conflicting.npcs.push({
      id: "entity:player",
      displayName: "同名实体",
      templateId: "npc_template:elder",
      regionId: "region:green_hollow",
      position: { x: 1, y: 0, z: 1 },
    });
    const conflictingIndex = createContentIndex(conflicting);
    expect(() => instantiateRegionEntities(conflictingIndex, "region:green_hollow")).toThrow(
      /重复/,
    );
  });
});
