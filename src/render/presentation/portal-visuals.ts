/**
 * 区域出口的视觉标记（票 37 验收修复）。
 *
 * 诊断：`exit:cave_mouth` 在 (0,19) 没有任何视觉——出口区域是「零视觉」：
 * 没有网格、没有标记，地面也只有一条没延伸到出口的土路（ground.dirt.south
 * 止于 z≈15）。玩家不知道南边有洞口，切区只能靠盲走。
 *
 * 这里给每个 exit 建一组程序化标记（不引入新资产管线，走 prop-mesh-builder
 * 同款的 MeshBuilder 配方思路）：
 *   - 洞口本体：两侧岩壁 + 上方岩檐拼出的「门框」网格（硬碰撞由 layout 决定，
 *     这里只负责画出来）；
 *   - 地面提示圈：一圈淡入的圆盘，把「这里能走/这里有东西」讲清楚；
 *   - 头顶浮动标记：NPC 头顶式的气泡标记（箭头朝下 + 名称），
 *     玩家远远扫一眼就知道南边有去处；
 *   - 脉冲光环：绕洞口缓慢呼吸的一圈，提示「这里是通路」。
 *
 * 全部用同一个 StandardMaterial + 顶点色实例化，网格数固定在 5 个/出口
 * （draw call 预算敏感，见 DRAW_CALL_BUDGET）。
 */

import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

/** 洞口门框的总宽（米）：比路宽，给「这是个洞」的体量感。 */
export const PORTAL_WIDTH = 5;
/** 洞口门框的总高（米）。 */
export const PORTAL_HEIGHT = 3.2;
/** 岩檐厚度（米）。 */
export const PORTAL_LINTEL = 0.6;
/** 岩壁厚度（米）：做薄一点，避免在等距视角下糊成一整块挡板。 */
export const PORTAL_PILLAR = 0.55;
/** 地面提示圈半径（米）：略大于 EXIT_TRIGGER_RADIUS（1.6），玩家站进去就该触发。 */
export const PORTAL_GROUND_RING_RADIUS = 2.1;
/** 头顶标记离地高度（米）。 */
export const PORTAL_MARKER_HEIGHT = 4.6;
/** 脉冲光环的缩放振幅（相对基准半径）。 */
export const PORTAL_PULSE_AMPLITUDE = 0.12;
/** 脉冲周期（毫秒）。 */
export const PORTAL_PULSE_PERIOD_MS = 2_600;

/** 一个出口标记的全部零件（纯数据，可无引擎直测）。 */
export interface PortalPart {
  /** 稳定 id：`${exitId}.${kind}`，场景里也用作网格名后缀。 */
  id: string;
  kind: "pillar-left" | "pillar-right" | "lintel" | "ground-ring" | "marker" | "pulse";
  /** 相对出口位置的偏移（米）。 */
  offset: { x: number; y: number; z: number };
  /** 尺寸（米）。 */
  size: { width: number; height: number; depth: number };
}

/** 出口 id → 显示名（头顶标记用）。 */
const PORTAL_LABELS: Record<string, string> = {
  "exit:cave_mouth": "史莱姆巢穴",
};

/**
 * 纯函数：按出口位置算出标记的全部零件。
 *
 * 单独拆出来是为了「存在性」可断言：不需要起 Babylon 场景就能验证
 * 每个出口确实被分配了洞口几何、地面圈与头顶标记。
 */
