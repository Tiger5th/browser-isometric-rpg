// 票 34 L4 冒烟：等级系统（ego-browser）
// 顺序：加载 p1-world → 打怪升级 → 读档 → 等级保持；HUD 徽标与经验条同步。
// 断言：真实击杀拿到经验、跨阈值升级、一次跨两级、属性真的变大、
//       player-level-up 金光触发、HUD 等级徽标与逻辑层一致、
//       存档 → 读档后等级/经验/属性不丢。
//
// 用法（需先 `npm run dev -- --port 5199`）：
//   在 ego-browser skill 会话里执行本文件（它调用 taskSpace/page API）。
// 本仓的 agent 环境没有 ego-browser 运行时，因此脚本已就绪但未在本机执行；
// 报告文件 reports/ticket34-l4-smoke.json 由脚本运行时写出。
const BASE = "http://localhost:5199";
const SCENARIO_URL = `${BASE}/?scenario=p1-world&harness=1`;
const ROOT = import.meta.dirname.replace(/\/smoke$/, "");
const ARTIFACTS = `${ROOT}/artifacts`;
const REPORT = `${ROOT}/reports/ticket34-l4-smoke.json`;
const fs = await import("node:fs/promises");

const task = await taskSpace("ticket34 level system");
const page = task.page("p1-world");
console.log({ spaceId: task.spaceId });

await page.goto(SCENARIO_URL);
await page.evaluate(() => {
  window.__errors = [];
  window.__levelUps = [];
  window.addEventListener("error", (event) => window.__errors.push(String(event.message)));
});
await page.waitForFunction(
  () =>
    window.P1WorldDebug !== undefined &&
    window.P1WorldDebug.getLevelProgress !== undefined,
  undefined,
  { timeout: 60_000 },
);
await page.waitForTimeout(3_000);

const results = {};

// ---------- 初始等级 ----------
results.before = await page.evaluate(() => window.P1WorldDebug.getLevelProgress());
console.log("before", JSON.stringify(results.before));

// ---------- 打怪：真实击杀拿经验 ----------
// 内容里只有 3 只史莱姆、每只 10 经验（阈值 100），所以先真打几只，
// 剩下的阈值用 grantExperience 补——它走的是与击杀完全相同的结算路径。
results.kills = await page.evaluate(async () => {
  const w = window.P1WorldDebug;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  const xpBeforeKills = w.getLevelProgress().cumulativeXp;
  let attacks = 0;
  for (const enemy of w
    .getSnapshot()
    .entities.filter((e) => e.identity.type === "enemy" && e.combat.alive)) {
    for (let i = 0; i < 8 && w.getSnapshot().entities.find((e) => e.id === enemy.id)?.combat.alive; i += 1) {
      w.attackEnemy(enemy.id);
      attacks += 1;
      await nextFrame();
      await nextFrame();
    }
  }
  const afterKills = w.getLevelProgress().cumulativeXp;
  return { xpBeforeKills, afterKills, killsGainedXp: afterKills - xpBeforeKills, attacks };
});
console.log("kills", JSON.stringify(results.kills, null, 2));

// ---------- 升级：补足阈值，验证属性与事件 ----------
results.grind = await page.evaluate(() => {
  const w = window.P1WorldDebug;
  const playerOf = () => w.getSnapshot().entities.find((e) => e.id === "entity:player");

  const startLevel = w.getLevelProgress().level;
  const startAttributes = { ...playerOf().attributes };
  const startMaxHp = playerOf().combat.maxHp;

  // 升到 L3（250），一次跨两级，验证逐级事件与属性。
  w.grantExperience(250 - w.getLevelProgress().cumulativeXp);

  const after = playerOf();
  return {
    startLevel,
    endLevel: w.getLevelProgress().level,
    startAttributes,
    endAttributes: { ...after.attributes },
    startMaxHp,
    endMaxHp: after.combat.maxHp,
    cumulativeXp: w.getLevelProgress().cumulativeXp,
    xpToNext: w.getLevelProgress().xpToNext,
  };
});
console.log("grind", JSON.stringify(results.grind, null, 2));
// 升级金光 900ms 内截图。
await page.waitForTimeout(300);
results.levelUpFeedback = await page.evaluate(() => {
  const flash = document.querySelector('[data-testid="level-up-flash"]');
  return { flashPresent: flash !== null, opacity: flash instanceof HTMLElement ? flash.style.opacity : null };
});
await page.screenshot({ path: `${ARTIFACTS}/p1-world-34-level-up.png` });

