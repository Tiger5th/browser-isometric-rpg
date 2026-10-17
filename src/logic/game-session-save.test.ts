import { describe, expect, it } from "vitest";

import elderMaCompiled from "../../content/dialogues/elder_ma.ink?ink";
import slimeTemplateData from "../../content/enemy-templates/slime.json";
import slimeBlueData from "../../content/enemies/slime_blue.json";
import slimeElderData from "../../content/enemies/slime_elder.json";
import slimeMeadowData from "../../content/enemies/slime_meadow.json";
import healingHerbData from "../../content/items/healing_herb.json";
import oldCoinData from "../../content/items/old_coin.json";
import slimeGelData from "../../content/items/slime_gel.json";
import travelerSwordData from "../../content/items/traveler_sword.json";
import npcElderData from "../../content/npcs/elder_ma.json";
import npcScoutData from "../../content/npcs/scout_lin.json";
import cullSlimesData from "../../content/quests/cull_slimes.json";
import regionData from "../../content/regions/green_hollow.json";

import type { ContentBundle } from "./content/types";
import { GameSession, GAME_SESSION_SNAPSHOT_VERSION } from "./game-session";
import type { EntitySnapshot, GameSessionSnapshot } from "./game-session";
import { migrateSave, readSessionSnapshot, type SaveFile } from "./save";

const REGION_ID = "region:green_hollow";
const PLAYER_ID = "entity:player";
const NPC_ID = "npc:elder_ma";
const QUEST_ID = "quest:cull_slimes";
const SLIME_TEMPLATE = "enemy_template:slime";

/** 真实 content/ 数据：存档要恢复的正是 P1 最小内容集。 */
const BUNDLE = {
  regions: [regionData],
  npcs: [npcElderData, npcScoutData],
  enemyTemplates: [slimeTemplateData],
  enemies: [slimeMeadowData, slimeBlueData, slimeElderData],
  items: [healingHerbData, oldCoinData, slimeGelData, travelerSwordData],
  quests: [cullSlimesData],
} as unknown as ContentBundle;

function createSession(): GameSession {
  const session = new GameSession();
  session.registerDialogue("elder_ma", elderMaCompiled);
  session.loadRegion(BUNDLE, REGION_ID);
  return session;
}

function playerOf(snapshot: GameSessionSnapshot): EntitySnapshot {
  const player = snapshot.entities.find((entity) => entity.identity.type === "player");
  if (player === undefined) {
    throw new Error("快照中缺少玩家");
  }
  return player;
}

function killSlime(session: GameSession, enemyId: string): void {
  session.emitCombatEvent({
    type: "enemy-killed",
    enemyId,
    enemyTemplateId: SLIME_TEMPLATE,
  });
}

function acceptQuest(session: GameSession): void {
  session.talkTo(NPC_ID);
  session.chooseDialogueOption(1);
}

