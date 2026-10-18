/**
 * 两段式对话交互（票 29）：纯逻辑状态机。
 *
 * 约定（specs/p2-gameplay.md「交互规则」）：
 * 1. 点击 NPC = moveTo 到对话距离（约 1.5m），**不弹对话框**；
 * 2. 到达后 NPC 头顶出现气泡按钮（`talk` 无任务 / `quest` 有可接任务）；
 * 3. 点击气泡才进入对话；
 * 4. 对话中玩家移动意图 = 结束对话；走出对话范围同样结束（不被锁死）。
 *
 * 本模块零引擎依赖：只做「阶段推进 + 该提交什么动作」的判定，
 * 不持有位置也不读会话内部状态。表现层每帧调用 updateInteraction()
 * 喂入实体位置表与可交互信息，按其返回的 action 提交意图。
 */

import type { Vec3 } from "./entity";

/** 对话距离：玩家停在距 NPC 这么远的位置。 */
export const DEFAULT_DIALOGUE_RANGE = 1.5;
/**
 * 交互判定范围（比对话距离略宽）：容纳表现层视觉位置与逻辑位置的
 * 微小误差，避免「明明贴在脸上却不给气泡」。
 */
export const DEFAULT_NPC_INTERACT_RANGE = 2;

export type InteractionPhase = "idle" | "approaching" | "ready" | "talking";

/**
 * 靠近中重新发路线的节流（毫秒）。
 *
 * 诊断（票 37 验收）：点击移动中的 NPC 时 target 是**点击瞬间**算出的固定点，
 * NPC 一边走玩家一边朝死点跑，追不上也永远出不了气泡。修法是每
 * APPROACH_REISSUE_INTERVAL_MS 重新朝 NPC 的**当前**位置发一次路——
 * 节流是为了不每帧重算 navmesh 路径。
 */
export const APPROACH_REISSUE_INTERVAL_MS = 1_500;

/**
 * 靠近阶段的超时（毫秒）：从点下 NPC 起超过这么久还没进入交互范围，
 * 就放弃这次交互并释放 NPC 巡逻冻结。
 *
 * 这是「NPC 停下等玩家」机制的兜底闸门：没有它，一次卡住的寻路
 * （目标点落在障碍上、玩家被顶开）会把 NPC 永久冻在原地。
 */
export const APPROACH_TIMEOUT_MS = 6_000;

/** 气泡按钮内容：普通「对话」或可接任务的感叹号。 */
export type InteractionBubble = "talk" | "quest";

/** 表现层可提交的动作集合。 */
export type InteractionAction =
  | { kind: "none" }
  | { kind: "approach"; npcId: string; target: Vec3 }
  | { kind: "arrived"; npcId: string }
  | { kind: "start-dialogue"; npcId: string }
  | { kind: "end-dialogue"; npcId: string };

/** 某个实体当前是否可交互、气泡该显示什么。 */
export interface InteractableInfo {
  hasDialogue: boolean;
  hasQuest: boolean;
}

export type InteractableIndex = ReadonlyMap<string, InteractableInfo>;

export interface InteractionState {
  phase: InteractionPhase;
  npcId: string | null;
  bubble: InteractionBubble | null;
  /** 距下次允许重发 approach 的剩余毫秒（节流）。 */
  approachCooldownMs: number;
  /** 本次交互已持续的毫秒（靠近超时用）。 */
  elapsedMs: number;
}

export function createInteractionState(): InteractionState {
  return {
    phase: "idle",
    npcId: null,
    bubble: null,
    approachCooldownMs: 0,
    elapsedMs: 0,
  };
}

/**
 * 当前是否应当冻结该 NPC 的巡逻。
 *
 * 诊断（票 37 验收）：NPC 一边巡逻一边「等你」，玩家永远追不上；
 * ready 阶段 NPC 走出 2m 还会把气泡直接 reset 掉（气泡刚出现就消失）。
 * 因此对话开始前的**整个 approaching + ready 阶段**都让 NPC 停下，
 * 复用对话冻结走的那条 setPatrolPaused 通路（逻辑层一个真相源）。
 *
 * ready 阶段不设超时：气泡在界面上挂着，NPC 就该等着。
 * approaching 阶段受 APPROACH_TIMEOUT_MS 约束（见 tickApproachTimeout）。
 */
