import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

import cullSlimes from "../../../content/quests/cull_slimes.json";
import elderMa from "../../../content/npcs/elder_ma.json";
import healHerb from "../../../content/items/healing_herb.json";
import oldCoin from "../../../content/items/old_coin.json";
import regionGreenHollow from "../../../content/regions/green_hollow.json";
import scoutLin from "../../../content/npcs/scout_lin.json";
import slimeBlue from "../../../content/enemies/slime_blue.json";
import slimeElder from "../../../content/enemies/slime_elder.json";
import slimeGel from "../../../content/items/slime_gel.json";
import slimeMeadow from "../../../content/enemies/slime_meadow.json";
import slimeTemplate from "../../../content/enemy-templates/slime.json";
import travelerSword from "../../../content/items/traveler_sword.json";

import type {
  CombatEvent,
  EntitySnapshot,
  GameSessionSnapshot,
} from "../../logic/game-session";
import { GameSession } from "../../logic/game-session";
import type { ContentBundle } from "../../logic/content/types";
import type { Metric } from "../../logic/report";
import { DEFAULT_CAMERA_VERTICAL_SPAN } from "../camera";
import {
  CHARACTER_ANIMATION_FRAMES,
  createCharacterAnimations,
  createCharacterMaterial,
  createCharacterPrototype,
  createCharacterSkeleton,
} from "../character-proto";
import { attachClickToMove } from "../crowd-utils";
import type { ScenarioContext, ScenarioDefinition } from "../harness";
import { createGroundVisual, setCameraSpan, setGreyboxEnabled } from "../navmesh-scene";
import type { Bounds2D } from "../../logic/navmesh-geometry";

const SCENARIO_NAME = "combat-loop";
const PLAYER_ID = "entity:player";
const ARENA_BOUNDS: Bounds2D = { minX: -24, maxX: 24, minZ: -24, maxZ: 24 };
const CAMERA_VERTICAL_SPAN = 30;
const CLICK_ENEMY_RADIUS = 1.6;
const LUNGE_DURATION_MS = 180;
const FLASH_DURATION_MS = 140;
const DEATH_SINK_MS = 600;
const MEASURE_TIMEOUT_MS = 10_000;

/** 用真实 content 数据构建会话；玩家出生点挪到史莱姆附近，便于演示与 measure。 */
function combatBundle(): ContentBundle {
  return {
    regions: [
      {
        ...regionGreenHollow,
        player: {
          ...regionGreenHollow.player,
          spawn: { position: { x: 9, y: 0, z: -4 } },
        },
      },
    ],
    npcs: [elderMa, scoutLin],
    enemyTemplates: [slimeTemplate],
    enemies: [slimeMeadow, slimeBlue, slimeElder],
    items: [slimeGel, healHerb, oldCoin, travelerSword],
    quests: [cullSlimes],
  } as unknown as ContentBundle;
}

interface ActorView {
  entityId: string;
  mesh: Mesh;
  material: ReturnType<typeof createCharacterMaterial>;
  skeleton: Skeleton;
  baseColor: Color3;
  lungeUntil: number;
  lungeDirection: { x: number; z: number };
  flashUntil: number;
  deadAt: number | null;
  removed: boolean;
}

interface CombatScenarioState {
  root: TransformNode;
  session: GameSession;
  actors: Map<string, ActorView>;
  observer: Observer<Scene> | null;
  detachClick: () => void;
  eventLog: CombatEvent[];
  overlay: HTMLDivElement | null;
  lastFrameAt: number;
}

/** ego-browser 验证入口：只经 snapshot 读取、只经意图写入。 */
export interface P0CombatDebugApi {
  scenario: string;
  getSnapshot(): GameSessionSnapshot;
  getPlayer(): EntitySnapshot | null;
  getEnemies(): EntitySnapshot[];
  attack(entityId: string): void;
  moveTo(x: number, z: number): void;
  stopAttack(): void;
  getEventLog(): CombatEvent[];
}

declare global {
  interface Window {
    P0CombatDebug?: P0CombatDebugApi;
  }
}

const states = new WeakMap<ScenarioContext, CombatScenarioState>();

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function entityById(snapshot: GameSessionSnapshot, id: string): EntitySnapshot | null {
  return snapshot.entities.find((entity) => entity.id === id) ?? null;
}

