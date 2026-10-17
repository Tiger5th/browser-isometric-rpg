import { describe, expect, it } from "vitest";

import {
  GAME_SESSION_SNAPSHOT_VERSION,
  type GameSessionSnapshot,
} from "./game-session";
import {
  SAVE_VERSION,
  GameSaveService,
  SaveMigrationError,
  SaveMigrationRegistry,
  createSaveFile,
  createSaveMigrationRegistry,
  migrateSave,
  parseSaveFile,
  readSessionSnapshot,
  serializeSaveFile,
  type SaveFile,
  type SaveStorage,
} from "./save";

function sampleQuest(): Record<string, unknown> {
  return {
    id: "quest:cull_slimes",
    title: "清理史莱姆",
    giverNpcId: "npc:elder_ma",
    turnInNpcId: "npc:elder_ma",
    status: "active",
    objectives: [
      {
        id: "objective:kill_slimes",
        type: "kill",
        enemyTemplateId: "enemy_template:slime",
        current: 2,
        required: 3,
      },
    ],
  };
}

/** P0 时代的 v1 存档：world/player/quests 分节，物品只有 { id, qty }。 */
function sampleV1Save(): SaveFile {
  return {
    version: 1,
    sections: {
      world: { regionId: "region:green_hollow", elapsedMs: 4200 },
      player: {
        id: "entity:player",
        templateId: "player_template:hero",
        displayName: "旅人",
        position: { x: 3, y: 0, z: -2 },
        rotation: { x: 0, y: 0.5, z: 0 },
        attributes: { maxHp: 100, hp: 80, attack: 10, defense: 4 },
        inventory: [
          { id: "item:traveler_sword", qty: 1 },
          { id: "item:healing_herb", qty: 3 },
        ],
      },
      quests: [sampleQuest()],
    },
  };
}

function latestSnapshot(): GameSessionSnapshot {
  return {
    version: GAME_SESSION_SNAPSHOT_VERSION,
    regionId: "region:green_hollow",
    elapsedMs: 1000,
    nextItemInstanceId: 7,
    respawnAtMs: null,
    entities: [],
    dialogue: null,
    quests: [],
  };
}

/** 内存存储：与 IndexedDB 适配器实现同一个 SaveStorage 接口。 */
function memoryStorage(initial: SaveFile | null = null): SaveStorage & {
  written: SaveFile[];
} {
  let current = initial;
  const written: SaveFile[] = [];
  return {
    written,
    async read() {
      return current === null ? null : (JSON.parse(JSON.stringify(current)) as SaveFile);
    },
    async write(save) {
      written.push(JSON.parse(JSON.stringify(save)) as SaveFile);
      current = JSON.parse(JSON.stringify(save)) as SaveFile;
    },
    async remove() {
      current = null;
    },
  };
}

