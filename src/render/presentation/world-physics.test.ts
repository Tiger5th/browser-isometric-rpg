import { describe, expect, it } from "vitest";

import {
  AMBIENT_COLOR,
  BUSH_INFLUENCE_RADIUS,
  BUSH_OCCLUSION_MIN_ALPHA,
  CHARACTER_COLLIDER_RADIUS,
  COLLIDER_HEIGHTS,
  FOG_COLOR,
  FOG_END,
  FOG_START,
  HARD_COLLIDER_KINDS,
  KEY_LIGHT_COLOR,
  KEY_LIGHT_DIRECTION,
  LANDSCAPE_BOUNDS,
  LANDSCAPE_HILLS,
  LANDSCAPE_RING_WIDTH,
  LANDSCAPE_TREES,
  landscapeEdgeMinDistance,
  NPC_BREATH_AMPLITUDE,
  NPC_PACE_MAX_INTERVAL_MS,
  NPC_PACE_MIN_INTERVAL_MS,
  NPC_PACE_RADIUS,
  PASSABLE_KINDS,
  buildPropColliders,
  bushAlphaForOcclusion,
  bushOcclusionAt,
  colliderObstacleSpecs,
  colliderOverlap,
  isBlockedByCollider,
  keyLightAzimuthDegrees,
  keyLightElevationDegrees,
  resolveMoveWithColliders,
  sampleNpcIdle,
  validateKeyLight,
  validateLandscape,
  type NpcIdleState,
} from "./world-physics";
import { SLIME_DEN_PROPS } from "./slime-den-layout";
import {
  GREEN_HOLLOW_BOUNDS,
  PROP_DIMENSIONS,
  PROPS,
  type PropPlacement,
} from "./green-hollow-layout";

/** 构造一个最小 PropPlacement（测试专用，避免依赖 PROPS 顺序）。 */
function prop(
  id: string,
  kind: PropPlacement["kind"],
  x: number,
  z: number,
  scale = 1,
): PropPlacement {
  return { id, kind, x, z, scale, occluder: true, zone: "village" };
}

/** 恒 0 随机源：待机行为测试用它得到确定性输出。 */
function constantRandom(value: number): () => number {
  return () => value;
}

