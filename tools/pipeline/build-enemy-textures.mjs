#!/usr/bin/env node
/**
 * 敌人贴图生成（票 36）。
 *
 * 产出两张 1024×765 白底立面精灵，与环境件同一规格（加载时抠白 + billboard）：
 * - assets/enemies/enemy_charger.png：冲锋型「角冲兽」——俯身前倾的兽形剪影 +
 *   明显的两根前角（识别点：角 + 前倾）。
 * - assets/enemies/enemy_spitter.png：吐弹型「孢囊蟾」——蹲伏蟾形 + 背部三颗
 *   发光孢囊（识别点：圆囊）。
 *
 * 说明：这一版是**程序化色板卡精灵**，不是 Gemini 生成图——生成管线（Gemini 调用 +
 * 色板卡）不在仓库内，先用程序化贴图保证「两种敌人有独立外形贴图」这一条票面
 * 要求可验证（贴图互不相同、可单独替换）。将来换成 Gemini 产物时，只需覆盖
 * assets/enemies/ 下的两张图，artifacts/enemies/ 同步留档即可，代码不动。
 *
 * 用法：node tools/pipeline/build-enemy-textures.mjs
 * 输出：assets/enemies/*.png + artifacts/enemies/*.png（留档）
 */
import { deflateSync } from "node:zlib";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const ASSET_DIR = join(ROOT, "assets/enemies");
const ARTIFACT_DIR = join(ROOT, "artifacts/enemies");

const WIDTH = 1024;
const HEIGHT = 765;

/** 色板卡（与站点的 toon 色阶同源，主色/辅色/点缀）。 */
const PALETTES = {
  charger: {
    main: [0.42, 0.24, 0.18], // 暗红棕躯干
    shade: [0.3, 0.16, 0.12],
    accent: [0.95, 0.86, 0.66], // 骨白角
    eye: [1.0, 0.85, 0.35],
  },
  spitter: {
    main: [0.36, 0.55, 0.3], // 苔绿躯干
    shade: [0.24, 0.4, 0.22],
    accent: [0.75, 0.95, 0.5], // 孢囊荧光
    eye: [0.2, 0.2, 0.25],
  },
};

/** RGBA 画布，白底（与 prop_* 一致，加载时抠白）。 */
function createCanvas() {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
  }
  return data;
}

function blendPixel(data, x, y, color, alpha = 1) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) {
    return;
  }
  const offset = (y * WIDTH + x) * 4;
  for (let channel = 0; channel < 3; channel += 1) {
    data[offset + channel] = Math.round(
      data[offset + channel] * (1 - alpha) + color[channel] * 255 * alpha,
    );
  }
}

/** 实心椭圆（羽化边缘 1px，模拟 toon 描边的软化）。 */
function fillEllipse(data, cx, cy, rx, ry, color, alpha = 1) {
  const minX = Math.max(0, Math.floor(cx - rx) - 1);
  const maxX = Math.min(WIDTH - 1, Math.ceil(cx + rx) + 1);
  const minY = Math.max(0, Math.floor(cy - ry) - 1);
  const maxY = Math.min(HEIGHT - 1, Math.ceil(cy + ry) + 1);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 1) {
        blendPixel(data, x, y, color, alpha);
      } else if (d <= 1.02) {
        blendPixel(data, x, y, color, alpha * (1 - (d - 1) / 0.02));
      }
    }
  }
}

/** 旋转椭圆（冲锋兽的前倾躯干、蟾的蹲伏身体）。 */
function fillRotatedEllipse(data, cx, cy, rx, ry, degrees, color, alpha = 1) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  const reach = Math.ceil(Math.max(rx, ry)) + 2;
  for (let y = Math.max(0, cy - reach); y <= Math.min(HEIGHT - 1, cy + reach); y += 1) {
    for (let x = Math.max(0, cx - reach); x <= Math.min(WIDTH - 1, cx + reach); x += 1) {
      const ox = x - cx;
      const oy = y - cy;
      const lx = (ox * cos - oy * sin) / rx;
      const ly = (ox * sin + oy * cos) / ry;
      const d = Math.sqrt(lx * lx + ly * ly);
      if (d <= 1) {
        blendPixel(data, x, y, color, alpha);
      }
    }
  }
}

/** 锥形（角、爪）。 */
function fillTaper(data, x0, y0, x1, y1, width0, width1, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2;
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    fillEllipse(data, cx, cy, width0 + (width1 - width0) * t, width0 + (width1 - width0) * t, color);
  }
}

