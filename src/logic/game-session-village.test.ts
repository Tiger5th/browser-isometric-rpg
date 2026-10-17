/**
 * 村庄安全区 / 商人经济 / NPC 巡逻与换锚点（票 33）的 L1 结算测试。
 *
 * 全部经 GameSession 的公开接口（意图 + 快照 + 订阅事件），不碰内部字段。
 */

import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { GameSession } from "./game-session";
import type { GameSessionEvent } from "./game-events";
import { Compiler } from "inkjs/full";
import { COIN_ITEM_ID } from "./trade";

const REGION_ID = "region:village";
const PLAYER_ID = "entity:player";
const ELDER_ID = "npc:elder_ma";
const VENDOR_ID = "npc:merchant_bo";
const SLIME_ID = "enemy:slime_outside";
const SLIME_TEMPLATE = "enemy_template:slime";
const GEL = "item:slime_gel";
const HERB = "item:healing_herb";
const COIN = COIN_ITEM_ID;

const QUEST_ID = "quest:cull_slimes";

/** 村庄在原点附近（安全区），史莱姆在安全区之外。 */
function villageBundle(): ContentBundle {
  return {
    regions: [
      {
        id: REGION_ID,
        displayName: "翠谷",
        asset: { model: "assets/regions/green_hollow.glb" },
        player: {
          id: PLAYER_ID,
          templateId: "player_template:hero",
          displayName: "旅人",
          spawn: { position: { x: 0, y: 0, z: 0 } },
          baseAttributes: {
            maxHp: 100,
            hp: 100,
            attack: 40,
            defense: 4,
            moveSpeed: 5.5,
          },
        },
        safeZones: [
          {
            id: "zone:village",
            shape: "rect",
            center: { x: 0, y: 0, z: 0 },
            halfExtents: { x: 10, z: 10 },
          },
        ],
      },
    ],
    npcs: [
      {
        id: ELDER_ID,
        displayName: "马婆婆",
        templateId: "npc_template:elder",
        regionId: REGION_ID,
        position: { x: 2, y: 0, z: 0 },
        tags: ["npc"],
        dialogueId: "elder_ma",
        questIds: [QUEST_ID],
        patrol: {
          waypoints: [
            { x: 2, y: 0, z: 0 },
            { x: 4, y: 0, z: 2 },
          ],
          dwellMs: 200,
        },
        reanchors: [
          {
            questId: QUEST_ID,
            waypoints: [
              { x: 8, y: 0, z: 0 },
              { x: 10, y: 0, z: 0 },
            ],
            dwellMs: 200,
          },
        ],
      },
      {
        id: VENDOR_ID,
        displayName: "老陶",
        templateId: "npc_template:merchant",
        regionId: REGION_ID,
        position: { x: -2, y: 0, z: 0 },
        tags: ["npc", "vendor"],
        dialogueId: "merchant_bo",
        vendor: { sell: { [GEL]: 3 }, buy: { [HERB]: 15 } },
        patrol: {
          waypoints: [
            { x: -2, y: 0, z: 0 },
            { x: -4, y: 0, z: 1 },
          ],
          dwellMs: 200,
        },
      },
    ],
    enemyTemplates: [
      {
        id: SLIME_TEMPLATE,
        displayName: "翠谷史莱姆",
        aiProfileId: "ai:melee_chaser",
        baseAttributes: {
          maxHp: 30,
          hp: 30,
          attack: 5,
          defense: 1,
          moveSpeed: 3,
          aggroRadius: 14,
          xp: 10,
        },
        drops: [],
      },
    ],
    enemies: [
      {
        id: SLIME_ID,
        templateId: SLIME_TEMPLATE,
        displayName: "草原史莱姆",
        regionId: REGION_ID,
        position: { x: 14, y: 0, z: 0 },
      },
    ],
    items: [
      {
        id: COIN,
        displayName: "旧铜币",
        kind: "misc",
        description: "铜币",
        maxStack: 999,
        value: 1,
      },
      {
        id: GEL,
        displayName: "史莱姆凝胶",
        kind: "misc",
        description: "凝胶",
        maxStack: 99,
        value: 2,
      },
      {
        id: HERB,
        displayName: "疗伤草",
        kind: "consumable",
        description: "草药",
        maxStack: 9,
        value: 12,
        consumable: { effects: [{ type: "restore", attribute: "hp", amount: 30 }] },
      },
    ],
    quests: [
      {
        id: QUEST_ID,
        title: "清理史莱姆",
        giverNpcId: ELDER_ID,
        turnInNpcId: ELDER_ID,
        objectives: [
          {
            id: "objective:kill_slimes",
            type: "kill",
            enemyTemplateId: SLIME_TEMPLATE,
            count: 1,
          },
        ],
        rewards: { items: [{ itemId: GEL, quantity: 4 }] },
      },
    ],
  };
}

