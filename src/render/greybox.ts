import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

/** 灰盒 Region 的稳定标识，供 Harness 场景引用。 */
export const GREYBOX_REGION_ID = "region.greybox";

export interface GreyboxEntity {
  /** 全局唯一 EntityId（GLOSSARY: Entity）。 */
  entityId: string;
  mesh: Mesh;
}

export interface GreyboxRegion {
  regionId: string;
  root: TransformNode;
  entities: GreyboxEntity[];
  dispose: () => void;
}

function createMaterial(
  scene: Scene,
  name: string,
  diffuse: Color3,
  emissive?: Color3,
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse;
  material.specularColor = Color3.Black();
  if (emissive) {
    material.emissiveColor = emissive;
  }
  return material;
}

function createEntity(
  root: TransformNode,
  entityId: string,
  mesh: Mesh,
): GreyboxEntity {
  mesh.name = entityId;
  mesh.parent = root;
  return { entityId, mesh };
}

/**
 * 程序化灰盒 Region：8×8 地块、边界矮墙与四个 Entity。
 * 不依赖任何正式美术资产（P0 灰盒约定）。
 */
export function createGreyboxRegion(scene: Scene): GreyboxRegion {
  const root = new TransformNode(GREYBOX_REGION_ID, scene);

  const tileDark = createMaterial(scene, "material.tile-dark", new Color3(0.2, 0.22, 0.26));
  const tileLight = createMaterial(scene, "material.tile-light", new Color3(0.26, 0.28, 0.32));
  const border = createMaterial(scene, "material.border", new Color3(0.12, 0.14, 0.18));
  const crate = createMaterial(scene, "material.crate", new Color3(0.55, 0.38, 0.2));
  const pillar = createMaterial(scene, "material.pillar", new Color3(0.46, 0.48, 0.53));
  const spawn = createMaterial(
    scene,
    "material.spawn",
    new Color3(0.1, 0.5, 0.6),
    new Color3(0.05, 0.35, 0.45),
  );
  const dummy = createMaterial(scene, "material.dummy", new Color3(0.62, 0.28, 0.32));

  // Region 尺寸 16×16，以原点为中心。
  for (let x = 0; x < 8; x += 1) {
    for (let z = 0; z < 8; z += 1) {
      const tile = MeshBuilder.CreateGround(
        `region.greybox.tile-${x}-${z}`,
        { width: 2, height: 2 },
        scene,
      );
      tile.position.set(x * 2 - 7, 0, z * 2 - 7);
      tile.material = (x + z) % 2 === 0 ? tileDark : tileLight;
      tile.isPickable = false;
      tile.parent = root;
    }
  }

  const borderSpecs: Array<{ name: string; width: number; depth: number; x: number; z: number }> = [
    { name: "border-north", width: 16.4, depth: 0.4, x: 0, z: -8.2 },
    { name: "border-south", width: 16.4, depth: 0.4, x: 0, z: 8.2 },
    { name: "border-west", width: 0.4, depth: 16.4, x: -8.2, z: 0 },
    { name: "border-east", width: 0.4, depth: 16.4, x: 8.2, z: 0 },
  ];
  for (const spec of borderSpecs) {
    const wall = MeshBuilder.CreateBox(
      `region.greybox.${spec.name}`,
      { width: spec.width, height: 0.5, depth: spec.depth },
      scene,
    );
    wall.position.set(spec.x, 0.25, spec.z);
    wall.material = border;
    wall.isPickable = false;
    wall.parent = root;
  }

  const entities: GreyboxEntity[] = [];

  const crateA = MeshBuilder.CreateBox(
    "entity.crate-01",
    { width: 1.2, height: 1.2, depth: 1.2 },
    scene,
  );
  crateA.position.set(-3, 0.6, -2);
  crateA.material = crate;
  entities.push(createEntity(root, "entity.crate-01", crateA));

  const crateB = MeshBuilder.CreateBox(
    "entity.crate-02",
    { width: 1.4, height: 1.4, depth: 1.4 },
    scene,
  );
  crateB.position.set(-1.5, 0.7, -3.2);
  crateB.rotation.y = Math.PI / 6;
  crateB.material = crate;
  entities.push(createEntity(root, "entity.crate-02", crateB));

  const pillarMesh = MeshBuilder.CreateCylinder(
    "entity.pillar-01",
    { diameter: 1, height: 3, tessellation: 12 },
    scene,
  );
  pillarMesh.position.set(3, 1.5, 1);
  pillarMesh.material = pillar;
  entities.push(createEntity(root, "entity.pillar-01", pillarMesh));

  const spawnMesh = MeshBuilder.CreateCylinder(
    "entity.spawn-01",
    { diameter: 2.4, height: 0.08, tessellation: 24 },
    scene,
  );
  spawnMesh.position.set(0, 0.04, 2);
  spawnMesh.material = spawn;
  entities.push(createEntity(root, "entity.spawn-01", spawnMesh));

  const dummyMesh = MeshBuilder.CreateCapsule(
    "entity.dummy-01",
    { radius: 0.35, height: 1.6, tessellation: 8 },
    scene,
  );
  dummyMesh.position.set(2.2, 0.8, 3.4);
  dummyMesh.material = dummy;
  entities.push(createEntity(root, "entity.dummy-01", dummyMesh));

  return {
    regionId: GREYBOX_REGION_ID,
    root,
    entities,
    dispose: () => root.dispose(false, true),
  };
}
