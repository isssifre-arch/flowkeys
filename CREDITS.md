# 第三方资源与致谢

本项目使用了以下第三方资源，感谢作者们的贡献。

## GeneralUser GS（内置音色库）

- 文件：`sounds/GeneralUserGS.sf2`
- 作者：S. Christian Collins
- 主页：<https://schristiancollins.com/generaluser.php>
- 仓库：<https://github.com/mrbumpy409/GeneralUser-GS>

许可摘要：GeneralUser GS 可免费用于个人与商业音乐制作，允许随作品或项目再分发；不得将其作为独立产品出售。本项目按此许可内置该音色库并在本文件与 README 中署名。

## 运行库与框架

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [Three.js r128](https://threejs.org/) | 3D 键盘渲染 | MIT |
| [VexFlow 3.0.9](https://www.vexflow.com/) | 五线谱渲染 | MIT |
| [Tauri 2](https://tauri.app/) | 桌面应用外壳 | MIT / Apache-2.0 |
| [tauri-plugin-single-instance](https://github.com/tauri-apps/plugins-workspace) | 单实例运行 | MIT / Apache-2.0 |

Three.js 与 VexFlow 通过 CDN 加载；桌面构建内嵌前端资源，离线可用。

## 曲目与谱面

- 内置示范曲（如 ABC 歌）的谱面数据为本项目自制。
- 用户导入的 MIDI 曲目归用户所有，不随仓库分发。
- 歌曲配套音频（`songs/*.mp3`）涉及版权，**不包含在本仓库中**，详见 README「自备音频」。
