import { Compiler } from "inkjs/full";
import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import {
  createDialogue,
  restoreDialogue,
  type DialogueSnapshot,
} from "./dialogue";
import { GameSession } from "./game-session";
import type { GameSessionEvent } from "./game-events";

const QUEST_ID = "quest:cull_slimes";
const NPC_ID = "npc:elder_ma";

function compileInk(source: string): string {
  const compiler = new Compiler(source);
  const story = compiler.Compile();
  if (story === null || compiler.errors.length > 0) {
    throw new Error(`测试 ink 编译失败：\n${compiler.errors.join("\n")}`);
  }
  const json = story.ToJson();
  if (typeof json !== "string") {
    throw new Error("ink 编译结果无法序列化");
  }
  return json;
}

/**
 * 测试对话：任务可接时给出接取分支；可交时给出复命分支。
 * 通过 GameSession 绑定的 questStatus 外部函数读取任务状态。
 */
function dialogueSource(): string {
  return [
    "EXTERNAL questStatus(questId)",
    "-> start",
    "",
    "=== start ===",
    "马婆婆：旅人，你来得正好。",
    '{ questStatus("quest:cull_slimes") == "available":',
    "    * [发生了什么？]",
    "        马婆婆：史莱姆从溪边涌出来了。",
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
    "马婆婆：帮我们清理三只史莱姆吧。",
    "-> END",
    "",
    "=== turn_in ===",
    "# quest:turnin:quest:cull_slimes",
    "马婆婆：你真的做到了！这是说好的报酬。",
    "-> END",
    "",
  ].join("\n");
}

