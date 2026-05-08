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

小窗播放时会持续向主进程上报 `<video>.currentTime`，本地桥接同时提供：

```text
GET http://127.0.0.1:39877/playback-state
```

扩展会轮询这个接口，把小窗最新进度同步回原 B 站网页视频；关闭小窗后再次点击“透明”会从同步后的进度继续。

## 透明行为

- 窗口属性：`transparent: true`、`frame: false`、`alwaysOnTop: true`
- 鼠标移出：`win.setOpacity(0)`，并暂停当前视频
- 鼠标移入：`win.setOpacity(你设置的可见态透明度)`，并恢复播放由隐身模式自动暂停的视频

完全透明后如果一时找不到窗口，可以按 `CommandOrControl+Shift+B` 强制恢复显示。

## 2026-05-02 修复

鼠标移出检测已经改为 Electron 主进程轮询屏幕鼠标坐标和窗口边界，不再依赖网页里的 `mouseleave` 事件。更新代码后必须停止旧的 `npm start` 进程并重新启动，否则仍会运行旧逻辑。

## 小窗控制条

鼠标移入小窗后，底部会出现控制条：播放/暂停、当前时间、可拖动进度条、总时长、倍速按钮、亮度按钮、透明按钮、弹幕开关。进度条直接控制页面里的 `<video>.currentTime`，倍速按钮直接控制 `<video>.playbackRate`，不依赖 B 站原控制栏，所以优先级最高。倍速按钮支持展开菜单后直接选择 `0.75x / 1x / 1.25x / 1.5x / 2x / 3x / 4x / 5x`。亮度按钮在悬停时会弹出垂直滑杆，实时调节小窗视频亮度，范围 `50% ~ 150%`。透明按钮在悬停时会弹出垂直滑杆，实时调节小窗可见状态透明度，范围 `20% ~ 100%`；鼠标移出后依然完全隐藏，鼠标移回后恢复到你设置的透明度。弹幕按钮通过隐藏/显示常见 B 站弹幕容器实现，B 站改版后可能需要更新选择器。
