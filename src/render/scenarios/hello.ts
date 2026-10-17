import { Camera } from "@babylonjs/core/Cameras/camera";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";

import { GREYBOX_REGION_ID } from "../greybox";
import type { ScenarioDefinition } from "../harness";

const BEACON_MESH_NAME = "entity.hello-beacon";
const BEACON_MATERIAL_NAME = "material.hello-beacon";

/**
 * Hello scenario：验证「场景注册 → 灰盒渲染 → 指标采集 → JSON 报告」全链路。
 * 同时演示 setup/teardown 生命周期与 Region/Entity 登记扩展点。
 */
export const helloScenario: ScenarioDefinition = {
  name: "hello",
  description: "P0Harness 冒烟：正交灰盒场景、场景注册与统一报告输出",

  setup(context) {
    const { scene } = context;

    const material = new StandardMaterial(BEACON_MATERIAL_NAME, scene);
    material.diffuseColor = new Color3(0.9, 0.72, 0.2);
    material.emissiveColor = new Color3(0.45, 0.32, 0.05);
    material.specularColor = Color3.Black();

    const beacon = MeshBuilder.CreateBox(
      BEACON_MESH_NAME,
      { width: 0.8, height: 0.8, depth: 0.8 },
      scene,
    );
    beacon.position.set(-4.5, 1.6, 4.5);
    beacon.rotation.y = Math.PI / 4;
    beacon.material = material;

    context.registerRegion(GREYBOX_REGION_ID);
    for (const mesh of scene.meshes) {
      if (mesh.name.startsWith("entity.")) {
        context.registerEntity(mesh.name);
      }
    }
  },

  measure(context) {
    const { scene } = context;
    const camera = scene.activeCamera;
    const isOrthographic = camera?.mode === Camera.ORTHOGRAPHIC_CAMERA ? 1 : 0;

    return [
      {
        name: "cameraOrthographic",
        value: isOrthographic,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      { name: "regionCount", value: context.regions.size, unit: "regions" },
      { name: "entityCount", value: context.entities.size, unit: "entities" },
      { name: "meshCount", value: scene.meshes.length, unit: "meshes" },
      { name: "activeMeshCount", value: scene.getActiveMeshes().length, unit: "meshes" },
    ];
  },

  teardown(context) {
    const { scene } = context;
    scene.getMeshByName(BEACON_MESH_NAME)?.dispose();
    scene.getMaterialByName(BEACON_MATERIAL_NAME)?.dispose();
  },
};
