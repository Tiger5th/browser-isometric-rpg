# ADR-0003: 区域 = AssetContainer 单元，加载门起步

日期：2026-10-17　状态：已接受

## 决策

区域为流式加载基本单位：一个区域 = 一个 glTF 文件 + 元数据 JSON（锚点、navmesh、触发器）。后台预载进 AssetContainer（不进场景），进入时 addAllToScene，离开时移除释放。切换体验从加载门（门/电梯/过场）起步。地图构建 = Babylon.js Editor 手工布局 + Node Geometry 程序化地形。

## 理由

- AssetContainer 是官方一等原语，预载/卸载机制与无缝流式共用——升级只改触发方式，不换底层。
- 大坐标精度由官方 Floating Origin 解决，无需自研分块坐标。
- Editor 项目保持「场景文件 + 可重建代码/数据层」双轨，降低社区维护停滞风险；LDtk JSON 为备选中间格式。

## 代价

- 加载门是体验妥协（商业 RPG 可接受形态）。
- Babylon Editor 为社区维护（非核心团队），有降级路径（LDtk）已备。
