// 票 28 L4 冒烟：世界质感（ego-browser）
// 顺序：measure（L5 预算，页面刚加载、负载最干净）→ 交互断言 → 四方向截图。
// 断言：4 类网格化 + 硬碰撞（撞树被挡）、灌木可穿 + 进入半透明、移动不被挡死、
//       边界景观 + 雾（四方向无黑色虚无）、唯一主光左上 45°、NPC 待机行为。
const BASE = "http://localhost:5199";
const SCENARIO_URL = `${BASE}/?scenario=p1-world&harness=1`;
const ROOT =
  "/Users/joule/Desktop/code/game kaifa/.claude/worktrees/agent-a055d22c1ffc929e3";
const ARTIFACTS = `${ROOT}/artifacts`;
const REPORT = `${ROOT}/reports/ticket28-l4-smoke.json`;
const fs = await import("node:fs/promises");

const task = await taskSpace("ticket28 world texture r6");
const page = task.page("p1");
console.log({ spaceId: task.spaceId });

await page.goto(SCENARIO_URL);
await page.evaluate(() => {
  window.__errors = [];
  window.addEventListener("error", (event) => window.__errors.push(String(event.message)));
});
await page.waitForFunction(
  () => window.P1WorldDebug !== undefined && window.P1WorldDebug.getRenderEvidence !== undefined,
  undefined,
  { timeout: 60_000 },
);
await page.waitForTimeout(3_000);
const sleep = (ms) => page.waitForTimeout(ms);
const results = {};

// ---------- L5 预算复测（最先跑，负载最干净） ----------
results.measure = await page.evaluate(async () => window.P0Harness.runScenario("p1-world"));
results.metrics = results.measure.metrics.map((m) => ({
  name: m.name,
  value: m.value,
  threshold: m.threshold,
  comparison: m.comparison,
  passed: m.passed,
}));
console.log("measure-status", results.measure.status);
console.log(
  "key-metrics",
  JSON.stringify(
    results.metrics.filter((m) =>
      [
        "fpsAverage",
        "fpsMin",
        "frameTimeP95Ms",
        "drawCallsMax",
        "drawCallsAverage",
        "jsHeapUsedMB",
        "renderScale",
      ].includes(m.name),
    ),
  ),
);
await page.screenshot({ path: `${ARTIFACTS}/p1-world-28-beauty.png` });

// ---------- 世界质感证据 ----------
results.world = await page.evaluate(() => window.P1WorldDebug.getWorldEvidence());
console.log("world-evidence", JSON.stringify(results.world, null, 2));

// ---------- 撞树被挡 ----------
results.treeProbe = await page.evaluate(() => window.P1WorldDebug.probeCollision(-20, -15.5));
console.log("tree-probe", JSON.stringify(results.treeProbe));

// ---------- 灌木可穿 + 进入半透明 ----------
results.bushWalk = await page.evaluate(async () => {
  const w = window.P1WorldDebug;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  w.moveTo(-5.5, 6);
  for (let i = 0; i < 120; i++) {
    await nextFrame();
    const snap = w.getSnapshot().entities.find((e) => e.id === "entity:player");
    if (snap && snap.movement === null) break;
  }
  for (let i = 0; i < 4; i++) await nextFrame();
  const world = w.getWorldEvidence();
  return {
    position: w.getMeshPosition("entity:player"),
    bushOcclusion: world.bushOcclusion,
    playerAlpha: world.playerAlpha,
  };
});
console.log("bush-walk", JSON.stringify(results.bushWalk, null, 2));
await page.screenshot({ path: `${ARTIFACTS}/p1-world-28-bush-occlusion.png` });

// ---------- 移动不被挡死 ----------
results.moveCheck = await page.evaluate(async () => {
  const w = window.P1WorldDebug;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const start = w.getMeshPosition("entity:player");
  const targets = [
    { x: 4, z: 0 },
    { x: 7, z: 0 },
    { x: 9, z: -0.5 },
    { x: 12, z: -0.5 },
    { x: 15, z: -0.5 },
  ];
  const trail = [];
  for (const t of targets) {
    w.moveTo(t.x, t.z);
    for (let i = 0; i < 60; i++) {
      await nextFrame();
      const p = w.getMeshPosition("entity:player");
      if (p) trail.push({ x: p.x, z: p.z });
      const snap = w.getSnapshot().entities.find((e) => e.id === "entity:player");
      if (snap && snap.movement === null) break;
    }
  }
  const end = w.getMeshPosition("entity:player");
  let stuck = true;
  for (let i = 8; i < trail.length; i++) {
    if (Math.hypot(trail[i].x - trail[i - 8].x, trail[i].z - trail[i - 8].z) > 0.05) {
      stuck = false;
      break;
    }
  }
  return {
    start,
    end,
    moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(3)),
    stuck,
    samples: trail.length,
  };
});
console.log("move-check", JSON.stringify(results.moveCheck, null, 2));

