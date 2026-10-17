import { describe, expect, it } from "vitest";

import {
  SAVE_VERSION,
  SaveMigrationError,
  SaveMigrationRegistry,
  createSaveMigrationRegistry,
  migrateSave,
  parseSaveFile,
  serializeSaveFile,
  type SaveFile,
} from "./save";

function sampleV1Save(): SaveFile {
  return {
    version: 1,
    sections: {
      world: { regionId: "harbor", timeOfDay: 8.5 },
      player: {
        attributes: { attack: 10, maxHealth: 100 },
        inventory: [
          { id: "iron-sword", qty: 1 },
          { id: "potion", qty: 3 },
        ],
      },
      quests: { active: ["q1"], completed: [] },
    },
  };
}

describe("v1 → v2 迁移", () => {
  it("把 player 分节升级为 entities.player + systems.quests", () => {
    const migrated = migrateSave(sampleV1Save());

    expect(migrated).toEqual({
      version: 2,
      sections: {
        world: { regionId: "harbor", timeOfDay: 8.5 },
        entities: {
          player: {
            baseAttributes: { attack: 10, maxHealth: 100 },
            modifiers: [],
            container: {
              items: [
                {
                  instanceId: "iron-sword#0",
                  templateId: "iron-sword",
                  quantity: 1,
                  equipped: false,
                },
                {
                  instanceId: "potion#1",
                  templateId: "potion",
                  quantity: 3,
                  equipped: false,
                },
              ],
            },
            claimedRewardIds: [],
          },
        },
        systems: { quests: { active: ["q1"], completed: [] } },
      },
    });
  });

  it("不修改调用方传入的旧存档", () => {
    const input = sampleV1Save();
    const snapshot = JSON.stringify(input);

    migrateSave(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("迁移函数拿到的是副本，即使原地修改也不会污染输入", () => {
    const registry = new SaveMigrationRegistry();
    registry.register(1, (save) => {
      save.sections.injectedByMigration = true;
      return { version: 2, sections: { ...save.sections } };
    });
    const input = sampleV1Save();

    registry.migrate(input);

    expect(input.sections.injectedByMigration).toBeUndefined();
  });

  it("旧存档经 JSON 往返后仍可迁移", () => {
    const roundTripped = parseSaveFile(JSON.stringify(sampleV1Save()));

    expect(migrateSave(roundTripped).version).toBe(2);
  });

  it("当前版本存档原样通过，并返回独立副本", () => {
    const latest: SaveFile = { version: SAVE_VERSION, sections: { world: { regionId: "harbor" } } };

    const migrated = migrateSave(latest);
    expect(migrated).toEqual(latest);

    (migrated.sections.world as Record<string, unknown>).regionId = "changed";
    expect((latest.sections.world as Record<string, unknown>).regionId).toBe("harbor");
  });
});

describe("迁移函数注册表", () => {
  it("按顺序执行多级迁移链 v1 → v2 → v3", () => {
    const registry = createSaveMigrationRegistry(3);
    const calls: number[] = [];
    registry.register(2, (save) => {
      calls.push(2);
      const systems = (save.sections.systems ?? {}) as Record<string, unknown>;
      return {
        version: 3,
        sections: {
          ...save.sections,
          systems: { ...systems, settings: { difficulty: "normal" } },
        },
      };
    });

    const migrated = registry.migrate(sampleV1Save());

    expect(calls).toEqual([2]);
    expect(migrated.version).toBe(3);
    expect(migrated.sections.systems).toMatchObject({ settings: { difficulty: "normal" } });
  });

  it("缺失中间迁移函数时给出明确错误", () => {
    const registry = new SaveMigrationRegistry(3);

    expect(() => registry.migrate(sampleV1Save())).toThrow(/缺少 v1 → v2/);
  });

  it("拒绝与当前版本不衔接的迁移输出", () => {
    const registry = new SaveMigrationRegistry();
    registry.register(1, (save) => ({ version: save.version, sections: save.sections }));

    expect(() => registry.migrate(sampleV1Save())).toThrow(/必须输出 v2/);
  });

  it("拒绝重复注册同一版本的迁移", () => {
    const registry = createSaveMigrationRegistry();

    expect(() => registry.register(1, (save) => save)).toThrow(/已注册/);
  });

  it("未来版本的存档被拒绝，不静默降级", () => {
    const futureSave: SaveFile = { version: SAVE_VERSION + 1, sections: {} };

    expect(() => migrateSave(futureSave)).toThrow(SaveMigrationError);
    expect(() => migrateSave(futureSave)).toThrow(/高于当前支持版本/);
  });

  it("拒绝格式非法的存档", () => {
    expect(() => parseSaveFile("not-json")).toThrow(/合法 JSON/);
    expect(() => migrateSave({ version: 0, sections: {} })).toThrow(/大于 0 的整数/);
    expect(() => migrateSave({ version: 1, sections: [] as unknown as Record<string, unknown> })).toThrow(
      /sections 必须是对象/,
    );
  });

  it("存档可序列化为带版本号与分节的 JSON", () => {
    const save: SaveFile = { version: 2, sections: { entities: { player: {} } } };

    expect(JSON.parse(serializeSaveFile(save))).toEqual(save);
  });
});
