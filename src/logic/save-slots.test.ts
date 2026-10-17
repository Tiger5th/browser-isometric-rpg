/**
 * 票 31：多槽存档服务（auto + slot-1..3）与槽位元数据。
 *
 * 接缝 = GameSaveSlotService（读写删查 + 元数据），
 * 存储侧只要求 SaveStorage 扩展出「列出槽位键」的最小能力。
 */

import { describe, expect, it } from "vitest";

import {
  MANUAL_SLOT_IDS,
  type SaveSlotId,
  type SaveSlotStorage,
} from "./save-slots";
import type { GameSessionSnapshot } from "./game-session";

/** 内存槽位存储（测试替身；结构与 IndexedDB 实现一致）。 */
function memorySlotStorage(): SaveSlotStorage & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    async read(slotId = "auto") {
      return (records.get(slotId) as never) ?? null;
    },
    async write(save, slotId = "auto") {
      records.set(slotId, save);
    },
    async remove(slotId = "auto") {
      records.delete(slotId);
    },
    async listSlotIds() {
      return [...records.keys()] as SaveSlotId[];
    },
  };
}

function snapshot(overrides: Partial<GameSessionSnapshot> = {}): GameSessionSnapshot {
  return {
    version: 3,
    regionId: "region:green_hollow",
    elapsedMs: 1000,
    playerLevel: 2,
    cumulativeXp: 240,
    worldState: {},
    nextItemInstanceId: 1,
    respawnAtMs: null,
    entities: [],
    dialogue: null,
    quests: [],
    ...overrides,
  };
}

function service() {
  const storage = memorySlotStorage();
  return { storage, slots: createService(storage) };
}

import { GameSaveSlotService } from "./save-slots";
function createService(storage: SaveSlotStorage): GameSaveSlotService {
  return new GameSaveSlotService(storage);
}

describe("槽位集合", () => {
  it("固定为 auto + 三个手动槽", () => {
    expect([...MANUAL_SLOT_IDS]).toEqual(["slot-1", "slot-2", "slot-3"]);
  });
});

describe("GameSaveSlotService：写入与读回", () => {
  it("写槽后能读回同一份快照", async () => {
    const { slots } = service();
    const original = snapshot();

    await slots.writeSlot("slot-2", original);

    const loaded = await slots.readSlot("slot-2");
    expect(loaded?.snapshot).toEqual(original);
  });

  it("不同槽位互不覆盖", async () => {
    const { slots } = service();

    await slots.writeSlot("slot-1", snapshot({ elapsedMs: 1000 }));
    await slots.writeSlot("slot-2", snapshot({ elapsedMs: 2000 }));

    expect((await slots.readSlot("slot-1"))?.snapshot.elapsedMs).toBe(1000);
    expect((await slots.readSlot("slot-2"))?.snapshot.elapsedMs).toBe(2000);
  });

  it("空槽位读回 null", async () => {
    const { slots } = service();
    expect(await slots.readSlot("slot-3")).toBeNull();
  });

  it("负向：未知槽位 id 被拒绝", async () => {
    const { slots } = service();
    await expect(slots.writeSlot("slot-9" as SaveSlotId, snapshot())).rejects.toThrow(
      /槽位/,
    );
  });

  it("坏档（迁移缺失中间版本）读槽时降级为 null，不再抛错锁死列表", async () => {
    // code review 修复：此前 readSlot 把 SaveMigrationError 往上抛，
    // listSlots 的 Promise.all 被一个坏档整体 reject、标题画面卡住。
    const { storage, slots } = service();
    const broken = {
      version: 3,
      sections: { session: { version: 2 } },
    };
    storage.records.set("slot-1", broken);
    await slots.writeSlot("slot-2", snapshot());

    const entries = await slots.listSlots();

    expect(entries.find((entry) => entry.slotId === "slot-1")).toEqual({
      slotId: "slot-1",
      meta: null,
      snapshot: null,
    });
    // 好档不受影响。
    expect(entries.find((entry) => entry.slotId === "slot-2")?.meta).not.toBeNull();
  });
});

describe("GameSaveSlotService：槽位元数据", () => {
  it("元数据记录存档时间、游戏时长与等级", async () => {
    const { slots } = service();

    await slots.writeSlot("slot-1", snapshot({ elapsedMs: 61500, playerLevel: 4 }), {
      savedAtMs: 1_700_000_000_000,
    });

    const loaded = await slots.readSlot("slot-1");
    expect(loaded?.meta).toEqual({
      slotId: "slot-1",
      savedAtMs: 1_700_000_000_000,
      playTimeMs: 61500,
      playerLevel: 4,
    });
  });

  it("元数据写在存档文件里而不是会话快照内", async () => {
    const { storage, slots } = service();

    await slots.writeSlot("auto", snapshot({ playerLevel: 5 }), { savedAtMs: 42 });

    const record = storage.records.get("auto") as {
      sections: Record<string, Record<string, unknown>>;
    };
    expect(record.sections.meta.playerLevel).toBe(5);
    const section = record.sections.session as Record<string, unknown>;
    expect(section.playerLevel).toBe(5);
    expect(section.savedAtMs).toBeUndefined();
    expect(section.slotId).toBeUndefined();
  });

  it("列表按 auto 在前、其后手动槽序号排列，并带上元数据", async () => {
    const { slots } = service();

    await slots.writeSlot("slot-3", snapshot({ playerLevel: 3 }), { savedAtMs: 300 });
    await slots.writeSlot("auto", snapshot({ playerLevel: 1 }), { savedAtMs: 100 });
    await slots.writeSlot("slot-1", snapshot({ playerLevel: 2 }), { savedAtMs: 200 });

    const list = await slots.listSlots();
    expect(list.map((entry) => entry.slotId)).toEqual([
      "auto",
      "slot-1",
      "slot-2",
      "slot-3",
    ]);
    // 有档的槽带元数据，空槽 null 占位。
    expect(list[0]?.meta).toEqual({
      slotId: "auto",
      savedAtMs: 100,
      playTimeMs: 1000,
      playerLevel: 1,
    });
    expect(list[1]?.meta?.playerLevel).toBe(2);
    expect(list[3]?.meta?.playerLevel).toBe(3);
    expect(list[2]).toEqual({ slotId: "slot-2", meta: null, snapshot: null });
  });

  it("全部槽位（含空槽）都出现在列表里，空槽 meta/snapshot 为 null", async () => {
    const { slots } = service();

    const list = await slots.listSlots();
    expect(list.map((entry) => entry.slotId)).toEqual([
      "auto",
      "slot-1",
      "slot-2",
      "slot-3",
    ]);
    expect(list.every((entry) => entry.meta === null)).toBe(true);
  });
});

describe("GameSaveSlotService：删除", () => {
  it("删除后该槽为空，其余槽不受影响", async () => {
    const { slots } = service();

    await slots.writeSlot("slot-1", snapshot({ elapsedMs: 1000 }));
    await slots.writeSlot("slot-2", snapshot({ elapsedMs: 2000 }));

    await slots.deleteSlot("slot-1");

    expect(await slots.readSlot("slot-1")).toBeNull();
    expect((await slots.readSlot("slot-2"))?.snapshot.elapsedMs).toBe(2000);
  });

  it("删除空槽不报错", async () => {
    const { slots } = service();
    await expect(slots.deleteSlot("slot-2")).resolves.toBeUndefined();
  });
});