/**
 * 战斗反馈层的零引擎核心（票 27）。
 *
 * 定义（GLOSSARY「反馈层」）：把 GameSession 结算事实转译为视听信号，
 * **只消费事件、不改变游戏状态、不读会话内部状态**。本模块零依赖（可在
 * vitest 里直接测），渲染侧（飘字/血条/抖动的 Babylon 表现）只读它产出的
 * 视图模型，不反向写回逻辑。
 *
 * 三类输出：
 * - `damageFeed`：伤害飘字队列（黄=对敌命中，红=玩家受击；重击更大）
 * - `targetFrames`：敌人血条/目标圈可见性（常显选中，受击后 5 秒淡出）
 * - `hitPulses`：命中顿帧/镜头微震/受击闪红的强度信号
 */

/** 一条待显示的伤害飘字。 */
export interface DamageFeedEntry {
  /** 递增 id；消费方据此去重与回收 DOM/实例。 */
  id: number;
  targetId: string;
  amount: number;
  /** 玩家受到伤害时为 true（红色），否则黄色。 */
  incoming: boolean;
  /** 重击飘字（更大字号）。 */
  heavy: boolean;
  /** 掉血前的生命值，供血条动画插值。 */
  previousHp: number;
  hp: number;
  maxHp: number;
  /** 会话时钟（毫秒），与 drainEvents 的 at 同源。 */
  at: number;
}

/** 一个实体的血条可见性状态。 */
export interface TargetFrameState {
  targetId: string;
  hp: number;
  maxHp: number;
  /** 常显（被玩家选中为目标）。 */
  pinned: boolean;
  /** 最近一次受击后还剩多少毫秒淡出。 */
  fadeRemainingMs: number;
  visible: boolean;
}

/** 命中反馈强度信号；渲染层据此决定顿帧长度/震屏幅度/闪红。 */
export interface HitPulse {
  id: number;
  targetId: string;
  /** 玩家受击时为 true（屏幕边缘闪红），否则黄色微震。 */
  incoming: boolean;
  heavy: boolean;
  /** 归一化强度 0..1（重击 1，普攻按伤害占目标上限比例衰减）。 */
  intensity: number;
  at: number;
}

/** 顿帧：命中瞬间冻结的毫秒数（重击更长）。 */
export const HIT_STOP_MS = { normal: 45, heavy: 110 } as const;
/** 镜头微震幅度（等距相机弧度）。 */
export const SHAKE_INTENSITY = { normal: 0.012, heavy: 0.03 } as const;
/** 受击后血条保留时长（user story 4）。 */
export const HEALTH_BAR_LINGER_MS = 5000;
/** 飘字上浮总时长。 */
export const DAMAGE_FEED_RISE_MS = 900;

export interface FeedbackView {
  /** 最近产生的飘字（按时间正序）。 */
  damage: DamageFeedEntry[];
  /** 需要显示血条的实体。 */
  frames: TargetFrameState[];
  /** 最近一次命中反馈（顿帧/震屏消费）。 */
  pulses: HitPulse[];
}

export interface CombatFeedbackCoreOptions {
  /** 血条淡出时长；测试可传小值。 */
  lingerMs?: number;
  /** 飘字保留时长。 */
  feedTtlMs?: number;
}

/**
 * 纯函数式反馈状态机：输入是事件流，输出是渲染可读的视图。
 * 内部只维护「最近受击时间」这类展示状态，绝不回写逻辑。
 */
export class CombatFeedbackCore {
  private readonly lingerMs: number;
  private readonly feedTtlMs: number;
  private readonly lastHitAt = new Map<string, number>();
  private readonly pinned = new Set<string>();
  private readonly damage: DamageFeedEntry[] = [];
  private readonly pulses: HitPulse[] = [];
  private nextId = 1;
  /** 由事件推导的 hp 基线：用于 previousHp，无需读会话。 */
  private readonly hpByEntity = new Map<string, { hp: number; maxHp: number }>();

