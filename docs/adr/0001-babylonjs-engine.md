# ADR-0001: 采用 Babylon.js 作为渲染引擎

日期：2026-10-17　状态：已接受

## 背景

浏览器优先、等距视角、长期扩展的 RPG。候选：Babylon.js、Three.js、PlayCanvas，以及 Godot 4 / Unity / Unreal / 纯 2D 引擎。

## 决策

采用 Babylon.js（当前 9.x，锁定小版本、按季度评估升级）。

## 理由

- 官方内置 Crowd Navigation（navmesh + crowd agents）、Occlusion Queries、GUI、`.babylon` 场景序列化——直接命中寻路、遮挡、UI、地图流式需求，避免自建引擎层。
- WebGPU 一等支持（5.0 起，核心 shader 原生 WGSL），同时向后兼容 WebGL2。
- Apache-2.0，无许可/服务费风险。
- 单一仓库统一治理，文档一致。

## 代价与后果

- npm 生态小于 three.js；发版快（约每周）导致第三方资料易过时——以官方文档为准并锁版本。
- 引擎包体较大——用 tree-shaking（`@babylonjs/core` 按需导入）缓解。
- 渲染管线细节掌控力低于裸 three.js——接受。

## 后续

- 02 号 ticket：等距相机 + crowd nav 的原型验证假设清单。
- 05 号 ticket：资产管线按 Babylon 官方 glTF/KTX2 文档路线。