function fixtureBundle(questOverrides: Record<string, unknown> = {}): ContentBundle {
  return {
    regions: [
      {
        id: "region:green_hollow",
        displayName: "翠谷",
        asset: { model: "assets/regions/green_hollow.glb" },
        player: {
          id: "entity:player",
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
        position: { x: 6, y: 0, z: 4 },
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
    items: [
      {
        id: "item:traveler_sword",
        displayName: "旅人短剑",
        kind: "equipment",
        description: "轻便的短剑。",
        equipment: { slot: "weapon", modifiers: [] },
      },
      {
        id: "item:healing_herb",
        displayName: "疗伤草",
        kind: "consumable",
        description: "常见的草药。",
        consumable: {
          effects: [{ type: "restore", attribute: "hp", amount: 30 }],
        },
      },
    ],
    quests: [
      {
        id: QUEST_ID,
        title: "清理史莱姆",
        giverNpcId: NPC_ID,
        turnInNpcId: NPC_ID,
        objectives: [
          {
            id: "objective:kill_slimes",
            type: "kill",
            enemyTemplateId: "enemy_template:slime",
            count: 3,
          },
        ],
        rewards: {
          items: [
            { itemId: "item:traveler_sword", quantity: 1 },
            { itemId: "item:healing_herb", quantity: 2 },
          ],
          modifiers: [{ attribute: "maxHp", operation: "add", value: 10 }],
        },
        ...questOverrides,
      },
    ],
  };
}

function createSession(options: {
  ink?: string;
  bundle?: ContentBundle;
  registerDialogue?: boolean;
} = {}): GameSession {
  const session = new GameSession();
  if (options.registerDialogue !== false) {
    session.registerDialogue("elder_ma", compileInk(options.ink ?? dialogueSource()));
  }
  session.loadRegion(options.bundle ?? fixtureBundle(), "region:green_hollow");
  return session;
}

function playerSnapshot(session: GameSession) {
  const player = session.snapshot().entities.find(
    (entity) => entity.identity.type === "player",
  );
  if (!player) {
    throw new Error("快照中缺少玩家");
  }
  return player;
}

function questSnapshot(session: GameSession, questId = QUEST_ID) {
  const quest = session.snapshot().quests.find((entry) => entry.id === questId);
  if (!quest) {
    throw new Error(`快照中缺少任务 ${questId}`);
  }
  return quest;
}

function killSlime(session: GameSession, enemyId = "enemy:slime_meadow"): void {
  session.emitCombatEvent({
    type: "enemy-killed",
    enemyId,
    enemyTemplateId: "enemy_template:slime",
  });
}

function acceptQuestThroughDialogue(session: GameSession): void {
  session.talkTo(NPC_ID);
  session.chooseDialogueOption(0);
}

describe("GameSession 对话可用性查询", () => {
  it("tryTalkTo 对无对话 NPC 返回友好失败而不抛异常", () => {
    const session = createSession({ ink: dialogueSource() });
    const result = session.tryTalkTo("npc:scout_lin");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/没有对话/);
  });

  it("canTalkTo 只对已注册对话的 NPC 返回 true", () => {
    const session = createSession({ ink: dialogueSource() });
    expect(session.canTalkTo(NPC_ID)).toBe(true);
    expect(session.canTalkTo("npc:scout_lin")).toBe(false);
    expect(session.canTalkTo("entity:missing")).toBe(false);
  });
});

describe("GameSession 对话与任务闭环", () => {
  it("talkTo 打开 NPC 对话并停在选项点，对话状态进入快照", () => {
    const session = createSession();

    session.talkTo(NPC_ID);

    const dialogue = session.snapshot().dialogue;
    expect(dialogue).not.toBeNull();
    expect(dialogue?.npcId).toBe(NPC_ID);
    expect(dialogue?.dialogueId).toBe("elder_ma");
    expect(dialogue?.text).toContain("旅人，你来得正好");
    expect(dialogue?.choices).toEqual(["发生了什么？"]);
  });

  it("选项推进经过 offer 标签接取任务，对话在 END 处关闭", () => {
    const session = createSession();
    const events: GameSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    session.talkTo(NPC_ID);
    session.chooseDialogueOption(0);

    expect(session.snapshot().dialogue).toBeNull();
    expect(questSnapshot(session).status).toBe("active");
    expect(questSnapshot(session).objectives[0].current).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "dialogue-started",
      "quest-accepted",
      "dialogue-ended",
    ]);
  });

  it("击杀事件推进目标计数；错误模板与超额击杀不改变进度", () => {
    const session = createSession();
    acceptQuestThroughDialogue(session);

    const readyEvents: GameSessionEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "quest-ready") {
        readyEvents.push(event);
      }
    });

    session.emitCombatEvent({
      type: "enemy-killed",
      enemyId: "enemy:bat_1",
      enemyTemplateId: "enemy_template:bat",
    });
    expect(questSnapshot(session).objectives[0].current).toBe(0);

    killSlime(session, "enemy:slime_meadow");
    killSlime(session, "enemy:slime_blue");
    expect(questSnapshot(session).objectives[0].current).toBe(2);
    expect(questSnapshot(session).status).toBe("active");
    expect(readyEvents).toEqual([]);

    killSlime(session, "enemy:slime_elder");
    expect(questSnapshot(session).objectives[0].current).toBe(3);
    expect(questSnapshot(session).status).toBe("ready_to_turn_in");
    expect(readyEvents).toEqual([{ type: "quest-ready", questId: QUEST_ID }]);

    killSlime(session, "enemy:slime_extra");
    expect(questSnapshot(session).objectives[0].current).toBe(3);
    expect(readyEvents).toHaveLength(1);
  });

  it("复命对话发放物品与修饰器，修饰器立即影响有效属性，且奖励只发一次", () => {
    const session = createSession();
    acceptQuestThroughDialogue(session);
    killSlime(session);
    killSlime(session);
    killSlime(session);

    session.talkTo(NPC_ID);
    expect(session.snapshot().dialogue?.choices).toEqual(["复命：史莱姆已经清理完了。"]);
    session.chooseDialogueOption(0);

    expect(questSnapshot(session).status).toBe("completed");
    expect(session.snapshot().dialogue).toBeNull();

    const player = playerSnapshot(session);
    expect(player.container.items).toEqual([
      {
        instanceId: "quest:cull_slimes:item:traveler_sword:0",
        templateId: "item:traveler_sword",
        quantity: 1,
        equipped: false,
      },
      {
        instanceId: "quest:cull_slimes:item:healing_herb:0",
        templateId: "item:healing_herb",
        quantity: 2,
        equipped: false,
      },
    ]);
    expect(player.modifiers).toEqual([
      {
        id: "quest:quest:cull_slimes:0",
        attribute: "maxHp",
        operation: "add",
        value: 10,
        source: { kind: "quest", id: "quest:cull_slimes" },
      },
    ]);
    expect(player.baseAttributes.maxHp).toBe(100);
    expect(player.attributes.maxHp).toBe(110);
    expect(player.claimedRewardIds).toEqual(["quest:cull_slimes"]);

    // 再次交谈：已完成分支直接结束且不再出现复命选项，奖励不会重复发放。
    session.talkTo(NPC_ID);
    expect(session.snapshot().dialogue).toBeNull();
    expect(playerSnapshot(session).container.items).toHaveLength(2);
    expect(playerSnapshot(session).modifiers).toHaveLength(1);
    expect(playerSnapshot(session).claimedRewardIds).toEqual(["quest:cull_slimes"]);
  });

  it("对话快照包含 ink 执行状态，序列化后可在新 Story 上恢复到同一选项点", () => {
    const ink = dialogueSource();
    const session = createSession({ ink });
    session.talkTo(NPC_ID);

    const serialized = session.serialize();
    const parsed = JSON.parse(serialized) as ReturnType<GameSession["snapshot"]>;
    expect(parsed.dialogue).not.toBeNull();

    const restoredStory = createDialogue(compileInk(ink));
    restoreDialogue(restoredStory, parsed.dialogue!.story as DialogueSnapshot);
    const bindStatus = (story: ReturnType<typeof createDialogue>) =>
      story.BindExternalFunction("questStatus", () => "available");
    bindStatus(restoredStory);

    expect(parsed.dialogue!.text).toContain("旅人，你来得正好");
    expect(() => JSON.parse(parsed.dialogue!.story.inkState)).not.toThrow();
    expect(restoredStory.currentChoices.map((choice) => choice.text)).toEqual(
      parsed.dialogue!.choices,
    );

    // 从快照恢复的 Story 与未中断的对照组继续执行，输出与标签完全一致。
    const controlStory = createDialogue(compileInk(ink));
    bindStatus(controlStory);
    const replay = (story: ReturnType<typeof createDialogue>) => {
      story.ChooseChoiceIndex(0);
      const lines: string[] = [];
      const tags: string[] = [];
      while (story.canContinue) {
        lines.push(story.Continue() ?? "");
        tags.push(...(story.currentTags ?? []));
      }
      return {
        text: lines.join("").trim(),
        tags,
        choices: story.currentChoices.map((choice) => choice.text),
      };
    };
    while (controlStory.canContinue) {
      controlStory.Continue();
    }

    const restoredResult = replay(restoredStory);
    const controlResult = replay(controlStory);
    expect(restoredResult).toEqual(controlResult);
    expect(restoredResult.tags).toContain("quest:offer:quest:cull_slimes");
  });

  it("对话标签引用未知任务时显式报错", () => {
    const ink = [
      "-> start",
      "=== start ===",
      "# quest:offer:quest:missing",
      "准备出发。",
      "-> END",
    ].join("\n");
    const session = createSession({ ink });

    expect(() => session.talkTo(NPC_ID)).toThrow(/未知任务/);
  });

  it("未知实体、无对话的 NPC、未注册对话与非法选项都会显式报错", () => {
    const session = createSession();

    expect(() => session.talkTo("npc:missing")).toThrow(/未知实体/);
    expect(() => session.talkTo("npc:scout_lin")).toThrow(/没有对话/);
    expect(() => session.chooseDialogueOption(0)).toThrow(/没有进行中的对话/);

    session.talkTo(NPC_ID);
    expect(() => session.talkTo(NPC_ID)).toThrow(/已有对话/);
    expect(() => session.chooseDialogueOption(5)).toThrow(/选项索引/);
    expect(() => session.chooseDialogueOption(-1)).toThrow(/选项索引/);
    expect(() => session.chooseDialogueOption(1.5)).toThrow(/选项索引/);

    const unregistered = createSession({ registerDialogue: false });
    expect(() => unregistered.talkTo(NPC_ID)).toThrow(/未注册/);
  });

  it("事件订阅返回的取消函数会停止后续通知", () => {
    const session = createSession();
    acceptQuestThroughDialogue(session);

    const events: GameSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    killSlime(session);
    unsubscribe();
    killSlime(session);

    expect(events.filter((event) => event.type === "enemy-killed")).toHaveLength(1);
  });

  it("战斗事件形状非法时拒绝，不改变任务进度", () => {
    const session = createSession();
    acceptQuestThroughDialogue(session);

    expect(() =>
      session.emitCombatEvent({
        type: "enemy-killed",
        enemyId: "",
        enemyTemplateId: "enemy_template:slime",
      }),
    ).toThrow(/enemyId/);
    expect(() =>
      session.emitCombatEvent({
        type: "enemy-killed",
        enemyId: "enemy:slime_meadow",
        enemyTemplateId: "",
      }),
    ).toThrow(/enemyTemplateId/);
    expect(questSnapshot(session).objectives[0].current).toBe(0);
  });
});