export function portalPartsFor(
  exitId: string,
  position: { x: number; z: number },
): PortalPart[] {
  const halfWidth = PORTAL_WIDTH / 2;
  const pillarY = PORTAL_HEIGHT / 2;
  return [
    {
      id: `${exitId}.pillar-left`,
      kind: "pillar-left",
      offset: { x: position.x - halfWidth, y: pillarY, z: position.z },
      size: { width: PORTAL_PILLAR, height: PORTAL_HEIGHT, depth: PORTAL_PILLAR * 1.6 },
    },
    {
      id: `${exitId}.pillar-right`,
      kind: "pillar-right",
      offset: { x: position.x + halfWidth, y: pillarY, z: position.z },
      size: { width: PORTAL_PILLAR, height: PORTAL_HEIGHT, depth: PORTAL_PILLAR * 1.6 },
    },
    {
      id: `${exitId}.lintel`,
      kind: "lintel",
      offset: { x: position.x, y: PORTAL_HEIGHT - PORTAL_LINTEL / 2, z: position.z },
      size: { width: PORTAL_WIDTH, height: PORTAL_LINTEL, depth: PORTAL_PILLAR * 1.6 },
    },
    {
      id: `${exitId}.ground-ring`,
      kind: "ground-ring",
      offset: { x: position.x, y: 0.02, z: position.z },
      size: { width: PORTAL_GROUND_RING_RADIUS * 2, height: 0.04, depth: PORTAL_GROUND_RING_RADIUS * 2 },
    },
    {
      id: `${exitId}.marker`,
      kind: "marker",
      offset: { x: position.x, y: PORTAL_MARKER_HEIGHT, z: position.z },
      size: { width: 1.9, height: 0.95, depth: 0.24 },
    },
    {
      id: `${exitId}.pulse`,
      kind: "pulse",
      offset: { x: position.x, y: 0.03, z: position.z },
      size: { width: PORTAL_GROUND_RING_RADIUS * 2, height: 0.02, depth: PORTAL_GROUND_RING_RADIUS * 2 },
    },
  ];
}

export interface PortalVisual {
  root: TransformNode;
  exitId: string;
  /** 全部零件网格（evidence API 直接读 meshCount）。 */
  meshes: Mesh[];
  /** 呼吸的光环网格（每帧改 scaling）。 */
  pulse: Mesh | null;
  /** 头顶标记网格（漂浮动画用）。 */
  marker: Mesh | null;
  /** 脉冲相位基准（确定性，不用随机）。 */
  phase: number;
}

/**
 * 扁平自发光材质。
 *
 * 洞口走 disableLighting（和 landscape-ring 的远景同一套）：场景只有一盏
 * DirectionalLight，纯 StandardMaterial 的背光面会渲染成纯黑（实测洞口
 * 是一坨黑块，还把站在后面的玩家糊住）。远处/标记类构件不需要真实光照。
 */
function material(scene: Scene, name: string, hex: string, alpha: number): StandardMaterial {
  const value = Color3.FromHexString(hex);
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = value;
  mat.specularColor = Color3.Black();
  mat.emissiveColor = value;
  mat.disableLighting = true;
  mat.alpha = alpha;
  return mat;
}

/**
 * 头顶标记的贴图：名字 + 朝下箭头。
 *
 * 原来是一块纯色板子（远看是一根黄条），不告诉玩家「这是什么」。
 * DynamicTexture 现画，2D canvas 上写中文 + ▼，零新资产。
 */
function markerTexture(scene: Scene, name: string, label: string): DynamicTexture {
  const width = 256;
  const height = 128;
  const texture = new DynamicTexture(name, { width, height }, scene, true);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, width, height);
  // 圆角底板
  ctx.fillStyle = "rgba(15, 23, 42, 0.78)";
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 5;
  const radius = 26;
  ctx.beginPath();
  ctx.roundRect(8, 8, width - 16, height - 16, radius);
  ctx.fill();
  ctx.stroke();
  // 箭头（朝下，指向洞口）
  ctx.fillStyle = "#fbbf24";
  ctx.beginPath();
  ctx.moveTo(width / 2, height - 30);
  ctx.lineTo(width / 2 - 22, height - 60);
  ctx.lineTo(width / 2 + 22, height - 60);
  ctx.closePath();
  ctx.fill();
  // 名字
  ctx.fillStyle = "#fde68a";
  ctx.font = "bold 42px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, width / 2, 46);
  texture.update();
  texture.hasAlpha = true;
  return texture;
}

/**
 * 建一个出口的完整视觉（网格 + 材质 + 呼吸动画数据）。
 *
 * 材质按零件分组：岩壁/岩檐共用岩石材质，地面圈与光环共用淡入材质，
 * 头顶标记用发光材质（始终朝向相机，billboard）。
 */
