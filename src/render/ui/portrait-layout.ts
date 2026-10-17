/**
 * galgame 立绘布局（票 29）：纯计算，零 DOM/引擎依赖。
 *
 * 规格（specs/p2-gameplay.md 用户故事 26/27）：
 * - 对话时屏幕两侧立起全屏立绘：NPC 左、玩家右（固定，与说话方无关）；
 * - 说话方亮、听话方微暗；
 * - 对话框与名牌用角色主色（主色由色板卡提供，这里只排布）。
 *
 * DOM 呈现（半透明深底/主色边/名牌）在 dialogue-portrait.ts；本模块
 * 只回答「谁在哪一侧、谁该多亮、镜头参数是多少」。
 */

/** 立绘缩放与锚点：两侧完全一致，保证构图对称。 */
export const PORTRAIT_SCALE = 1;
export const PORTRAIT_ANCHOR_Y = 0;

/** 听话方的亮度（微暗但仍可看清表情）。 */
export const LISTENER_BRIGHTNESS = 0.55;
export const SPEAKER_BRIGHTNESS = 1;

/** 对话镜头：推近后的相机可视高度（场景常规 30）。 */
export const DIALOGUE_ZOOM_SPAN = 22;
/** 对话期间背景压暗强度（仅表现层）。 */
export const DIALOGUE_DIM_STRENGTH = 0.35;
/** 推近/恢复的过渡时长（毫秒）。 */
export const DIALOGUE_ZOOM_DURATION_MS = 350;

export interface PortraitSpeaker {
  id: string;
  displayName: string;
  side: "left" | "right";
  /** 是否有立绘资源；缺省时 UI 用程序化色块占位。 */
  hasPortrait: boolean;
}

export interface SpeakerVisual extends PortraitSpeaker {
  speaking: boolean;
  brightness: number;
  scale: number;
  anchorY: number;
}

/**
 * 固定站位：NPS 左、玩家右。调用方负责传对 side，
 * 本函数只按说话方分配亮度，不改动站位。
 */
export function resolveSpeakers(
  npc: PortraitSpeaker,
  player: PortraitSpeaker,
): [PortraitSpeaker, PortraitSpeaker] {
  return [npc, player];
}

export function portraitLayout(
  speakers: readonly PortraitSpeaker[],
  activeSpeakerId: string | null,
): SpeakerVisual[] {
  return speakers.map((speaker) => ({
    ...speaker,
    speaking: speaker.id === activeSpeakerId,
    brightness: speaker.id === activeSpeakerId ? SPEAKER_BRIGHTNESS : LISTENER_BRIGHTNESS,
    scale: PORTRAIT_SCALE,
    anchorY: PORTRAIT_ANCHOR_Y,
  }));
}

/**
 * 对话镜头的相机可视高度。
 * progress 0 = 常规全景（baseSpan），1 = 完全推近；超出范围会被夹紧，
 * 便于过渡动画直接传入未归一化的时间比例。
 */
export function dialogueZoomSpan(baseSpan: number, progress = 1): number {
  const clamped = Math.min(1, Math.max(0, progress));
  const zoomed = Number.isFinite(baseSpan) && baseSpan > 0 ? baseSpan : DIALOGUE_ZOOM_SPAN;
  return zoomed + (DIALOGUE_ZOOM_SPAN - zoomed) * clamped;
}

/** 背景压暗强度；对话结束后回 0 由调用方按进度插值。 */
export function dialogueDimStrength(progress = 1): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return DIALOGUE_DIM_STRENGTH * clamped;
}
