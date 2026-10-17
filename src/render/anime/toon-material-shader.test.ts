import { describe, expect, it } from "vitest";

import { TOON_FRAGMENT_SHADER, TOON_VERTEX_SHADER } from "./toonMaterial";

/**
 * 票 25 清账项：toon shader 必须驱动 glTF morph（眨眼）。
 * 这些 include 由 Babylon ShaderMaterial 按 mesh.morphTargetManager
 * 自动补齐 MORPHTARGETS_POSITION / NUM_MORPH_INFLUENCERS 等定义。
 */
describe("toon shader 生产能力", () => {
  it("顶点着色器包含 morph include 链与 positionUpdated 路径", () => {
    expect(TOON_VERTEX_SHADER).toContain("#include<morphTargetsVertexGlobalDeclaration>");
    expect(TOON_VERTEX_SHADER).toContain(
      "#include<morphTargetsVertexDeclaration>[0..maxSimultaneousMorphTargets]",
    );
    expect(TOON_VERTEX_SHADER).toContain("#include<morphTargetsVertexGlobal>");
    expect(TOON_VERTEX_SHADER).toContain(
      "#include<morphTargetsVertex>[0..maxSimultaneousMorphTargets]",
    );
    expect(TOON_VERTEX_SHADER).toContain(
      "vec4 worldPos = finalWorld * vec4(positionUpdated, 1.0)",
    );
    expect(TOON_VERTEX_SHADER).toContain(
      "normalize(mat3(finalWorld) * normalUpdated)",
    );
  });

  it("保留骨骼蒙皮 include", () => {
    expect(TOON_VERTEX_SHADER).toContain("#include<bonesDeclaration>");
    expect(TOON_VERTEX_SHADER).toContain("#include<bonesVertex>");
  });

  it("片元着色器支持 tint / alpha 裁剪 / unlit 环境贴图", () => {
    expect(TOON_FRAGMENT_SHADER).toContain("uniform vec3 tintColor;");
    expect(TOON_FRAGMENT_SHADER).toContain("uniform float alphaCutoff;");
    expect(TOON_FRAGMENT_SHADER).toContain("if (texel.a < alphaCutoff)");
    expect(TOON_FRAGMENT_SHADER).toContain("#ifdef UNLIT");
  });
});
