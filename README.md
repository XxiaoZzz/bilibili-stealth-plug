# Bilibili Stealth Picture-in-Picture

一个给 B 站网页版视频使用的“透明隐身画中画”工具：在 B 站视频页点击扩展按钮后，视频会被交给本地 Electron 小窗播放。这个小窗支持跨标签页、跨应用置顶，并且在鼠标移出窗口时把整个原生窗口变成透明状态并暂停视频，鼠标移回窗口时恢复显示并继续播放。

> 这个项目不是改 Chrome/Edge 自带的画中画外壳。浏览器原生 PiP 不开放窗口透明度控制，所以本项目采用“浏览器扩展 + 本地 Electron 透明窗口”的组合实现。

## 功能特性

- 在 B 站视频页播放器控制栏注入“透明”按钮。
- 点击后把当前视频链接发送给本地 Electron helper。
- Electron 创建无边框、透明背景、置顶的小窗。
- 鼠标移出小窗：整个窗口 `opacity = 0`，实现真正隐藏，并自动暂停视频。
- 鼠标移入小窗：窗口恢复 `opacity = 1`，并继续播放由隐身模式自动暂停的视频。
- 支持播放/暂停、当前时间、可拖动进度条、总时长。
- 支持弹幕视觉开关：通过隐藏/显示常见 B 站弹幕 DOM 容器实现。
- 支持 `CommandOrControl + Shift + B` 强制恢复透明窗口。
- 支持 macOS 和 Windows。

## 项目结构

```text
.
├── bilibili-stealth-pip-extension/   # Chrome/Edge Manifest V3 扩展
│   ├── manifest.json                 # 扩展配置
│   ├── background.js                 # 向本地 helper 发送打开请求
│   ├── content.js                    # 在 B 站播放器里注入“透明”按钮
│   ├── styles.css                    # 扩展按钮和提示样式
│   └── README.md                     # 扩展单独说明
├── bilibili-stealth-pip-native/      # Electron 本地透明置顶小窗
│   ├── package.json                  # Electron 项目配置
│   ├── package-lock.json             # npm 锁定文件
│   ├── src/main.js                   # 主进程：HTTP 桥接、窗口透明、置顶、鼠标检测
│   ├── src/preload.js                # 注入 B 站页：控制条、进度条、弹幕开关
│   └── README.md                     # 本地 helper 单独说明
├── .gitignore
└── README.md                         # 当前文件
```

## 工作原理

```mermaid
flowchart LR
  A[Chrome/Edge B 站视频页] --> B[扩展 content.js 注入“透明”按钮]
  B --> C[background.js 请求 127.0.0.1:39877/open]
  C --> D[Electron main.js 本地 HTTP bridge]
  D --> E[透明/无边框/置顶 BrowserWindow]
  E --> F[preload.js 注入控制条]
  F --> G[鼠标移出: setOpacity(0) + pause()]
  F --> H[鼠标移入: setOpacity(1) + play()]
```

浏览器扩展只负责把当前 B 站视频 URL 交给本地程序。真正的透明和置顶由 Electron 原生窗口完成。

## 使用前准备

### 需要的软件

- Chrome 或 Edge 浏览器。
- Node.js 和 npm。
- Git，只有你想把项目上传到 GitHub 时才需要。

### 推荐版本

- Node.js 18 或更新版本。
- Chrome / Edge 最新稳定版。
- Electron 依赖会通过 `npm install` 自动安装。

## macOS 保姆级使用教程

### 第 1 步：确认 Node.js 是否安装

打开“终端”，输入：

```bash
node -v
npm -v
```

如果能看到类似下面的版本号，说明已经安装：

```text
v20.x.x
10.x.x
```

如果提示 `command not found`，请先安装 Node.js：

