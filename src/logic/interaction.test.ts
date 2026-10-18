import { describe, expect, it } from "vitest";

import {
  APPROACH_REISSUE_INTERVAL_MS,
  APPROACH_TIMEOUT_MS,
  DEFAULT_DIALOGUE_RANGE,
  DEFAULT_NPC_INTERACT_RANGE,
  activateBubble,
  createInteractionState,
  interactionTarget,
  npcHoldFor,
  requestMove,
  selectNpc,
  setInteractionPhase,
  updateInteraction,
  type InteractionState,
  type InteractableInfo,
  type InteractableIndex,
} from "./interaction";
import type { Vec3 } from "./entity";

const NPC_ID = "npc:elder_ma";
const NPC_POSITION = { x: 6, y: 0, z: 4 };

function index(overrides: Partial<Record<string, InteractableInfo>> = {}): InteractableIndex {
  return new Map<string, InteractableInfo>([
    [NPC_ID, overrides[NPC_ID] ?? { hasDialogue: true, hasQuest: false }],
  ]);
}

function positions(player: Vec3): Map<string, Vec3> {
  return new Map<string, Vec3>([[NPC_ID, { ...NPC_POSITION }], ["player", player]]);
}

function position(x: number, z: number): Vec3 {
  return { x, y: 0, z };
}

/** 玩家站在 NPC 对话距离之外 6m 处。 */
function farPlayer(): Vec3 {
  return position(0, 0);
}

/** 玩家已经走到 NPC 面前（1m）。 */
function nearPlayer(): Vec3 {
  return position(NPC_POSITION.x + 1, NPC_POSITION.z);
}