export function npcHoldFor(
  state: InteractionState,
): { npcId: string; active: true } | null {
  if (state.npcId === null) {
    return null;
  }
  if (state.phase === "approaching" || state.phase === "ready") {
    return { npcId: state.npcId, active: true };
  }
  return null;
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 从玩家当前位置朝 NPC 后退到对话距离的站立点。 */
export function interactionTarget(npcPosition: Vec3, playerPosition: Vec3): Vec3 {
  const dx = playerPosition.x - npcPosition.x;
  const dz = playerPosition.z - npcPosition.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) {
    // 重合时给一个确定方向（+X），保证目标点可复现。
    return { x: npcPosition.x + DEFAULT_DIALOGUE_RANGE, y: npcPosition.y, z: npcPosition.z };
  }
  const ratio = DEFAULT_DIALOGUE_RANGE / distance;
  return {
    x: npcPosition.x + dx * ratio,
    y: npcPosition.y,
    z: npcPosition.z + dz * ratio,
  };
}

function bubbleFor(info: InteractableInfo): InteractionBubble {
  return info.hasQuest ? "quest" : "talk";
}

function reset(state: InteractionState): void {
  state.phase = "idle";
  state.npcId = null;
  state.bubble = null;
  state.approachCooldownMs = 0;
  state.elapsedMs = 0;
}

/** 进入 approaching 时重装节流与计时（selectNpc / activateBubble 共用）。 */
function enterApproaching(state: InteractionState): void {
  state.phase = "approaching";
  state.bubble = null;
  state.approachCooldownMs = APPROACH_REISSUE_INTERVAL_MS;
  state.elapsedMs = 0;
}

/**
 * 推进计时（靠近超时 / 重发节流）。只在非 idle 阶段累计。
 * 返回是否发生了状态变化（超时会让调用方解冻 NPC）。
 */
function tickTimers(state: InteractionState, deltaMs: number): boolean {
  if (state.phase === "idle" || deltaMs <= 0) {
    return false;
  }
  state.approachCooldownMs = Math.max(0, state.approachCooldownMs - deltaMs);
  state.elapsedMs += deltaMs;
  if (state.phase === "approaching" && state.elapsedMs >= APPROACH_TIMEOUT_MS) {
    reset(state);
    return true;
  }
  return false;
}

/**
 * 选中一个 NPC（点击）：距离内直接出气泡，远处生成靠近动作。
 * 已经与其他 NPC 对话时拒绝（调用方不应发生）。
 */
export function selectNpc(
  state: InteractionState,
  npcId: string,
  interactables: InteractableIndex,
  playerPosition: Vec3,
  npcPosition: Vec3,
): InteractionAction {
  const info = interactables.get(npcId);
  if (info === undefined || (!info.hasDialogue && !info.hasQuest)) {
    return { kind: "none" };
  }
  if (state.phase === "talking") {
    return { kind: "none" };
  }

  const distance = horizontalDistance(playerPosition, npcPosition);
  if (distance <= DEFAULT_NPC_INTERACT_RANGE) {
    state.phase = "ready";
    state.npcId = npcId;
    state.bubble = bubbleFor(info);
    return { kind: "arrived", npcId };
  }

  state.npcId = npcId;
  enterApproaching(state);
  return { kind: "approach", npcId, target: interactionTarget(npcPosition, playerPosition) };
}

/**
 * 每帧推进：寻路中到点 → ready；走出范围 → 收起气泡；
 * 对话中离开 → 结束对话。positions 的键是实体 id，玩家固定为 "player"。
 */