function newSession(): GameSession {
  const session = new GameSession();
  session.registerDialogue("elder_ma", compileInk(elderMaInk()));
  session.registerDialogue("merchant_bo", compileInk(merchantInk()));
  session.loadRegion(villageBundle(), REGION_ID);
  return session;
}

function compileInk(source: string): string {
  const compiler = new Compiler(source);
  const story = compiler.Compile();
  if (story === null || compiler.errors.length > 0) {
    throw new Error("ink 编译失败：" + compiler.errors.map((e) => String(e)).join("; "));
  }
  const json = story.ToJson();
  if (typeof json !== "string") {
    throw new Error("ink 编译结果无法序列化");
  }
  return json;
}

/**
 * 与 content/dialogues/elder_ma.ink 同形：available → 接取 → ready_to_turn_in → 复命。
 * 这里不 import 内容文件本身，而是写一份最小同形 ink：内容对话的分支结构
 * （每个条件块都带一行台词）会影响 ink 的选择点，测试必须用真实可编译的形状。
 */
function elderMaInk(): string {
  return [
    "EXTERNAL questStatus(questId)",
    "-> start",
    "",
    "=== start ===",
    "马婆婆：旅人，你来得正好。",
    '{ questStatus("quest:cull_slimes") == "available":',
    "    * [发生了什么？]",
    "        马婆婆：它们从溪边涌出来。",
    "        -> offer",
    "}",
    '{ questStatus("quest:cull_slimes") == "ready_to_turn_in":',
    "    * [复命：史莱姆已经清理完了。]",
    "        -> turn_in",
    "}",
    '{ questStatus("quest:cull_slimes") == "completed":',
    "    马婆婆：路上小心。",
    "    -> END",
    "}",
    "",
    "=== offer ===",
    "# quest:offer:quest:cull_slimes",
    "马婆婆：帮我们清理史莱姆。",
    "-> END",
    "",
    "=== turn_in ===",
    "# quest:turnin:quest:cull_slimes",
    "马婆婆：你做到了。",
    "-> END",
  ].join("\n");
}

/** 商人的闲聊对话：给「对话结束后可开交易」一个真实起点。 */
function merchantInk(): string {
  return [
    "-> start",
    "=== start ===",
    "老陶：走走看看，草药刚到的。",
    "    * [交易。]",
    "        老陶：随便挑。",
    "        -> END",
    "    * [再见。]",
    "        -> END",
  ].join("\n");
}

function positionOf(session: GameSession, id: string): { x: number; z: number } {
  const entity = session.snapshot().entities.find((entry) => entry.id === id);
  if (!entity) {
    throw new Error(`快照缺少实体：${id}`);
  }
  return { x: entity.position.x, z: entity.position.z };
}

function itemTotal(session: GameSession, itemId: string): number {
  const player = session.snapshot().entities.find((entry) => entry.id === PLAYER_ID);
  return (player?.container.items ?? [])
    .filter((item) => item.templateId === itemId)
    .reduce((sum, item) => sum + item.quantity, 0);
}

