/**
 * IndexedDB 存档适配器（表现层）。
 *
 * 逻辑层只认识 SaveStorage / SaveSlotStorage 接口；本模块是唯一的浏览器
 * 持久化实现。单库单 object store，按槽位键存四份数据（`auto` / `slot-1..3`，
 * 票 31）。键名沿用旧的 `slot-1` 默认值时代不变，存量玩家数据原地可读。
 */

import type { SaveFile, SaveStorage } from "../../logic/save";
import { AUTO_SLOT_ID, type SaveSlotId, type SaveSlotStorage } from "../../logic/save-slots";

export interface IndexedDbSaveStorageOptions {
  databaseName?: string;
  storeName?: string;
  /** 存档槽位键（无参调用时的默认槽）。 */
  key?: string;
  /** 测试/特殊环境可注入 IDBFactory。 */
  factory?: IDBFactory;
}

export class IndexedDbSaveStorage implements SaveStorage, SaveSlotStorage {
  private readonly databaseName: string;
  private readonly storeName: string;
  private readonly key: string;
  private readonly factory: IDBFactory;
  private database: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbSaveStorageOptions = {}) {
    this.databaseName = options.databaseName ?? "browser-isometric-rpg";
    this.storeName = options.storeName ?? "saves";
    this.key = options.key ?? AUTO_SLOT_ID;
    this.factory = options.factory ?? globalThis.indexedDB;
  }

  async read(slotId: SaveSlotId = this.key as SaveSlotId): Promise<SaveFile | null> {
    const db = await this.openDatabase();
    return new Promise<SaveFile | null>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readonly");
      const request = transaction.objectStore(this.storeName).get(slotId);
      request.onsuccess = () => {
        resolve((request.result as SaveFile | undefined) ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("读取 IndexedDB 存档失败"));
      };
    });
  }

  async write(save: SaveFile, slotId: SaveSlotId = this.key as SaveSlotId): Promise<void> {
    const db = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      transaction.objectStore(this.storeName).put(save, slotId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("写入 IndexedDB 存档失败"));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("写入 IndexedDB 存档被中止"));
      };
    });
  }

  async remove(slotId: SaveSlotId = this.key as SaveSlotId): Promise<void> {
    const db = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readwrite");
      transaction.objectStore(this.storeName).delete(slotId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("删除 IndexedDB 存档失败"));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("删除 IndexedDB 存档被中止"));
      };
    });
  }

  /**
   * 游标扫描整个 object store 的键。多槽服务据此判断「有没有任一存档」
   * 以及渲染槽位列表——键就是槽位 id，无需额外的索引 object store。
   */
  async listSlotIds(): Promise<SaveSlotId[]> {
    const db = await this.openDatabase();
    return new Promise<SaveSlotId[]>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, "readonly");
      const request = transaction.objectStore(this.storeName).openCursor();
      const keys: SaveSlotId[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null || cursor === undefined) {
          resolve(keys);
          return;
        }
        keys.push(cursor.key as SaveSlotId);
        cursor.continue();
      };
      request.onerror = () => {
        reject(request.error ?? new Error("列举 IndexedDB 存档槽位失败"));
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

    const pending = new Promise<IDBDatabase>((resolve, reject) => {
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
        // 连接被浏览器关闭（磁盘/隐私模式/连接回收）后必须复位，
        // 否则后续读写会一直复用已关闭的 db。
        db.onclose = () => {
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
    this.database = pending;
    // 失败的 Promise 不能永久缓存：复位后下一次操作会重新打开。
    pending.catch(() => {
      if (this.database === pending) {
        this.database = null;
      }
    });
    return pending;
  }
}
