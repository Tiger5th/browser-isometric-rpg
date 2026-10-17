/**
 * 环境贴图白底抠除（票 25）。
 *
 * Gemini 生成的立面物件贴图是 1024×765、白底、无 alpha 的单件图。
 * 直接做 billboard 会露出白色方块，因此在加载时把「与图片边缘连通的近白像素」
 * 置为透明：
 * - 只抠与边缘连通的白色，物件内部的白色高光不会被误伤；
 * - 用洪水填充（栈式、TypedArray）而不是逐像素阈值，保持边缘封闭区域完整。
 *
 * 纯数据函数，不依赖 DOM，可在 vitest 中直测。
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA，长度 = width × height × 4。 */
  data: Uint8ClampedArray;
}

export interface KeyOutOptions {
  /** 三通道都不低于该值才视为白色背景。 */
  threshold?: number;
  /** 通道最大差值上限；避免把浅黄色/浅绿色误判成白。 */
  maxChroma?: number;
}

export interface KeyOutResult {
  removedPixels: number;
  totalPixels: number;
  transparentRatio: number;
}

/** 判断某个像素是否满足近白条件（不读 alpha）。 */
export function isNearWhite(
  r: number,
  g: number,
  b: number,
  threshold: number,
  maxChroma: number,
): boolean {
  if (r < threshold || g < threshold || b < threshold) {
    return false;
  }
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  return max - min <= maxChroma;
}

/**
 * 从四条边向内洪水填充，把与边缘连通的近白像素 alpha 置 0。
 * 返回值用于日志/报告（抠除了多少像素）。
 */
export function keyOutNearWhiteBackground(
  image: RgbaImage,
  options: KeyOutOptions = {},
): KeyOutResult {
  const threshold = options.threshold ?? 232;
  const maxChroma = options.maxChroma ?? 14;
  const { width, height, data } = image;
  const totalPixels = width * height;
  if (totalPixels === 0) {
    return { removedPixels: 0, totalPixels: 0, transparentRatio: 0 };
  }

  // 用 alpha=0 作为 visited 标记；输入贴图默认完全不透明。
  const stack = new Int32Array(totalPixels);
  let stackSize = 0;
  let removedPixels = 0;

  const tryPush = (pixelIndex: number): void => {
    const offset = pixelIndex * 4;
    if (data[offset + 3] === 0) {
      return;
    }
    if (
      !isNearWhite(
        data[offset],
        data[offset + 1],
        data[offset + 2],
        threshold,
        maxChroma,
      )
    ) {
      return;
    }
    data[offset + 3] = 0;
    removedPixels += 1;
    stack[stackSize] = pixelIndex;
    stackSize += 1;
  };

  for (let x = 0; x < width; x += 1) {
    tryPush(x);
    tryPush((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    tryPush(y * width);
    tryPush(y * width + width - 1);
  }

  while (stackSize > 0) {
    stackSize -= 1;
    const pixelIndex = stack[stackSize];
    const x = pixelIndex % width;
    const y = (pixelIndex - x) / width;
    if (x > 0) {
      tryPush(pixelIndex - 1);
    }
    if (x + 1 < width) {
      tryPush(pixelIndex + 1);
    }
    if (y > 0) {
      tryPush(pixelIndex - width);
    }
    if (y + 1 < height) {
      tryPush(pixelIndex + width);
    }
  }

  return {
    removedPixels,
    totalPixels,
    transparentRatio: totalPixels > 0 ? removedPixels / totalPixels : 0,
  };
}
