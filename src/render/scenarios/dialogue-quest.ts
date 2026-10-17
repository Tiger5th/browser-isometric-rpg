/**
 * 对话 + 任务闭环场景（票 22）。
 *
 * 点击 NPC 开始 ink 对话，选项推进；offer 标签接取任务；击杀事件推进目标；
 * 任务可交后 NPC 对话出现复命选项，回报后物品入背包、修饰器生效。
 *
 * 战斗系统归票 21：敌人死亡由 GameSession 的战斗结算触发，任务进度经
 * `onEnemyKilled` 自动推进；HUD 上的调试按钮只是发起一次真实攻击，
 * 方便在不开背包/装备 UI 的情况下手动走完任务闭环。
 */

import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

import cullSlimesData from "../../../content/quests/cull_slimes.json";
import elderMaCompiled from "../../../content/dialogues/elder_ma.ink?ink";
import slimeTemplateData from "../../../content/enemy-templates/slime.json";
import slimeBlueData from "../../../content/enemies/slime_blue.json";
import slimeElderData from "../../../content/enemies/slime_elder.json";
import slimeMeadowData from "../../../content/enemies/slime_meadow.json";
import healingHerbData from "../../../content/items/healing_herb.json";
import oldCoinData from "../../../content/items/old_coin.json";
import slimeGelData from "../../../content/items/slime_gel.json";
import travelerSwordData from "../../../content/items/traveler_sword.json";
import npcElderData from "../../../content/npcs/elder_ma.json";
import npcScoutData from "../../../content/npcs/scout_lin.json";
import regionData from "../../../content/regions/green_hollow.json";
import type { ContentBundle } from "../../logic/content/types";
import {
  GameSession,
  type EntitySnapshot,
  type GameSessionSnapshot,
} from "../../logic/game-session";
import type { Metric } from "../../logic/report";
import { DEFAULT_CAMERA_VERTICAL_SPAN } from "../camera";
import {
  createCharacterMaterial,
  createCharacterPrototype,
} from "../character-proto";
import type { ScenarioContext, ScenarioDefinition } from "../harness";
import {
  createGroundVisual,
  setCameraSpan,
  setGreyboxEnabled,
} from "../navmesh-scene";
import { createQuestLoopUi, type QuestLoopUi } from "../ui/quest-loop-ui";

const SCENARIO_NAME = "dialogue-quest";
const REGION_ID = "region:green_hollow";
const PLAYER_ID = "entity:player";
const CAMERA_VERTICAL_SPAN = 30;
const REGION_BOUNDS = { minX: -24, maxX: 24, minZ: -20, maxZ: 20 };

/** content/ 是数据源；这里只是把 P1 最小内容集装进一个 bundle。 */
const CONTENT_BUNDLE = {
  regions: [regionData],
  npcs: [npcElderData, npcScoutData],
  enemyTemplates: [slimeTemplateData],
  enemies: [slimeMeadowData, slimeBlueData, slimeElderData],
  items: [healingHerbData, oldCoinData, slimeGelData, travelerSwordData],
  quests: [cullSlimesData],
} as unknown as ContentBundle;

interface DialogueQuestState {
  root: TransformNode;
  session: GameSession;
  meshes: Map<string, Mesh>;
  deadEnemies: Set<string>;
  ui: QuestLoopUi;
  observer: Observer<Scene> | null;
  detachPointer: () => void;
}

/** ego-browser 手动/自动验证入口：只经 snapshot 读取、只经意图写入。 */
export interface DialogueQuestDebugApi {
  scenario: string;
  getSnapshot(): GameSessionSnapshot;
  moveTo(x: number, z: number): void;
  talkTo(npcId: string): void;
  chooseDialogueOption(index: number): void;
  /** 发起攻击；伤害/死亡结算仍由票 21 的战斗逻辑完成。 */
  attackEnemy(enemyId: string): void;
  getPlayer(): EntitySnapshot | null;
}

declare global {
  interface Window {
    P1DialogueQuestDebug?: DialogueQuestDebugApi;
  }
}

const states = new WeakMap<ScenarioContext, DialogueQuestState>();

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function playerSnapshot(session: GameSession): EntitySnapshot | null {
  return (
    session.snapshot().entities.find((entity) => entity.id === PLAYER_ID) ?? null
  );
}