function createActor(
  scene: Scene,
  session: GameSession,
  entityId: string,
  color: Color3,
  prefix: string,
): ActorView {
  const snapshot = entityById(session.snapshot(), entityId);
  const position = snapshot?.position ?? { x: 0, y: 0, z: 0 };
  const mesh = createCharacterPrototype(scene, `combat.${prefix}.`);
  mesh.name = `combat.actor.${entityId}`;
  mesh.isPickable = false;
  mesh.position.set(position.x, position.y, position.z);

  const material = createCharacterMaterial(scene, `combat.actor.${entityId}.material`, color);
  mesh.material = material;

  const skeleton = createCharacterSkeleton(
    scene,
    `combat.${prefix}.`,
    0,
    createCharacterAnimations(),
  );
  mesh.skeleton = skeleton;
  scene.beginAnimation(skeleton, 0, CHARACTER_ANIMATION_FRAMES, true, 1);

  return {
    entityId,
    mesh,
    material,
    skeleton,
    baseColor: color,
    lungeUntil: 0,
    lungeDirection: { x: 0, z: 0 },
    flashUntil: 0,
    deadAt: null,
    removed: false,
  };
}

function overlayText(session: GameSession): string {
  const snapshot = session.snapshot();
  const player = entityById(snapshot, PLAYER_ID);
  if (!player) {
    return "player missing";
  }
  const enemies = snapshot.entities.filter((entity) => entity.identity.type === "enemy");
  const alive = enemies.filter((entity) => entity.combat.alive).length;
  const gel = player.container.items
    .filter((item) => item.templateId === "item:slime_gel")
    .reduce((total, item) => total + item.quantity, 0);
  return [
    `HP ${Math.round(player.combat.hp)}/${Math.round(player.combat.maxHp)}`,
    `XP ${Math.round(player.attributes.xp ?? 0)}`,
    `史莱姆 ${alive}/${enemies.length}`,
    `凝胶 x${gel}`,
  ].join(" · ");
}

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.id = "combat-loop-overlay";
  overlay.style.position = "fixed";
  overlay.style.left = "16px";
  overlay.style.bottom = "16px";
  overlay.style.padding = "8px 12px";
  overlay.style.background = "rgba(15, 23, 42, 0.78)";
  overlay.style.color = "#e2e8f0";
  overlay.style.font = "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace";
  overlay.style.borderRadius = "6px";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "20";
  document.body.appendChild(overlay);
  return overlay;
}

function enemyColor(state: EntitySnapshot): Color3 {
  if (!state.combat.alive) {
    return Color3.FromHexString("#475569");
  }
  switch (state.combat.aiState) {
    case "chase":
      return Color3.FromHexString("#f59e0b");
    case "attack":
      return Color3.FromHexString("#ef4444");
    case "patrol":
      return Color3.FromHexString("#84cc16");
    default:
      return Color3.FromHexString("#22c55e");
  }
}

function syncActor(actor: ActorView, entity: EntitySnapshot, now: number): void {
  if (actor.removed) {
    return;
  }

  const lungeRemaining = actor.lungeUntil - now;
  let offsetX = 0;
  let offsetZ = 0;
  if (lungeRemaining > 0) {
    const progress = 1 - lungeRemaining / LUNGE_DURATION_MS;
    const push = Math.sin(progress * Math.PI) * 0.45;
    offsetX = actor.lungeDirection.x * push;
    offsetZ = actor.lungeDirection.z * push;
  }

  actor.mesh.position.set(
    entity.position.x + offsetX,
    entity.position.y,
    entity.position.z + offsetZ,
  );
  actor.mesh.rotation.y = entity.rotation.y;

  const isPlayer = entity.identity.type === "player";
  const isEnemy = entity.identity.type === "enemy";
  const color = isPlayer || !isEnemy ? actor.baseColor : enemyColor(entity);
  actor.material.diffuseColor = color;
  actor.material.emissiveColor =
    actor.flashUntil > now ? Color3.FromHexString("#fecaca") : Color3.Black();

  if (!entity.combat.alive && !isPlayer) {
    if (actor.deadAt === null) {
      actor.deadAt = now;
    }
    const sink = Math.min(1, (now - actor.deadAt) / DEATH_SINK_MS);
    actor.mesh.position.y -= sink * 1.4;
    if (sink >= 1) {
      actor.mesh.setEnabled(false);
      actor.removed = true;
    }
  }
}

