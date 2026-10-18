import { describe, expect, it } from "vitest";

import elderMaCompiled from "../../content/dialogues/elder_ma.ink?ink";
import scoutLinCompiled from "../../content/dialogues/scout_lin.ink?ink";

import { GREEN_HOLLOW_REGION_ID, SAMPLE_CONTENT_BUNDLE as BUNDLE } from "./content/sample-content";
import { GameSession } from "./game-session";

/**
 * 真实 content/ 数据的闭环测试：示例对话、任务标签、敌人模板与奖励引用
 * 必须能在一起跑通（L2 之外的运行时验证）。`?ink` 由 Vite 插件在测试期编译。
 */

describe("示例内容：马婆婆的清理史莱姆任务", () => {
  it("对话接取 → 击杀三只史莱姆 → 复命发奖，完整走通", () => {
    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.loadRegion(BUNDLE, GREEN_HOLLOW_REGION_ID);

    // 第一次交谈：可接状态显示两个接取分支（＋巢穴任务入口）。
    session.talkTo("npc:elder_ma");
    expect(session.snapshot().dialogue?.choices).toEqual([
      "发生了什么？",
      "我这就去。",
      "南边那个洞口是什么地方？",
    ]);
    session.chooseDialogueOption(1);
    expect(session.snapshot().quests[0].status).toBe("active");

    // 进行中交谈：只剩「还在清理」的应答，不会重复接取。
    session.talkTo("npc:elder_ma");
    expect(session.snapshot().dialogue?.choices).toContain("我还在清理史莱姆。");
    session.chooseDialogueOption(0);
    expect(session.snapshot().quests[0].status).toBe("active");

    for (const enemyId of ["enemy:slime_meadow", "enemy:slime_blue", "enemy:slime_elder"]) {
      session.emitCombatEvent({
        type: "enemy-killed",
        enemyId,
        enemyTemplateId: "enemy_template:slime",
      });
    }
    const ready = session.snapshot().quests[0];
    expect(ready.status).toBe("ready_to_turn_in");
    expect(ready.objectives[0].current).toBe(3);

    // 可交状态：对话显示复命分支。
    session.talkTo("npc:elder_ma");
    expect(session.snapshot().dialogue?.choices).toContain(
      "（复命）史莱姆已经清理完了。",
    );
    session.chooseDialogueOption(
      session.snapshot().dialogue!.choices.indexOf("（复命）史莱姆已经清理完了。"),
    );

    const snapshot = session.snapshot();
    expect(snapshot.quests[0].status).toBe("completed");
    const player = snapshot.entities.find((entity) => entity.identity.type === "player");
    expect(player).toBeDefined();
    expect(
      player!.container.items.map((item) => [item.templateId, item.quantity]),
    ).toEqual([
      // 起始金币（票 36：死亡轻惩罚的扣币对象）排在最前。
      ["item:old_coin", 25],
      ["item:traveler_sword", 1],
      ["item:healing_herb", 2],
    ]);
    expect(player!.attributes.maxHp).toBe(110);
    expect(player!.modifiers).toEqual([
      expect.objectContaining({
        attribute: "maxHp",
        operation: "add",
        value: 10,
        source: { kind: "quest", id: "quest:cull_slimes" },
      }),
    ]);
  });

  it("会话内战斗击杀自动推进任务进度（票 21 合流后的真实路径）", () => {
    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.loadRegion(BUNDLE, GREEN_HOLLOW_REGION_ID);
    session.talkTo("npc:elder_ma");
    session.chooseDialogueOption(1);
    expect(session.snapshot().quests[0].status).toBe("active");

    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));

    session.attack("entity:player", "enemy:slime_meadow");
    let objective = session.snapshot().quests[0].objectives[0];
    for (let index = 0; index < 20 && objective.current === 0; index += 1) {
      session.advance(1000);
      objective = session.snapshot().quests[0].objectives[0];
    }

    expect(objective.current).toBe(1);
    expect(events.filter((type) => type === "enemy-killed")).toHaveLength(1);
    expect(
      session.drainEvents().some(
        (event) => event.type === "death" && event.kind === "enemy",
      ),
    ).toBe(true);
  });
});

