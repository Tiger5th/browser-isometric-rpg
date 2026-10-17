import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
// 注册 Babylon 骨骼 / morph shader include（ShaderStore 副作用导入）。
import "@babylonjs/core/Shaders/ShadersInclude/bonesDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/bonesVertex";
import "@babylonjs/core/Shaders/ShadersInclude/morphTargetsVertexGlobalDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/morphTargetsVertexDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/morphTargetsVertexGlobal";
import "@babylonjs/core/Shaders/ShadersInclude/morphTargetsVertex";

/**
 * 自定义二次元 Toon Shader。
 *
 * Babylon.js 9.31 的核心包与 @babylonjs/materials 都已不再导出 ToonMaterial
 * （旧版 `Materials/toon/toonMaterial` 在 9.x 中移除），因此这里用
 * ShaderMaterial 实现等价效果：
 * - 三阶明暗分层（硬边 + 窄过渡）
 * - 高光/边缘光（rim light）
 * - 顶点色 × baseColor 贴图 × tint
 * - 通过 Babylon 的 bonesDeclaration/bonesVertex include 支持蒙皮
 * - 通过 morphTargets* include 支持表情/眨眼 morph（票 25 清账项）
 * - ALPHATEST：环境 billboard 的白底抠图后做 alpha 裁剪，避免透明排序
 * - UNLIT：环境贴图保留手绘明暗，不再叠加光照
 *
 * 描边由 Mesh.renderOutline 提供（角色）或 HighlightLayer（被遮挡时），
 * 色彩分级由 DefaultRenderingPipeline 提供。
 *
 * morph 说明：ShaderMaterial 会按 mesh.morphTargetManager 自动补齐
 * `MORPHTARGETS_POSITION` / `NUM_MORPH_INFLUENCERS` 定义、`position0..N`
 * 属性和 `morphTargetInfluences` uniform；shader 只需引用 include 链。
 */
export const TOON_VERTEX_SHADER = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
#ifdef USE_VERTEX_COLOR
attribute vec4 color;
#endif

uniform mat4 world;
uniform mat4 viewProjection;

#include<bonesDeclaration>
#include<morphTargetsVertexGlobalDeclaration>
#include<morphTargetsVertexDeclaration>[0..maxSimultaneousMorphTargets]

varying vec2 vUV;
varying vec3 vNormalW;
varying vec3 vPositionW;
#ifdef USE_VERTEX_COLOR
varying vec4 vColor;
#endif

void main() {
  vec3 positionUpdated = position;
  vec3 normalUpdated = normal;

  #include<morphTargetsVertexGlobal>
  #include<morphTargetsVertex>[0..maxSimultaneousMorphTargets]

  mat4 finalWorld = world;
  #include<bonesVertex>

  vec4 worldPos = finalWorld * vec4(positionUpdated, 1.0);
  vPositionW = worldPos.xyz;
  vNormalW = normalize(mat3(finalWorld) * normalUpdated);
  vUV = uv;
#ifdef USE_VERTEX_COLOR
  vColor = color;
#endif
  gl_Position = viewProjection * worldPos;
}
`;

export const TOON_FRAGMENT_SHADER = `
precision highp float;

varying vec2 vUV;
varying vec3 vNormalW;
varying vec3 vPositionW;
#ifdef USE_VERTEX_COLOR
varying vec4 vColor;
#endif

uniform sampler2D baseColorTexture;
uniform vec3 tintColor;
uniform float alphaCutoff;
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform vec3 ambientColor;
uniform vec3 rimColor;
uniform vec3 cameraPosition;
uniform float shadowFloor;
uniform float rimStrength;

