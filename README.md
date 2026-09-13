# FlowKeys 流光钢琴

[简体中文](README.zh-CN.md) ｜ **English** ｜ [한국어](README.ko.md) ｜ [日本語](README.ja.md) ｜ [Русский](README.ru.md) ｜ [Español](README.es.md)

A desktop app for learning piano by following along with your MIDI keyboard: 3D key visualization + staff / numbered / tile notation + built-in SoundFont engine (no host required). UI available in 简体中文 / English / 한국어 / 日本語 / Русский / Español.

![Main view](docs/screenshot-main.png)

![Settings](docs/screenshot-settings.png)

![Follow mode](docs/screenshot-follow.png)

## Features

**Playing**
- 3D keyboard (drag to orbit, scroll to zoom, click to audition); keys light up with note labels (name / solfa / numbered / MIDI)
- Play with your PC keyboard (A-K), incl. ±2 octave shift — no MIDI keyboard required
- Velocity sensitivity: fast/soft key presses on hardware keyboards; three velocity curves (soft / standard / hard)
- 8 drum pads, animated knobs; sustain pedal indicator

**Sound**
- Built-in SoundFont engine (reads .sf2 directly): ships with the GeneralUser GS bank, 288 presets with search & favorites
- Three output modes: built-in synth / SoundFont bank / external MIDI port (your VST, DAW or hardware)
- Load any local .sf2 bank; SF2 reverb (light / medium / large)
- Natural piano-like decay — notes fade out instead of sustaining forever

**Practice**
- Library: built-in songs + batch MIDI import + online search import (BitMidi)
- Four notation modes: staff / numbered / tiles / pure follow
- Follow mode: play at your own pace with a flowing light hinting the next key
- 5 difficulty levels (near-key tolerance); score & results (combo / star rating)
- A-B loop practice, 0.25x–1x speed, left/right-hand separation (for imported songs with an accompaniment voice)
- Record & playback your playing (including pedal)

**Other**
- Settings organized by category: Look / Sound / Practice / Keyboard / Record / General
- Multilingual UI: 简体中文 / English / 한국어 / 日本語 / Русский / Español (Settings → General → Language; auto-detects system language on first launch)
- Four background themes; one-click diagnostics copy
- Every optional feature is off by default — turn on what you need

## Download

Get the latest build from [Releases](../../releases):

| File | Description |
| --- | --- |
| `FlowKeys-portable-vX.X.X.exe` | Portable: run directly, no install |
| `FlowKeys-setup-vX.X.X.exe` | Installer: adds Start-menu entry and uninstaller |

Requires Windows 10 / 11 (uses the system WebView2; older systems can install the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)).

> The app is not code-signed, so Windows SmartScreen may warn about an unknown publisher on first run — click "More info → Run anyway".

## Usage tips

- A MIDI keyboard is detected automatically at launch; you can also play with the PC keyboard (A-K) or the mouse
- Settings → Sound: pick a SoundFont bank, search or favorite presets; drum pads use the drum kit automatically
- "Songs" mode scores you in time; "Follow" mode lets you practice at your own pace
- Settings → Practice: enable score & results, A-B loop, hand separation

### Backing audio (optional)

To keep the repo light and copyright-safe, song audio (`app/songs/*.mp3`) is not distributed. Notation data works out of the box; for backing tracks, drop an mp3 with the same name into `app/songs/` (e.g. `xiaoban.mp3`).

## Tech stack

- Frontend: vanilla JavaScript + [Three.js](https://threejs.org/) (3D keyboard) + [VexFlow](https://www.vexflow.com/) (staff notation) + Web Audio / Web MIDI
- Desktop: Tauri 2 (Rust)
- Sound: a minimal in-house SF2 parser/player (`app/src/sf2Player.js`) + built-in synth

## Project structure

```
app/                 Frontend (embedded into the desktop build)
  index.html         Main page: 3D keyboard / settings / recorder / diagnostics
  src/
    createKeyboardModel.js  3D keyboard modeling
    soundEngine.js          Built-in synth
    sf2Player.js            SoundFont engine
    followPlay.js           Library / notation / follow / import
    i18n.js                 UI translations (6 languages)
  songs/             Song library (notation JSON; audio is user-supplied)
  sounds/            Bundled soundfont
src-tauri/           Desktop shell (Rust / Tauri)
tests/               Playwright smoke tests
docs/                Screenshots
```

## Local development

Frontend (any static server):

```bash
python -m http.server 9200 --directory app
# open http://127.0.0.1:9200/index.html
```

Desktop (requires Rust + MSVC build tools):

```bash
cd src-tauri
cargo tauri dev      # dev mode (serve the frontend on port 9200 first)
cargo tauri build    # build the NSIS installer
```

## Tests

`tests/` contains per-feature Playwright smoke scripts (bring your own Playwright setup):

```bash
python -m http.server 9200 --directory app
node tests/features.js
```

## Contact

- Customization / feature requests / feedback: **348741976@qq.com**
- Or open an [Issue](../../issues) on GitHub

## License & credits

Third-party resources (soundfont, frameworks) are listed in [CREDITS.md](CREDITS.md). Code is released under the [MIT](LICENSE) license.

> Disclaimer: this is a personal learning project. The keyboard's appearance and interaction design are inspired by the **M-VAVE SMK-25** MIDI keyboard, purely for learning and homage. It is not affiliated with M-VAVE.
