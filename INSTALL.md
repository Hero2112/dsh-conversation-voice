# 安装 对话完成播报

Windows 10/11 桌面端用的 **Host 插件**，装完就生效，没有界面。

## 1. 下载

到 [Releases](https://github.com/Hero2112/dsh-conversation-voice/releases) 下最新的
`conversation-voice-X.Y.Z.zip`，解压得到一个 `conversation-voice` 文件夹，放固定位置，例如：

```
D:\dsh-plugins\conversation-voice
```

## 2. 让 DSH 装上

对 Agent 说：

> 安装本地插件包，包目录是 `D:\dsh-plugins\conversation-voice`

Host 插件是热加载的，通常不用重启；没声音就**完全退出 DSH 再打开**（只刷新页面不够）。

## 3. 确认

发一条消息，等这一轮回答结束：先一声系统提示音，再用中文语音念这一轮答复的摘要。

没声音就查三件事：是不是 Windows 桌面端、系统有没有静音、系统有没有装中文语音。

## 卸载

让 Agent 卸载这个插件（`remove_bundle`）。插件不写文件、不改设置，卸载不留数据。