describe("村庄安全区（票 33，user story 12）", () => {
  it("玩家站在安全区内时，敌人 AI 拒止追击（不追入）", () => {
    const session = newSession();
    session.moveTo(PLAYER_ID, { x: 0, y: 0, z: 0 });
    session.advance(2000);
    // 敌人在 (14,0)，安全区是 |x|<=10 的矩形；玩家在区内，敌人不得进入。
    const slime = positionOf(session, SLIME_ID);
    expect(slime.x).toBeGreaterThan(10);
  });

  it("玩家离开安全区后敌人恢复追击", () => {
    const session = newSession();
    session.moveTo(PLAYER_ID, { x: 0, y: 0, z: 0 });
    session.advance(2000);
    expect(positionOf(session, SLIME_ID).x).toBeGreaterThan(10);

    session.moveTo(PLAYER_ID, { x: 16, y: 0, z: 0 });
    session.advance(4000);
    expect(positionOf(session, SLIME_ID).x).toBeLessThan(16);
  });

  it("安全区内的敌人不会站桩追击到区内中心（停在边界外）", () => {
    const session = newSession();
    session.moveTo(PLAYER_ID, { x: 10, y: 0, z: 0 });
    session.advance(6000);
    expect(positionOf(session, SLIME_ID).x).toBeGreaterThan(10);
  });

  it("没有安全区的区域行为不变（敌人照常追到玩家跟前）", () => {
    const bundle = villageBundle();
    bundle.regions[0].safeZones = undefined;
    const session = new GameSession();
    session.loadRegion(bundle, REGION_ID);
    session.moveTo(PLAYER_ID, { x: 12, y: 0, z: 0 });
    session.advance(6000);
    expect(positionOf(session, SLIME_ID).x).toBeLessThanOrEqual(12.5);
  });
});

describe("商人买卖闭环（票 33，user story 13）", () => {
  it("玩家能在商人处读出买卖列表与价格表", () => {
    const session = newSession();
    const offer = session.vendorOffer(VENDOR_ID);
    expect(offer).not.toBeNull();
    expect(offer?.rows.map((row) => [row.kind, row.itemId, row.unitPrice])).toEqual([
      ["sell", GEL, 3],
      ["buy", HERB, 15],
    ]);
  });

  it("非商人 NPC 没有报价", () => {
    const session = newSession();
    expect(session.vendorOffer(ELDER_ID)).toBeNull();
  });

  it("卖出凝胶：凝胶减少、金币按价格表入包", () => {
    const session = newSession();
    session.grantItem(PLAYER_ID, GEL, 5);
    const result = session.trySellToVendor(VENDOR_ID, GEL, 2);
    expect(result).toMatchObject({ ok: true, message: undefined, quantity: 2 });
    expect(itemTotal(session, GEL)).toBe(3);
    expect(itemTotal(session, COIN)).toBe(6);
  });

  it("买入草药：金币按单价扣除、草药入包", () => {
    const session = newSession();
    session.grantItem(PLAYER_ID, COIN, 40);
    const result = session.tryBuyFromVendor(VENDOR_ID, HERB, 2);
    expect(result).toMatchObject({ ok: true, quantity: 2 });
    expect(itemTotal(session, COIN)).toBe(10);
    expect(itemTotal(session, HERB)).toBe(2);
  });

  it("金币不足时拒绝购买且不改动背包（金币不凭空变负）", () => {
    const session = newSession();
    session.grantItem(PLAYER_ID, COIN, 5);
    const result = session.tryBuyFromVendor(VENDOR_ID, HERB, 1);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("金币不够");
    expect(itemTotal(session, COIN)).toBe(5);
    expect(itemTotal(session, HERB)).toBe(0);
  });

  it("背包里没有该物品时拒绝卖出", () => {
    const session = newSession();
    const result = session.trySellToVendor(VENDOR_ID, GEL, 1);
    expect(result.ok).toBe(false);
    expect(itemTotal(session, COIN)).toBe(0);
  });

  it("买卖发布 item-gained 事件（反馈层与 HUD 消费）", () => {
    const session = newSession();
    session.grantItem(PLAYER_ID, GEL, 3);
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    session.trySellToVendor(VENDOR_ID, GEL, 1);
    expect(
      events.filter(
        (event) => event.type === "item-gained" && event.itemId === COIN && event.quantity === 3,
      ),
    ).toHaveLength(1);
  });

  it("玩家持币数即背包里的旧铜币数量（与存档口径一致）", () => {
    const session = newSession();
    session.grantItem(PLAYER_ID, COIN, 7);
    expect(session.coinsOf(PLAYER_ID)).toBe(7);
  });
});