// ---------- NPC 待机 ----------
results.npcIdle = await page.evaluate(async () => {
  const w = window.P1WorldDebug;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const start = {
    ma: w.getMeshPosition("npc:elder_ma"),
    lin: w.getMeshPosition("npc:scout_lin"),
  };
  let paced = 0;
  for (let i = 0; i < 400; i++) {
    await nextFrame();
    paced = Math.max(paced, w.getWorldEvidence().npcPacingCount);
  }
  return {
    start,
    end: {
      ma: w.getMeshPosition("npc:elder_ma"),
      lin: w.getMeshPosition("npc:scout_lin"),
    },
    paced,
    npcIdleCount: w.getWorldEvidence().npcIdleCount,
  };
});
console.log("npc-idle", JSON.stringify(results.npcIdle, null, 2));

// ---------- 四方向截图 + 角落亮度 ----------
const directions = [
  { name: "north", alpha: -Math.PI / 4 },
  { name: "east", alpha: 0 },
  { name: "south", alpha: Math.PI / 4 },
  { name: "west", alpha: Math.PI / 2 },
];
const cornerChecks = [];
for (const dir of directions) {
  await page.evaluate((alpha) => {
    const scene = window.P0HarnessDebug.scene;
    if (scene.activeCamera) scene.activeCamera.alpha = alpha;
  }, dir.alpha);
  await sleep(700);
  const luminance = await page.evaluate(() => {
    const scene = window.P0HarnessDebug.scene;
    const gl = scene.getEngine()._gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const sample = (fx, fy) => {
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(w * fx), Math.floor(h * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return Number(((0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255).toFixed(3));
    };
    return {
      bottomLeft: sample(0.02, 0.03),
      bottomRight: sample(0.98, 0.03),
      bottomCenter: sample(0.5, 0.03),
      topLeft: sample(0.02, 0.97),
      topRight: sample(0.98, 0.97),
      topCenter: sample(0.5, 0.97),
    };
  });
  const path = `${ARTIFACTS}/p1-world-28-landscape-${dir.name}.png`;
  await page.screenshot({ path });
  cornerChecks.push({ direction: dir.name, luminance, path });
}
results.corners = cornerChecks;
console.log("corner-luminance", JSON.stringify(cornerChecks, null, 2));

// ---------- 汇总落盘 ----------
results.pageErrors = await page.evaluate(() => window.__errors ?? []);
console.log("page-errors", JSON.stringify(results.pageErrors));

const metricValue = (name) => results.metrics.find((m) => m.name === name)?.value ?? null;
const reportFile = {
  schemaVersion: 1,
  ticket: "28-world-texture",
  layer: "L4-ego-browser",
  generatedAt: new Date().toISOString(),
  scenario: "p1-world",
  status: results.measure.status,
  environment: {
    url: SCENARIO_URL,
    viewport: await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    })),
  },
  results,
  assertions: {
    meshedFourKinds:
      results.world.meshedPartCount > 0 &&
      results.world.colliderKinds.join(",") === "barrel,crate,stone-wall,tree-large",
    treeBlocks: results.treeProbe.blocked === true && results.treeProbe.blockedBy !== null,
    bushPassable:
      results.bushWalk.position.x === -5.5 &&
      results.bushWalk.position.z === 6 &&
      results.bushWalk.bushOcclusion.bushId === "prop.bush.south-west" &&
      results.bushWalk.playerAlpha < 1,
    movementNotStuck: results.moveCheck.stuck === false && results.moveCheck.moved > 5,
    npcIdle: results.npcIdle.paced > 0 && results.npcIdle.npcIdleCount === 2,
    fogOn: results.world.fogEnabled === true,
    singleKeyLight: results.world.enabledLightCount === 1,
    noBlackVoid: results.corners.every((corner) =>
      Object.values(corner.luminance).every((value) => value > 0.2),
    ),
    budget:
      (metricValue("fpsAverage") ?? 0) >= 59.5 &&
      (metricValue("drawCallsMax") ?? 999) <= 350 &&
      (metricValue("jsHeapUsedMB") ?? 9999) <= 1500,
  },
};
await fs.writeFile(REPORT, JSON.stringify(reportFile, null, 2));
console.log("report", REPORT, JSON.stringify(reportFile.assertions, null, 2));

await task.finish({ keep: "all" });
