/**
 * 票 31：自动存档触发条件 + beforeunload 兜底。
 *
 * 接缝 = GameSessionAutoSaver：订阅会话事件判断「该不该写 auto 槽」，
 * 并注册一个卸载回调。存档写入本身委托给注入的写入函数，
 * 所以单测不需要 IndexedDB。
 */

import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { GameSession, type GameSessionSnapshot } from "./game-session";
import type { GameSessionEvent } from "./game-events";
import { GameSaveAutoSaver } from "./save-autosave";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";

function bundle(): ContentBundle {
  return {
    regions: [
      {
        id: REGION_ID,
        displayName: "竞技场",
        asset: { model: "assets/regions/arena.glb" },
        player: {
          id: PLAYER_ID,
          templateId: "player_template:hero",
          displayName: "旅人",
          spawn: { position: { x: 0, y: 0, z: 0 } },
          baseAttributes: {
            maxHp: 100,
            hp: 100,
            attack: 50,
            defense: 4,
            moveSpeed: 5.5,
          },
        },
      },
    ],
    npcs: [],
    enemyTemplates: [],
    enemies: [],
    items: [],
    quests: [],
  };
}

function createSession(): GameSession {
  const session = new GameSession({ random: () => 0 });
  session.loadRegion(bundle(), REGION_ID);
  return session;
}

/** 记录每次自动存档写入的槽位与快照。 */
function createRecorder() {
  const writes: Array<{ slotId: string; snapshot: GameSessionSnapshot }> = [];
  return {
    writes,
    write: (slotId: string, snapshot: GameSessionSnapshot) => {
      writes.push({ slotId, snapshot });
      return Promise.resolve();
    },
  };
}

function saver(session: GameSession, write = createRecorder().write) {
  const events: GameSessionEvent[] = [];
  const recorder = createRecorder();
  const auto = new GameSaveAutoSaver({
    getSnapshot: () => session.snapshot(),
    writeAutoSlot: write === undefined ? recorder.write : write,
  });
  session.subscribe((event) => {
    events.push(event);
    auto.handleEvent(event);
  });
  return { auto, events, recorder };
}

describe("自动存档：任务状态变化触发", () => {
  it("任务接取/可交付/完成都触发一次写 auto 槽", () => {
    const session = createSession();
    const written: string[] = [];
    const { auto } = saver(session, (slotId) => {
      written.push(slotId);
      return Promise.resolve();
    });

    for (const event of [
      { type: "quest-accepted", questId: "quest:a", npcId: "npc:1" },
      { type: "quest-ready", questId: "quest:a" },
      { type: "quest-completed", questId: "quest:a", npcId: "npc:1" },
    ] satisfies GameSessionEvent[]) {
      auto.handleEvent(event);
    }

    expect(written).toEqual(["auto", "auto", "auto"]);
  });

  it("战斗/伤害/生命等无关事件不触发", () => {
    const session = createSession();
    const written: string[] = [];
    const { auto } = saver(session, (slotId) => {
      written.push(slotId);
      return Promise.resolve();
    });

    auto.handleEvent({ type: "enemy-killed", enemyId: "e:1", enemyTemplateId: "t:1" });
    auto.handleEvent({
      type: "damage-dealt",
      attackerId: PLAYER_ID,
      targetId: "e:1",
      amount: 3,
      targetHp: 10,
      targetMaxHp: 10,
      heavy: false,
      lethal: false,
      at: 0,
    });
    auto.handleEvent({ type: "dialogue-started", npcId: "npc:1", dialogueId: "d:1" });

    expect(written).toEqual([]);
  });

  it("同一个事件连发不会重复写（读档/事件重放场景）", () => {
    const session = createSession();
    const written: string[] = [];
    const { auto } = saver(session, (slotId) => {
      written.push(slotId);
      return Promise.resolve();
    });

    const event: GameSessionEvent = {
      type: "quest-accepted",
      questId: "quest:a",
      npcId: "npc:1",
    };
    auto.handleEvent(event);
    auto.handleEvent(event);

    expect(written).toEqual(["auto"]);
  });
});

describe("自动存档：获得重要物品触发", () => {
  it("item-gained 触发写 auto 槽", () => {
    const session = createSession();
    const written: string[] = [];
    const { auto } = saver(session, (slotId) => {
      written.push(slotId);
      return Promise.resolve();
    });

    auto.handleEvent({
      type: "item-gained",
      entityId: PLAYER_ID,
      itemId: "item:slime_gel",
      quantity: 2,
    });

    expect(written).toEqual(["auto"]);
  });

  it("NPC 拾取重要物品也触发（世界状态会变）", () => {
    const session = createSession();
    const written: string[] = [];
    const { auto } = saver(session, (slotId) => {
      written.push(slotId);
      return Promise.resolve();
    });

    auto.handleEvent({
      type: "item-gained",
      entityId: "npc:merchant",
      itemId: "item:quest_key",
      quantity: 1,
    });

    expect(written).toEqual(["auto"]);
  });
});