void main() {
  vec4 texel = texture2D(baseColorTexture, vUV);
  if (texel.a < alphaCutoff) {
    discard;
  }

#ifdef USE_VERTEX_COLOR
  vec3 base = texel.rgb * vColor.rgb * tintColor;
#else
  // COLOR_0 是可选属性：缺失时 Babylon 会提供 generic attribute (0,0,0,1)，
  // 若无条件相乘会把整个资产乘黑，因此无顶点色时回退为贴图原色。
  vec3 base = texel.rgb * tintColor;
#endif

#ifdef UNLIT
  // 环境 billboard 使用手绘贴图的自带明暗，保留原始色相。
  gl_FragColor = vec4(base, 1.0);
#else
  vec3 normal = normalize(vNormalW);
  vec3 lightDir = normalize(lightDirection);
  float ndl = max(dot(normal, lightDir), 0.0);

  // 三阶色阶：暗部 / 中间调 / 亮部，交界处保留很窄的过渡避免锯齿。
  float band = smoothstep(0.08, 0.11, ndl) * 0.55
             + smoothstep(0.55, 0.58, ndl) * 0.45;
  vec3 lit = base * (ambientColor + lightColor * band);

  // 二次元边缘光：轮廓处偏冷色，增强与背景的分离。
  vec3 viewDir = normalize(cameraPosition - vPositionW);
  float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.2);
  lit += rimColor * rim * rimStrength;

  // 量化高光，模拟赛璐璐材质的硬高光点。
  vec3 halfDir = normalize(lightDir + viewDir);
  float spec = smoothstep(0.94, 0.98, max(dot(normal, halfDir), 0.0));
  lit += vec3(0.85, 0.92, 1.0) * spec * 0.18;

  lit = max(lit, base * shadowFloor);
  gl_FragColor = vec4(lit, 1.0);
#endif
}
`;

export interface ToonMaterialOptions {
  /** mesh 是否带 COLOR_0。缺省属性时不能乘 vColor（generic attribute 为 (0,0,0,1)）。 */
  useVertexColors?: boolean;
  /** 基础色乘数；用于给占位角色/NPC/敌人换色。 */
  tint?: Color3;
  /** 主光方向（指向光源的世界空间单位向量）。 */
  lightDirection?: Vector3;
  lightColor?: Color3;
  ambientColor?: Color3;
  rimColor?: Color3;
  shadowFloor?: number;
  rimStrength?: number;
  /** 透明度裁剪阈值；billboard 白底抠图后必须 > 0 才会丢弃透明像素。 */
  alphaCutoff?: number;
  /** 不参与光照（环境贴图 billboard / 地面平铺）。 */
  unlit?: boolean;
}

export function createToonMaterial(
  scene: Scene,
  name: string,
  baseColorTexture: BaseTexture | null,
  options: ToonMaterialOptions = {},
): ShaderMaterial {
  const material = new ShaderMaterial(
    name,
    scene,
    { vertexSource: TOON_VERTEX_SHADER, fragmentSource: TOON_FRAGMENT_SHADER },
    {
      attributes: ["position", "normal", "uv", "color"],
      uniforms: [
        "world",
        "viewProjection",
        "cameraPosition",
        "tintColor",
        "alphaCutoff",
        "lightDirection",
        "lightColor",
        "ambientColor",
        "rimColor",
        "shadowFloor",
        "rimStrength",
      ],
      samplers: ["baseColorTexture"],
      needAlphaBlending: false,
      // 裁剪完全由 shader 内 discard 完成；不要打开 Babylon 的 ALPHATEST，
      // 否则会自动追加重复的 #define ALPHATEST 并与自定义定义冲突。
      needAlphaTesting: false,
    },
  );

  material.backFaceCulling = true;
  material.setDefine("USE_VERTEX_COLOR", options.useVertexColors ?? true);
  if (options.unlit) {
    material.setDefine("UNLIT", true);
  }
  if (baseColorTexture) {
    material.setTexture("baseColorTexture", baseColorTexture);
  }
  material.setColor3("tintColor", options.tint ?? Color3.White());
  material.setFloat("alphaCutoff", options.alphaCutoff ?? 0);
  material.setVector3(
    "lightDirection",
    options.lightDirection ?? new Vector3(0.7, 1, 0.45).normalize(),
  );
  material.setColor3("lightColor", options.lightColor ?? new Color3(1.0, 0.97, 0.9));
  material.setColor3("ambientColor", options.ambientColor ?? new Color3(0.3, 0.34, 0.45));
  material.setColor3("rimColor", options.rimColor ?? new Color3(0.45, 0.7, 1.0));
  material.setFloat("shadowFloor", options.shadowFloor ?? 0.3);
  material.setFloat("rimStrength", options.rimStrength ?? 0.45);

  return material;
}
