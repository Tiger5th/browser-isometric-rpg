/**
 * 战斗反馈层：GameSession 一等事件 → DOM 视听信号（票 27）。
 *
 * 定义（GLOSSARY「反馈层」）：只消费订阅事件，把结算事实转译为飘字/血条/
 * 目标圈/受击闪红/顿帧/震屏。不读会话内部状态、不写回逻辑状态。
 *
 * 实现选择：
 * - 飘字/血条/目标圈用 DOM 覆盖层，每帧把世界坐标投影到屏幕；与既有 HUD
 *   （quest-loop-ui）同一套技术，不引入 Babylon GUI 依赖；
 * - 顿帧 = 请求削减本帧 delta（返回实际应推进的时间），不改逻辑时钟语义；
 * - 震屏 = 相机 alpha 的临时偏移，帧末还原，保持正交等距基准角度；
 * - 只在事件发生时创建节点、过期即回收，稳态零分配（L5 预算不回归）。
 */

import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Scene } from "@babylonjs/core/scene";

import type { GameSession } from "../../logic/game-session";
import type { GameSessionEvent } from "../../logic/game-events";
import {
  CombatFeedbackCore,
  DAMAGE_FEED_RISE_MS,
  HIT_STOP_MS,
  SHAKE_INTENSITY,
  type DamageFeedEntry,
} from "./combat-feedback-core";
import type { CombatAudio } from "./combat-audio";

export interface CombatFeedbackLayerOptions {
  /** DOM 挂载点（与 HUD 同级；本层自身 pointer-events:none）。 */
  mount: HTMLElement;
  /** 音效播放器；缺省表示静音（测试/无音频环境）。 */
  audio?: CombatAudio;
  /** 物品 id → 显示名（拾取飘字用）；缺省回落到 itemId。 */
  resolveItemName?: (itemId: string) => string;
}

interface FloatingNumber {
  node: HTMLElement;
  bornAt: number;
  ttl: number;
  feedId: number;
}

interface HealthBar {
  node: HTMLElement;
  fill: HTMLElement;
}

export interface CombatFeedbackDebugState {
  activeNumbers: number;
  activeBars: number;
  activeWindups: number;
  hitStopRemainingMs: number;
  shakeRemainingMs: number;
  flashOpacity: number;
}

export interface CombatFeedbackLayer {
  /**
   * 每帧调用。deltaMs 是逻辑层本帧想推进的时间；返回实际应推进的时间
   * （顿帧会削减）。nowMs 用同一时钟（performance.now）。
   */
  update(scene: Scene, deltaMs: number, nowMs: number): number;
  /** 玩家选中/取消选中目标：目标圈常显的来源。 */
  setSelected(entityId: string | null): void;
  /** 登记实体的世界锚点（mesh）与头顶高度，供投影用。 */
  trackEntity(entityId: string, mesh: { absolutePosition: Vector3 } | null, headHeight: number): void;
  /** 首次用户交互时解锁音效。 */
  unlockAudio(): Promise<void>;
  /** UI/前摇音效入口。 */
  playUiSound(kind: "ui-click" | "attack-windup", rate?: number): void;
  /** 调试/冒烟读取。 */
  debugState(): CombatFeedbackDebugState;
  dispose(): void;
}

const NUMBER_STYLE_BASE = [
  "position:absolute;pointer-events:none;font-weight:800",
  "text-shadow:0 2px 6px rgba(0,0,0,0.85);white-space:nowrap",
  "will-change:transform,opacity",
].join(";");

const BAR_STYLE = [
  "position:absolute;width:54px;height:6px;border-radius:999px;overflow:hidden",
  "background:rgba(15,23,42,0.72);border:1px solid rgba(148,163,184,0.45)",
].join(";");

const RING_STYLE = [
  "position:absolute;width:28px;height:28px;border-radius:999px",
  "border:2px solid rgba(74,222,128,0.9)",
].join(";");

const FLASH_STYLE =
  "position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity 90ms linear;" +
  "background:radial-gradient(ellipse at center, rgba(239,68,68,0) 45%, rgba(239,68,68,0.55) 100%);";

