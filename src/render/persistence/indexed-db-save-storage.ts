/**
 * IndexedDB 存档适配器（表现层）。
 *
 * 逻辑层只认识 SaveStorage 接口；本模块是唯一的浏览器持久化实现。
 * 单库单 object store 单槽位，够 P1 的手动存档/读档使用。
 */

import type { SaveFile, SaveStorage } from "../../logic/save";

export interface IndexedDbSaveStorageOptions {
  databaseName?: string;
  storeName?: string;
  /** 存档槽位键。 */
  key?: string;
  /** 测试/特殊环境可注入 IDBFactory。 */
  factory?: IDBFactory;
}

export class IndexedDbSaveStorage implements SaveStorage {
  private readonly databaseName: string;
  private readonly storeName: string;
  private readonly key: string;
  private readonly factory: IDBFactory;
  private database: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbSaveStorageOptions = {}) {
    this.databaseName = options.databaseName ?? "browser-isometric-rpg";
    this.storeName = options.storeName ?? "saves";
    this.key = options.key ?? "slot-1";
    this.factory = options.factory ?? globalThis.indexedDB;
  }

  async read(): Promise<SaveFile | null> {
    const db = await this.openDatabase();
    return new Promise<SaveFile | null>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readonly");
      const request = transaction.objectStore(this.storeName).get(this.key);
      request.onsuccess = () => {
        resolve((request.result as SaveFile | undefined) ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("读取 IndexedDB 存档失败"));
      };
    });
  }

  async write(save: SaveFile): Promise<void> {
    const db = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      transaction.objectStore(this.storeName).put(save, this.key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("写入 IndexedDB 存档失败"));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("写入 IndexedDB 存档被中止"));
      };
    });
  }

  async remove(): Promise<void> {
    const db = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      transaction.objectStore(this.storeName).delete(this.key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("删除 IndexedDB 存档失败"));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("删除 IndexedDB 存档被中止"));
      };
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.database !== null) {
      return this.database;
    }
    if (this.factory === undefined) {
      return Promise.reject(new Error("当前环境不支持 IndexedDB"));
    }

    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.database = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("打开 IndexedDB 失败"));
      };
      request.onblocked = () => {
        reject(new Error("IndexedDB 升级被其他页面阻塞"));
      };
    });
    return this.database;
  }
}
