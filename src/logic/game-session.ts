/**
 * GameSession：游戏逻辑核心。
 *
 * 单一时钟 + 实体集合；渲染层只允许读取 snapshot() 并提交意图，
 * 不得直接访问或修改实体。本模块零引擎依赖，可在 vitest 中手动推进时间。
 */

import {
  cloneEntity,
  type Entity,
  type EntityId,
  type EntityIdentity,
  type Vec3,
} from "./entity";

/** 与 Crowd V2 的 maxSpeed 对齐，逻辑与表现的速度感一致。 */
export const DEFAULT_MOVE_SPEED = 5.5;
export const GAME_SESSION_SNAPSHOT_VERSION = 1;

/** 渲染层可提交的意图集合；后续按票逐步扩展 attack/talk/useItem 等。 */
export interface GameSessionIntents {
  moveTo(entityId: EntityId | string, target: Vec3): void;
}

export interface EntityMovementSnapshot {
  target: Vec3;
  speed: number;
}

export interface EntitySnapshot {
  id: EntityId;
  identity: EntityIdentity;
  position: Vec3;
  rotation: Vec3;
  tags: string[];
  /** 当前移动意图；null 表示静止。 */
  movement: EntityMovementSnapshot | null;
}

/** 可 JSON 序列化的完整游戏状态。 */
export interface GameSessionSnapshot {
  version: number;
  elapsedMs: number;
  entities: EntitySnapshot[];
}

interface Movement {
  target: Vec3;
  speed: number;
}

function assertFiniteVec3(value: Vec3, label: string): void {
  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isFinite(value[axis])) {
      throw new Error(`${label} 的 ${axis} 必须是有限数值`);
    }
  }
}

function cloneVec3(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

export class GameSession implements GameSessionIntents {
  /** 以 EntityId 为键；值本身也不对外暴露，避免渲染层绕过意图直接修改。 */
  private readonly entities = new Map<EntityId, Entity>();
  private readonly movements = new Map<EntityId, Movement>();
  private elapsedMs = 0;

  /** 注册实体。实体在入会话时深拷贝，调用方后续修改不会穿透逻辑状态。 */
  addEntity(entity: Entity): void {
    if (this.entities.has(entity.id)) {
      throw new Error(`实体已存在：${entity.id}`);
    }
    this.entities.set(entity.id, cloneEntity(entity));
  }

  /** 提交移动到目标点的意图；重复提交会替换当前移动。 */
  moveTo(entityId: EntityId | string, target: Vec3): void {
    const id = entityId as EntityId;
    const entity = this.entities.get(id);
    if (!entity) {
      throw new Error(`未知实体：${entityId}`);
    }
    assertFiniteVec3(target, "移动目标");
    this.movements.set(id, { target: cloneVec3(target), speed: DEFAULT_MOVE_SPEED });
  }

  /** 手动推进游戏时钟（毫秒）。deltaMs 必须是非负有限值。 */
  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new Error("advance 的 deltaMs 必须是非负有限数值");
    }
    this.elapsedMs += deltaMs;

    for (const [id, movement] of this.movements) {
      const entity = this.entities.get(id);
      if (!entity) {
        this.movements.delete(id);
        continue;
      }

      const { position } = entity.state;
      const dx = movement.target.x - position.x;
      const dz = movement.target.z - position.z;
      const distance = Math.hypot(dx, dz);
      const step = (movement.speed * deltaMs) / 1000;

      if (distance <= step || distance === 0) {
        position.x = movement.target.x;
        position.y = movement.target.y;
        position.z = movement.target.z;
        this.movements.delete(id);
        continue;
      }

      position.x += (dx / distance) * step;
      position.z += (dz / distance) * step;
      // 与 Crowd V2 的视觉朝向约定一致（+Z 为 0，朝 +X 为 π/2）。
      entity.state.rotation.y = Math.atan2(dx, dz);
    }
  }

  /** 只读快照：每次调用都返回新对象，渲染层无法借此修改内部状态。 */
  snapshot(): GameSessionSnapshot {
    const entities: EntitySnapshot[] = [...this.entities.values()]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((entity) => {
        const movement = this.movements.get(entity.id);
        return {
          id: entity.id,
          identity: { ...entity.identity },
          position: cloneVec3(entity.state.position),
          rotation: cloneVec3(entity.state.rotation),
          tags: [...entity.state.tags],
          movement: movement
            ? { target: cloneVec3(movement.target), speed: movement.speed }
            : null,
        };
      });

    return {
      version: GAME_SESSION_SNAPSHOT_VERSION,
      elapsedMs: this.elapsedMs,
      entities,
    };
  }

  /** 快照的 JSON 表示（存档/测试共用）。 */
  serialize(): string {
    return JSON.stringify(this.snapshot());
  }
}
