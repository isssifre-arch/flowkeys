# FlowKeys 流光钢琴

[简体中文](README.zh-CN.md) ｜ [English](README.md) ｜ [한국어](README.ko.md) ｜ **日本語** ｜ [Русский](README.ru.md) ｜ [Español](README.es.md)

MIDI キーボードで追い弾きして学ぶデスクトップアプリ：3D 鍵盤ビジュアル + 五線譜 / 数字譜 / タイル譜 + 内蔵 SoundFont 音源（ホスト不要）。UI 言語：简体中文 / English / 한국어 / 日本語 / Русский / Español。

![メイン画面](docs/screenshot-main.png)

![設定](docs/screenshot-settings.png)

![フォローモード](docs/screenshot-follow.png)

## 機能

**演奏**
- 3D 鍵盤（ドラッグ回転 / ホイールズーム / クリック試奏）押すとハイライトし音名を表示（音名 / 階名 / 数字譜 / MIDI）
- PC キーボード A-K で演奏（±2 オクターブ）— MIDI キーボード不要
- ベロシティ対応：鍵盤の押し方で強弱、3 段階のベロシティカーブ（ソフト / 標準 / ハード）
- 8 つのドラムパッド、ノブ演出；サステインペダル表示

**音色**
- 内蔵 SoundFont エンジン（.sf2 を直接読み込み）：GeneralUser GS 同梱、検索・お気に入り対応の 288 音色
- 3 つの出力モード：内蔵シンセ / SoundFont 音色パック / 外部 MIDI ポート（VST・DAW・ハードウェア）
- ローカルの .sf2 を読み込み可能；SF2 リバーブ（弱 / 中 / 強）
- ピアノ式の自然減衰 — 長押しでも鳴り続けず、徐々に消える

**練習**
- 曲ライブラリ：内蔵曲 + ローカル MIDI 一括取り込み + オンライン検索取り込み（BitMidi）
- 4 つの譜面モード：五線譜 / 数字譜 / タイル / 純フォロー
- フォローモード：速度制限なしの自分のペース、次の鍵盤に流れる光のヒント
- 難易度 5 段階（隣接鍵の許容）；採点と結果（コンボ / 星評価）
- A-B ループ、0.25x–1x 速度、左右分離練習（伴奏パートのある取り込み曲）
- 録音と再生（ペダル含む）

**その他**
- 設定をカテゴリ別に整理：外観 / 音色 / 練習 / キーボード / 録音 / 一般
- 多言語 UI：简体中文 / English / 한국어 / 日本語 / Русский / Español（設定 → 一般 → 言語；初回起動時はシステム言語を自動検出）
- 背景テーマ 4 種；診断情報をワンクリックコピー
- 追加機能はすべて初期オフ — 必要なものだけオンに

## ダウンロード

[Releases](../../releases) から最新版をダウンロード：

| ファイル | 説明 |
| --- | --- |
| `FlowKeys-portable-vX.X.X.exe` | ポータブル版：インストール不要で直接実行 |
| `FlowKeys-setup-vX.X.X.exe` | インストーラー：スタートメニュー登録とアンインストール対応 |

動作環境：Windows 10 / 11（システムの WebView2 を使用；古い環境では [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) をインストール）。

> コード署名がないため、初回起動時に SmartScreen の警告が出る場合があります —「詳細情報 → 実行」を選択してください。

## 使い方のヒント

- MIDI キーボードは起動時に自動検出；なくても PC キーボード（A-K）やマウスで演奏できます
- 設定 → 音色：SoundFont 音色パックを選択、音色の検索・お気に入り；ドラムパッドは自動でドラムキットを使用
- 「楽曲」はテンポに合わせて採点、「フォロー」は自分のペースで練習
- 設定 → 練習：採点・結果、A-B ループ、左右分離をオンに

### 伴奏音源（任意）

リポジトリの軽量化と著作権のため、伴奏 mp3（`app/songs/*.mp3`）は配布していません。譜面データはそのまま使えます。伴奏が必要な場合は同名の mp3 を `app/songs/` に置いてください（例：`xiaoban.mp3`）。

## 技術スタック

- フロントエンド：Vanilla JavaScript + [Three.js](https://threejs.org/)（3D 鍵盤）+ [VexFlow](https://www.vexflow.com/)（五線譜）+ Web Audio / Web MIDI
- デスクトップ：Tauri 2（Rust）
- サウンド：自作のミニマル SF2 パーサー/プレイヤー（`app/src/sf2Player.js`）+ 内蔵シンセ

## プロジェクト構成

```
app/                 フロントエンド（デスクトップ版に内蔵）
  index.html         メインページ：3D 鍵盤 / 設定 / 録音 / 診断
  src/
    createKeyboardModel.js  3D 鍵盤モデリング
    soundEngine.js          内蔵シンセ
    sf2Player.js            SoundFont エンジン
    followPlay.js           曲ライブラリ / 譜面 / フォロー / 取り込み
    i18n.js                 UI 翻訳（6 言語）
  songs/             曲ライブラリ（譜面 JSON；音源は各自用意）
  sounds/            同梱サウンドフォント
src-tauri/           デスクトップシェル（Rust / Tauri）
tests/               Playwright スモークテスト
docs/                スクリーンショット
```

## ローカル開発

フロントエンド（任意の静的サーバー）：

```bash
python -m http.server 9200 --directory app
# ブラウザで http://127.0.0.1:9200/index.html を開く
```

デスクトップ（Rust + MSVC ビルド環境が必要）：

```bash
cd src-tauri
cargo tauri dev      # 開発モード（先に 9200 番でフロントエンドを配信）
cargo tauri build    # NSIS インストーラーをビルド
```

## テスト

`tests/` に機能別の Playwright スモークスクリプトがあります（Playwright 環境が必要）：

```bash
python -m http.server 9200 --directory app
node tests/features.js
```

## お問い合わせ

- カスタマイズ / 機能リクエスト / フィードバック：**348741976@qq.com**
- GitHub の [Issue](../../issues) も歓迎です

## ライセンスとクレジット

サードパーティリソース（サウンドフォント、フレームワーク）は [CREDITS.md](CREDITS.md) を参照。コードは [MIT](LICENSE) ライセンスです。

> 声明：個人の学習プロジェクトです。鍵盤の外観とインタラクションは **M-VAVE SMK-25** MIDI キーボードから着想を得たもので、学習とオマージュを目的としています。M-VAVE とは無関係です。
