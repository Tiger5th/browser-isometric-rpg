/**
 * GameSession 事件流的最小约定。
 *
 * 与票 21（战斗闭环，并行开发）的接口假设：
 * 1. 战斗结算发生在 GameSession 内；敌人死亡时，战斗代码调用
 *    `GameSession.emitCombatEvent({ type: "enemy-killed", enemyId, enemyTemplateId })`。
 * 2. 本票只消费该事件推进击杀目标，不实现攻击意图、伤害公式或敌人状态机；
 *    敌人是否从实体集合移除、何时移除，仍由票 21 决定。
 * 3. 事件形状与 GameSession 现有 intent 风格一致（同步方法 + 纯数据对象）。
 *    若票 21 的事件名/字段不同，合并时做一层适配后调用同一个入口即可。
 *
 * 订阅者（渲染层/HUD/后续存档系统）只读事件，不得借此修改会话内部状态。
 */

/** 战斗事件：P1 只需要「某敌人被击杀」这一个事实。 */
export interface EnemyKilledEvent {
  type: "enemy-killed";
  /** 死亡敌人实体 id，如 enemy:slime_meadow。 */
  enemyId: string;
  /** 敌人模板 id；任务目标按模板计数。 */
  enemyTemplateId: string;
  /** 可选：击杀者实体 id。票 21 提供时可用于只统计玩家击杀。 */
  killerId?: string;
}

export type CombatEvent = EnemyKilledEvent;

/** GameSession 对外事件：战斗事件 + 对话/任务状态变化。 */
export type GameSessionEvent =
  | CombatEvent
  | { type: "dialogue-started"; npcId: string; dialogueId: string }
  | { type: "dialogue-ended"; npcId: string; dialogueId: string }
  | { type: "quest-accepted"; questId: string; npcId: string }
  | { type: "quest-ready"; questId: string }
  | { type: "quest-completed"; questId: string; npcId: string };

export type GameSessionEventListener = (event: GameSessionEvent) => void;