function applyEvent(state: CombatScenarioState, event: CombatEvent, now: number): void {
  state.eventLog.push(event);
  if (state.eventLog.length > 200) {
    state.eventLog.splice(0, state.eventLog.length - 200);
  }

  if (event.type === "attack" && event.hit) {
    const attacker = state.actors.get(event.attackerId);
    const target = state.actors.get(event.targetId);
    if (attacker && target) {
      const dx = target.mesh.position.x - attacker.mesh.position.x;
      const dz = target.mesh.position.z - attacker.mesh.position.z;
      const length = Math.hypot(dx, dz) || 1;
      attacker.lungeDirection = { x: dx / length, z: dz / length };
      attacker.lungeUntil = now + LUNGE_DURATION_MS;
      target.flashUntil = now + FLASH_DURATION_MS;
    }
  }
}

function installDebugApi(state: CombatScenarioState): void {
  const snapshot = () => state.session.snapshot();
  window.P0CombatDebug = {
    scenario: SCENARIO_NAME,
    getSnapshot: snapshot,
    getPlayer: () => entityById(snapshot(), PLAYER_ID),
    getEnemies: () => snapshot().entities.filter((entity) => entity.identity.type === "enemy"),
    attack: (entityId) => state.session.attack(PLAYER_ID, entityId),
    moveTo: (x, z) => state.session.moveTo(PLAYER_ID, { x, y: 0, z }),
    stopAttack: () => state.session.stopAttack(PLAYER_ID),
    getEventLog: () => [...state.eventLog],
  };
}

async function waitForEnemyDeath(
  session: GameSession,
  enemyId: string,
  timeoutMs: number,
): Promise<number> {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= timeoutMs) {
    const enemy = entityById(session.snapshot(), enemyId);
    if (!enemy || !enemy.combat.alive) {
      return performance.now() - startedAt;
    }
    await nextFrame();
  }
  return performance.now() - startedAt;
}

/**
 * 战斗闭环演示：GameSession 内跑完 AI 状态机与回合结算，
 * 渲染层点击敌人提交 attack 意图，并按事件流触发冲刺/受击表现。
 */