const PLAYER_ID_PREFIX = "entity:player";

/** 世界坐标 → 屏幕 CSS 像素；相机缺失时返回 null。 */
function projectToScreen(
  scene: Scene,
  x: number,
  y: number,
  z: number,
): { x: number; y: number } | null {
  const camera: Camera | null = scene.activeCamera;
  if (!camera) {
    return null;
  }
  const engine: AbstractEngine = scene.getEngine();
  const viewport = camera.viewport.toGlobal(
    engine.getRenderWidth(),
    engine.getRenderHeight(),
  );
  const projected = Vector3.Project(
    new Vector3(x, y, z),
    Matrix.Identity(),
    scene.getTransformMatrix(),
    viewport,
  );
  // 渲染尺寸与 CSS 尺寸可能不同（动态分辨率/hardware scaling），换算成 CSS 像素。
  const canvas = engine.getRenderingCanvas();
  const cssWidth = canvas?.clientWidth ?? engine.getRenderWidth();
  const cssHeight = canvas?.clientHeight ?? engine.getRenderHeight();
  const scaleX = cssWidth / Math.max(1, viewport.width);
  const scaleY = cssHeight / Math.max(1, viewport.height);
  return { x: projected.x * scaleX, y: projected.y * scaleY };
}

export function createCombatFeedbackLayer(
  session: GameSession,
  options: CombatFeedbackLayerOptions,
): CombatFeedbackLayer {
  const core = new CombatFeedbackCore();
  const audio = options.audio;

  const root = document.createElement("div");
  root.dataset.testid = "combat-feedback-layer";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9;overflow:hidden;";
  options.mount.append(root);

  const flash = document.createElement("div");
  flash.dataset.testid = "player-hurt-flash";
  flash.style.cssText = FLASH_STYLE;
  root.append(flash);

  const numbers: FloatingNumber[] = [];
  /** 拾取/升级等非伤害飘字。 */
  const texts: FloatingNumber[] = [];
  /** 前摇提示（抬手/变色圈），按攻击者锚定。 */
  const windups: Array<{ node: HTMLElement; attackerId: string; until: number }> = [];
  const bars = new Map<string, HealthBar>();
  const rings = new Map<string, HTMLElement>();
  const anchors = new Map<string, { mesh: { absolutePosition: Vector3 }; head: number }>();

  let selectedId: string | null = null;
  let hitStopRemainingMs = 0;
  let shakeRemainingMs = 0;
  let shakeIntensity = 0;
  let flashRemainingMs = 0;
  let levelFlashRemainingMs = 0;
  const levelFlash = document.createElement("div");
  levelFlash.dataset.testid = "level-up-flash";
  levelFlash.style.cssText =
    "position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity 160ms ease-out;" +
    "background:radial-gradient(ellipse at center, rgba(253,224,71,0.55) 0%, rgba(253,224,71,0.12) 45%, rgba(253,224,71,0) 75%);";
  root.append(levelFlash);

  // ---- 事件订阅：反馈层的唯一输入 ----
  const unsubscribe = session.subscribe((event: GameSessionEvent) => {
    if (event.type === "damage-dealt") {
      const incoming = event.targetId.startsWith(PLAYER_ID_PREFIX);
      // 会话时钟与表现时钟不同源：飘字生命周期一律用 performance.now。
      core.onDamage({
        targetId: event.targetId,
        amount: event.amount,
        targetHp: event.targetHp,
        targetMaxHp: event.targetMaxHp,
        heavy: event.heavy,
        incoming,
        at: performance.now(),
      });
      hitStopRemainingMs = Math.max(
        hitStopRemainingMs,
        event.heavy ? HIT_STOP_MS.heavy : HIT_STOP_MS.normal,
      );
      shakeRemainingMs = Math.max(shakeRemainingMs, event.heavy ? 220 : 120);
      shakeIntensity = Math.max(
        shakeIntensity,
        event.heavy ? SHAKE_INTENSITY.heavy : SHAKE_INTENSITY.normal,
      );
      if (incoming) {
        flashRemainingMs = 260;
      }
      audio?.handleEvent(event);
      return;
    }
    if (event.type === "health-changed") {
      core.onHealth({ entityId: event.entityId, hp: event.hp, maxHp: event.maxHp, at: 0 });
      return;
    }
    if (event.type === "enemy-killed") {
      audio?.handleEvent(event);
      core.forget(event.enemyId);
      releaseBar(event.enemyId);
      return;
    }
    if (event.type === "attack-windup-started") {
      audio?.handleEvent(event);
      showWindup(event.attackerId, event.durationMs, event.heavy);
      return;
    }
    if (event.type === "item-gained") {
      audio?.handleEvent(event);
      const name = options.resolveItemName?.(event.itemId) ?? event.itemId;
      spawnText(
        event.entityId,
        `${name} ×${event.quantity}`,
        "#86efac",
        18,
        performance.now(),
        1300,
      );
      return;
    }
    if (event.type === "player-level-up") {
      audio?.handleEvent(event);
      // 升级金光时刻：全屏金色脉冲 + 玩家头顶文字。
      levelFlashRemainingMs = 900;
      spawnText(
        event.entityId,
        event.level === null ? "LEVEL UP" : `LEVEL ${event.level}`,
        "#fde047",
        28,
        performance.now(),
        1600,
      );
    }
  });

  function releaseBar(entityId: string): void {
    bars.get(entityId)?.node.remove();
    bars.delete(entityId);
    rings.get(entityId)?.remove();
    rings.delete(entityId);
  }

  function ensureBar(entityId: string): HealthBar {
    const existing = bars.get(entityId);
    if (existing) {
      return existing;
    }
    const node = document.createElement("div");
    node.dataset.testid = "enemy-health-bar";
    node.dataset.entityId = entityId;
    node.style.cssText = BAR_STYLE;
    const fill = document.createElement("div");
    fill.dataset.testid = "enemy-health-bar-fill";
    fill.style.cssText =
      "height:100%;width:100%;border-radius:999px;" +
      "background:linear-gradient(90deg,#ef4444,#f59e0b);transition:width 90ms linear;";
    node.append(fill);
    root.append(node);
    const bar: HealthBar = { node, fill };
    bars.set(entityId, bar);

    const ring = document.createElement("div");
    ring.dataset.testid = "target-ring";
    ring.dataset.entityId = entityId;
    ring.style.cssText = RING_STYLE;
    ring.style.opacity = "0";
    root.append(ring);
    rings.set(entityId, ring);
    return bar;
  }

  function spawnText(
    entityId: string,
    text: string,
    color: string,
    size: number,
    nowMs: number,
    ttl: number,
  ): void {
    const node = document.createElement("div");
    node.dataset.testid = "feedback-text";
    node.dataset.entityId = entityId;
    node.textContent = text;
    node.style.cssText =
      `${NUMBER_STYLE_BASE};color:${color};font-size:${size}px;` +
      "transform:translate(-50%,-50%);opacity:1;";
    root.append(node);
    texts.push({ node, bornAt: nowMs, ttl, feedId: -1 });
  }

  function showWindup(attackerId: string, durationMs: number, heavy: boolean): void {
    const node = document.createElement("div");
    node.dataset.testid = "attack-windup-telegraph";
    node.dataset.attackerId = attackerId;
    node.dataset.heavy = heavy ? "true" : "false";
    const color = heavy ? "rgba(251,146,60,0.95)" : "rgba(253,224,71,0.9)";
    node.style.cssText =
      "position:absolute;width:44px;height:44px;border-radius:999px;pointer-events:none;" +
      `border:2px solid ${color};box-shadow:0 0 12px ${color};` +
      "transform:translate(-50%,-50%) scale(0.6);opacity:0.9;" +
      `transition:transform ${Math.round(durationMs)}ms ease-in, opacity ${Math.round(durationMs)}ms ease-in;`;
    root.append(node);
    // 下一帧放大 → 前摇结束刚好收满（抬手感）。
    requestAnimationFrame(() => {
      node.style.transform = "translate(-50%,-50%) scale(1.25)";
      node.style.opacity = "0.35";
    });
    windups.push({ node, attackerId, until: performance.now() + durationMs });
  }

  function createNumberNode(entry: DamageFeedEntry, feedId: number): FloatingNumber {
    const node = document.createElement("div");
    node.dataset.testid = "damage-number";
    node.dataset.feedId = String(feedId);
    node.dataset.entityId = entry.targetId;
    node.dataset.incoming = entry.incoming ? "true" : "false";
    node.dataset.heavy = entry.heavy ? "true" : "false";
    node.dataset.amount = String(entry.amount);
    node.textContent = entry.incoming ? `-${entry.amount}` : String(entry.amount);
    const color = entry.incoming ? "#fca5a5" : entry.heavy ? "#fde047" : "#fef9c3";
    const size = entry.heavy ? 30 : entry.incoming ? 22 : 19;
    node.style.cssText =
      `${NUMBER_STYLE_BASE};color:${color};font-size:${size}px;` +
      `transform:translate(-50%,-50%) scale(${entry.heavy ? 1.35 : 1});`;
    root.append(node);
    return { node, bornAt: entry.at, ttl: DAMAGE_FEED_RISE_MS, feedId };
  }

  return {
    update(scene, deltaMs, nowMs) {
      // 顿帧：命中瞬间冻结逻辑推进（表现层时间膨胀），最多冻一帧的量。
      let effectiveDelta = deltaMs;
      if (hitStopRemainingMs > 0) {
        const frozen = Math.min(hitStopRemainingMs, deltaMs);
        hitStopRemainingMs -= frozen;
        effectiveDelta = deltaMs - frozen;
      }

      const view = core.view(nowMs);

      // 飘字：新事件建节点；过期/被回收的摘掉。
      const live = new Set<number>();
      for (const entry of view.damage) {
        live.add(entry.id);
        if (!numbers.some((item) => item.feedId === entry.id)) {
          numbers.push(createNumberNode(entry, entry.id));
        }
      }
      for (let index = numbers.length - 1; index >= 0; index -= 1) {
        const item = numbers[index];
        if (!live.has(item.feedId)) {
          item.node.remove();
          numbers.splice(index, 1);
          continue;
        }
        const age = nowMs - item.bornAt;
        if (age > item.ttl) {
          item.node.remove();
          numbers.splice(index, 1);
          continue;
        }
        const progress = Math.max(0, Math.min(1, age / item.ttl));
        const anchor = anchors.get(item.node.dataset.entityId ?? "");
        const point = anchor
          ? projectToScreen(
              scene,
              anchor.mesh.absolutePosition.x,
              anchor.mesh.absolutePosition.y + anchor.head,
              anchor.mesh.absolutePosition.z,
            )
          : null;
        if (point) {
          item.node.style.left = `${point.x}px`;
          item.node.style.top = `${point.y - progress * 46}px`;
        }
        item.node.style.opacity = String(Math.max(0, 1 - progress * progress));
      }

      // 拾取/升级等飘字。
      for (let index = texts.length - 1; index >= 0; index -= 1) {
        const item = texts[index];
        const age = nowMs - item.bornAt;
        if (age > item.ttl) {
          item.node.remove();
          texts.splice(index, 1);
          continue;
        }
        const progress = Math.max(0, Math.min(1, age / item.ttl));
        const anchor = anchors.get(item.node.dataset.entityId ?? "");
        const point = anchor
          ? projectToScreen(
              scene,
              anchor.mesh.absolutePosition.x,
              anchor.mesh.absolutePosition.y + anchor.head,
              anchor.mesh.absolutePosition.z,
            )
          : null;
        if (point) {
          item.node.style.left = `${point.x}px`;
          item.node.style.top = `${point.y - progress * 40}px`;
        }
        item.node.style.opacity = String(Math.max(0, 1 - progress));
      }

      // 前摇提示：跟随攻击者，时间到即回收。
      for (let index = windups.length - 1; index >= 0; index -= 1) {
        const windup = windups[index];
        if (nowMs >= windup.until) {
          windup.node.remove();
          windups.splice(index, 1);
          continue;
        }
        const anchor = anchors.get(windup.attackerId);
        const point = anchor
          ? projectToScreen(
              scene,
              anchor.mesh.absolutePosition.x,
              anchor.mesh.absolutePosition.y + anchor.head * 0.5,
              anchor.mesh.absolutePosition.z,
            )
          : null;
        if (point) {
          windup.node.style.left = `${point.x}px`;
          windup.node.style.top = `${point.y}px`;
        }
      }

      // 升级金光时刻。
      if (levelFlashRemainingMs > 0) {
        levelFlashRemainingMs = Math.max(0, levelFlashRemainingMs - deltaMs);
        levelFlash.style.opacity = String(Math.min(1, levelFlashRemainingMs / 900));
      } else if (levelFlash.style.opacity !== "0") {
        levelFlash.style.opacity = "0";
      }

      // 敌人血条 + 目标圈。玩家血条归 HUD（quest-loop-ui），这里不重复渲染。
      const enemyFrames = view.frames.filter(
        (frame) => !frame.targetId.startsWith(PLAYER_ID_PREFIX),
      );
      const active = new Set(enemyFrames.map((frame) => frame.targetId));
      for (const entityId of [...bars.keys()]) {
        if (!active.has(entityId)) {
          releaseBar(entityId);
        }
      }
      for (const frame of enemyFrames) {
        const bar = ensureBar(frame.targetId);
        const anchor = anchors.get(frame.targetId);
        const point = anchor
          ? projectToScreen(
              scene,
              anchor.mesh.absolutePosition.x,
              anchor.mesh.absolutePosition.y + anchor.head + 0.2,
              anchor.mesh.absolutePosition.z,
            )
          : null;
        if (point) {
          bar.node.style.left = `${point.x - 27}px`;
          bar.node.style.top = `${point.y}px`;
        }
        const ratio =
          frame.maxHp > 0 ? Math.max(0, Math.min(1, frame.hp / frame.maxHp)) : 0;
        bar.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
        const ring = rings.get(frame.targetId);
        if (ring) {
          ring.style.opacity = frame.pinned ? "0.95" : "0";
        }
      }

      // 受击闪红（屏幕边缘）。
      if (flashRemainingMs > 0) {
        flashRemainingMs = Math.max(0, flashRemainingMs - deltaMs);
        flash.style.opacity = String(Math.min(0.85, flashRemainingMs / 260));
      } else if (flash.style.opacity !== "0") {
        flash.style.opacity = "0";
      }

      // 震屏：相机 alpha 微偏移（正交等距基准角度由调用方在帧末还原）。
      const camera = scene.activeCamera as
        | (Camera & { alpha?: number })
        | null;
      if (camera && shakeRemainingMs > 0) {
        shakeRemainingMs = Math.max(0, shakeRemainingMs - deltaMs);
        const jitter = (Math.random() - 0.5) * 2 * shakeIntensity;
        camera.alpha = (camera.alpha ?? 0) + jitter;
      } else {
        shakeIntensity = 0;
      }

      return effectiveDelta;
    },

    setSelected(entityId) {
      if (selectedId !== null) {
        core.setPinned(selectedId, false);
      }
      selectedId = entityId;
      if (entityId !== null) {
        core.setPinned(entityId, true);
      }
    },

    trackEntity(entityId, mesh, headHeight) {
      if (mesh === null) {
        anchors.delete(entityId);
        return;
      }
      anchors.set(entityId, { mesh, head: headHeight });
    },

    async unlockAudio() {
      await audio?.unlock();
    },

    playUiSound(kind, rate) {
      audio?.playUi(kind, rate);
    },

    debugState() {
      return {
        activeNumbers: numbers.length,
        activeBars: bars.size,
        activeWindups: windups.length,
        hitStopRemainingMs,
        shakeRemainingMs,
        flashOpacity: Number(flash.style.opacity || "0"),
      };
    },

    dispose() {
      unsubscribe();
      for (const item of numbers) {
        item.node.remove();
      }
      numbers.length = 0;
      for (const item of texts) {
        item.node.remove();
      }
      texts.length = 0;
      for (const windup of windups) {
        windup.node.remove();
      }
      windups.length = 0;
      for (const entityId of [...bars.keys()]) {
        releaseBar(entityId);
      }
      root.remove();
    },
  };
}
