# conversation-voice 版本记录

插件：`@local/conversation-voice` · 当前版本 **1.0.1** · 详细说明见 [`versions/`](versions/) · 源码仓库 [Hero2112/dsh-conversation-voice](https://github.com/Hero2112/dsh-conversation-voice)

| 版本 | 日期 | 类型 | 一句话 |
|---|---|---|---|
| [1.0.1](versions/v1.0.1.md) | 2026-11-06 | 体验改进 | 摘要默认上限 120 字缩到 20 字；默认语速 0 提到 6（约两倍），念得更短更快 |
| [1.0.0](versions/v1.0.0.md) | 2026-11-06 | 初版 | 每轮对话结束后响一声系统提示音，并用 Windows 语音朗读这一轮最终答复的摘要 |

## 归档位置

每个版本都有一份**冻结快照**（完整可安装）和一份分发包；快照发布后不再改动。

| 版本 | 冻结快照 | 分发包 | 版本文档 |
|---|---|---|---|
| 1.0.1 | `releases/v1.0.1/`（当前安装） | `dist/conversation-voice-1.0.1.zip`（15,066 B，SHA256 `ECD01D30…3C545C`） | [versions/v1.0.1.md](versions/v1.0.1.md) |
| 1.0.0 | `releases/v1.0.0/`（可回滚） | `dist/conversation-voice-1.0.0.zip`（14,890 B，SHA256 `01BC0727…971155`） | [versions/v1.0.0.md](versions/v1.0.0.md) |

## 未发布

- 客户端设置面板（开关、发音人下拉、语速/音量滑块、试听）。
- 静音时段。
- macOS / Linux 支持。

## 迁移说明

无。插件不写文件、不改设置、不动会话数据，因此没有需要迁移的存储键。
