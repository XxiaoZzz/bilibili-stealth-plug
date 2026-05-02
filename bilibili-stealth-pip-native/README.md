# Bilibili Stealth PiP Native Helper

这是和 Chrome 扩展配套的 Electron 本地透明置顶窗口。

## 启动

```bash
cd "你的项目路径/bilibili-stealth-pip-native"
npm install
npm start
```

启动后会监听：

```text
http://127.0.0.1:39877
```

扩展会调用：

```text
POST http://127.0.0.1:39877/open
```

请求体示例：

```json
{
  "url": "https://www.bilibili.com/video/BV12ZFoe8Ek4/"
}
```

## 透明行为

- 窗口属性：`transparent: true`、`frame: false`、`alwaysOnTop: true`
- 鼠标移出：`win.setOpacity(0)`，并暂停当前视频
- 鼠标移入：`win.setOpacity(1)`，并恢复播放由隐身模式自动暂停的视频

完全透明后如果一时找不到窗口，可以按 `CommandOrControl+Shift+B` 强制恢复显示。

## 2026-05-02 修复

鼠标移出检测已经改为 Electron 主进程轮询屏幕鼠标坐标和窗口边界，不再依赖网页里的 `mouseleave` 事件。更新代码后必须停止旧的 `npm start` 进程并重新启动，否则仍会运行旧逻辑。

## 小窗控制条

鼠标移入小窗后，底部会出现控制条：播放/暂停、当前时间、可拖动进度条、总时长、弹幕开关。进度条直接控制页面里的 `<video>.currentTime`，不依赖 B 站原控制栏，所以优先级最高。弹幕按钮通过隐藏/显示常见 B 站弹幕容器实现，B 站改版后可能需要更新选择器。
