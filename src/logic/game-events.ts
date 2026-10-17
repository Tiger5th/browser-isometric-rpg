/**
 * GameSession 事件流的最小约定（票 22；票 21 合流后定稿）。
 *
 * 结算事实有两个消费通道，互不替代：
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
 *
 * 票 27：战斗反馈层的地基——伤害/生命/拾取/升级升级为与 `enemy-killed` 同级的
 * 一等订阅事件（specs/p2-gameplay.md「事件架构」）。飘字/血条/音效/顿帧只消费
 * 这些事件，不读会话内部状态；`drainEvents()` 保留不废弃。
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

/**
 * 一次成功命中造成伤害的事实（票 27）。
 * `heavy` 区分普攻/重击（重击飘字更大、音效不同）；`lethal` 标记致死一击
 * （反馈层据此播击杀消散而不是普通受击）。
 */
export interface DamageDealtEvent {
  type: "damage-dealt";
  attackerId: string;
  targetId: string;
  /** 实际造成的伤害（>=1）。 */
  amount: number;
  /** 结算后目标剩余生命。 */
  targetHp: number;
  targetMaxHp: number;
  /** 是否重击意图（1.5 倍伤害、独立前摇与音效）。 */
  heavy: boolean;
  /** 这一击是否导致目标死亡。 */
  lethal: boolean;
  /** 会话时钟（毫秒）。 */
  at: number;
}

/** 实体当前生命发生变化的事实（受伤/治疗/重生都走这条）。 */
export interface HealthChangedEvent {
  type: "health-changed";
  entityId: string;
  hp: number;
  maxHp: number;
  previousHp: number;
  cause: "damage" | "heal";
}

/**
 * 攻击前摇开始（票 27）：敌人抬手约 0.3 秒、重击约 0.6 秒后伤害才落地，
 * 给玩家走位躲避的窗口。反馈层据此播放前摇音效与抬手/变色提示。
 */
export interface AttackWindupStartedEvent {
  type: "attack-windup-started";
  attackerId: string;
  targetId: string;
  /** 是否重击前摇（更长、音效不同）。 */
  heavy: boolean;
  /** 前摇总时长（毫秒）。 */
  durationMs: number;
  at: number;
}

/** 背包获得物品的事实（掉落/任务奖励/购买共用）。 */
export interface ItemGainedEvent {
  type: "item-gained";
  entityId: string;
  itemId: string;
  quantity: number;
}

/**
 * 玩家升级的事实。等级/经验数值由票 31 的成长系统补齐；
 * 本事件先立好通道与字段（level/attributesGained 可选），
 * 避免升级系统落地时再动一次事件契约。
 */
export interface PlayerLevelUpEvent {
  type: "player-level-up";
  entityId: string;
  /** 升级后的等级；成长系统未接入时为 null。 */
  level: number | null;
  /** 升级带来的属性变化（如 maxHp +10）；未接入时为空数组。 */
  attributesGained: Array<{ attribute: string; delta: number }>;
}

/** GameSession 对外事件：战斗事件 + 对话/任务状态变化。 */
export type GameSessionEvent =
  | EnemyKilledEvent
  | DamageDealtEvent
  | HealthChangedEvent
  | AttackWindupStartedEvent
  | ItemGainedEvent
  | PlayerLevelUpEvent
  | { type: "dialogue-started"; npcId: string; dialogueId: string }
  | { type: "dialogue-ended"; npcId: string; dialogueId: string }
  | { type: "quest-accepted"; questId: string; npcId: string }
  | { type: "quest-ready"; questId: string }
  | { type: "quest-completed"; questId: string; npcId: string };

export type GameSessionEventListener = (event: GameSessionEvent) => void;