describe("两段式对话交互状态机", () => {
  it("远处点击 NPC 只生成靠近意图，不直接开对话", () => {
    const state = createInteractionState();

    const action = selectNpc(state, NPC_ID, index(), farPlayer(), NPC_POSITION);

    expect(action.kind).toBe("approach");
    if (action.kind !== "approach") {
      return;
    }
    expect(action.npcId).toBe(NPC_ID);
    // 目标点必须在 NPC 与玩家连线上，且恰好落在对话距离上。
    const targetDistance = Math.hypot(
      action.target.x - NPC_POSITION.x,
      action.target.z - NPC_POSITION.z,
    );
    expect(targetDistance).toBeCloseTo(DEFAULT_DIALOGUE_RANGE, 6);
    expect(Math.hypot(action.target.x - farPlayer().x, action.target.z - farPlayer().z))
      .toBeCloseTo(Math.hypot(NPC_POSITION.x - farPlayer().x, NPC_POSITION.z - farPlayer().z) - DEFAULT_DIALOGUE_RANGE, 6);
    expect(state.phase).toBe("approaching");
    expect(state.npcId).toBe(NPC_ID);
  });

  it("靠近目标点落在 NPC 对话距离上，与玩家来向无关", () => {
    // 玩家从 +X 一侧靠近：目标 = NPC + 单位方向 × 1.5。
    expect(interactionTarget(NPC_POSITION, nearPlayer())).toEqual({
      x: 7.5,
      y: 0,
      z: 4,
    });
    // 默认对话距离常量与规格一致（约 1.5m）。
    expect(DEFAULT_DIALOGUE_RANGE).toBe(1.5);
  });

  it("距离内点击 NPC 直接进入可交互阶段（出气泡，不弹对话）", () => {
    const state = createInteractionState();

    const action = selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);

    expect(action.kind).toBe("arrived");
    expect(state.phase).toBe("ready");
    expect(state.bubble).toBe("talk");
  });

  it("寻路推进中未到达时没有任何动作；到达后转为可交互阶段", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), farPlayer(), NPC_POSITION);

    const walking = updateInteraction(state, positions(farPlayer()), index());
    expect(walking.kind).toBe("none");
    expect(state.phase).toBe("approaching");

    const arrived = updateInteraction(state, positions(nearPlayer()), index());
    expect(arrived).toEqual({ kind: "arrived", npcId: NPC_ID });
    expect(state.phase).toBe("ready");
    expect(state.bubble).toBe("talk");
  });

  it("NPC 有可接任务时气泡是感叹号，任务状态变化后跟随更新", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index({ [NPC_ID]: { hasDialogue: true, hasQuest: true } }), nearPlayer(), NPC_POSITION);
    expect(state.bubble).toBe("quest");

    // 站在原地把任务接掉：气泡回落成普通「对话」。
    const updated = updateInteraction(
      state,
      positions(nearPlayer()),
      index({ [NPC_ID]: { hasDialogue: true, hasQuest: false } }),
    );
    expect(updated.kind).toBe("none");
    expect(state.phase).toBe("ready");
    expect(state.bubble).toBe("talk");
  });

  it("可交互阶段走出范围则气泡消失，回到空闲", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);
    expect(state.phase).toBe("ready");

    const left = updateInteraction(state, positions(farPlayer()), index());
    expect(left.kind).toBe("none");
    expect(state.phase).toBe("idle");
    expect(state.bubble).toBeNull();
  });

  it("点击气泡开启对话，阶段切到 talking", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);

    const action = activateBubble(state, positions(nearPlayer()), index());

    expect(action).toEqual({ kind: "start-dialogue", npcId: NPC_ID });
    expect(state.phase).toBe("talking");
  });

  it("远离后点击过期气泡会重新寻路靠近，而不是静默失败", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);
    // 玩家被敌人撞开/主动走远，气泡还挂在界面上。
    const action = activateBubble(state, positions(farPlayer()), index());

    expect(action.kind).toBe("approach");
    expect(state.phase).toBe("approaching");
  });

  it("对话中收到移动意图即结束对话并清空交互", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);
    activateBubble(state, positions(nearPlayer()), index());

    const action = requestMove(state);

    expect(action).toEqual({ kind: "end-dialogue", npcId: NPC_ID });
    expect(state.phase).toBe("idle");
    expect(state.npcId).toBeNull();
  });

  it("移动意图也会取消尚未点击的气泡", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);

    expect(requestMove(state).kind).toBe("none");
    expect(state.phase).toBe("idle");
    expect(state.bubble).toBeNull();
  });

  it("对话中走出对话范围会结束对话（不被对话锁死）", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);
    activateBubble(state, positions(nearPlayer()), index());

    const escaped = updateInteraction(state, positions(farPlayer()), index());

    expect(escaped).toEqual({ kind: "end-dialogue", npcId: NPC_ID });
    expect(state.phase).toBe("idle");
  });

  it("对话中原地不动时每帧都是无动作", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);
    activateBubble(state, positions(nearPlayer()), index());

    expect(updateInteraction(state, positions(nearPlayer()), index()).kind).toBe("none");
    expect(state.phase).toBe("talking");
  });

  it("没有可选交互时保持空闲", () => {
    const state = createInteractionState();

    expect(selectNpc(state, NPC_ID, index({ [NPC_ID]: { hasDialogue: false, hasQuest: false } }), farPlayer(), NPC_POSITION).kind).toBe("none");
    expect(state.phase).toBe("idle");

    expect(activateBubble(state, positions(nearPlayer()), index()).kind).toBe("none");
    expect(updateInteraction(state, positions(farPlayer()), index()).kind).toBe("none");
  });

  it("阶段可从快照恢复（读档后继续对话）", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index({ [NPC_ID]: { hasDialogue: true, hasQuest: true } }), nearPlayer(), NPC_POSITION);
    activateBubble(state, positions(nearPlayer()), index());

    const restored = createInteractionState();
    setInteractionPhase(restored, state);

    expect(restored.phase).toBe("talking");
    expect(restored.npcId).toBe(NPC_ID);
    // 对话阶段不显示气泡；恢复的是「阶段 + 目标」，气泡由界面层按阶段渲染。
    expect(restored.bubble).toBeNull();
    // 恢复后的状态继续参与同一套判定。
    expect(requestMove(restored)).toEqual({ kind: "end-dialogue", npcId: NPC_ID });
  });

  it("交互范围比对话距离宽，留出靠近容差", () => {
    expect(DEFAULT_NPC_INTERACT_RANGE).toBeGreaterThan(DEFAULT_DIALOGUE_RANGE);
  });
});

describe("交互状态不可变性", () => {
  it("updateInteraction 不修改传入的位置表", () => {
    const state: InteractionState = createInteractionState();
    selectNpc(state, NPC_ID, index(), farPlayer(), NPC_POSITION);
    const table = positions(farPlayer());
    const before = JSON.stringify(table);

    updateInteraction(state, table, index());

    expect(JSON.stringify(table)).toBe(before);
  });
});

/**
 * 票 37 验收修复：点击移动中的 NPC 追不上。
 *
 * 复现：点击时 target 是**点击瞬间**算的固定点，approaching 阶段永不重发。
 * NPC 停在下一次巡逻路上，玩家停在离 NPC 1.5m 的死点上，
 * 状态机永远停在 approaching（实测：气泡不出现）。
 */
