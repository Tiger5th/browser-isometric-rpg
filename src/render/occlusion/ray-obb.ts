/**
 * 射线-OBB 相交（P0 遮挡描边方案，票 13/25 复用）。
 *
 * 标量实现、零对象分配：场景每帧对「角色 × 遮挡盒」调用，
 * 不产生临时 Vector3 / 数组，避免 GC 长帧（P0 的 scene.pick 曾触发）。
 *
 * 纯数学模块，不依赖 Babylon；Vector3 结构兼容（都有 x/y/z）。
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface OccluderBox {
  center: Vec3Like;
  axisX: Vec3Like;
  axisY: Vec3Like;
  axisZ: Vec3Like;
  halfX: number;
  halfY: number;
  halfZ: number;
}

/**
 * 射线从 origin 沿 (dirX,dirY,dirZ) 前进，是否在 [0, maxDistance] 内穿过盒子。
 * dir 不必归一化，但 maxDistance 必须与 dir 的长度使用同一单位。
 */
export function rayIntersectsOccluder(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDistance: number,
  box: OccluderBox,
): boolean {
  const offsetX = originX - box.center.x;
  const offsetY = originY - box.center.y;
  const offsetZ = originZ - box.center.z;
  let tMin = 0;
  let tMax = maxDistance;

  let axis = box.axisX;
  let offset = offsetX * axis.x + offsetY * axis.y + offsetZ * axis.z;
  let direction = dirX * axis.x + dirY * axis.y + dirZ * axis.z;
  if (Math.abs(direction) < 1e-8) {
    if (Math.abs(offset) > box.halfX) {
      return false;
    }
  } else {
    let t1 = (-box.halfX - offset) / direction;
    let t2 = (box.halfX - offset) / direction;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
    if (tMin > tMax) {
      return false;
    }
  }

  axis = box.axisY;
  offset = offsetX * axis.x + offsetY * axis.y + offsetZ * axis.z;
  direction = dirX * axis.x + dirY * axis.y + dirZ * axis.z;
  if (Math.abs(direction) < 1e-8) {
    if (Math.abs(offset) > box.halfY) {
      return false;
    }
  } else {
    let t1 = (-box.halfY - offset) / direction;
    let t2 = (box.halfY - offset) / direction;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
    if (tMin > tMax) {
      return false;
    }
  }

  axis = box.axisZ;
  offset = offsetX * axis.x + offsetY * axis.y + offsetZ * axis.z;
  direction = dirX * axis.x + dirY * axis.y + dirZ * axis.z;
  if (Math.abs(direction) < 1e-8) {
    if (Math.abs(offset) > box.halfZ) {
      return false;
    }
  } else {
    let t1 = (-box.halfZ - offset) / direction;
    let t2 = (box.halfZ - offset) / direction;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
    if (tMin > tMax) {
      return false;
    }
  }

  return true;
}

const UNIT_X: Vec3Like = { x: 1, y: 0, z: 0 };
const UNIT_Y: Vec3Like = { x: 0, y: 1, z: 0 };
const UNIT_Z: Vec3Like = { x: 0, y: 0, z: 1 };

/** 世界轴对齐 OBB（墙体、塔等轴对齐几何）。 */
export function createAxisAlignedBox(
  center: Vec3Like,
  halfX: number,
  halfY: number,
  halfZ: number,
): OccluderBox {
  return {
    center: { x: center.x, y: center.y, z: center.z },
    axisX: UNIT_X,
    axisY: UNIT_Y,
    axisZ: UNIT_Z,
    halfX,
    halfY,
    halfZ,
  };
}

/**
 * 面向相机的 billboard 遮挡盒：
 * axisZ = 相机前向（进入屏幕），axisY = 屏幕上方在三维中的投影，
 * axisX = 屏幕右方。billboard 是一张竖立的平面，深度给半厚即可。
 */
export function createCameraAlignedBox(
  center: Vec3Like,
  forward: Vec3Like,
  halfWidth: number,
  halfHeight: number,
  halfDepth: number,
): OccluderBox {
  const length = Math.hypot(forward.x, forward.y, forward.z) || 1;
  const fx = forward.x / length;
  const fy = forward.y / length;
  const fz = forward.z / length;

  // 屏幕上方 = 世界 Y 减去其在相机前向上的分量。
  const dot = fy;
  let ux = -fx * dot;
  let uy = 1 - fy * dot;
  let uz = -fz * dot;
  const uLength = Math.hypot(ux, uy, uz) || 1;
  ux /= uLength;
  uy /= uLength;
  uz /= uLength;

  // 屏幕右方 = 上方 × 前向。
  const rx = uy * fz - uz * fy;
  const ry = uz * fx - ux * fz;
  const rz = ux * fy - uy * fx;

  return {
    center: { x: center.x, y: center.y, z: center.z },
    axisX: { x: rx, y: ry, z: rz },
    axisY: { x: ux, y: uy, z: uz },
    axisZ: { x: fx, y: fy, z: fz },
    halfX: halfWidth,
    halfY: halfHeight,
    halfZ: halfDepth,
  };
}