export function createPortalVisual(
  scene: Scene,
  root: TransformNode,
  exitId: string,
  position: { x: number; z: number },
  index = 0,
): PortalVisual {
  const node = new TransformNode(`portal.${exitId}`, scene);
  node.parent = root;

  const rock = material(scene, `portal.${exitId}.rock`, "#5b5346", 1);
  const glow = material(scene, `portal.${exitId}.glow`, "#7dd3fc", 0.45);
  const markerMat = material(scene, `portal.${exitId}.marker`, "#fde68a", 1);
  const markerTex = markerTexture(scene, `portal.${exitId}.marker.texture`, portalLabelFor(exitId));
  markerMat.diffuseTexture = markerTex;
  markerMat.emissiveTexture = markerTex;
  const marker = markerMat;

  const meshes: Mesh[] = [];
  let pulse: Mesh | null = null;
  let markerMesh: Mesh | null = null;

  for (const part of portalPartsFor(exitId, position)) {
    let mesh: Mesh;
    switch (part.kind) {
      case "ground-ring":
      case "pulse": {
        // 圆盘（极矮的圆柱）当作地面提示圈。
        mesh = MeshBuilder.CreateCylinder(
          `environment.portal.${part.id}`,
          {
            height: part.size.height,
            diameter: part.size.width,
            tessellation: 24,
          },
          scene,
        );
        mesh.material = glow;
        break;
      }
      case "marker": {
        // 头顶标记：NPC 气泡式浮动板（billboard 面向相机）。
        mesh = MeshBuilder.CreatePlane(
          `environment.portal.${part.id}`,
          { width: part.size.width, height: part.size.height },
          scene,
        );
        mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
        mesh.material = marker;
        markerMesh = mesh;
        break;
      }
      default:
        mesh = MeshBuilder.CreateBox(
          `environment.portal.${part.id}`,
          { width: part.size.width, height: part.size.height, depth: part.size.depth },
          scene,
        );
        mesh.material = rock;
        // 门框是「立着的岩壁」，底面不该被看到；反向背面剔除省一半三角。
        mesh.flipFaces(!(part.offset.x < position.x));
        break;
    }
    mesh.position.set(part.offset.x, part.offset.y, part.offset.z);
    mesh.parent = node;
    mesh.isPickable = false;
    // 提示圈与光环是半透明自发光，不参与遮挡描边。
    if (part.kind === "ground-ring" || part.kind === "pulse") {
      mesh.renderingGroupId = 1;
    }
    meshes.push(mesh);
    if (part.kind === "pulse") {
      pulse = mesh;
    }
  }

  return { root: node, exitId, meshes, pulse, marker: markerMesh, phase: index * 0.37 };
}

/** 每帧推进：光环呼吸 + 头顶标记上下漂浮（确定性相位，无随机）。 */
export function advancePortalVisual(
  visual: PortalVisual,
  elapsedMs: number,
  dtMs: number,
): void {
  void dtMs;
  if (visual.pulse !== null) {
    const phase = ((elapsedMs + visual.phase * PORTAL_PULSE_PERIOD_MS) % PORTAL_PULSE_PERIOD_MS) /
      PORTAL_PULSE_PERIOD_MS;
    const scale = 1 + Math.sin(phase * Math.PI * 2) * PORTAL_PULSE_AMPLITUDE;
    visual.pulse.scaling.set(scale, 1, scale);
  }
  if (visual.marker !== null) {
    visual.marker.position.y =
      PORTAL_MARKER_HEIGHT + Math.sin((elapsedMs / 900 + visual.phase) * Math.PI * 2) * 0.12;
  }
}

/** 出口 id 的显示名（头顶标记的文案；缺省回落到 id 尾段）。 */
export function portalLabelFor(exitId: string): string {
  const known = PORTAL_LABELS[exitId];
  if (known !== undefined) {
    return known;
  }
  const tail = exitId.split(":").pop() ?? exitId;
  return tail;
}