describe("自动存档：区域切换触发", () => {
  it("区域 id 变化后首次快照写 auto 槽（读档换区也算一次）", async () => {
    const written: Array<{ slotId: string; regionId: string | null }> = [];
    let regionId: string | null = "region:arena";
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => ({
        version: 3,
        regionId,
        elapsedMs: 0,
        playerLevel: 1,
        cumulativeXp: 0,
        worldState: {},
        nextItemInstanceId: 1,
        respawnAtMs: null,
        entities: [],
        dialogue: null,
        quests: [],
      }),
      writeAutoSlot: (slotId, snapshot) => {
        written.push({ slotId, regionId: snapshot.regionId });
        return Promise.resolve();
      },
    });

    await auto.notifyRegionChanged();
    expect(written).toEqual([{ slotId: "auto", regionId: "region:arena" }]);

    // 同一区域重复调用不再写。
    await auto.notifyRegionChanged();
    expect(written).toHaveLength(1);

    regionId = "region:cave";
    await auto.notifyRegionChanged();
    expect(written).toHaveLength(2);
    expect(written[1]?.regionId).toBe("region:cave");
  });

  it("首次存档前（区域从未记录）已经写过一次的，同区域不再重复", async () => {
    let writes = 0;
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => ({
        version: 3,
        regionId: REGION_ID,
        elapsedMs: 0,
        playerLevel: 1,
        cumulativeXp: 0,
        worldState: {},
        nextItemInstanceId: 1,
        respawnAtMs: null,
        entities: [],
        dialogue: null,
        quests: [],
      }),
      writeAutoSlot: () => {
        writes += 1;
        return Promise.resolve();
      },
    });

    await auto.notifyRegionChanged();
    await auto.notifyRegionChanged();
    await auto.notifyRegionChanged();

    expect(writes).toBe(1);
  });
});

describe("自动存档：beforeunload 兜底", () => {
  it("注册卸载回调，卸载时同步写 auto 槽", () => {
    const written: string[] = [];
    const captured: { handler: (() => void) | null } = { handler: null };
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => ({
        version: 3,
        regionId: REGION_ID,
        elapsedMs: 500,
        playerLevel: 1,
        cumulativeXp: 0,
        worldState: {},
        nextItemInstanceId: 1,
        respawnAtMs: null,
        entities: [],
        dialogue: null,
        quests: [],
      }),
      writeAutoSlot: (slotId) => {
        written.push(slotId);
        return Promise.resolve();
      },
    });

    auto.attachBeforeUnload((handler) => {
      captured.handler = handler;
      return () => undefined;
    });

    expect(captured.handler).not.toBeNull();
    captured.handler?.();

    expect(written).toEqual(["auto"]);
  });

  it("卸载兜底即使写入 Promise 尚未结算也已经发起", () => {
    const order: string[] = [];
    const captured: { handler: (() => void) | null } = { handler: null };
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => ({
        version: 3,
        regionId: REGION_ID,
        elapsedMs: 0,
        playerLevel: 1,
        cumulativeXp: 0,
        worldState: {},
        nextItemInstanceId: 1,
        respawnAtMs: null,
        entities: [],
        dialogue: null,
        quests: [],
      }),
      writeAutoSlot: () => {
        order.push("write:start");
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push("write:done");
            resolve();
          }, 5);
        });
      },
    });

    auto.attachBeforeUnload((handler) => {
      captured.handler = handler;
      return () => undefined;
    });
    captured.handler?.();
    expect(order).toEqual(["write:start"]);
  });

  it("detach 之后卸载不再写（避免重复注册的页面写两遍）", () => {
    const written: string[] = [];
    const captured: { handler: (() => void) | null } = { handler: null };
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => ({
        version: 3,
        regionId: REGION_ID,
        elapsedMs: 0,
        playerLevel: 1,
        cumulativeXp: 0,
        worldState: {},
        nextItemInstanceId: 1,
        respawnAtMs: null,
        entities: [],
        dialogue: null,
        quests: [],
      }),
      writeAutoSlot: (slotId) => {
        written.push(slotId);
        return Promise.resolve();
      },
    });

    // 真实的 addEventListener 返回值就是取消函数。
    auto.attachBeforeUnload((handler) => {
      captured.handler = handler;
      return () => {
        captured.handler = null;
      };
    });
    auto.detachBeforeUnload();
    captured.handler?.();

    expect(written).toEqual([]);
  });

  it("自动存档写入失败不影响游戏：把错误交给 onError 而不抛出", async () => {
    const errors: unknown[] = [];
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => ({
        version: 3,
        regionId: REGION_ID,
        elapsedMs: 0,
        playerLevel: 1,
        cumulativeXp: 0,
        worldState: {},
        nextItemInstanceId: 1,
        respawnAtMs: null,
        entities: [],
        dialogue: null,
        quests: [],
      }),
      writeAutoSlot: () => Promise.reject(new Error("quota exceeded")),
      onError: (error) => errors.push(error),
    });

    await expect(auto.notifyRegionChanged()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/quota exceeded/);
  });

  it("handleEvent 对触发事件返回 Promise，对无关事件返回 null（供调用方 await/忽略）", () => {
    const session = createSession();
    let pending: Promise<unknown> | null = null;
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => session.snapshot(),
      writeAutoSlot: () => Promise.resolve(),
    });

    expect(auto.handleEvent({ type: "dialogue-ended", npcId: "n", dialogueId: "d" })).toBeNull();
    pending = auto.handleEvent({
      type: "quest-accepted",
      questId: "q",
      npcId: "n",
    });
    expect(pending).toBeInstanceOf(Promise);
    return pending;
  });
});

