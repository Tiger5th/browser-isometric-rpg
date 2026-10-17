import { describe, expect, it } from "vitest";

import { createEntity, type Entity } from "./entity";
import { GameSession } from "./game-session";

function makePlayer(position = { x: 0, y: 0, z: 0 }): Entity {
  return createEntity({
    id: "entity:player",
    type: "player",
    templateId: "hero",
    displayName: "主角",
    position,
  });
}

function createSession(player: Entity = makePlayer()): GameSession {
  const session = new GameSession();
  session.addEntity(player);
  return session;
}

function playerOf(session: GameSession) {
  const player = session.snapshot().entities.find((entity) => entity.id === "entity:player");
  if (!player) {
    throw new Error("快照中缺少玩家实体");
  }
  return player;
}

describe("GameSession 移动意图", () => {
  it("moveTo 后手动推进时钟，位置朝目标变化并反映在快照里", () => {
    const session = createSession();

    session.moveTo("entity:player", { x: 10, y: 0, z: 0 });
    session.advance(1000);

    expect(playerOf(session).position.x).toBeCloseTo(5.5);
    expect(playerOf(session).position.z).toBeCloseTo(0);
  });

  it("推进足够时间后精确到达目标并清除移动意图", () => {
    const session = createSession();

    session.moveTo("entity:player", { x: 3, y: 0, z: 4 });
    session.advance(2000);

    const player = playerOf(session);
    expect(player.position).toEqual({ x: 3, y: 0, z: 4 });
    expect(player.movement).toBeNull();
  });

  it("快照可 JSON 序列化，且修改返回的快照不会穿透逻辑状态", () => {
    const session = createSession();
    session.moveTo("entity:player", { x: 10, y: 0, z: 0 });
    session.advance(500);

    const snapshot = session.snapshot();
    expect(JSON.parse(session.serialize())).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    snapshot.entities[0].position.x = 999;
    snapshot.entities[0].movement!.target.x = 999;

    expect(playerOf(session).position.x).toBeCloseTo(2.75);
    expect(playerOf(session).movement?.target.x).toBe(10);
  });

  it("游戏时钟独立于移动累计推进", () => {
    const session = createSession();

    session.advance(250);
    session.advance(250);

    expect(session.snapshot().elapsedMs).toBe(500);
  });

  it("新的 moveTo 替换尚未完成的旧目标", () => {
    const session = createSession();
    session.moveTo("entity:player", { x: 10, y: 0, z: 0 });
    session.advance(1000);

    session.moveTo("entity:player", { x: 5.5, y: 0, z: 6 });
    session.advance(1000);

    expect(playerOf(session).position.x).toBeCloseTo(5.5);
    expect(playerOf(session).position.z).toBeCloseTo(5.5);
  });

  it("未知实体、重复注册与非法时间步进会显式报错", () => {
    const session = createSession();

    expect(() => session.moveTo("entity:missing", { x: 0, y: 0, z: 0 })).toThrow();
    expect(() => session.addEntity(makePlayer())).toThrow();
    expect(() => session.advance(-1)).toThrow();
    expect(() => session.advance(Number.NaN)).toThrow();
    expect(() => session.moveTo("entity:player", { x: Number.NaN, y: 0, z: 0 })).toThrow();
  });
});
