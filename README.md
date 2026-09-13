# 流光钢琴 FlowKeys

用 MIDI 键盘跟弹学琴的桌面应用：3D 琴键可视化 + 五线谱 / 简谱 / 钢琴块 + 内置 SoundFont 音源（无需宿主）。

![主界面](docs/screenshot-main.png)

![设置面板](docs/screenshot-settings.png)

![跟弹谱面](docs/screenshot-follow.png)

## 功能

**弹奏**
- 3D 琴键键盘（可拖拽旋转 / 滚轮缩放 / 点击试音），按下即高亮并显示音名（音名 / 唱名 / 简谱 / MIDI 四种格式）
- 电脑键盘 A-K 弹奏（无需外接 MIDI 键盘），支持 ±2 八度
- 力度感应：硬件键盘的快按/慢按动态，内置轻触 / 标准 / 重锤三档力度曲线
- 打击垫 8 音色、旋钮可视化；延音踏板指示

**音色**
- 内置 SoundFont 引擎（.sf2 直读）：默认内置 GeneralUser GS 音色包，288 个音色可选，带搜索与收藏
- 三种音色输出：内置合成器 / SoundFont 音色包 / 外部 MIDI 端口（接你的 VST、宿主或硬件音源）
- 支持加载任意本地 .sf2 音色包；SF2 混响（轻/中/大三档）
- 长按自然衰减（钢琴式），不再无限延音

**跟弹与练习**
- 曲库：内置示范曲 + 本地 MIDI 批量导入 + 在线搜索导入（BitMidi）
- 四种谱面：五线谱 / 简谱 / 钢琴块 / 无谱纯跟弹
- 跟弹模式：不限速度，按自己的节奏，流光提示下一个键
- 跟弹难度 5 档（邻近键容错）；评分结算（连击 / 星级）
- 分段循环 A-B、0.25x-1x 变速、左右手分离练习（针对导入曲目的旋律/伴奏声部）
- 录音回放：录制弹奏（含踏板）并回放

**其他**
- 设置按分类整理：外观 / 音色 / 跟弹练习 / 键盘弹奏 / 录音 / 通用
- 背景主题四套；诊断信息一键复制
- 所有新增功能默认关闭，可在设置里自由开启

## 下载安装

到 [Releases](../../releases) 下载最新版本：

| 文件 | 说明 |
| --- | --- |
| `FlowKeys-portable-vX.X.X.exe` | 便携版：双击直接用，免安装 |
| `FlowKeys-setup-vX.X.X.exe` | 安装包：安装到系统（开始菜单 / 卸载项） |

系统要求：Windows 10 / 11（依赖系统自带 WebView2；老系统可安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)）。

> 应用未做代码签名，首次运行 Windows SmartScreen 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。

## 使用提示

- 连接 MIDI 键盘后打开应用会自动识别；没接键盘也能用电脑键盘（A-K 键）或鼠标弹
- 「设置 → 音色」里选择 SoundFont 音色包，可搜索 / 收藏音色；打击垫自动使用鼓组
- 「曲目」跟弹：「跟弹」不限速度练指法，「曲目」按节拍演奏评分
- 「设置 → 跟弹练习」可开启评分结算、分段循环、左右手分离

### 自备音频（可选）

为保证仓库体积与版权合规，歌曲配套音频（`app/songs/*.mp3`）不随仓库分发。谱面数据完整可用；如需伴奏，把与谱面同名的 mp3 放进 `app/songs/` 即可（例如 `xiaoban.mp3`）。

## 技术栈

- 前端：原生 JavaScript + [Three.js](https://threejs.org/)（3D 键盘）+ [VexFlow](https://www.vexflow.com/)（五线谱）+ Web Audio / Web MIDI
- 桌面：Tauri 2（Rust）
- 音源：自研极简 SF2 解析/播放引擎（`app/src/sf2Player.js`）+ 内置合成器

## 目录结构

```
app/                 前端（被桌面端内嵌）
  index.html         主页面：3D 键盘 / 设置 / 录音 / 诊断
  src/
    createKeyboardModel.js  3D 键盘建模
    soundEngine.js          内置合成器
    sf2Player.js            SoundFont 引擎
    followPlay.js           曲库 / 谱面 / 跟弹 / 导入
  songs/             曲库（谱面 JSON；音频需自备）
  sounds/            内置音色包
src-tauri/           桌面外壳（Rust / Tauri）
tests/               Playwright 冒烟测试脚本
docs/                截图等
```

## 本地开发

前端（任意静态服务器，例如）：

```bash
python -m http.server 9200 --directory app
# 浏览器打开 http://127.0.0.1:9200/index.html
```

桌面端（需要 Rust + MSVC 构建环境）：

```bash
cd src-tauri
cargo tauri dev      # 开发模式（前端需先在 9200 端口起服务）
cargo tauri build    # 打包 NSIS 安装包
```

## 测试

`tests/` 下是按功能拆分的 Playwright 冒烟脚本（需自备 Playwright 环境）：

```bash
python -m http.server 9200 --directory app
node tests/features.js
```

## 定制与联系

- 定制开发 / 功能需求 / 问题反馈：**348741976@qq.com**（邮箱同号 QQ）
- 也欢迎直接在 GitHub 提 [Issue](../../issues)

## 版权与致谢

第三方资源（音色库、框架）见 [CREDITS.md](CREDITS.md)。代码以 [MIT](LICENSE) 协议开源。

> 声明：本项目为个人学习作品，键盘外观与交互设计借鉴自 **M-VAVE SMK-25** MIDI 键盘，仅作学习交流与致敬之用，与 M-VAVE 官方无任何关联。
