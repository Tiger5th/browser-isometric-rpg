import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

/**
 * 程序化中型区域：10 块高细分地形 + 若干灰盒地标，导出为 GLB（二进制 glTF）。
 * 目标体积 ~50MB，用于验证 AssetContainer 的单区域加载预算。
 *
 * 体积来源（每块 296 细分）：
 *   顶点 297² = 88,209；索引 296²×6 = 525,696（uint32）
 *   position/normal/uv ≈ 2.82MB + 索引 2.10MB ≈ 4.93MB/块 × 10 ≈ 49.3MB
 */

export const REGION_ASSET_FILE_NAME = "region.mid.glb";
const REGION_FILE_PREFIX = "region.mid";

export const REGION_CHUNK_COUNT = 10;
export const REGION_CHUNK_SUBDIVISIONS = 296;
export const REGION_CHUNK_SIZE = 24;
const REGION_COLUMNS = 5;

/** 区域世界宽度（5 列 × 24）。窄屏时相机需按 aspect 加大竖向 span。 */
export const REGION_CONTENT_WIDTH = REGION_COLUMNS * REGION_CHUNK_SIZE;

/** 相机取景：84 是宽屏下的竖向最小高度，窄屏由 enterRegionDemo 自动加大。 */
export const REGION_VIEW_SPAN = 84;

export interface RegionAssetStats {
  chunkCount: number;
  chunkSubdivisions: number;
  sourceMeshCount: number;
  vertexCount: number;
  triangleCount: number;
  exportMs: number;
  cached: boolean;
}

export interface RegionAsset {
  /** 可直接传给 LoadAssetContainerAsync 的 File（.glb）。 */
  file: File;
  blob: Blob;
  bytes: number;
  stats: RegionAssetStats;
}

let cachedAsset: Promise<RegionAsset> | null = null;

/** 区域资产在页面生命周期内只生成一次；重复运行 scenario 直接复用。 */
export function getRegionAsset(engine: AbstractEngine): Promise<RegionAsset> {
  if (!cachedAsset) {
    cachedAsset = buildRegionAsset(engine).catch((error: unknown) => {
      cachedAsset = null;
      throw error;
    });
  }
  return cachedAsset;
}

export function resetRegionAssetCache(): void {
  cachedAsset = null;
}

export function hasCachedRegionAsset(): boolean {
  return cachedAsset !== null;
}

function terrainHeight(x: number, z: number): number {
  return (
    0.55 * Math.sin(x * 0.21) * Math.cos(z * 0.17) +
    0.28 * Math.sin((x + z) * 0.37) * Math.cos((x - z) * 0.11)
  );
}

function chunkCenter(index: number): { x: number; z: number } {
  const column = index % REGION_COLUMNS;
  const row = Math.floor(index / REGION_COLUMNS);
  return {
    x: (column - (REGION_COLUMNS - 1) / 2) * REGION_CHUNK_SIZE,
    z: (row - 0.5) * REGION_CHUNK_SIZE,
  };
}

function displaceChunk(ground: Mesh, center: { x: number; z: number }): void {
  const positions = ground.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) {
    throw new Error("地形块缺少 position 数据");
  }

  for (let index = 0; index < positions.length; index += 3) {
    // 用世界坐标采样高度，保证相邻地块边缘无缝衔接。
    const x = positions[index] + center.x;
    const z = positions[index + 2] + center.z;
    positions[index + 1] = terrainHeight(x, z);
  }

  ground.updateVerticesData(VertexBuffer.PositionKind, positions);
  ground.createNormals(true);
}

function createTerrainMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  return material;
}