function entityIdOf(mesh: AbstractMesh | null): string | null {
  let node: AbstractMesh | null = mesh;
  while (node !== null) {
    const metadata = node.metadata as { entityId?: unknown } | null;
    if (typeof metadata?.entityId === "string") {
      return metadata.entityId;
    }
    node = node.parent as AbstractMesh | null;
  }
  return null;
}

function groundPoint(scene: Scene): Vector3 | null {
  const camera = scene.activeCamera;
  if (!camera) {
    return null;
  }
  const ray = scene.createPickingRay(
    scene.pointerX,
    scene.pointerY,
    Matrix.Identity(),
    camera,
  );
  if (Math.abs(ray.direction.y) < 1e-6) {
    return null;
  }
  const distance = -ray.origin.y / ray.direction.y;
  if (distance <= 0) {
    return null;
  }
  return ray.origin.add(ray.direction.scale(distance));
}

function createEntityMesh(
  scene: Scene,
  root: TransformNode,
  id: string,
  type: string,
  displayName: string,
  position: { x: number; y: number; z: number },
): Mesh {
  let mesh: Mesh;
  if (type === "enemy") {
    mesh = MeshBuilder.CreateSphere(
      `entity.${id}.mesh`,
      { diameter: 0.9, segments: 10 },
      scene,
    );
    mesh.position.set(position.x, position.y + 0.45, position.z);
  } else {
    mesh = createCharacterPrototype(scene, `entity.${id}.`);
    const tint =
      type === "player"
        ? "#38bdf8"
        : displayName === "马婆婆"
          ? "#f0abfc"
          : "#a3e635";
    mesh.material = createCharacterMaterial(
      scene,
      `entity.${id}.material`,
      Color3.FromHexString(tint),
    );
  }
  mesh.name = `entity.${id}.mesh`;
  mesh.metadata = { entityId: id };
  mesh.parent = root;
  return mesh;
}

function installDebugApi(state: DialogueQuestState): void {
  const attackEnemy = (enemyId: string): void => {
    const enemy = state.session
      .snapshot()
      .entities.find((entity) => entity.id === enemyId);
    if (!enemy || enemy.identity.type !== "enemy") {
      throw new Error(`未知敌人：${enemyId}`);
    }
    // 走票 21 的真实战斗：伤害、死亡与击杀事件都由 GameSession 结算。
    state.session.attack(PLAYER_ID, enemyId);
  };

  state.session.subscribe((event) => {
    if (event.type === "enemy-killed" && !state.deadEnemies.has(event.enemyId)) {
      state.deadEnemies.add(event.enemyId);
      state.meshes.get(event.enemyId)?.setEnabled(false);
    }
  });

  window.P1DialogueQuestDebug = {
    scenario: SCENARIO_NAME,
    getSnapshot: () => state.session.snapshot(),
    moveTo: (x, z) => state.session.moveTo(PLAYER_ID, { x, y: 0, z }),
    talkTo: (npcId) => state.session.talkTo(npcId),
    chooseDialogueOption: (index) => state.session.chooseDialogueOption(index),
    attackEnemy,
    getPlayer: () => playerSnapshot(state.session),
  };
}