1. 打开 [https://nodejs.org/](https://nodejs.org/)。
2. 下载 LTS 版本。
3. 一路下一步安装。
4. 重新打开终端，再执行 `node -v` 和 `npm -v`。

### 第 2 步：安装本地 Electron helper 依赖

进入项目里的本地 helper 目录：

```bash
cd "/Users/你的用户名/项目所在目录/bilibili-stealth-pip-native"
npm install
```

如果你已经在项目根目录，可以直接运行：

```bash
cd bilibili-stealth-pip-native
npm install
```

### 第 3 步：启动本地 helper

```bash
npm start
```

看到下面这行就说明启动成功：

```text
[Bilibili Stealth PiP Native] listening on http://127.0.0.1:39877
```

这个终端窗口不要关。关掉后扩展就无法唤起透明小窗。

### 第 4 步：安装浏览器扩展

1. 打开 Chrome 或 Edge。
2. 地址栏输入：

```text
chrome://extensions/
```

Edge 用户也可以输入：

```text
edge://extensions/
```

3. 打开右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择项目目录里的：

```text
bilibili-stealth-pip-extension
```

### 第 5 步：使用透明画中画

1. 打开任意 B 站视频页，例如：

```text
https://www.bilibili.com/video/BV12ZFoe8Ek4/
```

2. 刷新页面，等待播放器加载完成。
3. 在播放器底部控制栏找到“透明”按钮。
4. 点击“透明”。
5. Electron 透明小窗会打开并播放当前视频。
6. 鼠标移出小窗：窗口完全透明，视频自动暂停。
7. 鼠标移回小窗：窗口恢复显示，视频继续播放。
8. 鼠标移入小窗底部：显示播放/暂停、进度条、弹幕开关。

### macOS 快捷键

如果窗口透明后找不到了，按：

```text
Command + Shift + B
```

会强制恢复窗口显示。

## Windows 保姆级使用教程

### 第 1 步：确认 Node.js 是否安装

打开 PowerShell 或 Windows Terminal，输入：

```powershell
node -v
npm -v
```

如果能看到版本号，说明已安装。

如果提示不是内部或外部命令：

1. 打开 [https://nodejs.org/](https://nodejs.org/)。
2. 下载 LTS 版本 Windows 安装包。
3. 双击安装，一路下一步。
4. 安装完成后重新打开 PowerShell。
5. 再执行：

```powershell
node -v
npm -v
```

### 第 2 步：复制项目到 Windows

把下面两个目录和根目录文件复制到 Windows 电脑：

```text
bilibili-stealth-pip-extension
bilibili-stealth-pip-native
README.md
```

不要直接复用 macOS 上的 `node_modules`。Windows 上必须重新执行 `npm install`。

### 第 3 步：安装本地 helper 依赖

在 PowerShell 中进入本地 helper 目录。假设项目放在桌面：

```powershell
cd "$env:USERPROFILE\Desktop\bilibili-stealth-pip-native"
npm install
```

如果你的项目在别的位置，就把路径换成你的实际路径。

### 第 4 步：启动本地 helper

```powershell
npm start
```

看到下面这行说明启动成功：

```text
[Bilibili Stealth PiP Native] listening on http://127.0.0.1:39877
```

如果 Windows 防火墙弹出提示，请允许本地访问。这个程序只监听本机地址：

```text
127.0.0.1:39877
```

### 第 5 步：安装 Chrome/Edge 扩展

Chrome：

```text
chrome://extensions/
```

Edge：

```text
edge://extensions/
```

然后：

1. 打开“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 选择：

```text
bilibili-stealth-pip-extension
```

### 第 6 步：使用透明画中画

1. 保持 `npm start` 的 PowerShell 窗口运行。
2. 打开 B 站视频页。
3. 刷新页面。
4. 点击播放器底部的“透明”按钮。
5. 透明小窗出现后，鼠标移出窗口会隐藏并暂停，移回会恢复并继续播放。
6. 鼠标移入小窗底部可以拖动进度条。

### Windows 快捷键

如果窗口透明后找不到了，按：

```text
Ctrl + Shift + B
```

会强制恢复窗口显示。

## 常见问题

### 1. 点击“透明”后提示本地小窗未启动

说明 Electron helper 没有运行。请先执行：

```bash
cd "你的项目路径/bilibili-stealth-pip-native"
npm start
```

然后刷新 B 站页面再试。

### 2. 端口 39877 被占用

说明可能已经有一个旧 helper 在运行。

macOS 可尝试：

```bash
lsof -ti tcp:39877 | xargs kill
npm start
```

Windows PowerShell 可尝试：

```powershell
netstat -ano | findstr :39877
```

找到 PID 后结束对应进程：

```powershell
taskkill /PID 你的PID /F
npm start
```

### 3. 鼠标移出后窗口透明并暂停了，但找不到窗口

macOS：

```text
Command + Shift + B
```

Windows：

```text
Ctrl + Shift + B
```

### 4. 视频黑屏或没有加载

建议按顺序处理：

1. 关闭当前 Electron helper。
2. 重新运行 `npm start`。
3. 刷新 B 站视频页。
4. 等网页播放器正常开始播放后再点击“透明”。

### 5. 进度条不显示

控制条只在鼠标移入小窗时显示。把鼠标移动到小窗底部即可看到。

### 6. 弹幕开关不生效

弹幕开关通过隐藏 B 站页面里的常见弹幕容器实现。如果 B 站改版导致 DOM 类名变化，可能需要更新 `bilibili-stealth-pip-native/src/preload.js` 里的弹幕选择器。

### 7. 为什么不用浏览器自带画中画？

Chrome/Edge 原生 PiP 不提供窗口透明度控制。网页或扩展只能控制 PiP 里的内容，不能控制系统 PiP 外壳，所以无法真正做到“整个窗口透明”。

## 开发说明

### 本地启动

```bash
cd bilibili-stealth-pip-native
npm install
npm start
```

### 语法检查

```bash
node --check bilibili-stealth-pip-extension/background.js
node --check bilibili-stealth-pip-extension/content.js
npm run check --prefix bilibili-stealth-pip-native
```

### 重新加载扩展

修改扩展文件后，需要到：

```text
chrome://extensions/
```

点击当前扩展卡片上的“重新加载”，然后刷新 B 站视频页。

修改 Electron 文件后，需要停止 `npm start`，再重新运行。

## 安全与隐私

- 本地 helper 只监听 `127.0.0.1:39877`，不对局域网开放。
- 扩展只匹配 `https://www.bilibili.com/video/*`。
- 扩展发送给本地 helper 的主要数据是当前 B 站视频 URL。
- 默认建议把 GitHub 仓库设为 private，确认无敏感信息后再改 public。

## 当前限制

- 需要本地 Electron helper 常驻运行。
- B 站改版后，播放器按钮位置或弹幕 DOM 选择器可能需要更新。
- Windows 上如果安全软件拦截本地服务，需要允许 `127.0.0.1:39877`。
- 透明窗口为原生窗口效果，不是 Chrome 自带 PiP。

## 许可协议

本项目使用 [MIT License](./LICENSE) 开源。

你可以自由使用、复制、修改、合并、发布、分发、再授权或销售本项目的副本，但需要在副本或重要部分中保留原始版权声明和许可证声明。