export function updateInteraction(
  state: InteractionState,
  positions: ReadonlyMap<string, Vec3>,
  interactables: InteractableIndex,
  playerId = "player",
  deltaMs = 0,
): InteractionAction {
  if (state.phase === "idle" || state.npcId === null) {
    return { kind: "none" };
  }
  // 超时先于一切距离判定：这次交互已经放弃，不再重发路。
  tickTimers(state, deltaMs);
  // tickTimers 可能把阶段 reset 回 idle（TS 不知道，重新读一次）。
  if ((state.phase as InteractionPhase) === "idle" || state.npcId === null) {
    return { kind: "none" };
  }
  const npcPosition = positions.get(state.npcId);
  const playerPosition = positions.get(playerId);
  const info = interactables.get(state.npcId);
  if (npcPosition === undefined || playerPosition === undefined || info === undefined) {
    // NPC 消失（读档换区等）：整体回到空闲，避免悬挂引用。
    reset(state);
    return { kind: "none" };
  }

  const distance = horizontalDistance(playerPosition, npcPosition);

  if (state.phase === "approaching") {
    if (distance <= DEFAULT_NPC_INTERACT_RANGE) {
      state.phase = "ready";
      state.bubble = bubbleFor(info);
      return { kind: "arrived", npcId: state.npcId };
    }
    // 还在范围外：按节流重发一条朝 NPC **当前**位置的路。
    // 玩家可能早就走到位了（movement 已结束），NPC 也在冻结下不动，
    // 不重发就会永远卡在 approaching（诊断：点击移动中的 NPC 追不上）。
    if (state.approachCooldownMs === 0) {
      state.approachCooldownMs = APPROACH_REISSUE_INTERVAL_MS;
      return {
        kind: "approach",
        npcId: state.npcId,
        target: interactionTarget(npcPosition, playerPosition),
      };
    }
    return { kind: "none" };
  }

  if (state.phase === "ready") {
    if (distance > DEFAULT_NPC_INTERACT_RANGE) {
      reset(state);
      return { kind: "none" };
    }
    state.bubble = bubbleFor(info);
    return { kind: "none" };
  }

  // talking：离开对话范围 = 结束对话（移动意图已经由 requestMove 处理）。
  if (distance > DEFAULT_DIALOGUE_RANGE + DEFAULT_NPC_INTERACT_RANGE) {
    const npcId = state.npcId;
    reset(state);
    return { kind: "end-dialogue", npcId };
  }
  return { kind: "none" };
}

/** 点击头顶气泡：范围内开对话，范围外重新寻路（过期气泡不静默失效）。 */
export function activateBubble(
  state: InteractionState,
  positions: ReadonlyMap<string, Vec3>,
  interactables: InteractableIndex,
  playerId = "player",
): InteractionAction {
  if (state.phase !== "ready" || state.npcId === null) {
    return { kind: "none" };
  }
  const info = interactables.get(state.npcId);
  const npcPosition = positions.get(state.npcId);
  const playerPosition = positions.get(playerId);
  if (info === undefined || npcPosition === undefined || playerPosition === undefined) {
    reset(state);
    return { kind: "none" };
  }
  if (!info.hasDialogue) {
    // 只有任务没有对话的 NPC 暂不支持（当前内容不存在）。
    reset(state);
    return { kind: "none" };
  }

  if (horizontalDistance(playerPosition, npcPosition) <= DEFAULT_NPC_INTERACT_RANGE) {
    state.phase = "talking";
    state.bubble = null;
    return { kind: "start-dialogue", npcId: state.npcId };
  }

  enterApproaching(state);
  return {
    kind: "approach",
    npcId: state.npcId,
    target: interactionTarget(npcPosition, playerPosition),
  };
}

/** 玩家移动意图（点击地面/其他实体）：立即取消靠近或结束对话。 */
export function requestMove(state: InteractionState): InteractionAction {
  if (state.phase === "talking" && state.npcId !== null) {
    const action: InteractionAction = { kind: "end-dialogue", npcId: state.npcId };
    reset(state);
    return action;
  }
  reset(state);
  return { kind: "none" };
}

/**
 * 从另一份状态恢复（读档 / 场景重建）。
 * 只拷阶段与目标，气泡按当前可交互信息在下一帧 updateInteraction 重算。
 */
export function setInteractionPhase(target: InteractionState, source: InteractionState): void {
  target.phase = source.phase;
  target.npcId = source.npcId;
  target.bubble = source.bubble;
  target.approachCooldownMs = source.approachCooldownMs;
  target.elapsedMs = source.elapsedMs;
}
