# 对话完成播报（Conversation Voice）v1.0.0

> **GitHub 仓库**：https://github.com/Hero2112/dsh-conversation-voice （私有）

DeepSeek Harness 的 **Host 插件**：每一轮对话结束后，先响一声 Windows 系统提示音，
再用系统自带的语音引擎朗读这一轮**最终答复的摘要**——人离开屏幕也能知道任务做完了什么。

不需要打开任何面板，也没有客户端界面：装上就生效，前台窗口失焦、浏览器标签被切走都照样出声。

## 它怎么判断「对话结束」

DSH 每完成一轮对话，会往会话日志里追加一个 `turn/end` 事件。插件监听这个事件：

| 情况 | 是否播报 |
|---|---|
| 正常完成（`reason.kind = completed`） | 播报 |
| 输出达到 token 上限（`max-tokens`） | 播报 |
| 用户中断（`aborted`）、报错（`error`）、被拦截（`blocked`） | 不播报 |
| 子代理会话（子任务自己的回合） | 不播报，避免一个任务响好几次 |
| 上一轮刚结束、下一轮马上开始（如目标模式自动续跑） | 延迟 0.9 秒判断，新一轮已开始就取消上一轮的播报 |

## 它念什么

取这一轮**最后一条带文字的 assistant 消息**，做三步处理：

1. **清洗 Markdown**：去掉代码块、图片、表格线、标题和列表符号、强调符号、表情符号；
   链接只留文字，表格竖线换成空格。
2. **截断**：默认最多 120 字，尽量切在句号 / 问号 / 分号处。
3. **加前缀**：默认「任务完成。」，然后交给语音引擎念出来。

例子：最终答复是「已完成：把 3 个 SKU 的价格表整理进 `价格表.xlsx`，并生成了对比页。」
听到的是：*任务完成。已完成 把 3 个 SKU 的价格表整理进 价格表 xlsx 并生成了对比页。*

> 摘要就是答复的开头，不额外调用模型，所以**零 token 消耗、零等待**。
> 如果这一轮最终答复没有文字（例如只调用了工具），就只播提示音 + 「任务完成。」

## 声音从哪来

- **提示音**：Windows 自带系统声音（`System.Media.SystemSounds`），默认 `Asterisk`。
- **语音**：Windows SAPI（`System.Speech.Synthesis`），用 `powershell.exe` 启动，
  文本以 Base64 传输，避开引号 / 换行 / 中文编码问题。
- **发音人**：默认自动挑第一个中文语音（中文 Windows 自带「Microsoft Huihui Desktop」）；
  也可以在配置里按名称指定。
- **不占用 DSH 的模型和工具**：整个过程只是拉起一个本地 PowerShell 进程。

## 安装

1. 解压 `conversation-voice-1.0.0.zip`，得到 `conversation-voice/` 文件夹，放到一个固定位置
   （例如 `F:\Z AirDisk_Obsidian_3DPrint_营销推广\插件\conversation-voice\`）。
2. 让 Agent 安装：`plugin_manager` → `install_bundle`，`target` 填这个文件夹的**绝对路径**。
3. 装好后下一轮对话结束就会出声，一般不用重启；如果没反应，完全退出 DSH 再启动一次。

详细步骤和排错见 [INSTALL.md](INSTALL.md)。

## 配置（高级，可选）

默认值就能用。要改的话，在 profile 的 `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- insert:
    - id: conversation-voice
      name: '@local/conversation-voice'
      config:
        maxChars: 60
        prefix: '搞定。'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 等于只装不响 |
| `chime` | `true` | 是否先响提示音 |
| `chimeSound` | `Asterisk` | 系统声音：`Asterisk` / `Beep` / `Exclamation` / `Hand` / `Question` |
| `speech` | `true` | 是否朗读摘要；关掉就只剩提示音 |
| `voice` | 空 | 发音人名称，空 = 自动挑中文语音 |
| `rate` | `0` | 语速，-10 到 10 |
| `volume` | `95` | 音量，0 到 100 |
| `maxChars` | `120` | 摘要最多多少字，20 到 500 |
| `prefix` | `任务完成。` | 朗读前缀，可清空 |
| `debounceMs` | `900` | 回合结束后等多久再播报，0 到 10000 毫秒 |
| `skipSubagent` | `true` | 是否跳过子代理会话 |
| `onlyCompleted` | `true` | 是否只播正常完成的回合 |

### 查本机有哪些发音人

```powershell
Add-Type -AssemblyName System.Speech
(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
  ForEach-Object { $_.VoiceInfo.Name + '  |  ' + $_.VoiceInfo.Culture.Name }
```

把想要的 `VoiceInfo.Name` 填进 `voice` 即可。

## 用到的 Harness 能力

| 能力 | 用途 |
|---|---|
| `ctx.on('session/event')` | 监听每一轮对话的 `turn/end` 事件 |
| `session.deriveMessages()` | 取这一轮最后一条 assistant 文字消息做摘要 |
| `session.header.parentSession` | 判断是不是子代理会话，决定跳过 |
| `node:child_process.spawn` | 拉起 `powershell.exe` 播放提示音并朗读 |

只用 Host 侧 API，不改 DSH 的文件、设置和会话数据；读会话只读不写。

## 数据和隐私

- 不写任何文件，不发起网络请求，不调用模型。
- 会话内容只在本机内存里清洗成一句摘要，交给本机 PowerShell 朗读，不离开电脑。
- 不修改、不删除任何会话数据。

## 已知限制

- **只支持 Windows**：依赖 Windows SAPI 和系统声音。macOS / Linux 上插件加载后不播报。
- **中文优先**：自动模式优先选中文语音；系统没装中文语音时会用默认发音人朗读，中文可能念不准。
- **只念开头**：摘要最多 `maxChars` 字，长答复的细节听不到。
- **多个会话同时完成**：串行播报，只保留最新一条待播摘要，避免叠音。
- **不做静音时段**：没有「夜间静音」之类的计划，需要的话下一版加。

## 目录

```
conversation-voice/
├── README.md  CHANGELOG.md  INSTALL.md（dev 里也有）
├── versions/v1.0.0.md          这一版说明
├── releases/v1.0.0/            冻结快照（安装用）
├── dist/conversation-voice-1.0.0.zip
├── dev/                        下一版工作副本
└── tests/
    ├── run.cjs                 行为冒烟测试（假 ctx + 假 spawn，24 项）
    └── check-manifest.cjs      清单 / 本地化 / 图标 / 补丁静态检查（8 项）
```

## 开发与验证

```powershell
node --check dev/index.js
node tests/run.cjs
node tests/check-manifest.cjs
```

真实出声验证：临时写一个不入库的小脚本，调用 `buildSpeechCommand` 并用真实 `spawn`
播一次，退出码 0 表示 PowerShell 脚本语法和语音引擎都正常（1.0.0 已这样验过）。