function drawCharger(palette) {
  const data = createCanvas();
  // 影子（贴地椭圆，压暗白底 → 抠白后仍保留一层淡影，说明「站在地上」）。
  fillEllipse(data, WIDTH / 2, 700, 250, 34, [0.78, 0.78, 0.8], 0.9);
  // 四条腿（后粗前细）
  fillTaper(data, 380, 470, 340, 690, 34, 22, palette.shade);
  fillTaper(data, 660, 470, 700, 690, 34, 22, palette.shade);
  fillTaper(data, 450, 500, 430, 690, 26, 18, palette.main);
  fillTaper(data, 600, 500, 620, 690, 26, 18, palette.main);
  // 前倾躯干（这是冲锋型的识别姿态）
  fillRotatedEllipse(data, 515, 470, 235, 130, -18, palette.main);
  // 颈 + 头（头更低更前）
  fillRotatedEllipse(data, 720, 400, 105, 78, -22, palette.main);
  fillEllipse(data, 790, 400, 92, 62, palette.main);
  // 两根前角（识别点）
  fillTaper(data, 745, 350, 665, 195, 26, 6, palette.accent);
  fillTaper(data, 800, 350, 800, 180, 24, 6, palette.accent);
  // 眼
  fillEllipse(data, 790, 385, 14, 14, palette.eye);
  fillEllipse(data, 838, 380, 12, 12, palette.eye);
  // 背部鬃刺（暗色三角感）
  for (let index = 0; index < 5; index += 1) {
    fillTaper(data, 380 + index * 62, 360, 400 + index * 62, 275, 20, 4, palette.shade);
  }
  // 尾
  fillTaper(data, 300, 470, 210, 400, 20, 6, palette.shade);
  return data;
}

function drawSpitter(palette) {
  const data = createCanvas();
  fillEllipse(data, WIDTH / 2, 700, 255, 32, [0.78, 0.78, 0.8], 0.9);
  // 后腿（蹲踞）
  fillRotatedEllipse(data, 330, 560, 105, 85, 0, palette.shade);
  fillRotatedEllipse(data, 700, 560, 105, 85, 0, palette.shade);
  // 躯干（宽扁）
  fillRotatedEllipse(data, 512, 570, 250, 135, 0, palette.main);
  // 头（前低）
  fillEllipse(data, 512, 470, 175, 110, palette.main);
  // 背部三颗孢囊（识别点）
  fillEllipse(data, 400, 425, 52, 52, palette.accent);
  fillEllipse(data, 512, 405, 60, 60, palette.accent);
  fillEllipse(data, 624, 425, 52, 52, palette.accent);
  fillEllipse(data, 512, 405, 30, 30, [0.95, 1.0, 0.8], 0.9);
  // 嘴 + 眼
  fillRotatedEllipse(data, 512, 545, 95, 32, 0, palette.shade);
  fillEllipse(data, 445, 455, 24, 24, palette.eye);
  fillEllipse(data, 579, 455, 24, 24, palette.eye);
  fillEllipse(data, 445, 455, 11, 11, [1, 1, 1], 0.85);
  fillEllipse(data, 579, 455, 11, 11, [1, 1, 1], 0.85);
  // 前爪
  fillTaper(data, 370, 600, 320, 680, 26, 16, palette.shade);
  fillTaper(data, 654, 600, 704, 680, 26, 16, palette.shade);
  return data;
}

/* --------------------------- 最小 PNG 编码器 --------------------------- */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba) {
  const stride = WIDTH * 4;
  const raw = Buffer.alloc((stride + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --------------------------------- 主流程 -------------------------------- */
mkdirSync(ASSET_DIR, { recursive: true });
mkdirSync(ARTIFACT_DIR, { recursive: true });

const sprites = {
  "enemy_charger.png": drawCharger(PALETTES.charger),
  "enemy_spitter.png": drawSpitter(PALETTES.spitter),
};

for (const [name, data] of Object.entries(sprites)) {
  const png = encodePng(data);
  writeFileSync(join(ASSET_DIR, name), png);
  copyFileSync(join(ASSET_DIR, name), join(ARTIFACT_DIR, name));
  console.log(`[enemies] ${name} ${WIDTH}×${HEIGHT} ${png.length} bytes`);
}
console.log(`[enemies] 产出 ${Object.keys(sprites).length} 张精灵 → assets/enemies/ 与 artifacts/enemies/`);
