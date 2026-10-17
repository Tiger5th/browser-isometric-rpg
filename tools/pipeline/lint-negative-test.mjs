#!/usr/bin/env node
/**
 * lint 负向自测：构造一个非流形网格，确认加固规则会拦截。
 * 输出：reports/lint-negative-test.json
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";

import { lintAssets } from "./lint.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE = join(process.env.TMPDIR ?? "/tmp", "p0-nonmanifold.glb");

const doc = new Document();
const buffer = doc.createBuffer();
const position = doc
  .createAccessor("attr_prop_nonmanifold_test_position")
  .setType("VEC3")
  .setArray(
    new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, -1, 0,
      0, 0, 1,
    ]),
  )
  .setBuffer(buffer);
const indices = doc
  .createAccessor("attr_prop_nonmanifold_test_indices")
  .setType("SCALAR")
  .setArray(new Uint16Array([0, 1, 2, 0, 1, 3, 1, 0, 4]))
  .setBuffer(buffer);
const primitive = doc
  .createPrimitive("primitive_prop_nonmanifold_test")
  .setAttribute("POSITION", position)
  .setIndices(indices);
const mesh = doc.createMesh("prop_nonmanifold_test").addPrimitive(primitive);
const node = doc.createNode("prop_nonmanifold_test").setMesh(mesh);
const scene = doc.createScene("scene_prop_nonmanifold_test");
scene.addChild(node);
doc.getRoot().setDefaultScene(scene);
await writeFile(FIXTURE, await new NodeIO().writeBinary(doc));

const lintReport = await lintAssets([FIXTURE]);
const file = lintReport.files[0];
const wrapper = {
  schemaVersion: 1,
  purpose: "负向测试：确认非流形/边界边规则会拦截 AI 生成的坏拓扑",
  fixture: "3 个三角共享同一条边（0-1），期望 non-manifold 错误",
  exitExpectation: "failed",
  status: file.status,
  violations: file.violations,
  assertNonManifoldCaught: file.violations.some(
    (item) => item.rule === "non-manifold" && item.severity === "error",
  ),
  raw: lintReport,
};
await writeFile(
  join(ROOT, "reports/lint-negative-test.json"),
  `${JSON.stringify(wrapper, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      status: wrapper.status,
      assertNonManifoldCaught: wrapper.assertNonManifoldCaught,
      violations: wrapper.violations,
    },
    null,
    2,
  ),
);
if (!wrapper.assertNonManifoldCaught) {
  process.exitCode = 1;
}
