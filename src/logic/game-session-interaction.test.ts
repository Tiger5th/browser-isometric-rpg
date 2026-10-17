import { Compiler } from "inkjs/full";
import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { GameSession } from "./game-session";

const QUEST_ID = "quest:cull_slimes";
const NPC_ID = "npc:elder_ma";
const PLAYER_ID = "entity:player";
const NPC_POSITION = { x: 6, y: 0, z: 4 };

function bundle(): ContentBundle {
  return {
    regions: [
      {
        id: "region:green_hollow",
        displayName: "翠谷",
        asset: { model: "assets/regions/green_hollow.glb" },
        player: {
          id: PLAYER_ID,
          templateId: "player_template:hero",
          displayName: "旅人",
          spawn: { position: { x: 0, y: 0, z: 0 } },
          baseAttributes: { maxHp: 100, hp: 100, attack: 12 },
        },
      },
    ],
    npcs: [
      {
        id: NPC_ID,
        displayName: "马婆婆",
        templateId: "npc_template:elder",
        regionId: "region:green_hollow",
        position: { ...NPC_POSITION },
        dialogueId: "elder_ma",
        questIds: [QUEST_ID],
      },
      {
        id: "npc:scout_lin",
        displayName: "林斥候",
        templateId: "npc_template:scout",
        regionId: "region:green_hollow",
        position: { x: -6, y: 0, z: 3 },
      },
    ],
    enemyTemplates: [],
    enemies: [],
    items: [],
    quests: [
      {
        id: QUEST_ID,
        title: "清理史莱姆",
        giverNpcId: NPC_ID,
        objectives: [
          { id: "objective:kill_slimes", type: "kill", enemyTemplateId: "enemy_template:slime", count: 3 },
        ],
        rewards: { modifiers: [{ attribute: "maxHp", operation: "add", value: 10 }] },
      },
    ],
  };
}

function compileInk(source: string): string {
  const compiler = new Compiler(source);
  const story = compiler.Compile();
  if (story === null || compiler.errors.length > 0) {
    throw new Error(`测试 ink 编译失败：\n${compiler.errors.join("\n")}`);
  }
  const json = story.ToJson();
  if (typeof json !== "string") {
    throw new Error("测试 ink 编译结果无法序列化");
  }
  return json;
}

function createSession(): GameSession {
  const session = new GameSession();
  session.registerDialogue("elder_ma", compileInk(dialogueSource()));
  session.loadRegion(bundle(), "region:green_hollow");
  return session;
}

/** 停在选择点的对话：足以覆盖「移动意图打断」语义，不涉及任务状态转移。 */
function dialogueSource(): string {
  return [
    "EXTERNAL questStatus(questId)",
    "-> start",
    "",
    "=== start ===",
    "马婆婆：旅人，你来了。",
    '{ questStatus("quest:cull_slimes") == "available":',
    "    * [继续]",
    "        马婆婆：路上小心。",
    "        -> END",
    "}",
    "",
  ].join("\n");
}

function entityOf(session: GameSession, id: string) {
  const entity = session.snapshot().entities.find((entry) => entry.id === id);
  if (!entity) {
    throw new Error(`快照缺少实体 ${id}`);
  }
  return entity;
}

/** 把玩家传送到 NPC 附近（绕过移动推进，专注意图语义）。 */
function teleport(session: GameSession, x: number, z: number): void {
  session.moveTo(PLAYER_ID, { x, y: 0, z });
  for (let step = 0; step < 400; step += 1) {
    session.advance(100);
    const player = entityOf(session, PLAYER_ID);
    if (player.movement === null) {
      return;
    }
  }
  throw new Error("传送未完成");
}

function distance(session: GameSession, fromId: string, toId: string): number {
  const from = entityOf(session, fromId).position;
  const to = entityOf(session, toId).position;
  return Math.hypot(from.x - to.x, from.z - to.z);
}

describe("GameSession 靠近与面对面", () => {
  it("approachNpc 让玩家朝 NPC 走到对话距离并停下", () => {
    const session = createSession();
    expect(distance(session, PLAYER_ID, NPC_ID)).toBeCloseTo(Math.hypot(6, 4), 5);

    session.approachNpc(PLAYER_ID, NPC_ID);

    const player = entityOf(session, PLAYER_ID);
    expect(player.movement).not.toBeNull();
    for (let step = 0; step < 400 && entityOf(session, PLAYER_ID).movement !== null; step += 1) {
      session.advance(100);
    }
    expect(distance(session, PLAYER_ID, NPC_ID)).toBeCloseTo(1.5, 1);
  });

  it("靠近意图是普通移动意图：可被新的移动打断", () => {
    const session = createSession();

    session.approachNpc(PLAYER_ID, NPC_ID);
    session.moveTo(PLAYER_ID, { x: 0, y: 0, z: 0 });

    for (let step = 0; step < 200 && entityOf(session, PLAYER_ID).movement !== null; step += 1) {
      session.advance(100);
    }
    const player = entityOf(session, PLAYER_ID);
    expect(player.position.x).toBeCloseTo(0, 1);
    expect(player.position.z).toBeCloseTo(0, 1);
  });

  it("canTalkTo 之外的距离不再影响对话：faceNpc 让双方转向面对面", () => {
    const session = createSession();
    teleport(session, NPC_POSITION.x + 1, NPC_POSITION.z);

    session.faceNpc(PLAYER_ID, NPC_ID);

    const player = entityOf(session, PLAYER_ID);
    const npc = entityOf(session, NPC_ID);
    // rotation.y = atan2(dx, dz)；玩家应指向 NPC，NPC 应指向玩家。
    expect(player.rotation.y).toBeCloseTo(Math.atan2(NPC_POSITION.x - player.position.x, NPC_POSITION.z - player.position.z), 3);
    expect(npc.rotation.y).toBeCloseTo(Math.atan2(player.position.x - NPC_POSITION.x, player.position.z - NPC_POSITION.z), 3);
  });

  it("对话中玩家移动意图结束对话并发布 dialogue-ended", () => {
    const session = createSession();
    teleport(session, NPC_POSITION.x + 1, NPC_POSITION.z);
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));

    session.talkTo(NPC_ID);
    expect(session.snapshot().dialogue).not.toBeNull();

    session.moveTo(PLAYER_ID, { x: 0, y: 0, z: 0 });

    expect(session.snapshot().dialogue).toBeNull();
    expect(events).toEqual(["dialogue-started", "dialogue-ended"]);
  });

  it("对话中点击地面之外的意图（攻击/选项）不会结束对话", () => {
    const session = createSession();
    teleport(session, NPC_POSITION.x + 1, NPC_POSITION.z);
    session.talkTo(NPC_ID);

    session.stopAttack(PLAYER_ID);

    expect(session.snapshot().dialogue).not.toBeNull();
  });

  it("endDialogue 幂等：没有对话时静默返回", () => {
    const session = createSession();
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));

    session.endDialogue();
    session.talkTo(NPC_ID);
    session.endDialogue();
    session.endDialogue();

    expect(session.snapshot().dialogue).toBeNull();
    expect(events).toEqual(["dialogue-started", "dialogue-ended"]);
  });
});