/**
 * 票 37 验收修复：林斥候原本没有 dialogueId，`canTalkTo` 恒 false，
 * 点击他连气泡都不出（实测「不可交互」）。这里用真实 content 数据锁住：
 * 他可对话，且台词承担「南边洞口/巢穴」的引导职责。
 */
describe("示例内容：林斥候的洞口指引对话", () => {
  function sessionWithScout(): GameSession {
    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.registerDialogue("scout_lin", scoutLinCompiled);
    session.loadRegion(BUNDLE, GREEN_HOLLOW_REGION_ID);
    return session;
  }

  it("林斥候可对话（canTalkTo 为 true）", () => {
    const session = sessionWithScout();
    expect(session.canTalkTo("npc:scout_lin")).toBe(true);
    expect(session.tryTalkTo("npc:scout_lin").ok).toBe(true);
    expect(session.snapshot().dialogue?.npcId).toBe("npc:scout_lin");
  });

  it("对话给出指向南边洞口的选项与说明文本", () => {
    const session = sessionWithScout();
    session.talkTo("npc:scout_lin");

    const first = session.snapshot().dialogue!;
    expect(first.choices).toContain("你认识南边那个洞口？");
    session.chooseDialogueOption(
      first.choices.findIndex((choice) => choice.includes("洞口")),
    );

    // 选进洞口分支：ink 会连着走完 hint 段再 END，
    // 因此整个分支的台词要从「本分支结束前」累积（END 后 dialogue 变 null）。
    const hint = session.snapshot().dialogue!;
    // hint 段承担「南边洞口/巢穴」的引导：文本与最后的收尾选项都在。
    expect(hint.text).toContain("南边");
    expect(hint.text).toContain("洞口");
    expect(hint.text).toContain("马婆婆");
    expect(hint.choices.length).toBeGreaterThan(0);

    session.chooseDialogueOption(0);
    expect(session.snapshot().dialogue).toBeNull();
  });

  it("对话开始会冻结林斥候的巡逻，结束后恢复", () => {
    const session = sessionWithScout();
    session.talkTo("npc:scout_lin");
    const during = session.patrolSampleOf("npc:scout_lin");
    expect(during?.moving).toBe(false);

    session.endDialogue();
    const after = session.patrolSampleOf("npc:scout_lin");
    expect(after?.moving).toBeDefined();
  });
});

/**
 * 票 37 验收修复：NPC 巡逻节奏（dwell 拉长、路线总长收敛到 ≤8m）。
 * 数值住在 content（npatrol.dwellMs 已有覆盖机制），这里锁住不退回旧值。
 */
describe("示例内容：NPC 巡逻节奏", () => {
  function patrolOf(npcId: string): { total: number; dwellMs: number | undefined } {
    const npc = BUNDLE.npcs.find((entry) => entry.id === npcId);
    if (npc === undefined || npc.patrol === undefined) {
      throw new Error(`NPC 缺少巡逻定义：${npcId}`);
    }
    const waypoints = npc.patrol.waypoints;
    let total = 0;
    for (let index = 0; index < waypoints.length; index += 1) {
      const current = waypoints[index];
      const next = waypoints[(index + 1) % waypoints.length];
      total += Math.hypot(next.x - current.x, next.z - current.z);
    }
    return { total, dwellMs: npc.patrol.dwellMs };
  }

  it("四位 NPC 的 dwell 都在 4.5–6s 且互不相同", () => {
    const dwells = ["npc:elder_ma", "npc:scout_lin", "npc:merchant_bo", "npc:smith_qi"]
      .map((id) => patrolOf(id).dwellMs);
    for (const dwell of dwells) {
      expect(dwell).toBeGreaterThanOrEqual(4_500);
      expect(dwell).toBeLessThanOrEqual(6_000);
    }
    expect(new Set(dwells).size).toBe(dwells.length);
  });

  it("所有 NPC 的巡逻路线总长都 ≤8m", () => {
    for (const npc of BUNDLE.npcs) {
      const route = patrolOf(npc.id);
      expect(route.total).toBeLessThanOrEqual(8);
    }
  });
});
