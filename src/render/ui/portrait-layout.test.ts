import { describe, expect, it } from "vitest";

import {
  DIALOGUE_DIM_STRENGTH,
  DIALOGUE_ZOOM_SPAN,
  dialogueDimStrength,
  dialogueZoomSpan,
  type PortraitSpeaker,
  portraitLayout,
  resolveSpeakers,
  type SpeakerVisual,
} from "./portrait-layout";

function speaker(id: string, side: "left" | "right", name: string): PortraitSpeaker {
  return { id, displayName: name, side, hasPortrait: true };
}

describe("galgame 立绘布局", () => {
  it("NPC 站左侧、玩家站右侧，与谁在说话无关", () => {
    const speakers = resolveSpeakers(
      speaker("npc:elder_ma", "left", "马婆婆"),
      speaker("entity:player", "right", "旅人"),
    );

    const npcSpeaking = portraitLayout(speakers, "npc:elder_ma");
    expect(npcSpeaking).toHaveLength(2);
    expect(npcSpeaking[0]).toMatchObject({ id: "npc:elder_ma", side: "left" });
    expect(npcSpeaking[1]).toMatchObject({ id: "entity:player", side: "right" });
  });

  it("说话方全亮、听话方压暗", () => {
    const speakers = resolveSpeakers(
      speaker("npc:elder_ma", "left", "马婆婆"),
      speaker("entity:player", "right", "旅人"),
    );

    const [npc, player] = portraitLayout(speakers, "npc:elder_ma") as SpeakerVisual[];
    expect(npc.brightness).toBe(1);
    expect(npc.speaking).toBe(true);
    expect(player.brightness).toBeLessThan(1);
    expect(player.brightness).toBeGreaterThan(0);
    expect(player.speaking).toBe(false);
  });

  it("说话方切换后亮暗关系互换", () => {
    const speakers = resolveSpeakers(
      speaker("npc:elder_ma", "left", "马婆婆"),
      speaker("entity:player", "right", "旅人"),
    );

    const [npc, player] = portraitLayout(speakers, "entity:player") as SpeakerVisual[];
    expect(player.brightness).toBe(1);
    expect(npc.brightness).toBeLessThan(1);
  });

  it("两侧立绘同源同尺寸：只有亮度与锚点不同", () => {
    const speakers = resolveSpeakers(
      speaker("npc:elder_ma", "left", "马婆婆"),
      speaker("entity:player", "right", "旅人"),
    );

    const [npc, player] = portraitLayout(speakers, "npc:elder_ma") as SpeakerVisual[];
    expect(npc.scale).toBe(player.scale);
    expect(npc.anchorY).toBe(player.anchorY);
  });

  it("没有立绘资源的一方退化为程序化色块（仍有主色可渲染）", () => {
    const speakers = resolveSpeakers(
      { ...speaker("npc:elder_ma", "left", "马婆婆"), hasPortrait: false },
      speaker("entity:player", "right", "旅人"),
    );

    const [npc] = portraitLayout(speakers, "npc:elder_ma") as SpeakerVisual[];
    expect(npc.hasPortrait).toBe(false);
  });
});

describe("对话镜头（仅表现层参数）", () => {
  it("推近：对话期间相机可视高度小于常规全景", () => {
    const zoomed = dialogueZoomSpan(30);
    expect(zoomed).toBe(DIALOGUE_ZOOM_SPAN);
    expect(zoomed).toBeLessThan(30);
  });

  it("压暗强度在 0–1 之间且为常量", () => {
    expect(dialogueDimStrength()).toBe(DIALOGUE_DIM_STRENGTH);
    expect(DIALOGUE_DIM_STRENGTH).toBeGreaterThan(0);
    expect(DIALOGUE_DIM_STRENGTH).toBeLessThan(1);
  });

  it("缩放进度可按归一化时间插值，两端收敛到原值/目标值", () => {
    expect(dialogueZoomSpan(30, 0)).toBe(30);
    expect(dialogueZoomSpan(30, 1)).toBe(DIALOGUE_ZOOM_SPAN);
    const middle = dialogueZoomSpan(30, 0.5);
    expect(middle).toBeGreaterThan(DIALOGUE_ZOOM_SPAN);
    expect(middle).toBeLessThan(30);
  });
});