export const combatLoopScenario: ScenarioDefinition = {
  name: SCENARIO_NAME,
  description:
    "战斗闭环：点击敌人攻击，敌人 idle→patrol→chase→attack→dead 状态机驱动移动/攻击表现，死亡掉经验与战利品",
  interactive: true,

  async setup(context) {
    const { scene } = context;
    setGreyboxEnabled(scene, false);
    setCameraSpan(scene, CAMERA_VERTICAL_SPAN);

    const root = new TransformNode("scenario.combat-loop", scene);
    createGroundVisual(
      scene,
      root,
      ARENA_BOUNDS,
      "region.combat-loop.ground",
      Color3.FromHexString("#8fa3b8"),
    );

    const session = new GameSession();
    session.loadRegion(combatBundle(), "region:green_hollow");

    const actors = new Map<string, ActorView>();
    const snapshot = session.snapshot();
    for (const entity of snapshot.entities) {
      const isPlayer = entity.identity.type === "player";
      const isEnemy = entity.identity.type === "enemy";
      const color = isPlayer
        ? Color3.FromHexString("#38bdf8")
        : isEnemy
          ? enemyColor(entity)
          : Color3.FromHexString("#a78bfa"); // NPC：中性紫，避免与敌人混淆
      const actor = createActor(
        scene,
        session,
        entity.id,
        color,
        isPlayer ? "player" : entity.id.replace(/[^a-z0-9]+/gi, "-"),
      );
      // 挂到场景根节点：teardown 的 root.dispose(false, true) 才能级联
      // 释放 actor 网格/材质，否则每次运行都会泄漏一批 mesh。
      actor.mesh.parent = root;
      actors.set(entity.id, actor);
    }

    const state: CombatScenarioState = {
      root,
      session,
      actors,
      observer: null,
      detachClick: () => undefined,
      eventLog: [],
      overlay: createOverlay(),
      lastFrameAt: performance.now(),
    };
    states.set(context, state);

    state.detachClick = attachClickToMove(scene, (point) => {
      const current = session.snapshot();
      let nearest: { id: string; distance: number } | null = null;
      for (const entity of current.entities) {
        if (entity.identity.type !== "enemy" || !entity.combat.alive) {
          continue;
        }
        const distance = Math.hypot(entity.position.x - point.x, entity.position.z - point.z);
        if (distance > CLICK_ENEMY_RADIUS) {
          continue;
        }
        if (nearest === null || distance < nearest.distance) {
          nearest = { id: entity.id, distance };
        }
      }

      if (nearest) {
        session.attack(PLAYER_ID, nearest.id);
      } else {
        session.moveTo(PLAYER_ID, { x: point.x, y: 0, z: point.z });
      }
    });

    state.observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const deltaSeconds = Math.min(Math.max((now - state.lastFrameAt) / 1000, 0), 0.1);
      state.lastFrameAt = now;

      state.session.advance(deltaSeconds * 1000);
      for (const event of state.session.drainEvents()) {
        applyEvent(state, event, now);
      }

      const current = session.snapshot();
      for (const entity of current.entities) {
        const actor = state.actors.get(entity.id);
        if (actor) {
          syncActor(actor, entity, now);
        }
      }
      if (state.overlay) {
        state.overlay.textContent = overlayText(session);
      }
    });

    for (const entityId of session.snapshot().entities.map((entity) => entity.id)) {
      context.registerEntity(entityId);
    }
    context.registerRegion("region:green_hollow");
    installDebugApi(state);

    await nextFrame();
  },

  async measure(context) {
    const state = states.get(context);
    if (!state) {
      throw new Error("combat-loop state 未初始化");
    }

    const before = state.session.snapshot();
    const beforePlayer = entityById(before, PLAYER_ID);
    const target = before.entities.find(
      (entity) => entity.identity.type === "enemy" && entity.combat.alive,
    );
    if (!target) {
      throw new Error("战斗场景没有可攻击的敌人");
    }

    state.session.attack(PLAYER_ID, target.id);
    const killMs = await waitForEnemyDeath(state.session, target.id, MEASURE_TIMEOUT_MS);

    const after = state.session.snapshot();
    const player = entityById(after, PLAYER_ID);
    const deadEnemies = after.entities.filter(
      (entity) => entity.identity.type === "enemy" && !entity.combat.alive,
    );
    const loot = player?.container.items.reduce((total, item) => total + item.quantity, 0) ?? 0;
    const attackEvents = state.eventLog.filter((event) => event.type === "attack").length;
    const deathEvents = state.eventLog.filter(
      (event) => event.type === "death" && event.kind === "enemy",
    ).length;

    const metrics: Metric[] = [
      {
        name: "combat.entityCount",
        value: after.entities.length,
        unit: "entities",
        threshold: 3,
        comparison: "gte",
      },
      {
        name: "combat.snapshotVersion",
        value: after.version,
        unit: "version",
      },
      {
        name: "combat.attackEvents",
        value: attackEvents,
        unit: "events",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "combat.enemyDeaths",
        value: deathEvents,
        unit: "events",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "combat.deadEnemies",
        value: deadEnemies.length,
        unit: "enemies",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "combat.playerHp",
        value: Math.round(player?.combat.hp ?? 0),
        unit: "hp",
      },
      {
        name: "combat.playerXp",
        value: Math.round(player?.attributes.xp ?? 0),
        unit: "xp",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "combat.lootQuantity",
        value: loot,
        unit: "items",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "combat.killMs",
        value: Math.round(killMs),
        unit: "ms",
      },
      {
        name: "combat.playerMoved",
        value:
          player && beforePlayer
            ? Math.round(
                Math.hypot(
                  player.position.x - beforePlayer.position.x,
                  player.position.z - beforePlayer.position.z,
                ) * 1000,
              ) / 1000
            : 0,
        unit: "units",
      },
    ];

    return metrics;
  },

  teardown(context) {
    const state = states.get(context);
    if (!state) {
      return;
    }
    states.delete(context);

    state.detachClick();
    if (state.observer) {
      context.scene.onBeforeRenderObservable.remove(state.observer);
    }
    for (const actor of state.actors.values()) {
      context.scene.stopAnimation(actor.skeleton);
      actor.skeleton.dispose();
    }
    state.root.dispose(false, true);
    state.overlay?.remove();

    setGreyboxEnabled(context.scene, true);
    setCameraSpan(context.scene, DEFAULT_CAMERA_VERTICAL_SPAN);
    delete window.P0CombatDebug;
  },
};
