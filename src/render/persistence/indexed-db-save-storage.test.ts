import { describe, expect, it } from "vitest";

import { IndexedDbSaveStorage } from "./indexed-db-save-storage";

interface FakeRequest<T> {
  result?: T;
  error?: Error;
  onsuccess?: () => void;
  onerror?: () => void;
  onupgradeneeded?: () => void;
  onblocked?: () => void;
}

interface FakeDatabase {
  onversionchange?: () => void;
  onclose?: () => void;
  transaction: () => {
    objectStore: () => { get: () => FakeRequest<unknown> };
  };
}

function createFakeDatabase(): FakeDatabase {
  return {
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const request: FakeRequest<unknown> = {};
          queueMicrotask(() => {
            request.result = undefined;
            request.onsuccess?.();
          });
          return request;
        },
      }),
    }),
  };
}

function createFailingThenSucceedingFactory(failures: number): {
  factory: IDBFactory;
  attempts: () => number;
  database: FakeDatabase;
} {
  let attempts = 0;
  const database = createFakeDatabase();
  const factory = {
    open: () => {
      attempts += 1;
      const request: FakeRequest<FakeDatabase> = {};
      queueMicrotask(() => {
        if (attempts <= failures) {
          request.error = new Error("open failed");
          request.onerror?.();
          return;
        }
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, attempts: () => attempts, database };
}

describe("IndexedDbSaveStorage 连接生命周期", () => {
  it("打开失败的 Promise 不被永久缓存：下一次读档会重试", async () => {
    const { factory, attempts } = createFailingThenSucceedingFactory(1);
    const storage = new IndexedDbSaveStorage({ factory });

    await expect(storage.read()).rejects.toThrow(/open failed|打开 IndexedDB/);
    await expect(storage.read()).resolves.toBeNull();
    expect(attempts()).toBe(2);
  });

  it("数据库触发 onclose 后复位缓存，下一次操作重新打开", async () => {
    const { factory, attempts, database } = createFailingThenSucceedingFactory(0);
    const storage = new IndexedDbSaveStorage({ factory });

    await expect(storage.read()).resolves.toBeNull();
    expect(attempts()).toBe(1);

    database.onclose?.();

    await expect(storage.read()).resolves.toBeNull();
    expect(attempts()).toBe(2);
  });
});
