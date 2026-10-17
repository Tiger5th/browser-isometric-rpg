import { describe, expect, it } from "vitest";

import type { Camera } from "@babylonjs/core/Cameras/camera";

import {
  DEFAULT_CAMERA_VERTICAL_SPAN,
  cameraVerticalSpan,
  updateOrthographicFrustum,
} from "./camera";

function fakeCamera(): Camera {
  return {
    metadata: null,
    orthoTop: 0,
    orthoBottom: 0,
    orthoLeft: 0,
    orthoRight: 0,
  } as unknown as Camera;
}

describe("正交相机可视高度", () => {
  it("updateOrthographicFrustum 记录当前 span，resize 可读取场景自定义值", () => {
    const camera = fakeCamera();

    updateOrthographicFrustum(camera, 16 / 9, 30);

    expect(cameraVerticalSpan(camera)).toBe(30);
    expect(camera.orthoTop).toBe(15);
    expect(camera.orthoBottom).toBe(-15);
  });

  it("没有记录时回落到默认 span", () => {
    const camera = fakeCamera();
    expect(cameraVerticalSpan(camera)).toBe(DEFAULT_CAMERA_VERTICAL_SPAN);
  });
});
