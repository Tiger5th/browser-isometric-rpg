/**
 * 存档：版本号 + 数据分节 + 迁移链 + 存储适配器。
 *
 * 存档 = `{ version, sections: { session: GameSessionSnapshot } }`。
 * `version` 与 `GAME_SESSION_SNAPSHOT_VERSION` 对齐：一次会话快照 schema
 * 变更对应一次存档版本升级；旧存档读取时按注册表逐级迁移。
 *
 * 本模块零 IndexedDB/浏览器依赖：持久化通过 `SaveStorage` 适配器注入，
 * 渲染层提供 IndexedDB 实现，测试可用内存实现。
 *
 * 迁移约定（P0 雏形沿用）：
 * - 输入存档不被修改；
 * - 缺失中间迁移函数会显式报错；
 * - 高于当前版本（未来存档）拒绝加载，绝不静默降级。
 *
 * v1（P0 时代）：world / player / quests 分节，物品只有 `{ id, qty }`，
 * 实体没有战斗与背包容器。v2 把玩家升级为完整的 EntitySnapshot 并收进
 * `sections.session`，使旧存档可以直接交给 GameSession.restoreSnapshot()。
 */

import type { Vec3 } from "./entity";
import {
  GAME_SESSION_SNAPSHOT_VERSION,
  type GameSessionSnapshot,
} from "./game-session";

export const SAVE_VERSION = GAME_SESSION_SNAPSHOT_VERSION;

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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

    let save = cloneJson(input);
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
// 存档编解码：v2 的 sections.session 就是 GameSessionSnapshot
// ---------------------------------------------------------------------------

/** 把会话快照封装成可持久化存档（深拷贝，调用方后续修改不会影响文件）。 */
export function createSaveFile(snapshot: GameSessionSnapshot): SaveFile {
  if (snapshot.version !== SAVE_VERSION) {
    throw new SaveMigrationError(
      `会话快照版本 ${snapshot.version} 与存档版本 ${SAVE_VERSION} 不一致`,
    );
  }
  return {
    version: SAVE_VERSION,
    sections: { session: cloneJson(snapshot) },
  };
}

/** 从（已迁移到当前版本的）存档里取出会话快照；结构非法时显式报错。 */
export function readSessionSnapshot(save: SaveFile): GameSessionSnapshot {
  assertValidSaveFile(save);
  if (save.version !== SAVE_VERSION) {
    throw new SaveMigrationError(
      `存档版本 ${save.version} 不是当前版本 ${SAVE_VERSION}，请先执行迁移`,
    );
  }
  const session = save.sections.session;
  if (!isRecord(session)) {
    throw new SaveMigrationError("存档缺少 sections.session");
  }
  if (session.version !== SAVE_VERSION) {
    throw new SaveMigrationError(
      `sections.session.version 必须是 ${SAVE_VERSION}，实际为 ${String(session.version)}`,
    );
  }
  if (!Array.isArray(session.entities)) {
    throw new SaveMigrationError("sections.session.entities 必须是数组");
  }
  if (!Array.isArray(session.quests)) {
    throw new SaveMigrationError("sections.session.quests 必须是数组");
  }
  if (session.dialogue !== null && !isRecord(session.dialogue)) {
    throw new SaveMigrationError("sections.session.dialogue 必须是对象或 null");
  }
  if (
    session.regionId !== null &&
    (typeof session.regionId !== "string" || session.regionId.trim() === "")
  ) {
    throw new SaveMigrationError("sections.session.regionId 必须是非空字符串或 null");
  }
  if (!Number.isFinite(session.elapsedMs) || (session.elapsedMs as number) < 0) {
    throw new SaveMigrationError("sections.session.elapsedMs 必须是非负有限数值");
  }
  if (
    session.respawnAtMs !== null &&
    (!Number.isFinite(session.respawnAtMs) || (session.respawnAtMs as number) < 0)
  ) {
    throw new SaveMigrationError("sections.session.respawnAtMs 必须是非负有限数值或 null");
  }
  if (
    !Number.isInteger(session.nextItemInstanceId) ||
    (session.nextItemInstanceId as number) < 1
  ) {
    throw new SaveMigrationError("sections.session.nextItemInstanceId 必须是正整数");
  }
  return cloneJson(session) as unknown as GameSessionSnapshot;
}

// ---------------------------------------------------------------------------
// 内置迁移：v1 → v2（P0 存档 → 正式会话快照）
// ---------------------------------------------------------------------------

function legacyVec3(value: unknown, label: string): Vec3 {
  if (value === undefined) {
    return { x: 0, y: 0, z: 0 };
  }
  if (!isRecord(value)) {
    throw new SaveMigrationError(`${label} 必须是对象`);
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (value[axis] !== undefined && !Number.isFinite(value[axis])) {
      throw new SaveMigrationError(`${label}.${axis} 必须是有限数值`);
    }
  }
  return {
    x: Number(value.x ?? 0),
    y: Number(value.y ?? 0),
    z: Number(value.z ?? 0),
  };
}

function legacyAttributes(value: unknown): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new SaveMigrationError("v1 存档 player.attributes 必须是对象");
  }
  const attributes: Record<string, number> = {};
  for (const [key, attribute] of Object.entries(value)) {
    if (key.trim() === "" || !Number.isFinite(attribute)) {
      throw new SaveMigrationError(`v1 存档属性 ${key || "(空)"} 必须是有限数值`);
    }
    attributes[key] = attribute as number;
  }
  return attributes;
}