function addLandmarks(scene: Scene): Mesh[] {
  const pillarMaterial = createTerrainMaterial(
    scene,
    "region.mid.material.pillar",
    new Color3(0.62, 0.64, 0.68),
  );
  const beaconMaterial = new StandardMaterial("region.mid.material.beacon", scene);
  beaconMaterial.diffuseColor = new Color3(0.12, 0.62, 0.68);
  beaconMaterial.emissiveColor = new Color3(0.04, 0.38, 0.42);
  beaconMaterial.specularColor = Color3.Black();

  const meshes: Mesh[] = [];
  const landmarkPositions: Array<{ x: number; z: number; emissive: boolean }> = [];
  for (let column = 0; column < REGION_COLUMNS; column += 1) {
    for (const row of [0, 1]) {
      landmarkPositions.push({
        x: (column - (REGION_COLUMNS - 1) / 2) * REGION_CHUNK_SIZE,
        z: (row - 0.5) * REGION_CHUNK_SIZE,
        emissive: column === 2,
      });
    }
  }

  landmarkPositions.forEach((landmark, index) => {
    const pillar = MeshBuilder.CreateCylinder(
      `region.mid.landmark-${index}`,
      { diameter: 1.1, height: landmark.emissive ? 5.2 : 3.4, tessellation: 10 },
      scene,
    );
    pillar.position.set(
      landmark.x,
      terrainHeight(landmark.x, landmark.z) + (landmark.emissive ? 2.6 : 1.7),
      landmark.z,
    );
    pillar.material = landmark.emissive ? beaconMaterial : pillarMaterial;
    meshes.push(pillar);
  });

  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2;
    const x = Math.cos(angle) * 18;
    const z = Math.sin(angle) * 12;
    const crate = MeshBuilder.CreateBox(
      `region.mid.crate-${index}`,
      { width: 1.2, height: 1.2, depth: 1.2 },
      scene,
    );
    crate.position.set(x, terrainHeight(x, z) + 0.6, z);
    crate.rotation.y = angle;
    crate.material = pillarMaterial;
    meshes.push(crate);
  }

  return meshes;
}

async function buildRegionAsset(engine: AbstractEngine): Promise<RegionAsset> {
  const [{ GLTF2Export }] = await Promise.all([
    import("@babylonjs/serializers/glTF"),
    // 副作用注册 glTF loader（loadAssetContainer 依赖）。
    import("@babylonjs/loaders/glTF"),
  ]);

  const sourceScene = new Scene(engine);
  const terrainMaterials = [
    createTerrainMaterial(
      sourceScene,
      "region.mid.material.terrain-a",
      new Color3(0.42, 0.52, 0.36),
    ),
    createTerrainMaterial(
      sourceScene,
      "region.mid.material.terrain-b",
      new Color3(0.36, 0.46, 0.33),
    ),
  ];

  let vertexCount = 0;
  let triangleCount = 0;

  for (let index = 0; index < REGION_CHUNK_COUNT; index += 1) {
    const center = chunkCenter(index);
    const ground = MeshBuilder.CreateGround(
      `region.mid.chunk-${index}`,
      {
        width: REGION_CHUNK_SIZE,
        height: REGION_CHUNK_SIZE,
        subdivisions: REGION_CHUNK_SUBDIVISIONS,
        updatable: true,
      },
      sourceScene,
    );
    ground.position.set(center.x, 0, center.z);
    ground.material = terrainMaterials[index % terrainMaterials.length];
    displaceChunk(ground, center);
    vertexCount += ground.getTotalVertices();
    triangleCount += ground.getTotalIndices() / 3;
  }

  const landmarks = addLandmarks(sourceScene);
  for (const landmark of landmarks) {
    vertexCount += landmark.getTotalVertices();
    triangleCount += landmark.getTotalIndices() / 3;
  }

  const exportStartedAt = performance.now();
  const gltfData = await GLTF2Export.GLBAsync(sourceScene, REGION_FILE_PREFIX, {
    exportWithoutWaitingForScene: true,
    // 区域资产保留 UV，后续替换为真实贴图时无需重新导出几何体。
    exportUnusedUVs: true,
  });
  const exportMs = performance.now() - exportStartedAt;

  const glbBlob = Object.values(gltfData.files).find(
    (entry): entry is Blob => typeof entry !== "string",
  );
  if (!glbBlob) {
    sourceScene.dispose();
    throw new Error("glTF 导出未产出 GLB 数据");
  }

  const sourceMeshCount = sourceScene.meshes.length;
  sourceScene.dispose();

  return {
    file: new File([glbBlob], REGION_ASSET_FILE_NAME, { type: "model/gltf-binary" }),
    blob: glbBlob,
    bytes: glbBlob.size,
    stats: {
      chunkCount: REGION_CHUNK_COUNT,
      chunkSubdivisions: REGION_CHUNK_SUBDIVISIONS,
      sourceMeshCount,
      vertexCount,
      triangleCount,
      exportMs,
      cached: false,
    },
  };
}

/** 缓存命中时把 stats.cached 置为 true，便于报告区分首次导出与复用。 */
export function markAssetCached(asset: RegionAsset): RegionAsset {
  return { ...asset, stats: { ...asset.stats, cached: true } };
}
