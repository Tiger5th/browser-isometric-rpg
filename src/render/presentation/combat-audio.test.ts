/**
 * 战斗音效：事件 → 音效映射与首次交互解锁（票 27）。
 *
 * 只测零依赖的映射与队列语义（浏览器自动播放策略不做自动化断言）。
 */

import { describe, expect, it } from "vitest";

import {
  CombatAudio,
  combatSoundUrl,
  soundForEvent,
  type AudioBufferLike,
  type AudioContextLike,
  type GainNodeLike,
  type AudioBufferSourceNodeLike,
} from "./combat-audio";

function fakeBuffer(duration = 0.5): AudioBufferLike {
  return { duration };
}

function fakeContext(): AudioContextLike & { played: string[] } {
  const played: string[] = [];
  const context: AudioContextLike & { played: string[] } = {
    played,
    currentTime: 0,
    state: "running",
    destination: {},
    async resume() {},
    createGain(): GainNodeLike {
      return {
        gain: {
          value: 1,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    },
    createBufferSource(): AudioBufferSourceNodeLike {
      return {
        buffer: null,
        playbackRate: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      };
    },
    async decodeAudioData() {
      return fakeBuffer();
    },
  };
  return context;
}

function createAudio(overrides: { context?: AudioContextLike } = {}) {
  const context = overrides.context ?? fakeContext();
  const audio = new CombatAudio({
    createContext: () => context,
    loadSound: async () => new ArrayBuffer(8),
    minIntervalMs: 0,
  });
  return { audio, context };
}

describe("soundForEvent：事件到音效的映射", () => {
  it("普攻/重击/受击映射到不同音效", () => {
    expect(soundForEvent("damage-dealt:light")).toBe("attack_hit");
    expect(soundForEvent("damage-dealt:heavy")).toBe("heavy_attack");
    expect(soundForEvent("damage-dealt:incoming")).toBe("hurt");
  });

  it("击杀/拾取/升级/UI/前摇各有音效", () => {
    expect(soundForEvent("enemy-killed")).toBe("enemy_die");
    expect(soundForEvent("item-gained")).toBe("item_pickup");
    expect(soundForEvent("player-level-up")).toBe("level_up");
    expect(soundForEvent("ui-click")).toBe("ui_click");
    expect(soundForEvent("attack-windup")).toBe("wind_up");
  });

  it("全部音效都落在 assets/audio/ 下", () => {
    for (const name of [
      "attack_hit",
      "hurt",
      "enemy_die",
      "item_pickup",
      "level_up",
      "ui_click",
      "heavy_attack",
      "wind_up",
    ] as const) {
      // Vite 把音频打包成带 hash 的 URL；只断言文件名与目录归属。
      expect(combatSoundUrl(name)).toMatch(
        new RegExp(`/assets/audio/${name}(-[\\w-]+)?\\.wav$`),
      );
    }
  });
});

describe("CombatAudio 首次交互解锁", () => {
  it("未解锁前播放请求静默入队，解锁后补发", async () => {
    const { audio } = createAudio();
    expect(audio.isUnlocked).toBe(false);

    audio.handleEvent({ type: "damage-dealt", heavy: false, incoming: false });
    audio.handleEvent({ type: "enemy-killed" });

    await audio.unlock();
    expect(audio.isUnlocked).toBe(true);
  });

  it("解锁后重复 unlock 不重复启动上下文", async () => {
    let created = 0;
    const audio = new CombatAudio({
      createContext: () => {
        created += 1;
        return fakeContext();
      },
      loadSound: async () => new ArrayBuffer(8),
    });

    await audio.unlock();
    await audio.unlock();

    expect(created).toBe(1);
  });

  it("未知事件不产生播放请求", async () => {
    const { audio } = createAudio();
    audio.handleEvent({ type: "quest-completed" });
    await audio.unlock();
    // 没有崩溃即可；映射为空时内部直接返回。
    expect(audio.isUnlocked).toBe(true);
  });

  it("音效文件缺失时预加载不抛错", async () => {
    const audio = new CombatAudio({
      createContext: () => fakeContext(),
      loadSound: async () => {
        throw new Error("404");
      },
    });
    await audio.preloadAll();
    await audio.unlock();
    expect(audio.isUnlocked).toBe(true);
  });
});