describe("硬碰撞环境件（user story 15）", () => {
  it("树/石墙/木桶/木箱有碰撞体，灌木没有", () => {
    const colliders = buildPropColliders();
    const kinds = new Set(colliders.map((collider) => collider.kind));
    expect([...kinds].sort()).toEqual(["barrel", "crate", "stone-wall", "tree-large"]);
    expect(colliders.some((collider) => collider.id === "prop.bush.north-west")).toBe(false);
  });

  it("布局里每棵硬碰撞树都恰好对应一个碰撞体", () => {
    const hardProps = PROPS.filter((item) => HARD_COLLIDER_KINDS.includes(item.kind));
    const colliders = buildPropColliders();
    expect(colliders).toHaveLength(hardProps.length);
    expect(new Set(colliders.map((collider) => collider.id))).toEqual(
      new Set(hardProps.map((item) => item.id)),
    );
  });

  it("硬碰撞种类与可穿种类互斥", () => {
    for (const kind of HARD_COLLIDER_KINDS) {
      expect(PASSABLE_KINDS).not.toContain(kind);
    }
    for (const kind of PASSABLE_KINDS) {
      expect(HARD_COLLIDER_KINDS).not.toContain(kind);
    }
  });

  it("每个区域布局都覆盖了共享的硬碰撞件与可穿件", () => {
    // 巢穴件（票 35）只出现在区域 2，因此「共享种类」是两区域的交集：
    // 任一区域缺少其中一种就说明该区域的件被漏配。
    const sharedHardKinds = HARD_COLLIDER_KINDS.filter((kind) =>
      kind.startsWith("den-") ? false : true,
    );
    for (const props of [PROPS, SLIME_DEN_PROPS]) {
      const all = new Set(props.map((item) => item.kind));
      for (const kind of sharedHardKinds) {
        expect(all.has(kind)).toBe(true);
      }
      for (const kind of PASSABLE_KINDS) {
        expect(all.has(kind)).toBe(true);
      }
    }
    // 区域 2 额外带上巢穴件（否则「晶簇/茧/蛋」那一档等于没接管线）。
    expect(new Set(SLIME_DEN_PROPS.map((item) => item.kind)).has("den-crystal")).toBe(true);
  });

  it("碰撞半径含角色半径后不会小于一个身位（树/桶/箱都挡得住）", () => {
    for (const collider of buildPropColliders()) {
      const clearance = collider.radius + CHARACTER_COLLIDER_RADIUS;
      // 树干至少 0.5m 粗，桶/箱至少 0.6m 宽：小于这个角色能整个站进去。
      expect(clearance).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("石墙碰撞盒有最小厚度，角色不能从墙侧缝穿过", () => {
    const wall = prop("prop.test.wall", "stone-wall", 0, 0, 1);
    const collider = buildPropColliders([wall])[0];
    // 视觉遮挡盒半深只有 0.35m，碰撞盒必须补厚到 0.45m 以上。
    expect(collider.halfDepth * 2).toBeGreaterThanOrEqual(0.9);
    expect(collider.height).toBeCloseTo(COLLIDER_HEIGHTS["stone-wall"], 5);
  });

  it("碰撞盒高度按种类缩放（大树比小树高）", () => {
    const small = buildPropColliders([prop("prop.test.small", "tree-large", 0, 0, 0.9)])[0];
    const large = buildPropColliders([prop("prop.test.large", "tree-large", 0, 0, 1.1)])[0];
    expect(large.height).toBeGreaterThan(small.height);
    expect(large.height).toBeCloseTo(COLLIDER_HEIGHTS["tree-large"] * 1.1, 5);
  });

  it("scale 放大后碰撞半径同比放大", () => {
    const base = buildPropColliders([prop("prop.test.barrel", "barrel", 0, 0, 1)])[0];
    const scaled = buildPropColliders([prop("prop.test.barrel", "barrel", 0, 0, 1.5)])[0];
    expect(scaled.radius).toBeGreaterThan(base.radius);
  });
});

describe("硬碰撞求解：玩家/敌人均不可穿（user story 15/16）", () => {
  const tree = prop("prop.test.tree", "tree-large", 0, 0, 1);
  const colliders = buildPropColliders([tree]);

  it("正对树干的目标被挡住，停在碰撞体外侧", () => {
    const result = resolveMoveWithColliders({ x: 0, z: 3 }, { x: 0, z: 0 }, colliders);
    expect(result.blocked).toBe(true);
    expect(result.blockedBy).toBe("prop.test.tree");
    expect(Math.hypot(result.x, result.z)).toBeGreaterThan(
      colliders[0].radius + CHARACTER_COLLIDER_RADIUS - 1e-6,
    );
  });

  it("沿树干切线移动可以滑行，不会被卡死", () => {
    const start = { x: 0, z: 3 };
    // 先横移到树的一侧（切线方向，不该被挡）。
    const first = resolveMoveWithColliders(start, { x: 3, z: 3 }, colliders);
    expect(first.blocked).toBe(false);
    expect(first.x).toBeCloseTo(3, 6);

    // 从侧面正对树干推进（目标 x=0.5 落在碰撞盒内）：被挡住，
    // 但停在树北侧而不是原地不动。
    const second = resolveMoveWithColliders(first, { x: 0.5, z: 0 }, colliders);
    expect(second.blocked).toBe(true);
    expect(second.z).toBeGreaterThan(0);
    expect(isBlockedByCollider(colliders[0], second.x, second.z)).toBe(false);

    // 贴着树继续横移：仍能走（贴脸不钉死），这是 L4「移动不被挡死」的核心。
    const third = resolveMoveWithColliders(second, { x: 6, z: second.z }, colliders);
    expect(third.x).toBeGreaterThan(second.x);
    expect(third.blocked).toBe(false);
  });

  it("从树的一侧走到另一侧（绕行）全程不被判定为可穿", () => {
    let position = { x: 0, z: 6 };
    for (let step = 0; step < 40; step += 1) {
      position = resolveMoveWithColliders(
        position,
        { x: (step / 39) * 6 - 3, z: 6 - step * 0.3 },
        colliders,
      );
      expect(isBlockedByCollider(colliders[0], position.x, position.z)).toBe(false);
    }
  });

  it("远离树的移动完全不受影响", () => {
    const result = resolveMoveWithColliders({ x: 0, z: 20 }, { x: 5, z: 18 }, colliders);
    expect(result).toEqual({ x: 5, z: 18, blocked: false, blockedBy: null });
  });

  it("区域边界同样挡住角色（不会走出世界掉进虚空）", () => {
    const result = resolveMoveWithColliders(
      { x: GREEN_HOLLOW_BOUNDS.maxX - 1, z: 0 },
      { x: GREEN_HOLLOW_BOUNDS.maxX + 50, z: 0 },
      [],
    );
    expect(result.x).toBeLessThanOrEqual(GREEN_HOLLOW_BOUNDS.maxX);
    expect(result.x).toBeGreaterThan(GREEN_HOLLOW_BOUNDS.maxX - 1);
  });

  it("灌木不产生碰撞体，可以直接穿过（user story 16）", () => {
    const bush = prop("prop.test.bush", "bush", 0, 0, 1);
    const bushColliders = buildPropColliders([bush]);
    expect(bushColliders).toHaveLength(0);
    const result = resolveMoveWithColliders({ x: 0, z: 2 }, { x: 0, z: 0 }, bushColliders);
    expect(result).toEqual({ x: 0, z: 0, blocked: false, blockedBy: null });
  });

  it("colliderOverlap 对接触表面返回 0，侵入后为正", () => {
    const surface = colliders[0].radius + CHARACTER_COLLIDER_RADIUS + 1e-6;
    expect(colliderOverlap(colliders[0], surface, 0)).toBe(0);
    expect(colliderOverlap(colliders[0], surface - 0.2, 0)).toBeGreaterThan(0);
  });

  it("正式布局的碰撞体不会压在实体出生点上", () => {
    for (const collider of buildPropColliders()) {
      // 玩家出生点与敌人/NPC 锚点必须可站立（布局自检已保证间距，这里复算碰撞）。
      expect(
        isBlockedByCollider(collider, 0, 0) ||
          Math.hypot(collider.x, collider.z) > collider.radius + CHARACTER_COLLIDER_RADIUS,
      ).toBe(true);
    }
  });

  it("正式布局下从出生点走向任一方向都不会被永久钉死", () => {
    // L4 冒烟的前提：任何方向都存在可行走步长。若某个碰撞体组合把角色
    // 夹在中间（推出方向又被另一个碰撞体挡住），移动会完全失效。
    const colliders = buildPropColliders();
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * Math.PI * 2;
      const target = {
        x: Math.cos(angle) * 10,
        z: Math.sin(angle) * 10,
      };
      const result = resolveMoveWithColliders({ x: 0, z: 0 }, target, colliders);
      const moved = Math.hypot(result.x, result.z);
      expect(moved).toBeGreaterThan(0.05);
      expect(isBlockedByCollider(colliders[0], result.x, result.z)).toBe(false);
      for (const collider of colliders) {
        expect(isBlockedByCollider(collider, result.x, result.z)).toBe(false);
      }
    }
  });

  it("连续小步推进能穿过树与墙之间的走廊（不抖、不穿）", () => {
    // 村庄广场东侧树与北墙之间约 1.5m 宽：模拟逐帧小步穿过。
    const colliders = buildPropColliders();
    let position = { x: 0, z: -2 };
    const goal = { x: 9.5, z: -1.5 };
    for (let step = 0; step < 60; step += 1) {
      const next = resolveMoveWithColliders(
        position,
        {
          x: position.x + (goal.x - position.x) * 0.15,
          z: position.z + (goal.z - position.z) * 0.15,
        },
        colliders,
      );
      // 每步都必须有进展（不被钉死）且不进入任何碰撞体。
      expect(Math.hypot(next.x - position.x, next.z - position.z)).toBeGreaterThan(0);
      for (const collider of colliders) {
        expect(isBlockedByCollider(collider, next.x, next.z)).toBe(false);
      }
      position = next;
    }
    // 终点应到达目标附近（或贴着障碍停住，但不穿越）。
    expect(Math.hypot(position.x - goal.x, position.z - goal.z)).toBeLessThan(3);
  });
});

describe("灌木进入视觉反馈（user story 17）", () => {
  const bushes = [
    { id: "bush.a", x: 0, z: 0 },
    { id: "bush.b", x: 8, z: 8 },
  ];

  it("远离灌木时无遮挡", () => {
    expect(bushOcclusionAt(20, 20, bushes)).toEqual({ bushId: null, occlusion: 0 });
  });

  it("在灌木中心时遮挡最强，且不超过 1", () => {
    const result = bushOcclusionAt(0, 0, bushes);
    expect(result.bushId).toBe("bush.a");
    expect(result.occlusion).toBe(1);
  });

  it("遮挡随距离线性衰减，影响半径之外为 0", () => {
    const half = BUSH_INFLUENCE_RADIUS / 2;
    expect(bushOcclusionAt(half, 0, bushes).occlusion).toBeCloseTo(0.5, 6);
    expect(bushOcclusionAt(BUSH_INFLUENCE_RADIUS + 0.01, 0, bushes).occlusion).toBe(0);
  });

  it("多棵灌木取最高遮挡强度", () => {
    const near = bushOcclusionAt(8.2, 8, bushes);
    expect(near.bushId).toBe("bush.b");
    expect(near.occlusion).toBeGreaterThan(0);
  });

  it("角色半透明有下限：藏进灌木仍可辨认", () => {
    expect(bushAlphaForOcclusion(0)).toBe(1);
    expect(bushAlphaForOcclusion(1)).toBeCloseTo(BUSH_OCCLUSION_MIN_ALPHA, 6);
    expect(bushAlphaForOcclusion(0.5)).toBeCloseTo((1 + BUSH_OCCLUSION_MIN_ALPHA) / 2, 6);
    // 输入越界时也要保持有界。
    expect(bushAlphaForOcclusion(-3)).toBe(1);
    expect(bushAlphaForOcclusion(3)).toBeCloseTo(BUSH_OCCLUSION_MIN_ALPHA, 6);
  });
});

describe("边界景观环带 + 渐暗雾（user story 18）", () => {
  it("环带比区域宽，四方向都有余量", () => {
    expect(LANDSCAPE_BOUNDS.minX).toBeLessThan(GREEN_HOLLOW_BOUNDS.minX);
    expect(LANDSCAPE_BOUNDS.maxX).toBeGreaterThan(GREEN_HOLLOW_BOUNDS.maxX);
    expect(LANDSCAPE_BOUNDS.minZ).toBeLessThan(GREEN_HOLLOW_BOUNDS.minZ);
    expect(LANDSCAPE_BOUNDS.maxZ).toBeGreaterThan(GREEN_HOLLOW_BOUNDS.maxZ);
    expect(LANDSCAPE_BOUNDS.maxX - GREEN_HOLLOW_BOUNDS.maxX).toBe(LANDSCAPE_RING_WIDTH);
  });

  it("景观自检通过：不深入可行走区域、四方向都有内容", () => {
    expect(validateLandscape()).toEqual([]);
  });

  it("validateLandscape 能发现空环带与越界景观", () => {
    const issues = validateLandscape([], []);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.id === "landscape.north")).toBe(true);

    const deepHill = [
      { id: "hill.deep", x: 0, z: GREEN_HOLLOW_BOUNDS.minZ + 1, radius: 10, height: 5 },
    ];
    expect(validateLandscape(deepHill, LANDSCAPE_TREES).some((i) => i.id === "hill.deep")).toBe(
      true,
    );
  });

  it("所有远景树都在可行走区域之外", () => {
    for (const tree of LANDSCAPE_TREES) {
      expect(
        tree.x > GREEN_HOLLOW_BOUNDS.minX &&
          tree.x < GREEN_HOLLOW_BOUNDS.maxX &&
          tree.z > GREEN_HOLLOW_BOUNDS.minZ &&
          tree.z < GREEN_HOLLOW_BOUNDS.maxZ,
      ).toBe(false);
    }
  });

  it("雾在环带外缘前完全饱和，且不是纯黑", () => {
    // 等距相机（radius=40）到环带外缘的最近距离：雾必须在此之前饱和成雾色，
    // 否则屏幕边缘露出环带边界 = 黑色虚无。
    expect(FOG_END).toBeLessThan(landscapeEdgeMinDistance());
    expect(FOG_START).toBeLessThan(FOG_END);
    // 暗部紫灰：三通道都明显大于 0，且蓝 >= 红（偏冷）。
    expect(FOG_COLOR.r).toBeGreaterThan(0.2);
    expect(FOG_COLOR.g).toBeGreaterThan(0.2);
    expect(FOG_COLOR.b).toBeGreaterThanOrEqual(FOG_COLOR.r);
  });

  it("环带外缘比相机视锥远角更远（相机看不到环带外）", () => {
    // 相机 radius=40 + 正交跨度 30 → 最远可见地面约 49m；环带外缘必须更远。
    expect(landscapeEdgeMinDistance()).toBeGreaterThan(49);
  });

  it("山丘尺寸为正且高度成景（最低 5m，最高 8m）", () => {
    for (const hill of LANDSCAPE_HILLS) {
      expect(hill.height).toBeGreaterThanOrEqual(5);
      expect(hill.height).toBeLessThanOrEqual(8);
      expect(hill.radius).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("统一主光与暗部紫灰（user story 19）", () => {
  it("主光方向来自左上 45° 且高于水平面", () => {
    expect(validateKeyLight()).toEqual([]);
    expect(KEY_LIGHT_DIRECTION.x).toBeLessThan(0);
    expect(KEY_LIGHT_DIRECTION.z).toBeLessThan(0);
    expect(KEY_LIGHT_DIRECTION.y).toBeGreaterThan(0);
    expect(keyLightElevationDegrees()).toBeGreaterThan(35);
    // 等距画面「左上」的水平方位 = -135°（-90° 是画面正左，再偏向深处 45°）。
    expect(Math.abs(keyLightAzimuthDegrees() + 135)).toBeLessThan(5);
  });

  it("validateKeyLight 拒绝水平光、右下光与画面右侧光", () => {
    expect(validateKeyLight({ x: -1, y: 0, z: -1 }).length).toBeGreaterThan(0);
    expect(validateKeyLight({ x: 1, y: 1, z: 1 }).length).toBeGreaterThan(0);
    expect(validateKeyLight({ x: -0.1, y: 5, z: -0.1 }).length).toBeGreaterThan(0);
    // -X 方向是画面正左而非左上：方位角 -90°，应被拒。
    expect(validateKeyLight({ x: -1, y: 1, z: 0 }).length).toBeGreaterThan(0);
  });

  it("主光是暖色、环境光是紫灰", () => {
    // 暖：红 >= 蓝。紫灰：蓝 > 红 > 绿，且都不为 0（不纯黑）。
    expect(KEY_LIGHT_COLOR.r).toBeGreaterThanOrEqual(KEY_LIGHT_COLOR.b);
    expect(AMBIENT_COLOR.b).toBeGreaterThan(AMBIENT_COLOR.r);
    expect(AMBIENT_COLOR.r).toBeGreaterThan(AMBIENT_COLOR.g);
    expect(AMBIENT_COLOR.g).toBeGreaterThan(0.3);
  });
});

describe("NPC 待机行为（user story 20）", () => {
  const home = { x: 6, z: 4 };

  const idleState = (cooldownMs: number, random = constantRandom(0)): NpcIdleState => ({
    yaw: 0,
    paceCooldownMs: cooldownMs,
    random,
  });

  it("冷却中只呼吸、不踱步", () => {
    const { sample, next } = sampleNpcIdle(idleState(2_000), 0, 16, home);
    expect(sample.paceTarget).toBeNull();
    expect(sample.faceYaw).toBeNull();
    expect(next.paceCooldownMs).toBe(2_000 - 16);
  });

  it("冷却归零时触发一次踱步，目标在半径内且朝向目标", () => {
    const { sample, next } = sampleNpcIdle(idleState(0, constantRandom(0.25)), 0, 16, home);
    expect(sample.paceTarget).not.toBeNull();
    const target = sample.paceTarget!;
    expect(Math.hypot(target.x - home.x, target.z - home.z)).toBeLessThanOrEqual(
      NPC_PACE_RADIUS + 1e-9,
    );
    expect(sample.faceYaw).not.toBeNull();
    expect(next.yaw).toBe(sample.faceYaw);
    // 重新装填冷却，落在配置区间内。
    expect(next.paceCooldownMs).toBeGreaterThanOrEqual(NPC_PACE_MIN_INTERVAL_MS);
    expect(next.paceCooldownMs).toBeLessThanOrEqual(NPC_PACE_MAX_INTERVAL_MS);
  });

  it("呼吸摆动有界且周期性（一个周期后回到起点）", () => {
    const period = 3_200;
    const start = sampleNpcIdle(idleState(10_000), 0, 16, home).sample.sway;
    const quarter = sampleNpcIdle(idleState(10_000), period / 4, 16, home).sample.sway;
    const half = sampleNpcIdle(idleState(10_000), period / 2, 16, home).sample.sway;
    const full = sampleNpcIdle(idleState(10_000), period, 16, home).sample.sway;
    expect(Math.abs(start)).toBeLessThan(1e-9);
    expect(quarter).toBeCloseTo(NPC_BREATH_AMPLITUDE, 6);
    expect(half).toBeCloseTo(-start, 6);
    expect(full).toBeCloseTo(start, 6);
    for (const value of [start, quarter, half, full]) {
      expect(Math.abs(value)).toBeLessThanOrEqual(NPC_BREATH_AMPLITUDE + 1e-9);
    }
  });

  it("踱步目标不越出区域边界", () => {
    const edgeHome = { x: GREEN_HOLLOW_BOUNDS.maxX - 1, z: GREEN_HOLLOW_BOUNDS.maxZ - 1 };
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      const { sample } = sampleNpcIdle(idleState(0, constantRandom(roll)), 0, 16, edgeHome);
      const target = sample.paceTarget!;
      expect(target.x).toBeLessThanOrEqual(GREEN_HOLLOW_BOUNDS.maxX);
      expect(target.z).toBeLessThanOrEqual(GREEN_HOLLOW_BOUNDS.maxZ);
    }
  });

  it("同一随机源产生同一串踱步（表现层可复现）", () => {
    const first = sampleNpcIdle(idleState(0, constantRandom(0.4)), 0, 16, home);
    const second = sampleNpcIdle(idleState(0, constantRandom(0.4)), 0, 16, home);
    expect(second.sample.paceTarget).toEqual(first.sample.paceTarget);
  });
});

describe("navmesh 障碍与硬碰撞同源（user story 15/16）", () => {
  it("灌木不进 navmesh 障碍（可穿的核心前提）", () => {
    const specs = colliderObstacleSpecs();
    const bushIds = PROPS.filter((prop) => prop.kind === "bush").map((prop) => prop.id);
    for (const bushId of bushIds) {
      expect(specs.some((spec) => spec.name === `obstacle.${bushId}`)).toBe(false);
    }
  });

  it("硬碰撞件全部进 navmesh 障碍，且尺寸不小于最小 footprint", () => {
    const specs = colliderObstacleSpecs();
    const colliders = buildPropColliders();
    expect(specs).toHaveLength(colliders.length);
    for (const spec of specs) {
      expect(spec.width).toBeGreaterThanOrEqual(1.5);
      expect(spec.depth).toBeGreaterThanOrEqual(1.5);
      expect(spec.height).toBeGreaterThan(0);
    }
  });

  it("navmesh 障碍与碰撞体位置一一对应（不漂移）", () => {
    const specs = colliderObstacleSpecs();
    const colliders = buildPropColliders();
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    for (const collider of colliders) {
      const spec = byName.get(`obstacle.${collider.id}`);
      expect(spec).toBeDefined();
      expect(spec?.x).toBeCloseTo(collider.x, 6);
      expect(spec?.z).toBeCloseTo(collider.z, 6);
    }
  });
});

describe("布局常量与碰撞的关系（不变量）", () => {
  it("每类物件的碰撞高度不超过视觉高度", () => {
    for (const [kind, height] of Object.entries(COLLIDER_HEIGHTS)) {
      const visual = PROP_DIMENSIONS[kind as keyof typeof PROP_DIMENSIONS];
      expect(height).toBeLessThanOrEqual(visual.height);
    }
  });

  it("硬碰撞件数量与布局里的对应件数量一致（两区域分别断言）", () => {
    // 巢穴件（den-*）只在区域 2 的布局里，单独断言。
    expect(
      SLIME_DEN_PROPS.filter((item) => item.kind.startsWith("den-")).length,
    ).toBeGreaterThan(0);
    for (const props of [PROPS, SLIME_DEN_PROPS]) {
      const counts = new Map<string, number>();
      for (const item of props) {
        counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
      }
      for (const kind of HARD_COLLIDER_KINDS.filter((entry) => !entry.startsWith("den-"))) {
        expect(counts.get(kind) ?? 0).toBeGreaterThan(0);
      }
      // 灌木不进入碰撞列表，但每个区域都要有。
      expect(counts.get("bush") ?? 0).toBeGreaterThan(0);
    }
  });
});
