/**
 * 战斗音效（票 27）：事件驱动的 CC0 音效播放。
 *
 * 约束（specs/p2-gameplay.md）：
 * - 音效只消费 GameSession 一等事件，不读会话内部状态；
 * - 浏览器自动播放策略要求首次用户交互后才能启动 AudioContext，
 *   因此 unlock() 由输入层（点击/按键）调用，未解锁前播放请求静默入队；
 * - 不做自动化断言（浏览器策略干扰），人工验收清单另行覆盖。
 *
 * 文件来源与许可证见 assets/audio/SOURCES.md（全部 CC0 1.0）。
 */

export type CombatSoundName =
  | "attack_hit"
  | "hurt"
  | "enemy_die"
  | "item_pickup"
  | "level_up"
  | "ui_click"
  | "heavy_attack"
  | "wind_up";

/** 事件 → 音效 的固定映射（一处可查）。 */
const SOUND_BY_EVENT: Record<string, CombatSoundName> = {
  "damage-dealt:light": "attack_hit",
  "damage-dealt:heavy": "heavy_attack",
  "damage-dealt:incoming": "hurt",
  "enemy-killed": "enemy_die",
  "item-gained": "item_pickup",
  "player-level-up": "level_up",
  "ui-click": "ui_click",
  "attack-windup": "wind_up",
};

export interface CombatAudioOptions {
  /** 基础音量 0..1。 */
  volume?: number;
  /** 同一音效的最小间隔（毫秒），避免一帧内多次命中叠成噪音。 */
  minIntervalMs?: number;
  /** 音效 URL 解析；测试注入内存实现。 */
  loadSound?: (name: CombatSoundName) => Promise<unknown>;
  /** 音频上下文工厂；测试注入假实现。 */
  createContext?: () => AudioContextLike;
  now?: () => number;
}

/**  AudioContext 的最小可用面（真实实现与测试替身共用）。 */
export interface AudioContextLike {
  currentTime: number;
  state: AudioContextState | string;
  /** 音频输出终点；gain 必须连到这里（AudioContext 本身不是 AudioNode）。 */
  destination: unknown;
  resume(): Promise<void>;
  close?(): Promise<void>;
  createGain(): GainNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}

export interface GainNodeLike {
  gain: AudioParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, when: number): void;
  exponentialRampToValueAtTime(value: number, when: number): void;
}

export interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null;
  playbackRate: AudioParamLike;
  connect(target: unknown): void;
  disconnect(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioBufferLike {
  duration: number;
}

/**
 * 音效文件 URL：由 Vite 在构建期把 assets/audio/*.wav 打包成带 hash 的
 * 静态资源（与占位角色 glb 同一机制），避免运行时相对路径在 dist 下失效。
 * 测试环境（vitest/node）没有 import.meta.glob，回落到源路径。
 */
const SOUND_MODULES = import.meta.glob("../../../assets/audio/*.wav", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const SOUND_FILES: Record<CombatSoundName, string> = {
  attack_hit: "attack_hit.wav",
  hurt: "hurt.wav",
  enemy_die: "enemy_die.wav",
  item_pickup: "item_pickup.wav",
  level_up: "level_up.wav",
  ui_click: "ui_click.wav",
  heavy_attack: "heavy_attack.wav",
  wind_up: "wind_up.wav",
};

/** 音效文件 URL 表。 */
export function combatSoundUrl(name: CombatSoundName): string {
  const file = SOUND_FILES[name];
  const key = `../../../assets/audio/${file}`;
  return SOUND_MODULES[key] ?? `assets/audio/${file}`;
}

/** 把事件映射成音效名；没有对应音效时返回 null。 */
export function soundForEvent(
  kind:
    | "damage-dealt:light"
    | "damage-dealt:heavy"
    | "damage-dealt:incoming"
    | "enemy-killed"
    | "item-gained"
    | "player-level-up"
    | "ui-click"
    | "attack-windup",
): CombatSoundName | null {
  return SOUND_BY_EVENT[kind] ?? null;
}

interface PlaybackRequest {
  name: CombatSoundName;
  /** 播放速度；重击前摇等需要变调时使用。 */
  rate: number;
  gain: number;
}

/**
 * 事件驱动的音效播放器。
 * 单例语义：一个会话一个实例，teardown 时释放 AudioContext。
 */
export class CombatAudio {
  private readonly volume: number;
  private readonly minIntervalMs: number;
  private readonly loadSound: (name: CombatSoundName) => Promise<unknown>;
  private readonly createContext: () => AudioContextLike;
  private readonly now: () => number;
  private readonly lastPlayedAt = new Map<CombatSoundName, number>();
  private readonly buffers = new Map<CombatSoundName, AudioBufferLike>();
  private readonly pending: PlaybackRequest[] = [];
  private context: AudioContextLike | null = null;
  private unlocked = false;

  constructor(options: CombatAudioOptions = {}) {
    this.volume = options.volume ?? 0.6;
    this.minIntervalMs = options.minIntervalMs ?? 40;
    this.loadSound =
      options.loadSound ??
      (async (name) => {
        const response = await fetch(combatSoundUrl(name));
        return response.arrayBuffer();
      });
    this.createContext =
      options.createContext ??
      (() =>
        new AudioContext() as unknown as AudioContextLike);
    this.now = options.now ?? (() => performance.now());
  }

  /** 首次用户交互时调用；之后播放请求才会真正发声。 */
  async unlock(): Promise<void> {
    if (this.unlocked) {
      return;
    }
    const context = this.ensureContext();
    if (context.state === "suspended") {
      await context.resume();
    }
    this.unlocked = true;
    // 解锁前堆积的请求现在补发。
    const queued = this.pending.splice(0, this.pending.length);
    for (const request of queued) {
      await this.play(request);
    }
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /** 预加载全部音效（场景 setup 时调用；失败只警告不阻断）。 */
  async preloadAll(): Promise<void> {
    const names = Object.keys(SOUND_FILES) as CombatSoundName[];
    await Promise.all(
      names.map(async (name) => {
        try {
          const data = await this.loadSound(name);
          if (data instanceof ArrayBuffer) {
            this.buffers.set(name, await this.ensureContext().decodeAudioData(data));
          }
        } catch {
          // 单个音效缺失不阻断其余反馈（视觉反馈仍然工作）。
        }
      }),
    );
  }

  /** 事件入口：damage-dealt / item-gained / attack-windup-started 等。 */
  handleEvent(event: {
    type: string;
    heavy?: boolean;
    incoming?: boolean;
    amount?: number;
  }): void {
    if (event.type === "attack-windup-started") {
      // 重击前摇用更低沉的前摇音（rate 0.75），与普攻提示区分。
      this.playUi("attack-windup", event.heavy === true ? 0.75 : 1);
      return;
    }
    let kind: Parameters<typeof soundForEvent>[0] | null = null;
    if (event.type === "damage-dealt") {
      kind = event.incoming
        ? "damage-dealt:incoming"
        : event.heavy
          ? "damage-dealt:heavy"
          : "damage-dealt:light";
    } else if (
      event.type === "enemy-killed" ||
      event.type === "item-gained" ||
      event.type === "player-level-up"
    ) {
      kind = event.type;
    }
    if (kind === null) {
      return;
    }
    const name = soundForEvent(kind);
    if (name === null) {
      return;
    }
    const gain = event.type === "damage-dealt" && event.incoming ? 0.75 : 1;
    this.enqueue({ name, rate: 1, gain: this.volume * gain });
  }

  /** UI 点击与攻击前摇提示（不由 GameSession 事件驱动，仍走同一条播放链路）。 */
  playUi(kind: "ui-click" | "attack-windup", rate = 1): void {
    const name = soundForEvent(kind);
    if (name === null) {
      return;
    }
    this.enqueue({ name, rate, gain: this.volume * 0.8 });
  }

  dispose(): void {
    this.pending.length = 0;
    this.buffers.clear();
    this.unlocked = false;
    void this.context?.close?.();
    this.context = null;
  }

  private enqueue(request: PlaybackRequest): void {
    if (!this.unlocked) {
      // 未解锁：只保留最近几条，避免解锁瞬间音效洪水。
      this.pending.push(request);
      if (this.pending.length > 4) {
        this.pending.shift();
      }
      return;
    }
    void this.play(request);
  }

  private async play(request: PlaybackRequest): Promise<void> {
    const now = this.now();
    const last = this.lastPlayedAt.get(request.name) ?? -Infinity;
    if (now - last < this.minIntervalMs) {
      return;
    }

    const buffer = this.buffers.get(request.name);
    const context = this.ensureContext();
    if (!buffer || context.state !== "running") {
      return;
    }
    // 通过间隔检查且确认能发声后才记时间戳：否则缺 buffer / 上下文未就绪
    // 的请求会白白占掉节流名额，解锁瞬间真正该响的那一声反被吞掉。
    this.lastPlayedAt.set(request.name, now);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = request.rate;
    const gain = context.createGain();
    gain.gain.value = request.gain;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    source.stop(context.currentTime + buffer.duration / Math.max(0.1, request.rate));
  }

  private ensureContext(): AudioContextLike {
    if (this.context === null) {
      this.context = this.createContext();
    }
    return this.context;
  }
}
