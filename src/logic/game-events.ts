/**
 * GameSession 事件流的最小约定（票 22；票 21 合流后定稿）。
 *
 * 击杀事实有两个消费通道，互不替代：
 * 1. 本模块的订阅式事件（subscribe）：面向表现层/HUD，会话内战斗在敌人死亡时
 *    自动发布 `enemy-killed`，任务系统用同一事件推进击杀目标。
 * 2. GameSession.drainEvents()：票 21 的战斗日志（attack/death/xp/loot/respawn），
 *    面向需要逐条回放战斗过程的消费方（combat-loop 场景）。
 *
 * 外部战斗实现（若未来替换票 21 的结算器）可调用
 * `GameSession.emitCombatEvent({ type: "enemy-killed", enemyId, enemyTemplateId })`
 * 把击杀送入同一处理路径；本票不实现攻击意图、伤害公式或敌人状态机。
 *
 * 订阅者只读事件，不得借此修改会话内部状态。
 */

/** 战斗事件：P1 任务系统只需要「某敌人被击杀」这一个事实。 */
export interface EnemyKilledEvent {
  type: "enemy-killed";
  /** 死亡敌人实体 id，如 enemy:slime_meadow。 */
  enemyId: string;
  /** 敌人模板 id；任务目标按模板计数。 */
  enemyTemplateId: string;
  /** 可选：击杀者实体 id。 */
  killerId?: string;
}

/** GameSession 对外事件：战斗事件 + 对话/任务状态变化。 */
export type GameSessionEvent =
  | EnemyKilledEvent
  | { type: "dialogue-started"; npcId: string; dialogueId: string }
  | { type: "dialogue-ended"; npcId: string; dialogueId: string }
  | { type: "quest-accepted"; questId: string; npcId: string }
  | { type: "quest-ready"; questId: string }
  | { type: "quest-completed"; questId: string; npcId: string };

export type GameSessionEventListener = (event: GameSessionEvent) => void;
