import { describe, expect, it } from "vitest";

import {
  isNearWhite,
  keyOutNearWhiteBackground,
  type RgbaImage,
} from "./texture-key";

function createImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { width, height, data };
}

function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3];
}

describe("白底抠图", () => {
  it("从边缘连通的近白像素被置为透明", () => {
    const image = createImage(5, 5, (x, y) =>
      x >= 1 && x <= 3 && y >= 1 && y <= 3
        ? [200, 40, 40, 255]
        : [253, 253, 253, 255],
    );
    const result = keyOutNearWhiteBackground(image);
    expect(result.removedPixels).toBe(16);
    expect(result.transparentRatio).toBeCloseTo(16 / 25, 5);
    expect(alphaAt(image, 0, 0)).toBe(0);
    expect(alphaAt(image, 2, 2)).toBe(255);
    expect(alphaAt(image, 1, 1)).toBe(255);
  });

  it("被物件包围的内部白色高光不会被误抠", () => {
    const image = createImage(7, 7, (x, y) => {
      const inside = x >= 1 && x <= 5 && y >= 1 && y <= 5;
      const innerWhite = x === 3 && y === 3;
      if (innerWhite) {
        return [255, 255, 255, 255];
      }
      return inside ? [40, 120, 60, 255] : [253, 253, 253, 255];
    });
    keyOutNearWhiteBackground(image);
    expect(alphaAt(image, 3, 3)).toBe(255);
    expect(alphaAt(image, 1, 1)).toBe(255);
    expect(alphaAt(image, 0, 0)).toBe(0);
  });

  it("偏灰/偏色的浅色像素不会被当作背景", () => {
    const image = createImage(3, 3, () => [225, 225, 225, 255]);
    const result = keyOutNearWhiteBackground(image);
    expect(result.removedPixels).toBe(0);
  });

  it("色度保护：浅黄像素不抠，纯白抠", () => {
    expect(isNearWhite(253, 253, 253, 232, 14)).toBe(true);
    expect(isNearWhite(253, 250, 210, 232, 14)).toBe(false);
    expect(isNearWhite(220, 220, 220, 232, 14)).toBe(false);
  });

  it("阈值可配置（更严格的背景定义）", () => {
    const image = createImage(3, 3, () => [240, 240, 240, 255]);
    expect(keyOutNearWhiteBackground(image, { threshold: 232 }).removedPixels).toBe(9);

    const strict = createImage(3, 3, () => [240, 240, 240, 255]);
    expect(
      keyOutNearWhiteBackground(strict, { threshold: 245 }).removedPixels,
    ).toBe(0);
  });

  it("已经透明的像素不会被重复计数", () => {
    const image = createImage(3, 3, () => [253, 253, 253, 0]);
    const result = keyOutNearWhiteBackground(image);
    expect(result.removedPixels).toBe(0);
  });

  it("空图像安全返回", () => {
    const result = keyOutNearWhiteBackground({
      width: 0,
      height: 0,
      data: new Uint8ClampedArray(),
    });
    expect(result).toEqual({
      removedPixels: 0,
      totalPixels: 0,
      transparentRatio: 0,
    });
  });
});
