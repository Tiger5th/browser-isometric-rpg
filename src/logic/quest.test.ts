import { describe, expect, it } from "vitest";

import type { QuestDefinition } from "./content/types";
import { QuestLog } from "./quest";

function killQuest(overrides: Partial<QuestDefinition> = {}): QuestDefinition {
  return {
    id: "quest:cull_slimes",
    title: "清理史莱姆",
    description: "清理三只史莱姆。",
    giverNpcId: "npc:elder_ma",
    turnInNpcId: "npc:elder_ma",
    objectives: [
      {
        id: "objective:kill_slimes",
        type: "kill",
        enemyTemplateId: "enemy_template:slime",
        count: 3,
      },
    ],
    rewards: {
      items: [{ itemId: "item:healing_herb", quantity: 2 }],
    },
    ...overrides,
  };
}

describe("QuestLog 任务状态机", () => {
  it("初始状态为可接，目标进度从 0 开始", () => {
    const log = new QuestLog([killQuest()]);

    expect(log.get("quest:cull_slimes")?.status).toBe("available");
    expect(log.snapshot()).toEqual([
      {
        id: "quest:cull_slimes",
        title: "清理史莱姆",
        giverNpcId: "npc:elder_ma",
        turnInNpcId: "npc:elder_ma",
        status: "available",
        objectives: [
          {
            id: "objective:kill_slimes",
            type: "kill",
            enemyTemplateId: "enemy_template:slime",
            current: 0,
            required: 3,
          },
        ],
      },
    ]);
  });

  it("offer：可接 → 进行中；重复 offer 不重置进度", () => {
    const log = new QuestLog([killQuest()]);

    expect(log.offer("quest:cull_slimes")).toBe(true);
    expect(log.get("quest:cull_slimes")?.status).toBe("active");

    expect(log.recordEnemyKill("enemy_template:slime")).toEqual([]);
    expect(log.offer("quest:cull_slimes")).toBe(false);
    expect(log.get("quest:cull_slimes")?.objectives[0].current).toBe(1);
  });

  it("击杀按敌人模板计数，未接取时击杀不计进度", () => {
    const log = new QuestLog([killQuest()]);

    expect(log.recordEnemyKill("enemy_template:slime")).toEqual([]);
    expect(log.get("quest:cull_slimes")?.objectives[0].current).toBe(0);

    log.offer("quest:cull_slimes");
    log.recordEnemyKill("enemy_template:bat");
    expect(log.get("quest:cull_slimes")?.objectives[0].current).toBe(0);

    log.recordEnemyKill("enemy_template:slime");
    expect(log.get("quest:cull_slimes")?.objectives[0].current).toBe(1);
  });

  it("目标达成后进入可交，进度封顶且 ready 只报告一次", () => {
    const log = new QuestLog([killQuest()]);
    log.offer("quest:cull_slimes");

    expect(log.recordEnemyKill("enemy_template:slime")).toEqual([]);
    expect(log.recordEnemyKill("enemy_template:slime")).toEqual([]);
    expect(log.recordEnemyKill("enemy_template:slime")).toEqual(["quest:cull_slimes"]);
    expect(log.get("quest:cull_slimes")?.status).toBe("ready_to_turn_in");
    expect(log.get("quest:cull_slimes")?.objectives[0].current).toBe(3);

    expect(log.recordEnemyKill("enemy_template:slime")).toEqual([]);
    expect(log.get("quest:cull_slimes")?.objectives[0].current).toBe(3);
  });

  it("多目标全部达成才算可交", () => {
    const log = new QuestLog([
      killQuest({
        objectives: [
          {
            id: "objective:kill_slimes",
            type: "kill",
            enemyTemplateId: "enemy_template:slime",
            count: 2,
          },
          {
            id: "objective:kill_elite",
            type: "kill",
            enemyTemplateId: "enemy_template:slime_elite",
            count: 1,
          },
        ],
      }),
    ]);
    log.offer("quest:cull_slimes");

    log.recordEnemyKill("enemy_template:slime");
    log.recordEnemyKill("enemy_template:slime");
    expect(log.get("quest:cull_slimes")?.status).toBe("active");

    expect(log.recordEnemyKill("enemy_template:slime_elite")).toEqual([
      "quest:cull_slimes",
    ]);
    expect(log.get("quest:cull_slimes")?.status).toBe("ready_to_turn_in");
  });

  it("turnIn：仅可交状态可完成；重复 turnIn 无效", () => {
    const log = new QuestLog([killQuest()]);
    log.offer("quest:cull_slimes");

    expect(log.turnIn("quest:cull_slimes")).toBe(false);
    expect(log.get("quest:cull_slimes")?.status).toBe("active");

    log.recordEnemyKill("enemy_template:slime");
    log.recordEnemyKill("enemy_template:slime");
    log.recordEnemyKill("enemy_template:slime");

    expect(log.turnIn("quest:cull_slimes")).toBe(true);
    expect(log.get("quest:cull_slimes")?.status).toBe("completed");
    expect(log.turnIn("quest:cull_slimes")).toBe(false);
  });

  it("已完成的任务不能再接取，也不会因击杀变化", () => {
    const log = new QuestLog([killQuest()]);
    log.offer("quest:cull_slimes");
    for (let index = 0; index < 3; index += 1) {
      log.recordEnemyKill("enemy_template:slime");
    }
    log.turnIn("quest:cull_slimes");

    expect(log.offer("quest:cull_slimes")).toBe(false);
    expect(log.recordEnemyKill("enemy_template:slime")).toEqual([]);
    expect(log.get("quest:cull_slimes")?.status).toBe("completed");
  });

  it("快照是深拷贝，修改快照不会影响内部状态", () => {
    const log = new QuestLog([killQuest()]);
    const snapshot = log.snapshot();
    snapshot[0].objectives[0].current = 99;
    snapshot[0].status = "completed";

    expect(log.snapshot()[0].objectives[0].current).toBe(0);
    expect(log.snapshot()[0].status).toBe("available");
  });

  it("重复任务定义与未知任务会显式报错", () => {
    expect(() => new QuestLog([killQuest(), killQuest()])).toThrow(/重复/);

    const log = new QuestLog([killQuest()]);
    expect(() => log.offer("quest:missing")).toThrow(/未知任务/);
    expect(() => log.turnIn("quest:missing")).toThrow(/未知任务/);
  });
});
