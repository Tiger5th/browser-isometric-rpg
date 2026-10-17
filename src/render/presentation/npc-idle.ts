/**
 * NPC 待机行为控制器（票 28，user story 20）。
 *
 * 纯表现层：只改视觉节点的 transform，不写 GameSession 快照——
 * NPC 的逻辑位置仍由会话推进（NPC 没有 moveTo 意图，站在那里），
 * 这里只叠加「呼吸摆动」与「偶尔踱步」两层演出。
 *
 * 数学与随机都在 world-physics.sampleNpcIdle（纯函数、可 L1 直测）；
 * 本类只负责把它接到 Babylon 节点上，并处理踱步的插值推进。
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import { mulberry32 } from "../character-proto";
import { GREEN_HOLLOW_BOUNDS } from "./green-hollow-layout";
import {
  NPC_BREATH_PERIOD_MS,
  NPC_PACE_MAX_INTERVAL_MS,
  NPC_PACE_MIN_INTERVAL_MS,
  sampleNpcIdle,
  type NpcIdleState,
} from "./world-physics";

export interface NpcIdleConfig {
  scene: Scene;
  /** NPC 视觉根节点（位置由 syncVisualToSnapshot 写入，这里只叠加局部变换）。 */
  node: TransformNode;
  /** NPC 的默认位置（踱步以此为中心）。 */
  home: { x: number; z: number };
  /** 确定性种子：同一 NPC 每次进区域演出一致。 */
  seed: number;
  /**
   * 区域边界（code-review #13）：踱步钳制按当前区域的可行走区算，
   * 不再永远用翠谷 bounds。缺省翠谷（老调用方兼容）。
   */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** 踱步移动速度（m/s）：比玩家慢，避免视觉上「NPC 在赶路」。 */
const PACE_SPEED = 0.9;

export class NpcIdleController {
  private readonly node: TransformNode;
  private readonly home: { x: number; z: number };
  private readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private state: NpcIdleState;
  private elapsedMs = 0;
  /** 踱步中的剩余目标；null 表示站着不动。 */
  private paceTarget: { x: number; z: number } | null = null;
  /** 呼吸累计时间（用于把 sway 写进 rotation.x）。 */
  private breathMs = 0;
  /** 对话中暂停演出（避免对话时角色还在乱动）。 */
  private paused = false;
  private disposed = false;

  constructor(config: NpcIdleConfig) {
    this.node = config.node;
    this.home = config.home;
    this.bounds = config.bounds ?? GREEN_HOLLOW_BOUNDS;
    this.state = {
      yaw: config.node.rotation.y,
      paceCooldownMs:
        NPC_PACE_MIN_INTERVAL_MS +
        mulberry32(config.seed)() * (NPC_PACE_MAX_INTERVAL_MS - NPC_PACE_MIN_INTERVAL_MS),
      random: mulberry32(config.seed ^ 0x9e3779b9),
    };
  }

  /** 对话/过场时暂停待机演出。 */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.paceTarget = null;
    }
  }

  /**
   * 每帧调用。deltaMs 为帧间隔；position 是会话当前的权威位置，
   * 踱步只在该位置附近做小偏移，不改变逻辑事实。
   */
  update(deltaMs: number, position: { x: number; z: number }): void {
    if (this.paused || this.disposed) {
      return;
    }
    this.elapsedMs += deltaMs;
    this.breathMs = (this.breathMs + deltaMs) % NPC_BREATH_PERIOD_MS;

    const { sample, next } = sampleNpcIdle(
      this.state,
      this.elapsedMs,
      deltaMs,
      this.home,
      this.bounds,
    );
    this.state = next;

    if (sample.paceTarget !== null) {
      this.paceTarget = sample.paceTarget;
    }

    let renderX = position.x;
    let renderZ = position.z;
    if (this.paceTarget !== null) {
      const dx = this.paceTarget.x - position.x;
      const dz = this.paceTarget.z - position.z;
      const distance = Math.hypot(dx, dz);
      const step = (PACE_SPEED * deltaMs) / 1000;
      if (distance <= step) {
        // 到达踱步点：停一下（冷却已由 sampleNpcIdle 重新装填）。
        this.paceTarget = null;
      } else {
        renderX = position.x + (dx / distance) * step;
        renderZ = position.z + (dz / distance) * step;
      }
    }

    this.node.position.x = renderX;
    this.node.position.z = renderZ;
    // 呼吸：绕 X 轴的微小前后倾；踱步时面向由 sampleNpcIdle 给出。
    this.node.rotation.x = sample.sway;
    if (sample.faceYaw !== null) {
      this.node.rotation.y = sample.faceYaw;
    }
  }

  /** 供报告/截图核对：当前是否在踱步。 */
  get isPacing(): boolean {
    return this.paceTarget !== null;
  }

  /** 呼吸相位（0–1），便于 ego-browser 断言摆动在推进。 */
  get breathPhase(): number {
    return this.breathMs / NPC_BREATH_PERIOD_MS;
  }

  dispose(): void {
    this.paceTarget = null;
    this.disposed = true;
  }
}

/** NPC 待机演出的统一 tint（票 25 的占位配色，票 29 会换成角色色板卡）。 */
export const NPC_IDLE_TINTS: Record<string, Color3> = {
  "npc:elder_ma": Color3.FromHexString("#f0abfc"),
  "npc:scout_lin": Color3.FromHexString("#a3e635"),
};

export function npcTintFor(npcId: string, displayName: string): Color3 {
  return (
    NPC_IDLE_TINTS[npcId] ??
    Color3.FromHexString(displayName === "马婆婆" ? "#f0abfc" : "#a3e635")
  );
}