export const dialogueQuestScenario: ScenarioDefinition = {
  name: SCENARIO_NAME,
  description:
    "对话 + 任务闭环：点击 NPC 进入 ink 对话，接取/推进/交付任务，HUD 显示目标与奖励",
  interactive: true,

  async setup(context) {
    const { scene } = context;
    setGreyboxEnabled(scene, false);
    setCameraSpan(scene, CAMERA_VERTICAL_SPAN);

    const root = new TransformNode("scenario.dialogue-quest", scene);
    createGroundVisual(
      scene,
      root,
      REGION_BOUNDS,
      "region.dialogue-quest.ground",
      Color3.FromHexString("#7f9a8a"),
    );

    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.loadRegion(CONTENT_BUNDLE, REGION_ID);

    const meshes = new Map<string, Mesh>();
    for (const entity of session.snapshot().entities) {
      meshes.set(
        entity.id,
        createEntityMesh(
          scene,
          root,
          entity.id,
          entity.identity.type,
          entity.identity.displayName,
          entity.position,
        ),
      );
    }

    const state: DialogueQuestState = {
      root,
      session,
      meshes,
      deadEnemies: new Set<string>(),
      observer: null,
      detachPointer: () => undefined,
      ui: { update: () => undefined, dispose: () => undefined },
    };
    states.set(context, state);

    const killNextEnemy = (): void => {
      const remaining = state.session
        .snapshot()
        .entities.filter(
          (entity) =>
            entity.identity.type === "enemy" &&
            entity.combat.alive &&
            !state.deadEnemies.has(entity.id),
        );
      const next = remaining[0];
      if (next !== undefined) {
        window.P1DialogueQuestDebug?.attackEnemy(next.id);
      }
    };

    state.ui = createQuestLoopUi({
      mount: document.body,
      bundle: CONTENT_BUNDLE,
      onChoose: (index) => session.chooseDialogueOption(index),
      onDebugKill: killNextEnemy,
    });

    // 点击 NPC = 对话；点击其他实体 = 走过去；点击地面 = 移动。
    const pointerObserver = scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) {
        return;
      }
      // 对话进行中时，场景点击不打断当前对话（选项由 DOM 面板提交）。
      if (session.snapshot().dialogue !== null) {
        return;
      }
      const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) =>
        mesh.isPickable && mesh.isEnabled(),
      );
      const pickedId = entityIdOf(pick?.pickedMesh ?? null);
      if (pickedId !== null) {
        const picked = session
          .snapshot()
          .entities.find((entity) => entity.id === pickedId);
        if (picked?.identity.type === "npc") {
          session.talkTo(pickedId);
          return;
        }
        if (picked !== undefined) {
          session.moveTo(PLAYER_ID, {
            x: picked.position.x,
            y: 0,
            z: picked.position.z + 1.5,
          });
        }
        return;
      }
      const point = groundPoint(scene);
      if (point !== null) {
        session.moveTo(PLAYER_ID, { x: point.x, y: 0, z: point.z });
      }
    });
    state.detachPointer = () => {
      scene.onPointerObservable.remove(pointerObserver);
    };

    let lastFrameAt = performance.now();
    state.observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const deltaSeconds = Math.min(Math.max((now - lastFrameAt) / 1000, 0), 0.1);
      lastFrameAt = now;

      session.advance(deltaSeconds * 1000);
      const snapshot = session.snapshot();
      for (const entity of snapshot.entities) {
        const mesh = meshes.get(entity.id);
        if (!mesh || state.deadEnemies.has(entity.id)) {
          continue;
        }
        if (entity.identity.type === "enemy") {
          mesh.position.set(entity.position.x, 0.45, entity.position.z);
        } else {
          mesh.position.set(entity.position.x, entity.position.y, entity.position.z);
          mesh.rotation.y = entity.rotation.y;
        }
      }
      state.ui.update(snapshot);
    });

    context.registerRegion(REGION_ID);
    for (const entity of session.snapshot().entities) {
      context.registerEntity(entity.id);
    }
    installDebugApi(state);

    await nextFrame();
  },

  async measure(context) {
    const state = states.get(context);
    if (!state) {
      throw new Error("dialogue-quest state 未初始化");
    }
    const snapshot = state.session.snapshot();
    const quests = snapshot.quests;

    const metrics: Metric[] = [
      {
        name: "gameSession.entityCount",
        value: snapshot.entities.length,
        unit: "entities",
        threshold: 6,
        comparison: "eq",
      },
      {
        name: "gameSession.snapshotVersion",
        value: snapshot.version,
        unit: "version",
      },
      {
        name: "quest.total",
        value: quests.length,
        unit: "quests",
        threshold: 1,
        comparison: "eq",
      },
      {
        // 交互式场景允许在 measure 前就开始操作；这里只报告，不断言。
        name: "quest.available",
        value: quests.filter((quest) => quest.status === "available").length,
        unit: "quests",
      },
      {
        name: "dialogue.open",
        value: snapshot.dialogue === null ? 0 : 1,
        unit: "boolean",
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

    state.detachPointer();
    if (state.observer) {
      context.scene.onBeforeRenderObservable.remove(state.observer);
    }
    state.ui.dispose();
    state.root.dispose(false, true);

    setGreyboxEnabled(context.scene, true);
    setCameraSpan(context.scene, DEFAULT_CAMERA_VERTICAL_SPAN);
    delete window.P1DialogueQuestDebug;
  },
};