describe("NPC 巡逻与对话暂停（票 33，user story 14/15）", () => {
  it("NPC 沿巡逻路线走停：会真的走到下一个点位并停留", () => {
    const session = newSession();
    const visited: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < 40; i += 1) {
      session.advance(200);
      visited.push(positionOf(session, VENDOR_ID));
    }
    const atHome = { x: -2, z: 0 };
    const atFar = { x: -4, z: 1 };
    expect(visited).toContainEqual(atHome);
    expect(visited).toContainEqual(atFar);
  });

  it("对话期间巡逻暂停：位置冻结；结束对话后继续", () => {
    const session = newSession();
    session.advance(1000);
    session.talkTo(ELDER_ID);
    const during = positionOf(session, ELDER_ID);
    session.advance(3000);
    expect(positionOf(session, ELDER_ID)).toEqual(during);

    session.endDialogue();
    session.advance(3000);
    expect(positionOf(session, ELDER_ID)).not.toEqual(during);
  });

  it("对话时 NPC 面向玩家（朝向是快照里的世界事实）", () => {
    const session = newSession();
    session.moveTo(PLAYER_ID, { x: 3.5, y: 0, z: 0 });
    session.advance(1000);
    session.talkTo(ELDER_ID);
    session.faceNpc(PLAYER_ID, ELDER_ID);
    const snapshot = session.snapshot();
    const elder = snapshot.entities.find((entry) => entry.id === ELDER_ID)!;
    const player = snapshot.entities.find((entry) => entry.id === PLAYER_ID)!;
    // 朝向约定：+Z 为 0、朝 +X 为 π/2；两人的正面向量都应指向对方。
    const facing = (yaw: number): { x: number; z: number } => ({
      x: Math.sin(yaw),
      z: Math.cos(yaw),
    });
    const toward = (from: typeof elder, to: typeof player) => {
      const dx = to.position.x - from.position.x;
      const dz = to.position.z - from.position.z;
      const length = Math.hypot(dx, dz);
      return { x: dx / length, z: dz / length };
    };
    const dot = (a: { x: number; z: number }, b: { x: number; z: number }) =>
      a.x * b.x + a.z * b.z;
    expect(dot(facing(elder.rotation.y), toward(elder, player))).toBeGreaterThan(0.95);
    expect(dot(facing(player.rotation.y), toward(player, elder))).toBeGreaterThan(0.95);
  });
});

describe("巡逻进度与读档恢复（票 33）", () => {
  it("快照带出巡逻进度（点位索引）", () => {
    const session = newSession();
    const indices = new Set<number | undefined>();
    for (let i = 0; i < 40; i += 1) {
      session.advance(200);
      indices.add(
        session.snapshot().entities.find((entry) => entry.id === VENDOR_ID)?.patrolIndex,
      );
    }
    // 两个点位都被记录过：进度真的在动。
    expect([...indices].sort()).toEqual([0, 1]);
  });

  it("没有巡逻路线的实体不写 patrolIndex（可选字段）", () => {
    const session = newSession();
    expect(session.snapshot().entities.find((e) => e.id === SLIME_ID)?.patrolIndex).toBeUndefined();
  });

  it("快照往返后 NPC 位置与巡逻进度都恢复（不回到出生点重来）", () => {
    const session = newSession();
    session.advance(1250);
    const before = positionOf(session, VENDOR_ID);
    const beforeIndex = session.snapshot().entities.find((e) => e.id === VENDOR_ID)?.patrolIndex;
    // 断言点必须真的在路上（不是恰好站在点位上，否则恢复对不上也看不出问题）。
    expect(Math.hypot(before.x + 2, before.z)).toBeGreaterThan(0.05);

    const restored = new GameSession();
    restored.registerDialogue("elder_ma", compileInk(elderMaInk()));
    restored.registerDialogue("merchant_bo", compileInk(merchantInk()));
    restored.loadRegion(villageBundle(), REGION_ID);
    restored.restoreSnapshot(JSON.parse(session.serialize()) as never);
    const after = positionOf(restored, VENDOR_ID);
    expect(after).toEqual(before);
    expect(restored.snapshot().entities.find((e) => e.id === VENDOR_ID)?.patrolIndex).toBe(
      beforeIndex,
    );
  });

  it("读档后巡逻从恢复的进度继续，而不是跳回首点", () => {
    const session = newSession();
    // 跑到远端点位（索引 1）后存档：等到真的站上去为止。
    for (let i = 0; i < 60; i += 1) {
      session.advance(100);
      if (positionOf(session, VENDOR_ID).x === -4) {
        break;
      }
    }
    expect(positionOf(session, VENDOR_ID)).toEqual({ x: -4, z: 1 });
    const restored = new GameSession();
    restored.registerDialogue("elder_ma", compileInk(elderMaInk()));
    restored.registerDialogue("merchant_bo", compileInk(merchantInk()));
    restored.loadRegion(villageBundle(), REGION_ID);
    restored.restoreSnapshot(JSON.parse(session.serialize()) as never);
    // 从索引 1 的张望继续 → 走回点位 0，而不是从点位 1 重新出发（index 会先跳 0）。
    restored.advance(1000);
    expect(positionOf(restored, VENDOR_ID)).not.toEqual({ x: -4, z: 1 });
    restored.advance(1200);
    expect(positionOf(restored, VENDOR_ID)).toEqual({ x: -2, z: 0 });
  });
});

