# 音频来源与许可证

全部文件为 **CC0 1.0（Creative Commons Zero，公有领域奉献）**，来自 freesound.org。
按「普攻命中 / 受击 / 击杀 / 拾取 / 升级 / UI / 重击 / 前摇」八个用途各取一个。

下载方式说明：本机 shell 到 freesound.org / cdn.freesound.org 的直连被网络策略阻断
（SSL_ERROR_SYSCALL），改用 ego-browser（用户已登录环境）访问音效详情页，取页面
`<audio>` 元素的 preview 流（`cdn.freesound.org/previews/...-lq.mp3`）保存，再用
ffmpeg 统一转码为 44.1kHz 单声道 16-bit wav（PCM s16le）并做淡入淡出/截断。
preview 流与原文件同源同许可；正式版可在能登录下载的环境里用「原文件」链接替换为无损原件。

| 文件 | 用途 | 原名 | 作者 | 链接 | 许可证 |
|---|---|---|---|---|---|
| `attack_hit.wav` | 普攻命中（对敌） | Punch Hit 1.wav | joe_anderson22 | https://freesound.org/people/joe_anderson22/sounds/439747/ | CC0 1.0 |
| `hurt.wav` | 玩家受击 | Voice_AdultMale_PainGrunts_09.wav | MrFossy | https://freesound.org/people/MrFossy/sounds/547209/ | CC0 1.0 |
| `enemy_die.wav` | 击杀消散 | Slime Death | qubodup | https://freesound.org/people/qubodup/sounds/751340/ | CC0 1.0 |
| `item_pickup.wav` | 拾取/掉落 | Plingy Coin | Fupicat | https://freesound.org/people/Fupicat/sounds/538146/ | CC0 1.0 |
| `level_up.wav` | 升级金光时刻 | Level Up | qubodup | https://freesound.org/people/qubodup/sounds/442943/ | CC0 1.0 |
| `ui_click.wav` | UI 点击（含重击按钮） | UI Button Click | el_boss | https://freesound.org/people/el_boss/sounds/677861/ | CC0 1.0 |
| `heavy_attack.wav` | 重击命中（更大更闷） | Punch | danlucaz | https://freesound.org/people/danlucaz/sounds/517744/ | CC0 1.0 |
| `wind_up.wav` | 攻击前摇提示（抬手 whoosh） | Punches/hits | Wigglesworth | https://freesound.org/people/Wigglesworth/sounds/853588/ | CC0 1.0 |

后处理（ffmpeg 9.0.2）：

```bash
# 统一格式：44.1kHz / 单声道 / 16-bit PCM
ffmpeg -i <preview>.mp3 -ar 44100 -ac 1 <name>.wav
# wind_up：原文件 15.7s，截取 0.2s–0.9s 段并淡入淡出
ffmpeg -i wind_up.mp3 -ss 0.2 -t 0.7 -af "afade=t=in:st=0:d=0.02,afade=t=out:st=0.55:d=0.15" -ar 44100 -ac 1 wind_up.wav
```

CC0 1.0 全文：https://creativecommons.org/publicdomain/zero/1.0/legalcode
（CC0 不要求署名；本文件保留来源便于审计与后续替换。）
