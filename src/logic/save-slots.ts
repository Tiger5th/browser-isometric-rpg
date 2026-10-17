/**
 * 多槽存档服务（票 31）。
 *
 * 槽位 = `auto`（自动存档）+ `slot-1..3`（手动槽）。槽位 id 只是
 * 存储适配器的一把 key：逻辑层只认 `SaveSlotId`，不知道 IndexedDB 的存在。
 *
 * 槽位元数据（存档时间 / 游戏时长 / 等级）存在存档文件的 `sections.meta`
 * 分节，**不在会话快照内**——快照只描述游戏世界事实，档位侧信息属于存档系统。
 * 这样 UI 可以在不读懂整份快照的前提下渲染槽位列表。
 */

import type { GameSessionSnapshot } from "./game-session";
import {
  createSaveFile,
  readSessionSnapshot,
  migrateSave,
  SAVE_VERSION,
  SaveMigrationError,
  type SaveFile,
} from "./save";

/** 自动存档槽。区域切换 / 任务变化 / 重要物品 / 退出兜底都写这里。 */
export const AUTO_SLOT_ID = "auto";

/** 手动槽固定三个，顺序即 UI 展示顺序。 */
export const MANUAL_SLOT_IDS = ["slot-1", "slot-2", "slot-3"] as const;

export type SaveSlotId = typeof AUTO_SLOT_ID | (typeof MANUAL_SLOT_IDS)[number];

export const SAVE_SLOT_IDS: readonly SaveSlotId[] = [
  AUTO_SLOT_ID,
  ...MANUAL_SLOT_IDS,
];

export function isSaveSlotId(value: unknown): value is SaveSlotId {
  return typeof value === "string" && (SAVE_SLOT_IDS as readonly string[]).includes(value);
}

/** 槽位侧元数据：读档/写档之外的「这个档是什么时候、玩了多久、几级」。 */
export interface SaveSlotMeta {
  slotId: SaveSlotId;
  /** 存档写入时刻（毫秒时间戳，由调用方注入以便测试）。 */
  savedAtMs: number;
  /** 游戏时长 = 快照 elapsedMs。 */
  playTimeMs: number;
  /** 玩家等级，读档界面不必解析整份快照。 */
  playerLevel: number;
}

export interface SaveSlotContents {
  meta: SaveSlotMeta;
  snapshot: GameSessionSnapshot;
}

/** 列表条目：空槽用 null 占位，保证 UI 能画出全部四个槽位。 */
export interface SaveSlotEntry {
  slotId: SaveSlotId;
  meta: SaveSlotMeta | null;
  snapshot: GameSessionSnapshot | null;
}

export interface WriteSlotOptions {
  /** 存档时刻；缺省用 Date.now()。 */
  savedAtMs?: number;
}

/**
 * 槽位存储：SaveStorage 的多槽扩展。
 * `read/write/remove` 作用于默认槽（保持单槽调用方无需改动），
 * `listSlotIds` 是实现多槽所需的唯一新增能力。
 */
export interface SaveSlotStorage {
  read(slotId?: SaveSlotId): Promise<SaveFile | null>;
  write(save: SaveFile, slotId?: SaveSlotId): Promise<void>;
  remove(slotId?: SaveSlotId): Promise<void>;
  listSlotIds(): Promise<SaveSlotId[]>;
}

const META_SECTION = "meta";

function assertSlotId(slotId: unknown): asserts slotId is SaveSlotId {
  if (!isSaveSlotId(slotId)) {
    throw new SaveMigrationError(
      `未知存档槽位：${String(slotId)}（合法值：${SAVE_SLOT_IDS.join(", ")}）`,
    );
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function metaOf(slotId: SaveSlotId, save: SaveFile): SaveSlotMeta | null {
  const section = save.sections[META_SECTION];
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    return null;
  }
  const meta = section as Record<string, unknown>;
  if (
    typeof meta.savedAtMs !== "number" ||
    !Number.isFinite(meta.savedAtMs) ||
    typeof meta.playTimeMs !== "number" ||
    !Number.isFinite(meta.playTimeMs) ||
    !Number.isInteger(meta.playerLevel) ||
    (meta.playerLevel as number) < 1
  ) {
    // 元数据不合法时不让整个档不可读：丢掉元数据，快照仍可读。
    return null;
  }
  return {
    slotId,
    savedAtMs: meta.savedAtMs,
    playTimeMs: meta.playTimeMs,
    playerLevel: meta.playerLevel as number,
  };
}

/**
 * 读旧 `slot-1` 时代的数据：这类档没有 meta 分节。
 * 用会话快照自身能拿到的字段合成元数据，存量玩家不至于看到空槽。
 */
function synthesizeMeta(slotId: SaveSlotId, snapshot: GameSessionSnapshot): SaveSlotMeta {
  return {
    slotId,
    savedAtMs: 0,
    playTimeMs: snapshot.elapsedMs,
    playerLevel: snapshot.playerLevel,
  };
}

/**
 * 多槽存档服务：槽位操作 + 版本迁移 + 列表。
 *
 * 迁移链沿用 `save.ts` 的内置注册表——本模块只负责「哪个槽」，
 * 不重新实现版本逻辑。
 */
export class GameSaveSlotService {
  constructor(
    private readonly storage: SaveSlotStorage,
    private readonly migrate: (save: SaveFile) => GameSessionSnapshot = (save) =>
      readSessionSnapshot(migrateSave(save)),
  ) {}

  /** 写入指定槽位（附槽位元数据）。 */
  async writeSlot(
    slotId: SaveSlotId,
    snapshot: GameSessionSnapshot,
    options: WriteSlotOptions = {},
  ): Promise<SaveSlotMeta> {
    assertSlotId(slotId);
    const file = createSaveFile(snapshot);
    const meta: SaveSlotMeta = {
      slotId,
      savedAtMs: options.savedAtMs ?? Date.now(),
      playTimeMs: snapshot.elapsedMs,
      playerLevel: snapshot.playerLevel,
    };
    await this.storage.write(
      { ...file, sections: { ...file.sections, [META_SECTION]: meta } },
      slotId,
    );
    return meta;
  }

  /** 读指定槽位；空槽返回 null。 */
  async readSlot(slotId: SaveSlotId): Promise<SaveSlotContents | null> {
    assertSlotId(slotId);
    const raw = await this.storage.read(slotId);
    if (raw === null) {
      return null;
    }
    const snapshot = this.migrate(raw);
    return { meta: metaOf(slotId, raw) ?? synthesizeMeta(slotId, snapshot), snapshot };
  }

  /** 删除指定槽位；删除空槽是幂等空操作。 */
  async deleteSlot(slotId: SaveSlotId): Promise<void> {
    assertSlotId(slotId);
    await this.storage.remove(slotId);
  }

  /** 是否存在任一存档（主菜单「继续游戏」入口的判据）。 */
  async hasAnySave(): Promise<boolean> {
    const ids = await this.storage.listSlotIds();
    return ids.some((id) => isSaveSlotId(id));
  }

  /** 四个槽位的完整视图（空槽占位），顺序为 auto 在前。 */
  async listSlots(): Promise<SaveSlotEntry[]> {
    return Promise.all(
      SAVE_SLOT_IDS.map(async (slotId) => {
        const contents = await this.readSlot(slotId);
        return {
          slotId,
          meta: contents === null ? null : cloneJson(contents.meta),
          snapshot: contents === null ? null : contents.snapshot,
        };
      }),
    );
  }
}

export { SAVE_VERSION };