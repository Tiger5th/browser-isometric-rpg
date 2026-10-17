# 14: 区域加载验证（AssetContainer + Editor git 友好度）

**What to build:** 构造一个中型区域（目标 50MB glTF，程序化填充），通过 AssetContainer 完成后台预载 → addAllToScene → 移除的完整循环，采集加载耗时与内存峰值；安装 Babylon.js Editor v5.5，搭建一个最小项目并提交 git，观察项目文件的 diff 友好度（文本 vs 二进制）。对应 spec user story 7/8。

**Blocked by:** 10 (项目骨架 + Harness 雏形)

**Status:** ready-for-agent

- [ ] 50MB 区域加载耗时/内存峰值数字进报告
- [ ] 区域进出循环可演示（加载门掩蔽）
- [ ] Editor 项目 git 提交实验完成，diff 友好度有结论
- [ ] 结论：若 Editor git 不友好，显式记录「触发 LDtk 降级」建议