describe("v1 → v2 迁移", () => {
  it("把 world/player/quests 升级为一份完整 v2 会话快照", () => {
    const migrated = migrateSave(sampleV1Save());

    expect(migrated.version).toBe(2);
    const session = migrated.sections.session as GameSessionSnapshot;
    expect(session).toMatchObject({
      version: 2,
      regionId: "region:green_hollow",
      elapsedMs: 4200,
      nextItemInstanceId: 1,
      respawnAtMs: null,
      dialogue: null,
      quests: [sampleQuest()],
    });
    expect(session.entities).toEqual([
      {
        id: "entity:player",
        identity: {
          type: "player",
          templateId: "player_template:hero",
          displayName: "旅人",
        },
        position: { x: 3, y: 0, z: -2 },
        rotation: { x: 0, y: 0.5, z: 0 },
        tags: [],
        movement: null,
        baseAttributes: { maxHp: 100, hp: 80, attack: 10, defense: 4 },
        attributes: { maxHp: 100, hp: 80, attack: 10, defense: 4 },
        modifiers: [],
        combat: {
          hp: 80,
          maxHp: 100,
          attack: 10,
          defense: 4,
          alive: true,
          aiState: null,
          targetId: null,
          attackCooldownMs: 0,
        },
        container: {
          items: [
            {
              instanceId: "item:traveler_sword#0",
              templateId: "item:traveler_sword",
              quantity: 1,
              equipped: false,
            },
            {
              instanceId: "item:healing_herb#1",
              templateId: "item:healing_herb",
              quantity: 3,
              equipped: false,
            },
          ],
        },
        claimedRewardIds: [],
      },
    ]);
  });

  it("迁移结果可直接读成会话快照", () => {
    const snapshot = readSessionSnapshot(migrateSave(sampleV1Save()));

    expect(snapshot.version).toBe(SAVE_VERSION);
    expect(snapshot.entities[0].identity.type).toBe("player");
    expect(snapshot.quests[0].status).toBe("active");
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

  it("拒绝缺少玩家、非法背包与非法属性的 v1 存档", () => {
    const missingPlayer = sampleV1Save();
    delete missingPlayer.sections.player;
    expect(() => migrateSave(missingPlayer)).toThrow(/sections\.player/);

    const badInventory = sampleV1Save();
    (badInventory.sections.player as Record<string, unknown>).inventory = [
      { id: "", qty: 1 },
    ];
    expect(() => migrateSave(badInventory)).toThrow(/inventory\[0\]/);

    const badQuantity = sampleV1Save();
    (badQuantity.sections.player as Record<string, unknown>).inventory = [
      { id: "item:healing_herb", qty: 0 },
    ];
    expect(() => migrateSave(badQuantity)).toThrow(/qty/);

    const badQuest = sampleV1Save();
    badQuest.sections.quests = { active: ["quest:cull_slimes"] };
    expect(() => migrateSave(badQuest)).toThrow(/quests/);
  });

  it("当前版本存档原样通过，并返回独立副本", () => {
    const latest: SaveFile = {
      version: SAVE_VERSION,
      sections: { session: latestSnapshot() },
    };

    const migrated = migrateSave(latest);
    expect(migrated).toEqual(latest);

    (migrated.sections.session as GameSessionSnapshot).elapsedMs = 5;
    expect((latest.sections.session as GameSessionSnapshot).elapsedMs).toBe(1000);
  });
});

describe("迁移函数注册表", () => {
  it("按顺序执行多级迁移链 v1 → v2 → v3", () => {
    const registry = createSaveMigrationRegistry(3);
    const calls: number[] = [];
    registry.register(2, (save) => {
      calls.push(2);
      const session = save.sections.session as GameSessionSnapshot;
      return {
        version: 3,
        sections: {
          ...save.sections,
          session: { ...session, elapsedMs: session.elapsedMs + 1 },
        },
      };
    });

    const migrated = registry.migrate(sampleV1Save());

    expect(calls).toEqual([2]);
    expect(migrated.version).toBe(3);
    expect((migrated.sections.session as GameSessionSnapshot).elapsedMs).toBe(4201);
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
    expect(() =>
      migrateSave({ version: 1, sections: [] as unknown as Record<string, unknown> }),
    ).toThrow(/sections 必须是对象/);
  });

  it("存档可序列化为带版本号与分节的 JSON", () => {
    const save: SaveFile = { version: 2, sections: { session: latestSnapshot() } };

    expect(JSON.parse(serializeSaveFile(save))).toEqual(save);
  });
});

describe("存档编解码", () => {
  it("createSaveFile 把会话快照装进 v2 的 session 分节", () => {
    const snapshot = latestSnapshot();
    const save = createSaveFile(snapshot);

    expect(save.version).toBe(SAVE_VERSION);
    expect(save.sections.session).toEqual(snapshot);
    expect(save.sections.session).not.toBe(snapshot);
  });

  it("拒绝版本不符的会话快照", () => {
    expect(() => createSaveFile({ ...latestSnapshot(), version: 99 })).toThrow(/版本/);
  });

  it("readSessionSnapshot 拒绝缺少 session 或结构非法的存档", () => {
    expect(() =>
      readSessionSnapshot({ version: SAVE_VERSION, sections: {} }),
    ).toThrow(/session/);

    expect(() =>
      readSessionSnapshot({
        version: SAVE_VERSION,
        sections: { session: { version: SAVE_VERSION, entities: "nope" } },
      }),
    ).toThrow(/entities/);
  });
});

describe("GameSaveService：存储适配器之上的存读档", () => {
  it("存档 → 读档返回一致的会话快照", async () => {
    const storage = memoryStorage();
    const service = new GameSaveService(storage);
    const snapshot = latestSnapshot();

    const file = await service.save(snapshot);
    expect(file.version).toBe(SAVE_VERSION);
    expect(storage.written).toHaveLength(1);
    expect(await service.hasSave()).toBe(true);

    expect(await service.load()).toEqual(snapshot);
  });

  it("没有存档时读档返回 null", async () => {
    const service = new GameSaveService(memoryStorage());

    expect(await service.hasSave()).toBe(false);
    expect(await service.load()).toBeNull();
  });

  it("删除存档后读档返回 null", async () => {
    const service = new GameSaveService(memoryStorage());
    await service.save(latestSnapshot());

    await service.clear();

    expect(await service.load()).toBeNull();
  });

  it("读档时自动执行迁移链", async () => {
    const service = new GameSaveService(memoryStorage(sampleV1Save()));

    const snapshot = await service.load();

    expect(snapshot?.version).toBe(SAVE_VERSION);
    expect(snapshot?.entities[0].id).toBe("entity:player");
    expect(snapshot?.quests[0].status).toBe("active");
  });
});
