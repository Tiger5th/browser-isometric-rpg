/**
 * 存档迁移链雏形。
 *
 * 存档 = 版本号 + 数据分节（world / entities / systems ...）。
 * 读取时按注册表逐级执行迁移：v1 → v2 → ... → 当前版本。
 * - 输入存档不被修改；
 * - 缺失中间迁移函数会显式报错；
 * - 高于当前版本（未来存档）拒绝加载，绝不静默降级。
 */

export const SAVE_VERSION = 2;

export interface SaveFile {
  version: number;
  sections: Record<string, unknown>;
}

export type SaveMigration = (save: SaveFile) => SaveFile;

export class SaveMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveMigrationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertValidSaveFile(value: unknown): asserts value is SaveFile {
  if (!isRecord(value)) {
    throw new SaveMigrationError("存档必须是对象");
  }
  if (!Number.isInteger(value.version) || (value.version as number) < 1) {
    throw new SaveMigrationError("存档 version 必须是大于 0 的整数");
  }
  if (!isRecord(value.sections)) {
    throw new SaveMigrationError("存档 sections 必须是对象");
  }
}

function cloneSave(save: SaveFile): SaveFile {
  return JSON.parse(JSON.stringify(save)) as SaveFile;
}

export function parseSaveFile(json: string): SaveFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SaveMigrationError("存档不是合法 JSON");
  }
  assertValidSaveFile(parsed);
  return parsed;
}

export function serializeSaveFile(save: SaveFile): string {
  assertValidSaveFile(save);
  return JSON.stringify(save);
}

export class SaveMigrationRegistry {
  readonly currentVersion: number;
  private readonly migrations = new Map<number, SaveMigration>();

  constructor(currentVersion: number = SAVE_VERSION) {
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      throw new SaveMigrationError("currentVersion 必须是大于 0 的整数");
    }
    this.currentVersion = currentVersion;
  }

  /** 注册 fromVersion → fromVersion + 1 的迁移函数。 */
  register(fromVersion: number, migration: SaveMigration): void {
    if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion >= this.currentVersion) {
      throw new SaveMigrationError(
        `迁移起点版本 ${fromVersion} 必须在 1..${this.currentVersion - 1} 之间`,
      );
    }
    if (this.migrations.has(fromVersion)) {
      throw new SaveMigrationError(`版本 ${fromVersion} 的迁移函数已注册`);
    }
    this.migrations.set(fromVersion, migration);
  }

  migrate(input: SaveFile): SaveFile {
    assertValidSaveFile(input);

    if (input.version > this.currentVersion) {
      throw new SaveMigrationError(
        `存档版本 ${input.version} 高于当前支持版本 ${this.currentVersion}，请升级游戏后再读取`,
      );
    }

    let save = cloneSave(input);
    while (save.version < this.currentVersion) {
      const fromVersion = save.version;
      const migration = this.migrations.get(fromVersion);
      if (migration === undefined) {
        throw new SaveMigrationError(
          `缺少 v${fromVersion} → v${fromVersion + 1} 的迁移函数`,
        );
      }

      const migrated = migration(save);
      assertValidSaveFile(migrated);
      if (migrated.version !== fromVersion + 1) {
        throw new SaveMigrationError(
          `迁移函数 v${fromVersion} 必须输出 v${fromVersion + 1}，实际输出 v${migrated.version}`,
        );
      }
      save = migrated;
    }

    return save;
  }
}

// ---------------------------------------------------------------------------
// 内置迁移：v1 → v2（模拟一次真实 schema 演进）
//
// v1：sections.player = { attributes, inventory: [{ id, qty }] }，任务在 sections.quests
// v2：实体模型统一为 sections.entities.player =
//       { baseAttributes, modifiers, container: { items }, claimedRewardIds }
//     系统状态收进 sections.systems.quests
// ---------------------------------------------------------------------------

function migrateV1ToV2(save: SaveFile): SaveFile {
  const { player, quests, ...restSections } = save.sections;

  if (!isRecord(player)) {
    throw new SaveMigrationError("v1 存档缺少 sections.player");
  }
  const attributes = player.attributes ?? {};
  if (!isRecord(attributes)) {
    throw new SaveMigrationError("v1 存档 sections.player.attributes 必须是对象");
  }
  const rawInventory = player.inventory ?? [];
  if (!Array.isArray(rawInventory)) {
    throw new SaveMigrationError("v1 存档 sections.player.inventory 必须是数组");
  }

  const items = rawInventory.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new SaveMigrationError(`v1 存档 inventory[${index}] 缺少有效 id`);
    }
    const quantity = entry.qty ?? 1;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 1) {
      throw new SaveMigrationError(`v1 存档 inventory[${index}].qty 必须是正数`);
    }
    return {
      instanceId: `${entry.id}#${index}`,
      templateId: entry.id,
      quantity,
      equipped: false,
    };
  });

  return {
    version: 2,
    sections: {
      ...restSections,
      entities: {
        player: {
          baseAttributes: { ...attributes },
          modifiers: [],
          container: { items },
          claimedRewardIds: [],
        },
      },
      systems: {
        quests: quests ?? { active: [], completed: [] },
      },
    },
  };
}

export function createSaveMigrationRegistry(
  currentVersion: number = SAVE_VERSION,
): SaveMigrationRegistry {
  const registry = new SaveMigrationRegistry(currentVersion);
  if (currentVersion >= 2) {
    registry.register(1, migrateV1ToV2);
  }
  return registry;
}

const defaultRegistry = createSaveMigrationRegistry();

/** 使用内置迁移链把存档升级到当前版本。 */
export function migrateSave(save: SaveFile): SaveFile {
  return defaultRegistry.migrate(save);
}
