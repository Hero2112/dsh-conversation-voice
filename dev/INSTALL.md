# 安装说明（对话完成播报 v1.0.2）

## 一句话

把 `conversation-voice/` 文件夹放到电脑上任意固定位置，让 Agent 用
`plugin_manager` → `install_bundle` 安装这个**文件夹的绝对路径**即可。

## 前置条件

1. **Windows 10 / 11**（插件用 Windows 自带的 SAPI 语音引擎和系统声音）。
2. 系统装了中英文语音。中文 Windows 默认自带「Microsoft Huihui Desktop」；
   查有没有：

   ```powershell
   Add-Type -AssemblyName System.Speech
   (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
     ForEach-Object { $_.VoiceInfo.Name + '  |  ' + $_.VoiceInfo.Culture.Name }
   ```

3. 能听到系统声音（没静音、输出设备正常）。

## 安装步骤

### 方法一：让 Agent 装（推荐）

1. 解压 `conversation-voice-1.0.2.zip`，得到 `conversation-voice/` 文件夹；
   放到一个固定位置，例如：

   ```
   F:\Z AirDisk_Obsidian_3DPrint_营销推广\插件\conversation-voice\
   ```

2. 对 Agent 说：

   > 安装插件 `F:\Z AirDisk_Obsidian_3DPrint_营销推广\插件\conversation-voice\`（install_bundle）

3. Agent 安装成功后会返回 `application: applied`、`warnings: []`。
   插件是 Host 侧热加载的，通常**不用重启**；下一轮对话结束就会响。
   如果没反应，完全退出 DSH 再启动一次（只刷新页面不够，因为这不是客户端插件）。

### 方法二：手动装

DSH 的 profile 目录在 `C:\Users\<用户名>\.dsh\profiles\web\`：

1. 把 `conversation-voice/` 放到一个固定位置（不要放临时目录）。
2. 在 profile 的 `cordis.patch.yml` 末尾加一行：

   ```yaml
   - insert:
       - id: conversation-voice
         name: '@local/conversation-voice'
   ```

3. 让 profile 的 `node_modules` 里能解析到 `@local/conversation-voice`：
   最省事的是还是用 `install_bundle`，它会自动建软链接；手改容易漏。

## 装好之后怎么确认

1. 观察 DSH 日志或让 Agent 查插件列表里有没有 `conversation-voice` 这一行（enabled）。
2. 随便发一条消息，等这一轮回答结束：
   - 先听到一声系统提示音（默认 Windows 的 Asterisk）；
   - 接着听到中文语音念「任务完成。……」，内容是这一轮答复的开头摘要。
3. 如果只响没说话，或者完全没声音，看下面的排错。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 完全没声音 | 确认是 Windows；确认 DSH 是桌面端（Host 进程在这台电脑上）；确认系统没静音 |
| 有提示音但没语音 | `System.Speech` 不可用：用 `powershell.exe`（Windows PowerShell 5.1）手动跑一次 README 里的语音自检 |
| 语音念的是英文腔中文 | 系统没有中文语音，或 `voice` 配错了；按 README 查发音人名称后填 `voice` |
| 一个任务响好几次 | 那是子代理或目标模式的多轮；默认已跳过子代理，目标模式的多轮会在 0.9 秒内合并，可把 `debounceMs` 调大 |
| 不想用了 | `plugin_manager` → `remove_bundle`，卸载插件即可；不会动任何会话数据 |

## 卸载

- Agent：`plugin_manager` → `remove_bundle`，`target` 填 `@local/conversation-voice` 或安装时的包路径。
- 或删掉 profile 里对应的软链接和 `cordis.patch.yml` 里的那一行，然后重启 DSH。

本插件不写文件、不改设置，卸载不会留下数据。