function legacyInventory(value: unknown): {
  instanceId: string;
  templateId: string;
  quantity: number;
  equipped: boolean;
}[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SaveMigrationError("v1 存档 player.inventory 必须是数组");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new SaveMigrationError(`v1 存档 inventory[${index}] 缺少有效 id`);
    }
    const quantity = entry.qty ?? 1;
    if (!Number.isInteger(quantity) || (quantity as number) < 1) {
      throw new SaveMigrationError(`v1 存档 inventory[${index}].qty 必须是正整数`);
    }
    return {
      instanceId: `${entry.id}#${index}`,
      templateId: entry.id,
      quantity: quantity as number,
      equipped: false,
    };
  });
}

function migrateV1ToV2(save: SaveFile): SaveFile {
  const { world, player, quests, dialogue, ...restSections } = save.sections;

  if (!isRecord(player)) {
    throw new SaveMigrationError("v1 存档缺少 sections.player");
  }
  if (!Array.isArray(quests)) {
    throw new SaveMigrationError("v1 存档 sections.quests 必须是数组");
  }
  if (dialogue !== undefined && dialogue !== null && !isRecord(dialogue)) {
    throw new SaveMigrationError("v1 存档 sections.dialogue 必须是对象或 null");
  }
  const worldSection = world === undefined ? {} : world;
  if (!isRecord(worldSection)) {
    throw new SaveMigrationError("v1 存档 sections.world 必须是对象");
  }
  if (
    worldSection.regionId !== undefined &&
    (typeof worldSection.regionId !== "string" || worldSection.regionId.trim() === "")
  ) {
    throw new SaveMigrationError("v1 存档 world.regionId 必须是非空字符串");
  }
  const elapsedMs = worldSection.elapsedMs ?? 0;
  if (!Number.isFinite(elapsedMs) || (elapsedMs as number) < 0) {
    throw new SaveMigrationError("v1 存档 world.elapsedMs 必须是非负有限数值");
  }

  const attributes = legacyAttributes(player.attributes);
  const items = legacyInventory(player.inventory);
  const maxHp = Math.max(1, attributes.maxHp ?? attributes.hp ?? 1);
  const hp = Math.min(maxHp, Math.max(0, attributes.hp ?? maxHp));

  const session: GameSessionSnapshot = {
    version: 2,
    regionId: (worldSection.regionId as string | undefined) ?? null,
    elapsedMs: elapsedMs as number,
    nextItemInstanceId: 1,
    respawnAtMs: null,
    entities: [
      {
        id: (typeof player.id === "string" && player.id.trim() !== ""
          ? player.id
          : "entity:player") as GameSessionSnapshot["entities"][number]["id"],
        identity: {
          type: "player",
          templateId:
            typeof player.templateId === "string" && player.templateId.trim() !== ""
              ? player.templateId
              : "player_template:hero",
          displayName:
            typeof player.displayName === "string" && player.displayName.trim() !== ""
              ? player.displayName
              : "旅人",
        },
        position: legacyVec3(player.position, "v1 存档 player.position"),
        rotation: legacyVec3(player.rotation, "v1 存档 player.rotation"),
        tags: [],
        movement: null,
        baseAttributes: { ...attributes },
        attributes: { ...attributes },
        modifiers: [],
        combat: {
          hp,
          maxHp,
          attack: attributes.attack ?? 0,
          defense: attributes.defense ?? 0,
          alive: hp > 0,
          aiState: null,
          targetId: null,
          attackCooldownMs: 0,
        },
        container: { items },
        claimedRewardIds: [],
      },
    ],
    dialogue: (dialogue as GameSessionSnapshot["dialogue"]) ?? null,
    quests: cloneJson(quests) as GameSessionSnapshot["quests"],
  };

  return {
    version: 2,
    sections: {
      ...restSections,
      session: session as unknown as Record<string, unknown>,
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

// ---------------------------------------------------------------------------
// 存储适配器（渲染层注入 IndexedDB 实现，测试注入内存实现）
// ---------------------------------------------------------------------------

export interface SaveStorage {
  read(): Promise<SaveFile | null>;
  write(save: SaveFile): Promise<void>;
  remove(): Promise<void>;
}

/**
 * 存读档服务：负责版本迁移、结构校验与存储适配器调用。
 * 逻辑层不知道 IndexedDB 的存在；渲染层只需提供 SaveStorage。
 */
export class GameSaveService {
  private readonly registry: SaveMigrationRegistry;

  constructor(
    private readonly storage: SaveStorage,
    registry: SaveMigrationRegistry = createSaveMigrationRegistry(),
  ) {
    this.registry = registry;
  }

  /** 把当前会话快照写入存档（自动附上版本号）。 */
  async save(snapshot: GameSessionSnapshot): Promise<SaveFile> {
    const file = createSaveFile(snapshot);
    await this.storage.write(file);
    return file;
  }

  /** 读取存档并迁移到当前版本；没有存档时返回 null。 */
  async load(): Promise<GameSessionSnapshot | null> {
    const raw = await this.storage.read();
    if (raw === null) {
      return null;
    }
    return readSessionSnapshot(this.registry.migrate(raw));
  }

  async hasSave(): Promise<boolean> {
    return (await this.storage.read()) !== null;
  }

  async clear(): Promise<void> {
    await this.storage.remove();
  }
}