describe("GameSession.restoreSnapshot：存档往返", () => {
  it("存档 → 继续玩 → 读档后快照逐字段一致，且意图与推进继续生效", () => {
    const saved = createSession();
    saved.moveTo(PLAYER_ID, { x: 4, y: 0, z: 0 });
    saved.advance(400);
    acceptQuest(saved);
    killSlime(saved, "enemy:slime_meadow");
    saved.advance(300);

    const savepoint = saved.snapshot();
    expect(savepoint.version).toBe(GAME_SESSION_SNAPSHOT_VERSION);
    expect(savepoint.quests[0].objectives[0].current).toBe(1);

    // 存档后继续玩：状态必须和存档点不同，才能证明读档真的回滚了。
    killSlime(saved, "enemy:slime_blue");
    saved.advance(800);
    expect(saved.snapshot()).not.toEqual(savepoint);

    const loaded = createSession();
    loaded.restoreSnapshot(savepoint);

    expect(loaded.snapshot()).toEqual(savepoint);
    expect(loaded.currentRegionId).toBe(REGION_ID);

    // 恢复后移动意图生效。
    const before = playerOf(loaded.snapshot());
    loaded.moveTo(PLAYER_ID, { x: 9, y: 0, z: 0 });
    loaded.advance(1000);
    const after = playerOf(loaded.snapshot());
    expect(after.position.x).toBeGreaterThan(before.position.x);
    expect(after.movement).toBeNull();

    // 恢复后推进仍然有效：击杀继续累加任务进度。
    killSlime(loaded, "enemy:slime_elder");
    expect(loaded.snapshot().quests[0].objectives[0].current).toBe(2);
  });

  it("恢复移动中的实体会保留移动意图", () => {
    const saved = createSession();
    saved.moveTo(PLAYER_ID, { x: 20, y: 0, z: 0 });
    saved.advance(200);
    const savepoint = saved.snapshot();
    expect(playerOf(savepoint).movement).not.toBeNull();

    const loaded = createSession();
    loaded.restoreSnapshot(savepoint);

    expect(playerOf(loaded.snapshot()).movement).toEqual(playerOf(savepoint).movement);
    loaded.advance(200);
    expect(playerOf(loaded.snapshot()).position.x).toBeGreaterThan(
      playerOf(savepoint).position.x,
    );
  });

  it("对话中存档：读档后文本/选项一致，选择可继续推进", () => {
    const saved = createSession();
    saved.talkTo(NPC_ID);
    const savepoint = saved.snapshot();
    expect(savepoint.dialogue?.npcId).toBe(NPC_ID);
    expect(savepoint.dialogue?.choices.length).toBeGreaterThan(0);

    const loaded = createSession();
    loaded.restoreSnapshot(savepoint);

    expect(loaded.snapshot().dialogue).toEqual(savepoint.dialogue);

    loaded.chooseDialogueOption(1);
    expect(loaded.snapshot().dialogue).toBeNull();
    expect(loaded.snapshot().quests[0].status).toBe("active");
  });

  it("任务奖励账本、背包与修饰器经往返后不重复发放", () => {
    const saved = createSession();
    acceptQuest(saved);
    killSlime(saved, "enemy:slime_meadow");
    killSlime(saved, "enemy:slime_blue");
    killSlime(saved, "enemy:slime_elder");
    saved.talkTo(NPC_ID);
    saved.chooseDialogueOption(0);
    const savepoint = saved.snapshot();
    const rewarded = playerOf(savepoint);
    expect(savepoint.quests[0].status).toBe("completed");
    expect(rewarded.claimedRewardIds).toEqual([QUEST_ID]);

    const loaded = createSession();
    loaded.restoreSnapshot(savepoint);
    expect(playerOf(loaded.snapshot())).toEqual(rewarded);

    // 已完成任务再次对话不应重复发奖。
    loaded.talkTo(NPC_ID);
    loaded.chooseDialogueOption(0);
    expect(playerOf(loaded.snapshot()).container.items).toEqual(
      rewarded.container.items,
    );
    expect(playerOf(loaded.snapshot()).modifiers).toEqual(rewarded.modifiers);
  });

  it("死亡计时器随存档恢复，读档后按原节奏重生", () => {
    const saved = createSession();
    const snapshot = saved.snapshot();
    const player = snapshot.entities.find((entity) => entity.id === PLAYER_ID);
    if (player === undefined) {
      throw new Error("快照中缺少玩家");
    }
    player.combat.hp = 0;
    player.combat.alive = false;
    snapshot.respawnAtMs = snapshot.elapsedMs + 1000;

    const loaded = createSession();
    loaded.restoreSnapshot(snapshot);
    expect(playerOf(loaded.snapshot()).combat.alive).toBe(false);
    expect(loaded.snapshot().respawnAtMs).toBe(snapshot.respawnAtMs);

    loaded.advance(1000);
    const respawned = playerOf(loaded.snapshot());
    expect(respawned.combat.alive).toBe(true);
    expect(respawned.combat.hp).toBe(respawned.combat.maxHp);
    expect(loaded.snapshot().respawnAtMs).toBeNull();
  });

  it("旧版 v1 存档经迁移链升级后可直接恢复进新会话", () => {
    const legacySave: SaveFile = {
      version: 1,
      sections: {
        world: { regionId: REGION_ID, elapsedMs: 5000 },
        player: {
          attributes: { maxHp: 100, hp: 70, attack: 15, defense: 4 },
          inventory: [{ id: "item:healing_herb", qty: 2 }],
        },
        quests: [
          {
            id: QUEST_ID,
            title: "清理史莱姆",
            giverNpcId: NPC_ID,
            turnInNpcId: NPC_ID,
            status: "active",
            objectives: [
              {
                id: "objective:kill_slimes",
                type: "kill",
                enemyTemplateId: SLIME_TEMPLATE,
                current: 2,
                required: 3,
              },
            ],
          },
        ],
      },
    };

    const migrated = readSessionSnapshot(migrateSave(legacySave));
    const session = createSession();
    session.restoreSnapshot(migrated);

    const restored = session.snapshot();
    expect(restored.elapsedMs).toBe(5000);
    const player = playerOf(restored);
    expect(player.combat.hp).toBe(70);
    expect(player.attributes.attack).toBe(15);
    expect(player.container.items.map((item) => [item.templateId, item.quantity])).toEqual([
      ["item:healing_herb", 2],
    ]);
    expect(restored.quests[0].status).toBe("active");
    expect(restored.quests[0].objectives[0].current).toBe(2);

    // 迁移后继续玩：击杀推进到可交付。
    killSlime(session, "enemy:slime_meadow");
    expect(session.snapshot().quests[0].status).toBe("ready_to_turn_in");
  });

  it("损坏的修饰器/标签/奖励账本整体拒绝读档，且不留下半恢复状态", () => {
    const session = createSession();
    acceptQuest(session);
    killSlime(session, "enemy:slime_meadow");
    session.moveTo(PLAYER_ID, { x: 3, y: 0, z: 0 });
    session.advance(200);
    const before = session.snapshot();
    const playerIndex = before.entities.findIndex(
      (entity) => entity.identity.type === "player",
    );
    expect(playerIndex).toBeGreaterThanOrEqual(0);

    const badValue = structuredClone(before);
    badValue.entities[playerIndex].modifiers = [
      {
        id: "equipment:bad:0",
        attribute: "moveSpeed",
        operation: "add",
        value: "1205",
        source: { kind: "equipment", id: "item:bad@1" },
      } as unknown as (typeof badValue.entities)[number]["modifiers"][number],
    ];
    expect(() => session.restoreSnapshot(badValue)).toThrow(/value/);

    const badOperation = structuredClone(before);
    badOperation.entities[playerIndex].modifiers = [
      {
        id: "equipment:bad:0",
        attribute: "moveSpeed",
        operation: "inject",
        value: 1,
        source: { kind: "equipment", id: "item:bad@1" },
      } as unknown as (typeof badOperation.entities)[number]["modifiers"][number],
    ];
    expect(() => session.restoreSnapshot(badOperation)).toThrow(/operation/);

    const badTags = structuredClone(before);
    badTags.entities[playerIndex].tags = [123 as unknown as string];
    expect(() => session.restoreSnapshot(badTags)).toThrow(/tags/);

    const badLedger = structuredClone(before);
    badLedger.entities[playerIndex].claimedRewardIds = [
      42 as unknown as string,
    ];
    expect(() => session.restoreSnapshot(badLedger)).toThrow(/claimedRewardIds/);

    expect(session.snapshot()).toEqual(before);
  });

  it("任务快照非法时整体拒绝，已有实体/任务状态保持不变（两阶段恢复）", () => {
    const session = createSession();
    acceptQuest(session);
    killSlime(session, "enemy:slime_meadow");
    const before = session.snapshot();

    const corrupted = structuredClone(before);
    corrupted.quests[0].objectives[0].current = 99;
    expect(() => session.restoreSnapshot(corrupted)).toThrow(/进度非法/);
    expect(session.snapshot()).toEqual(before);
  });

  it("拒绝版本不符、未知实体与区域不符的快照", () => {
    const session = createSession();
    const savepoint = session.snapshot();

    expect(() =>
      session.restoreSnapshot({ ...savepoint, version: savepoint.version + 1 }),
    ).toThrow(/版本/);

    const unknownEntity = structuredClone(savepoint);
    unknownEntity.entities[0].id = "entity:ghost" as typeof unknownEntity.entities[0]["id"];
    expect(() => createSession().restoreSnapshot(unknownEntity)).toThrow(/未知实体/);

    expect(() =>
      createSession().restoreSnapshot({ ...savepoint, regionId: "region:other" }),
    ).toThrow(/区域/);
  });
});