describe("自动存档器：卸载写入不吞异常也不外泄", () => {
  it("会话快照已不可用时卸载回调静默返回（unload 里抛错只会污染控制台）", () => {
    const written: string[] = [];
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => ({
        version: 3,
        regionId: REGION_ID,
        elapsedMs: 0,
        playerLevel: 1,
        cumulativeXp: 0,
        worldState: {},
        nextItemInstanceId: 1,
        respawnAtMs: null,
        entities: [],
        dialogue: null,
        quests: [],
      }),
      writeAutoSlot: (slotId) => {
        written.push(slotId);
        return Promise.resolve();
      },
      onError: () => {
        throw new Error("error handler itself throws");
      },
    });

    let handler: (() => void) | null = null;
    auto.attachBeforeUnload((h) => {
      handler = h;
      return () => undefined;
    });

    expect(() => handler?.()).not.toThrow();
    expect(written).toEqual(["auto"]);
  });
});
describe("事件去重是有界窗口而不是「最近一条」（review 修复）", () => {
  /** 纯计数用的 saver（快照只要求 regionId 有效）。 */
  function countingSaver() {
    const session = createSession();
    const writes: number[] = [];
    const auto = new GameSaveAutoSaver({
      getSnapshot: () => session.snapshot(),
      writeAutoSlot: () => {
        writes.push(1);
        return Promise.resolve();
      },
    });
    return { auto, writes };
  }

  it("连续三条不同签名的事件都写盘（只记「最近一条」会吃掉后两条）", () => {
    const { auto, writes } = countingSaver();

    // 旧实现只保留 lastEventSignature：第二条把它覆盖、第三条又跟它不同，
    // 看起来没事；但「同一条重放 + 新事件」交替时会周期性丢写。
    // 真实场景：一次任务推进同时发 quest:accepted 与 item-gained，
    // 两条都必须落盘。
    auto.handleEvent({ type: "quest-accepted", questId: "quest:a" } as never);
    auto.handleEvent({ type: "item-gained", entityId: "entity:player", itemId: "item:x", quantity: 1 } as never);
    auto.handleEvent({ type: "quest-ready", questId: "quest:a" } as never);

    expect(writes).toHaveLength(3);
  });

  it("重放去重只挡相邻的同一条事件，不影响后续新事件", () => {
    const { auto, writes } = countingSaver();

    const replay = { type: "item-gained", entityId: "entity:player", itemId: "item:x", quantity: 1 } as never;
    auto.handleEvent(replay);
    expect(auto.handleEvent(replay)).toBeNull();
    auto.handleEvent({ type: "item-gained", entityId: "entity:player", itemId: "item:y", quantity: 2 } as never);

    expect(writes).toHaveLength(2);
  });

  it("紧邻重放同一条签名仍被去重", () => {
    const { auto, writes } = countingSaver();

    const event = { type: "item-gained", entityId: "entity:player", itemId: "item:x", quantity: 1 } as never;
    auto.handleEvent(event);
    expect(auto.handleEvent(event)).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it("去重窗口有界：远早于窗口的签名会被释放（不会永久记忆）", () => {
    const { auto, writes } = countingSaver();

    const first = { type: "quest-accepted", questId: "quest:a" } as never;
    auto.handleEvent(first);
    for (let index = 0; index < 64; index += 1) {
      auto.handleEvent({ type: "quest-ready", questId: `quest:filler_${index}` } as never);
    }
    // 已滑出窗口 → 视为新事件，再写一次（而不是永久记住这条签名）。
    expect(auto.handleEvent(first)).not.toBeNull();
    expect(writes.length).toBeGreaterThan(1);
  });
});
