/**
 * 任务状态机：可接 → 进行中 → 可交 → 完成。
 *
 * 纯逻辑、零引擎依赖。任务定义来自 content/quests/*.json；
 * 运行期进度只存在于本模块，经 GameSession.snapshot() 序列化。
 * 击杀目标只统计任务接取之后的战斗事件，因此「先杀后接」不会补进度。
 */

import type { QuestDefinition, QuestObjectiveDefinition } from "./content/types";

export type QuestStatus = "available" | "active" | "ready_to_turn_in" | "completed";

const QUEST_STATUSES: readonly QuestStatus[] = [
  "available",
  "active",
  "ready_to_turn_in",
  "completed",
];

function isQuestStatus(value: unknown): value is QuestStatus {
  return QUEST_STATUSES.includes(value as QuestStatus);
}

export interface QuestObjectiveSnapshot {
  id: string;
  type: QuestObjectiveDefinition["type"];
  enemyTemplateId: string;
  current: number;
  required: number;
}

export interface QuestSnapshot {
  id: string;
  title: string;
  giverNpcId: string;
  turnInNpcId: string;
  status: QuestStatus;
  objectives: QuestObjectiveSnapshot[];
}

interface QuestProgress {
  definition: QuestDefinition;
  status: QuestStatus;
  /** 与 definition.objectives 一一对应，顺序一致。 */
  current: number[];
}

function objectiveRequired(objective: QuestObjectiveDefinition): number {
  return objective.count;
}

/**
 * 持有全部任务的运行期进度。
 *
 * 状态转移规则（显式、幂等）：
 * - offer：仅 available → active；其他状态原样返回 false。
 * - recordEnemyKill：仅 active 任务的匹配目标 +1，封顶 required；
 *   目标全部达成时自动 → ready_to_turn_in，并报告该任务 id。
 * - turnIn：仅 ready_to_turn_in → completed；其他状态返回 false。
 */
export class QuestLog {
  private readonly quests = new Map<string, QuestProgress>();

  constructor(definitions: readonly QuestDefinition[]) {
    for (const definition of definitions) {
      if (this.quests.has(definition.id)) {
        throw new Error(`重复的任务定义：${definition.id}`);
      }
      this.quests.set(definition.id, {
        definition,
        status: "available",
        current: definition.objectives.map(() => 0),
      });
    }
  }

  get(questId: string): QuestSnapshot | undefined {
    const progress = this.quests.get(questId);
    return progress === undefined ? undefined : this.toSnapshot(progress);
  }

  /** 对话 offer 标签：接取任务。返回是否发生状态转移。 */
  offer(questId: string): boolean {
    const progress = this.requireQuest(questId);
    if (progress.status !== "available") {
      return false;
    }
    progress.status = "active";
    return true;
  }

  /**
   * 记录一次敌人死亡事件。
   * 返回本次事件后新进入 ready_to_turn_in 的任务 id（用于事件流/HUD）。
   */
  recordEnemyKill(enemyTemplateId: string): string[] {
    const newlyReady: string[] = [];

    for (const progress of this.quests.values()) {
      if (progress.status !== "active") {
        continue;
      }

      let changed = false;
      progress.definition.objectives.forEach((objective, index) => {
        if (objective.enemyTemplateId !== enemyTemplateId) {
          return;
        }
        const required = objectiveRequired(objective);
        if (progress.current[index] < required) {
          progress.current[index] += 1;
          changed = true;
        }
      });

      if (
        changed &&
        progress.definition.objectives.every(
          (objective, index) => progress.current[index] >= objectiveRequired(objective),
        )
      ) {
        progress.status = "ready_to_turn_in";
        newlyReady.push(progress.definition.id);
      }
    }

    return newlyReady;
  }

  /** 对话 turnin 标签：仅可交状态完成任务。返回是否发生状态转移。 */
  turnIn(questId: string): boolean {
    const progress = this.requireQuest(questId);
    if (progress.status !== "ready_to_turn_in") {
      return false;
    }
    progress.status = "completed";
    return true;
  }

  /**
   * 从快照恢复任务进度（读档）。
   * 快照中未出现的任务重置为 available/0；未知任务、重复任务或进度越界显式报错。
   */
  restore(snapshots: readonly QuestSnapshot[]): void {
    for (const progress of this.quests.values()) {
      progress.status = "available";
      progress.current = progress.definition.objectives.map(() => 0);
    }

    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      const progress = this.quests.get(snapshot.id);
      if (progress === undefined) {
        throw new Error(`快照包含未知任务：${snapshot.id}`);
      }
      if (seen.has(snapshot.id)) {
        throw new Error(`快照包含重复任务：${snapshot.id}`);
      }
      seen.add(snapshot.id);

      if (!isQuestStatus(snapshot.status)) {
        throw new Error(`任务 ${snapshot.id} 的状态非法：${String(snapshot.status)}`);
      }
      if (snapshot.objectives.length !== progress.definition.objectives.length) {
        throw new Error(
          `任务 ${snapshot.id} 的目标数量与内容定义不一致（快照 ${snapshot.objectives.length}，定义 ${progress.definition.objectives.length}）`,
        );
      }

      progress.status = snapshot.status;
      progress.current = snapshot.objectives.map((objective, index) => {
        const required = objectiveRequired(progress.definition.objectives[index]);
        if (
          !Number.isInteger(objective.current) ||
          objective.current < 0 ||
          objective.current > required
        ) {
          throw new Error(
            `任务 ${snapshot.id} 的目标 ${objective.id} 进度非法：${String(objective.current)}`,
          );
        }
        return objective.current;
      });
    }
  }

  /** 全量任务快照；每次返回新对象，调用方无法修改内部进度。 */
  snapshot(): QuestSnapshot[] {
    return [...this.quests.values()].map((progress) => this.toSnapshot(progress));
  }

  private requireQuest(questId: string): QuestProgress {
    const progress = this.quests.get(questId);
    if (progress === undefined) {
      throw new Error(`未知任务：${questId}`);
    }
    return progress;
  }

  private toSnapshot(progress: QuestProgress): QuestSnapshot {
    const { definition } = progress;
    return {
      id: definition.id,
      title: definition.title,
      giverNpcId: definition.giverNpcId,
      turnInNpcId: definition.turnInNpcId ?? definition.giverNpcId,
      status: progress.status,
      objectives: definition.objectives.map((objective, index) => ({
        id: objective.id,
        type: objective.type,
        enemyTemplateId: objective.enemyTemplateId,
        current: progress.current[index],
        required: objectiveRequired(objective),
      })),
    };
  }
}
