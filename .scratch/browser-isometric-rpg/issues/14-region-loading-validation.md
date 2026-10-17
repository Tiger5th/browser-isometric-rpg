# 14: 区域加载验证（AssetContainer + Editor git 友好度）

**What to build:** 构造一个中型区域（目标 50MB glTF，程序化填充），通过 AssetContainer 完成后台预载 → addAllToScene → 移除的完整循环，采集加载耗时与内存峰值；安装 Babylon.js Editor v5.5，搭建一个最小项目并提交 git，观察项目文件的 diff 友好度（文本 vs 二进制）。对应 spec user story 7/8。

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** resolved (3b83e8a 合并至 p0-integration)

- [x] 50MB 区域加载耗时/内存峰值数字进报告（实际生成 49.31MB：preload 55.3ms，JS 堆峰值增量 251MB）
- [x] 区域进出循环可演示（加载门掩蔽）——关键发现：addAllToScene <1ms 但首帧 GPU 上传/shader 编译卡 203–233ms，黑场需盖住预热渲染 ~1.1s
- [x] Editor v5.5.2 git 实验完成——**git 友好**：对象为 UUID JSON 文件，幂等保存，移动物体仅 1 行 diff；建议 gitignore preview.png + 大文件 LFS
- [x] 结论：**不触发 LDtk 降级**（ldktDowngradeTriggered: false 已记录）