/**
 * 走真实路径完成任务：对话接取 → 击杀事件推进 → 对话复命。
 * 不给会话加测试专用后门，换锚点必须在真实任务流程里触发。
 */
function completeQuest(session: GameSession): void {
  session.talkTo(ELDER_ID);
  session.chooseDialogueOption(0);
  session.emitCombatEvent({
    type: "enemy-killed",
    enemyId: SLIME_ID,
    enemyTemplateId: SLIME_TEMPLATE,
  });
  session.talkTo(ELDER_ID);
  session.chooseDialogueOption(0);
}

describe("任务完成后换锚点（票 33，user story 16）", () => {
  it("任务完成时 NPC 换到新锚点并广播 npc-reanchored 事件", () => {
    const session = newSession();
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    completeQuest(session);
    const elder = positionOf(session, ELDER_ID);
    expect(elder).toEqual({ x: 8, z: 0 });
    expect(
      events.filter(
        (event) => event.type === "npc-reanchored" && event.npcId === ELDER_ID,
      ),
    ).toHaveLength(1);
  });

  it("换锚点后 NPC 在新锚点附近继续巡逻（不站桩）", () => {
    const session = newSession();
    completeQuest(session);
    session.advance(5000);
    expect(positionOf(session, ELDER_ID)).not.toEqual({ x: 8, z: 0 });
  });

  it("换锚点后的位置与进度同样进快照并可读档恢复", () => {
    const session = newSession();
    completeQuest(session);
    const restored = new GameSession();
    restored.registerDialogue("elder_ma", compileInk(elderMaInk()));
    restored.registerDialogue("merchant_bo", compileInk(merchantInk()));
    restored.loadRegion(villageBundle(), REGION_ID);
    restored.restoreSnapshot(JSON.parse(session.serialize()) as never);
    expect(positionOf(restored, ELDER_ID)).toEqual({ x: 8, z: 0 });
  });

  it("没有 reanchors 声明的 NPC 不受任务完成影响", () => {
    const session = newSession();
    completeQuest(session);
    expect(positionOf(session, VENDOR_ID)).toEqual({ x: -2, z: 0 });
  });
});

describe("换锚点后巡逻路线随之更新（review 修复）", () => {
  it("patrolSampleOf 用的是新路线的点位，而不是内容里的旧路线", () => {
    const session = newSession();
    // 换锚点前：路线 = 内容里的两点（2,0,0) → (4,0,2)。
    const before = session.patrolSampleOf(ELDER_ID);
    expect(before).not.toBeNull();

    completeQuest(session);

    const after = session.patrolSampleOf(ELDER_ID);
    expect(after).not.toBeNull();
    expect(after!.position).toEqual({ x: 8, y: 0, z: 0 });
    // 站着不动时（刚换锚点，index 0）朝向前一点 (10,0,0)，即 +X（π/2）。
    // 若 patrolRoutes 还是旧路线，这里会算成朝旧路线的 (4,0,2) 方向。
    session.advance(300);
    const walking = session.patrolSampleOf(ELDER_ID)!;
    expect(walking.moving).toBe(true);
    expect(walking.position.x).toBeGreaterThan(8);
  });

  it("读档恢复后巡逻点位同样是新路线（patrolRoutes 进快照的实体位置一致）", () => {
    const session = newSession();
    completeQuest(session);
    session.advance(600);
    const live = session.patrolSampleOf(ELDER_ID)!.position;

    const restored = new GameSession();
    restored.registerDialogue("elder_ma", compileInk(elderMaInk()));
    restored.registerDialogue("merchant_bo", compileInk(merchantInk()));
    restored.loadRegion(villageBundle(), REGION_ID);
    restored.restoreSnapshot(JSON.parse(session.serialize()) as never);

    expect(restored.patrolSampleOf(ELDER_ID)!.position).toEqual(live);
  });
});

