/**
 * Babylon 逻辑类在 vitest（node 环境）中的可测边界探测。
 *
 * 本文件故意放在 src/render/ 而不是 src/logic/：
 * 它依赖 Babylon，用于验证「哪些 Babylon 类可以脱离浏览器直测」，
 * 不影响逻辑层零引擎依赖的架构约束。
 */

import { describe, expect, it } from "vitest";

describe("vitest 直测 Babylon 的边界", () => {
  it("深层子路径可导入纯数学类并运行", async () => {
    const startedAt = performance.now();
    const { Matrix, Quaternion, Vector3 } = await import(
      "@babylonjs/core/Maths/math.vector"
    );
    const importMs = performance.now() - startedAt;

    expect(Vector3.Dot(new Vector3(1, 2, 3), new Vector3(4, 5, 6))).toBe(32);
    expect(Vector3.Cross(new Vector3(1, 0, 0), new Vector3(0, 1, 0)).asArray()).toEqual([
      0, 0, 1,
    ]);

    const rotation = Quaternion.RotationYawPitchRoll(Math.PI / 2, 0, 0);
    const rotated = new Vector3(0, 0, 1).applyRotationQuaternion(rotation);
    expect(rotated.x).toBeCloseTo(1);
    expect(rotated.y).toBeCloseTo(0);
    expect(rotated.z).toBeCloseTo(0);

    const transform = Matrix.RotationY(Math.PI / 2);
    const normal = Vector3.TransformNormal(new Vector3(1, 0, 0), transform);
    expect(normal.x).toBeCloseTo(0);
    expect(normal.z).toBeCloseTo(-1);

    console.info(
      `[p0-babylon-boundary] ${JSON.stringify({
        deepMathImportMs: Number(importMs.toFixed(3)),
        feature: "Vector3/Quaternion/Matrix",
        supported: true,
      })}`,
    );
  });

  it("包入口 barrel 导入可用（含副作用模块）", async () => {
    const startedAt = performance.now();
    const babylon = await import("@babylonjs/core");
    const importMs = performance.now() - startedAt;

    expect(babylon.Vector3.Dot(new babylon.Vector3(1, 2, 3), new babylon.Vector3(4, 5, 6))).toBe(
      32,
    );

    console.info(
      `[p0-babylon-boundary] ${JSON.stringify({
        barrelImportMs: Number(importMs.toFixed(3)),
        feature: "@babylonjs/core barrel",
        supported: true,
      })}`,
    );
  });

  it("NullEngine + Scene 可在 node 环境做无渲染场景图测试", async () => {
    const startedAt = performance.now();
    const { NullEngine, Scene, TransformNode, Vector3 } = await import("@babylonjs/core");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const node = new TransformNode("probe", scene);
    node.position = new Vector3(1, 2, 3);

    expect(node.getAbsolutePosition().asArray()).toEqual([1, 2, 3]);
    expect(scene.meshes).toHaveLength(0);

    engine.dispose();

    console.info(
      `[p0-babylon-boundary] ${JSON.stringify({
        nullEngineSceneMs: Number((performance.now() - startedAt).toFixed(3)),
        feature: "NullEngine + Scene + TransformNode",
        supported: true,
      })}`,
    );
  });
});
