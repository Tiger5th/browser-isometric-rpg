/**
 * 票 31：IndexedDB 存档适配器的多槽扩展。
 *
 * 旧实现是单 key（`slot-1`）单槽。现在同一个 object store 按槽位键存
 * 四个槽位：`auto` / `slot-1..3`。**旧数据不搬家**——存量玩家原本就写在
 * `slot-1` 这个键上，键名沿用即天然兼容。
 */

import { describe, expect, it } from "vitest";

import type { SaveFile } from "../../logic/save";
import type { SaveSlotId } from "../../logic/save-slots";
import { IndexedDbSaveStorage } from "./indexed-db-save-storage";

interface FakeRequest<T> {
  result?: T;
  error?: Error;
  onsuccess?: () => void;
  onerror?: () => void;
  onupgradeneeded?: () => void;
  onblocked?: () => void;
}

interface FakeCursor {
  key: string;
  continue: () => void;
}

interface FakeTransaction {
  oncomplete?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  objectStore: (name: string) => {
    get: (key: string) => FakeRequest<unknown>;
    put: (value: unknown, key: string) => void;
    delete: (key: string) => void;
    openCursor: () => FakeRequest<FakeCursor>;
  };
}

interface FakeDatabase {
  onversionchange?: () => void;
  onclose?: () => void;
  transaction: () => FakeTransaction;
}

/** 用一张内存 Map 冒充 object store，覆盖读写删与游标列举。 */
function createFakeFactory(): { factory: IDBFactory; records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  const database: FakeDatabase = {
    transaction: () => {
      const transaction: FakeTransaction = {
        objectStore: () => ({
          get: (key) => {
            const request: FakeRequest<unknown> = {};
            queueMicrotask(() => {
              request.result = records.get(key);
              request.onsuccess?.();
            });
            return request;
          },
          put: (value, key) => {
            records.set(key, value);
          },
          delete: (key) => {
            records.delete(key);
          },
          openCursor: () => {
            const request: FakeRequest<FakeCursor> = {};
            const keys = [...records.keys()];
            let index = 0;
            const step = (): void => {
              if (index >= keys.length) {
                request.result = undefined;
                request.onsuccess?.();
                return;
              }
              const key = keys[index] as string;
              index += 1;
              const cursor: FakeCursor = { key, continue: step };
              request.result = cursor;
              request.onsuccess?.();
            };
            queueMicrotask(step);
            return request;
          },
        }),
      };
      // 写/删事务在下一微任务后完成（真实 IDB 也是异步提交）。
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  const factory = {
    open: () => {
      const request: FakeRequest<FakeDatabase> = {};
      queueMicrotask(() => {
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, records };
}

function saveFile(marker: string): SaveFile {
  return { version: 3, sections: { session: { marker } } };
}

describe("IndexedDbSaveStorage 多槽", () => {
  it("不同槽位互相独立：写 slot-2 不影响 auto", async () => {
    const { factory } = createFakeFactory();
    const storage = new IndexedDbSaveStorage({ factory });

    await storage.write(saveFile("auto"), "auto");
    await storage.write(saveFile("manual"), "slot-2");

    expect((await storage.read("auto"))?.sections.session).toEqual({ marker: "auto" });
    expect((await storage.read("slot-2"))?.sections.session).toEqual({ marker: "manual" });
    expect(await storage.read("slot-1")).toBeNull();
  });

  it("删一个槽不影响其他槽", async () => {
    const { factory } = createFakeFactory();
    const storage = new IndexedDbSaveStorage({ factory });

    await storage.write(saveFile("a"), "slot-1");
    await storage.write(saveFile("b"), "slot-2");

    await storage.remove("slot-1");

    expect(await storage.read("slot-1")).toBeNull();
    expect(await storage.read("slot-2")).not.toBeNull();
  });

  it("listSlotIds 返回实际存在的槽位键", async () => {
    const { factory } = createFakeFactory();
    const storage = new IndexedDbSaveStorage({ factory });

    await storage.write(saveFile("a"), "auto");
    await storage.write(saveFile("b"), "slot-3");

    const ids = await storage.listSlotIds();
    expect([...ids].sort()).toEqual(["auto", "slot-3"]);
  });

  it("空的库列出零个槽位", async () => {
    const { factory } = createFakeFactory();
    const storage = new IndexedDbSaveStorage({ factory });
    expect(await storage.listSlotIds()).toEqual([]);
  });

  it("默认槽是 slot-1 而不是 auto：手动存档不会覆盖自动存档", async () => {
    const { factory, records } = createFakeFactory();
    const storage = new IndexedDbSaveStorage({ factory });

    await storage.write(saveFile("manual-default"));

    expect([...records.keys()]).toEqual(["slot-1"]);
    expect(await storage.read()).not.toBeNull();
    expect(await storage.read("auto")).toBeNull();
  });

  it("手动默认槽与 auto 槽互相独立", async () => {
    const { factory } = createFakeFactory();
    const storage = new IndexedDbSaveStorage({ factory });

    await storage.write(saveFile("manual"));
    await storage.write(saveFile("auto"), "auto");

    expect((await storage.read("slot-1"))?.sections.session).toEqual({ marker: "manual" });
    expect((await storage.read("auto"))?.sections.session).toEqual({ marker: "auto" });
  });

  it("旧的 slot-1 存量数据用默认槽即可读到", async () => {
    const { factory, records } = createFakeFactory();
    const storage = new IndexedDbSaveStorage({ factory });

    records.set("slot-1", saveFile("legacy") as never);

    expect(await storage.read()).not.toBeNull();
    expect((await storage.read())?.sections.session).toEqual({ marker: "legacy" });
  });

  it("显式指定的旧键名 slot-1 仍是合法槽（存量玩家数据不丢）", async () => {
    const { factory, records } = createFakeFactory();
    const storage = new IndexedDbSaveStorage({ factory });

    await storage.write(saveFile("legacy"), "slot-1" as SaveSlotId);

    expect([...records.keys()]).toEqual(["slot-1"]);
    expect(await storage.read("slot-1")).not.toBeNull();
  });
});