/**
 * 安全区拒止对**所有** AI 档案生效（review 修复）：
 * 原先只有 melee_chaser 查 playerIsSheltered，冲锋型与吐弹型直接绕过，
 * 于是玩家站在村口也会被冲锋/吐弹命中。
 */
function specializedAiBundle(aiProfile: unknown): ContentBundle {
  const bundle = villageBundle();
  bundle.enemyTemplates = [
    {
      id: "enemy_template:charger",
      displayName: "角冲兽",
      aiProfileId: "ai:windup_charge",
      aiProfile: aiProfile as never,
      baseAttributes: {
        maxHp: 34,
        hp: 34,
        attack: 9,
        defense: 1,
        moveSpeed: 4,
        aggroRadius: 30,
        xp: 14,
      },
      drops: [],
    },
  ];
  // 敌人放在安全区**内**，玩家也在区内：没有拒止的话冲锋型会直接起手。
  bundle.enemies = [
    {
      id: "enemy:special",
      templateId: "enemy_template:charger",
      displayName: "测试用敌",
      regionId: REGION_ID,
      position: { x: 5, y: 0, z: 0 },
    },
  ];
  return bundle;
}

function newAiSession(aiProfile: unknown): GameSession {
  const session = new GameSession();
  session.loadRegion(specializedAiBundle(aiProfile), REGION_ID);
  session.moveTo(PLAYER_ID, { x: 0, y: 0, z: 0 });
  return session;
}

const CHARGE_PROFILE = {
  kind: "windup-charge",
  windupMs: 600,
  chargeSpeed: 14,
  chargeDistance: 8,
  recoveryMs: 900,
  triggerRange: 6,
  hitRadius: 1,
};

const KITE_PROFILE = {
  kind: "ranged-kite",
  preferredRange: 8,
  retreatRange: 5,
  fireIntervalMs: 2000,
  projectileSpeed: 16,
  projectileDamage: 7,
  projectileRadius: 0.35,
  projectileLifetimeMs: 2500,
};

describe("安全区拒止对冲锋/吐弹同样生效（review 修复）", () => {
  it("冲锋型在玩家处于安全区时不起手前摇、不冲锋", () => {
    const session = newAiSession(CHARGE_PROFILE);
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    session.advance(4000);

    expect(events.some((event) => event.type === "attack-windup-started")).toBe(false);
    // 敌人原地不动（没有朝向玩家的移动意图），玩家满血。
    expect(positionOf(session, "enemy:special")).toEqual({ x: 5, z: 0 });
    const player = session.snapshot().entities.find((entry) => entry.id === PLAYER_ID);
    expect(player?.combat.hp).toBe(player?.baseAttributes.maxHp);
  });

  it("冲锋型在玩家出安全区后恢复正常（拒止不是永久失效）", () => {
    const session = newAiSession(CHARGE_PROFILE);
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    session.moveTo(PLAYER_ID, { x: 20, y: 0, z: 0 });
    session.advance(4000);

    expect(events.some((event) => event.type === "attack-windup-started")).toBe(true);
  });

  it("吐弹型在玩家处于安全区时不发射投射物", () => {
    const session = newAiSession(KITE_PROFILE);
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    session.advance(4000);

    expect(events.some((event) => event.type === "projectile-spawned")).toBe(false);
    const player = session.snapshot().entities.find((entry) => entry.id === PLAYER_ID);
    expect(player?.combat.hp).toBe(player?.baseAttributes.maxHp);
  });

  it("吐弹型在玩家出安全区后恢复开火", () => {
    const session = newAiSession(KITE_PROFILE);
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    session.moveTo(PLAYER_ID, { x: 20, y: 0, z: 0 });
    session.advance(4000);

    expect(events.some((event) => event.type === "projectile-spawned")).toBe(true);
  });
});
