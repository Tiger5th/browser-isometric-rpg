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

/**
 * 冲锋被硬碰撞挡停（票 36）。表现层据此播放「撞墙踉跄」而不是被击杀。
 */
export interface ChargeBlockedEvent {
  type: "charge-blocked";
  attackerId: string;
  targetId: string;
  /** 挡停冲锋的障碍 id（对应 world-physics 的 PropCollider）。 */
  obstacleId: string;
  at: number;
}

/**
 * 发射投射物（票 36）：吐弹型敌人的远程攻击。位置/速度/命中判定都在逻辑层，
 * 表现层只按 projectile-spawned/projectile-removed 渲染飞行与消失。
 */
export interface ProjectileSpawnedEvent {
  type: "projectile-spawned";
  projectileId: string;
  ownerId: string;
  targetId: string;
  position: { x: number; y: number; z: number };
  at: number;
}

/** 投射物消失（命中 / 撞障碍 / 超时）；命中伤害走 damage-dealt。 */
export interface ProjectileRemovedEvent {
  type: "projectile-removed";
  projectileId: string;
  ownerId: string;
  reason: "hit" | "blocked" | "expired";
  at: number;
}

/**
 * 玩家死亡惩罚（票 36）：复活回村出生点并损失向上取整的 10% 金币。
 * 无金币时 event 为 null（免罚）；金币余额是背包物品，扣减结果自然进快照。
 */
export interface PlayerDeathPenaltyEvent {
  type: "player-death-penalty";
  entityId: string;
  itemId: string;
  lostQuantity: number;
  remainingQuantity: number;
  at: number;
}

/**
 * 宝箱开启（票 37）：loot 已入包。反馈层据此播开箱闪光与战利品飘字，
 * 同一 tick 里还会收到每件 loot 的 `item-gained`。
 */
export interface ChestOpenedEvent {
  type: "chest-opened";
  chestId: string;
  entityId: string;
  loot: Array<{ itemId: string; quantity: number }>;
}

/** 拾取收集品（票 37）：萤光草已进包，计数由 worldState 聚合。 */
export interface CollectibleCollectedEvent {
  type: "collectible-collected";
  collectibleId: string;
  entityId: string;
  itemId: string;
  quantity: number;
  /** 该收集集当前进度（已收集 / 总数）。 */
  collected: number;
  total: number;
  /** 本次拾取是否让收集集满（满的那一 tick 才为 true）。 */
  setCompleted: boolean;
}

/** 收集集全收集：奖励饰品已自动入包（同一 tick 伴随 item-gained）。 */
export interface CollectSetCompletedEvent {
  type: "collect-set-completed";
  setId: string;
  entityId: string;
  rewardItemId: string;
  rewardQuantity: number;
}

/** 背包获得/失去物品的事实（掉落/任务奖励/购买/死亡惩罚共用）。 */
export interface ItemLostEvent {
  type: "item-lost";
  entityId: string;
  itemId: string;
  quantity: number;
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

/**
 * 区域切换的事实（票 35）：玩家走到路口触发切区后广播一次。
 * 渲染层据此做黑场过场与场景重建，自动存档据此判断区域是否变化
 * （GameSaveAutoSaver.notifyRegionChanged）——两者都不需要轮询快照。
 */
export interface RegionChangedEvent {
  type: "region-changed";
  /** 出发区域 id。 */
  fromRegionId: string;
  /** 目标区域 id（= 触发出口的 targetRegionId）。 */
  toRegionId: string;
  /** 触发的出口 id。 */
  exitId: string;
}

/** GameSession 对外事件：战斗事件 + 对话/任务状态变化。 */
export type GameSessionEvent =
  | EnemyKilledEvent
  | RegionChangedEvent
  | DamageDealtEvent
  | HealthChangedEvent
  | AttackWindupStartedEvent
  | ChargeBlockedEvent
  | ProjectileSpawnedEvent
  | ProjectileRemovedEvent
  | PlayerDeathPenaltyEvent
  | ChestOpenedEvent
  | CollectibleCollectedEvent
  | CollectSetCompletedEvent
  | ItemGainedEvent
  | ItemLostEvent
  | PlayerLevelUpEvent
  | { type: "dialogue-started"; npcId: string; dialogueId: string }
  | { type: "dialogue-ended"; npcId: string; dialogueId: string }
  | { type: "quest-accepted"; questId: string; npcId: string }
  | { type: "quest-ready"; questId: string }
  | { type: "quest-completed"; questId: string; npcId: string }
  /**
   * 换锚点完成（票 33，user story 16）：任务状态变化后 NPC 站到了新锚点。
   * 表现层据此把演出目标切到新位置（过渡插值/镜头提示）。
   */
  | { type: "npc-reanchored"; npcId: string; questId: string; position: { x: number; y: number; z: number } }
  /** 一笔买卖结算完成（票 33）：coinDelta 正数 = 玩家收到金币。 */
  | {
      type: "trade-completed";
      npcId: string;
      itemId: string;
      kind: "sell" | "buy";
      quantity: number;
      coinDelta: number;
    };

export type GameSessionEventListener = (event: GameSessionEvent) => void;