describe("靠近移动中的 NPC（票 37 验收）", () => {
  /** 玩家已停在一个离 NPC 4m 的点上，NPC 还在原地不动。 */
  function stalledPositions(player: Vec3, npc: Vec3 = NPC_POSITION): Map<string, Vec3> {
    return new Map<string, Vec3>([[NPC_ID, npc], ["player", player]]);
  }

  it("玩家到位但距离仍超交互范围时，按节流重发朝 NPC 当前位置的接近", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), farPlayer(), NPC_POSITION);
    expect(state.phase).toBe("approaching");

    // 首帧消耗节流窗口。
    updateInteraction(state, stalledPositions(farPlayer()), index(), "player", 1_000);
    // 玩家停在离 NPC 4m 处（moveTo 完成），距离没变。
    const stuck = updateInteraction(
      state,
      stalledPositions(position(NPC_POSITION.x, NPC_POSITION.z - 4)),
      index(),
      "player",
      600,
    );

    expect(stuck.kind).toBe("approach");
    if (stuck.kind !== "approach") {
      return;
    }
    expect(stuck.npcId).toBe(NPC_ID);
    // 重发的目标点必须朝 NPC 的**当前**位置算，且落在对话距离上。
    const targetDistance = Math.hypot(
      stuck.target.x - NPC_POSITION.x,
      stuck.target.z - NPC_POSITION.z,
    );
    expect(targetDistance).toBeCloseTo(DEFAULT_DIALOGUE_RANGE, 6);
  });

  it("重发按 APPROACH_REISSUE_INTERVAL_MS 节流，不会每帧刷路径", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), farPlayer(), NPC_POSITION);
    const far = stalledPositions(position(NPC_POSITION.x, NPC_POSITION.z - 4));

    // 刚进 approaching：节流窗口已装填。
    expect(updateInteraction(state, far, index(), "player", 100).kind).toBe("none");
    // 窗口内再次推进仍然无动作。
    expect(updateInteraction(state, far, index(), "player", 100).kind).toBe("none");
    // 累计超过窗口才重发一条。
    expect(
      updateInteraction(state, far, index(), "player", APPROACH_REISSUE_INTERVAL_MS).kind,
    ).toBe("approach");
  });

  it("NPC 移动后重发的目标跟着 NPC 走（不是点击瞬间的死点）", () => {
    const state = createInteractionState();
    const movedNpc = { x: NPC_POSITION.x, y: 0, z: NPC_POSITION.z };
    selectNpc(state, NPC_ID, index(), farPlayer(), movedNpc);
    const startPlayer = position(NPC_POSITION.x, NPC_POSITION.z - 4);
    updateInteraction(state, stalledPositions(startPlayer, movedNpc), index(), "player", 1_000);

    // NPC 巡逻到了别处（玩家原地不动）。
    const npcNow = { x: NPC_POSITION.x, y: 0, z: NPC_POSITION.z + 6 };
    // 玩家在 NPC 正南 4m 处（+z 方向，重发的目标因此是 NPC.z + 1.5）。
    const playerNow = position(npcNow.x, npcNow.z + 4);
    const reissued = updateInteraction(
      state,
      stalledPositions(playerNow, npcNow),
      index(),
      "player",
      APPROACH_REISSUE_INTERVAL_MS,
    );

    expect(reissued.kind).toBe("approach");
    if (reissued.kind !== "approach") {
      return;
    }
    expect(reissued.target.z).toBeCloseTo(npcNow.z + DEFAULT_DIALOGUE_RANGE, 6);
    expect(reissued.target.x).toBeCloseTo(npcNow.x, 6);
  });

  it("接近超时后放弃这次交互并回到空闲（不再无限重发）", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), farPlayer(), NPC_POSITION);
    const far = stalledPositions(position(NPC_POSITION.x, NPC_POSITION.z - 9));

    let last: string = state.phase;
    for (let elapsed = 0; elapsed < APPROACH_TIMEOUT_MS; elapsed += 500) {
      last = updateInteraction(state, far, index(), "player", 500).kind;
    }
    expect(state.phase).toBe("idle");
    expect(state.npcId).toBeNull();
    expect(last).toBe("none");
  });

  it("NPC 冻结请求覆盖 approaching 与 ready（对话开始本来就冻结）", () => {
    const state = createInteractionState();

    selectNpc(state, NPC_ID, index(), farPlayer(), NPC_POSITION);
    expect(npcHoldFor(state)).toEqual({ npcId: NPC_ID, active: true });

    selectNpc(state, NPC_ID, index(), nearPlayer(), NPC_POSITION);
    expect(npcHoldFor(state)).toEqual({ npcId: NPC_ID, active: true });

    activateBubble(state, positions(nearPlayer()), index());
    // 对话阶段由会话自己的对话冻结负责，不重复要求。
    expect(npcHoldFor(state)).toBeNull();
  });

  it("接近超时/放弃后释放 NPC 冻结", () => {
    const state = createInteractionState();
    selectNpc(state, NPC_ID, index(), farPlayer(), NPC_POSITION);
    expect(npcHoldFor(state)).not.toBeNull();

    updateInteraction(
      state,
      stalledPositions(farPlayer()),
      index(),
      "player",
      APPROACH_TIMEOUT_MS,
    );

    expect(npcHoldFor(state)).toBeNull();
  });
});