  constructor(options: CombatFeedbackCoreOptions = {}) {
    this.lingerMs = options.lingerMs ?? HEALTH_BAR_LINGER_MS;
    this.feedTtlMs = options.feedTtlMs ?? DAMAGE_FEED_RISE_MS;
  }

  /** 玩家选中/取消选中某个实体（目标圈常显的来源）。 */
  setPinned(targetId: string, pinned: boolean): void {
    if (pinned) {
      this.pinned.add(targetId);
    } else {
      this.pinned.delete(targetId);
    }
  }

  /** 消费一条伤害事实。 */
  onDamage(event: {
    targetId: string;
    amount: number;
    targetHp: number;
    targetMaxHp: number;
    heavy: boolean;
    incoming: boolean;
    at: number;
  }): void {
    // previousHp = 这一击之前的生命。事件只带结算后的 targetHp，
    // 因此回推 amount（夹在上限内）；这样不需要读会话内部状态。
    const previousHp = Math.min(event.targetMaxHp, event.targetHp + event.amount);
    this.hpByEntity.set(event.targetId, {
      hp: event.targetHp,
      maxHp: event.targetMaxHp,
    });
    this.lastHitAt.set(event.targetId, event.at);

    const id = this.nextId++;
    this.damage.push({
      id,
      targetId: event.targetId,
      amount: event.amount,
      incoming: event.incoming,
      heavy: event.heavy,
      previousHp,
      hp: event.targetHp,
      maxHp: event.targetMaxHp,
      at: event.at,
    });
    const ratio =
      event.targetMaxHp > 0 ? Math.min(1, event.amount / event.targetMaxHp) : 1;
    this.pulses.push({
      id,
      targetId: event.targetId,
      incoming: event.incoming,
      heavy: event.heavy,
      intensity: event.heavy ? 1 : Math.max(0.25, ratio * 2),
      at: event.at,
    });
    this.trim(event.at);
  }

  /** 治疗等非伤害生命变化：只更新血条基线，不产生飘字/顿帧。 */
  onHealth(event: {
    entityId: string;
    hp: number;
    maxHp: number;
    at: number;
  }): void {
    this.hpByEntity.set(event.entityId, { hp: event.hp, maxHp: event.maxHp });
  }

  /** 实体消失（死亡消散完成）时清理。 */
  forget(targetId: string): void {
    this.pinned.delete(targetId);
    this.lastHitAt.delete(targetId);
    this.hpByEntity.delete(targetId);
    for (let index = this.damage.length - 1; index >= 0; index -= 1) {
      if (this.damage[index].targetId === targetId) {
        this.damage.splice(index, 1);
      }
    }
  }

  /** 读取当前视图（渲染层每帧调用）。 */
  view(nowMs: number): FeedbackView {
    this.trim(nowMs);
    const frames: TargetFrameState[] = [];
    for (const [targetId, hit] of this.lastHitAt) {
      const isPinned = this.pinned.has(targetId);
      const fadeRemainingMs = Math.max(0, this.lingerMs - (nowMs - hit));
      const baseline = this.hpByEntity.get(targetId);
      if (!isPinned && fadeRemainingMs <= 0) {
        continue;
      }
      frames.push({
        targetId,
        hp: baseline?.hp ?? 0,
        maxHp: baseline?.maxHp ?? 1,
        pinned: isPinned,
        fadeRemainingMs,
        visible: true,
      });
    }
    return { damage: [...this.damage], frames, pulses: [...this.pulses] };
  }

  /** 过期条目回收（飘字上浮结束即移除；脉冲一次性消费）。 */
  private trim(nowMs: number): void {
    while (this.damage.length > 0 && nowMs - this.damage[0].at > this.feedTtlMs) {
      this.damage.shift();
    }
    while (this.pulses.length > 0 && nowMs - this.pulses[0].at > this.feedTtlMs) {
      this.pulses.shift();
    }
  }
}