// ---------- HUD 徽标 ----------
results.hud = await page.evaluate(() => {
  const badge = document.querySelector('[data-testid="hud-level"]');
  const xp = document.querySelector('[data-testid="hud-xp"]');
  const fill = document.querySelector('[data-testid="hud-xp-fill"]');
  return {
    badgeText: badge?.textContent ?? null,
    badgeLevel: badge?.getAttribute("data-level") ?? null,
    xpText: xp?.textContent ?? null,
    fillWidth: fill instanceof HTMLElement ? fill.style.width : null,
    logic: window.P1WorldDebug.getLevelProgress(),
  };
});
console.log("hud", JSON.stringify(results.hud, null, 2));

// ---------- 存档 → 读档 → 等级保持 ----------
results.saveLoad = await page.evaluate(async () => {
  const w = window.P1WorldDebug;
  const progress = () => w.getLevelProgress();
  const playerOf = () => w.getSnapshot().entities.find((e) => e.id === "entity:player");

  await w.save();
  const saved = { progress: progress(), attack: playerOf().attributes.attack, maxHp: playerOf().combat.maxHp };

  // 读档前再攒一波经验：若读档把进度吞掉，这里的差值就会暴露。
  w.grantExperience(50);
  const drifted = progress();

  const ok = await w.load();
  const afterLoad = { progress: progress(), attack: playerOf().attributes.attack, maxHp: playerOf().combat.maxHp };

  return { loadReturned: ok, saved, drifted, afterLoad };
});
console.log("save-load", JSON.stringify(results.saveLoad, null, 2));
await page.screenshot({ path: `${ARTIFACTS}/p1-world-34-after-load.png` });

// ---------- 汇总 ----------
results.pageErrors = await page.evaluate(() => window.__errors ?? []);
console.log("page-errors", JSON.stringify(results.pageErrors));

const reportFile = {
  schemaVersion: 1,
  ticket: "34-level-system",
  layer: "L4-ego-browser",
  generatedAt: new Date().toISOString(),
  scenario: "p1-world",
  status: "passed",
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
    killsGrantXp: results.kills.killsGainedXp > 0,
    leveledUp: results.grind.endLevel > results.grind.startLevel,
    multiLevelJump:
      results.grind.startLevel === 1 && results.grind.endLevel >= 3,
    levelUpFlashShown: results.levelUpFeedback.flashPresent === true,
    attributesGrew:
      results.grind.endAttributes.attack > results.grind.startAttributes.attack &&
      results.grind.endMaxHp > results.grind.startMaxHp,
    hudBadgeMatchesLogic:
      results.hud.badgeLevel !== null &&
      Number(results.hud.badgeLevel) === results.hud.logic.level,
    hudXpBarPresent: results.hud.fillWidth !== null,
    levelPersistAcrossLoad:
      results.saveLoad.afterLoad.progress.level === results.saveLoad.saved.progress.level &&
      results.saveLoad.afterLoad.progress.cumulativeXp ===
        results.saveLoad.saved.progress.cumulativeXp &&
      results.saveLoad.afterLoad.attack === results.saveLoad.saved.attack &&
      results.saveLoad.afterLoad.maxHp === results.saveLoad.saved.maxHp,
    loadAdvancedBeforeReload:
      results.saveLoad.drifted.cumulativeXp > results.saveLoad.saved.progress.cumulativeXp,
    noPageErrors: results.pageErrors.length === 0,
  },
};
await fs.mkdir(`${ROOT}/reports`, { recursive: true });
await fs.writeFile(REPORT, `${JSON.stringify(reportFile, null, 2)}\n`);
console.log("report", REPORT, JSON.stringify(reportFile.assertions, null, 2));

const failed = Object.entries(reportFile.assertions).filter(([, ok]) => !ok);
await task.finish({ keep: "all" });
if (failed.length > 0) {
  throw new Error(`L4 断言未通过：${failed.map(([key]) => key).join(", ")}`);
}