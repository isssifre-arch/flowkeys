# FlowKeys 流光钢琴

[简体中文](README.zh-CN.md) ｜ [English](README.md) ｜ **한국어** ｜ [日本語](README.ja.md) ｜ [Русский](README.ru.md) ｜ [Español](README.es.md)

MIDI 키보드로 따라 치며 배우는 데스크톱 앱: 3D 건반 시각화 + 오선보 / 숫자보 / 타일 악보 + 내장 SoundFont 사운드 엔진(호스트 불필요). UI 언어: 简体中文 / English / 한국어 / 日本語 / Русский / Español.

![메인 화면](docs/screenshot-main.png)

![설정](docs/screenshot-settings.png)

![따라치기 모드](docs/screenshot-follow.png)

## 기능

**연주**
- 3D 건반(드래그 회전 / 스크롤 확대 / 클릭 시청), 누르면 하이라이트 + 음이름 표시(음이름 / 계이름 / 숫자보 / MIDI)
- PC 키보드 A-K 연주(±2 옥타브) — MIDI 키보드 없이도 가능
- 벨로시티 감지: 건반을 세게/약하게 누르는 다이내믹, 3단 벨로시티 커브(소프트 / 표준 / 하드)
- 8개 드럼 패드, 노브 애니메이션; 서스테인 페달 표시

**사운드**
- 내장 SoundFont 엔진(.sf2 직접 로드): GeneralUser GS 번들, 검색·즐겨찾기 지원 288개 음색
- 3가지 출력 모드: 내장 신디 / SoundFont 음색팩 / 외부 MIDI 포트(VST, DAW, 하드웨어)
- 로컬 .sf2 로드 가능; SF2 리버브(약 / 중 / 강)
- 피아노식 자연 감쇠 — 길게 눌러도 계속 울리지 않고 서서히 사라짐

**연습**
- 곡 목록: 내장 곡 + 로컬 MIDI 일괄 가져오기 + 온라인 검색 가져오기(BitMidi)
- 4가지 악보 모드: 오선보 / 숫자보 / 타일 / 순수 따라치기
- 따라치기 모드: 속도 제한 없이 자유롭게, 다음 건반에 흐르는 빛 힌트
- 난이도 5단계(인접 건반 허용); 점수 결산(콤보 / 별점)
- A-B 구간 반복, 0.25x–1x 속도, 왼손/오른손 분리(반주 성부가 있는 가져온 곡)
- 녹음 & 재생(페달 포함)

**기타**
- 설정 분류 정리: 화면 / 음색 / 연습 / 키보드 / 녹음 / 일반
- 다국어 UI: 简体中文 / English / 한국어 / 日本語 / Русский / Español (설정 → 일반 → 언어; 첫 실행 시 시스템 언어 자동 감지)
- 배경 테마 4종; 진단 정보 원클릭 복사
- 모든 추가 기능은 기본 꺼짐 — 필요할 때 켜면 됩니다

## 다운로드

[Releases](../../releases) 에서 최신 버전을 받으세요:

| 파일 | 설명 |
| --- | --- |
| `FlowKeys-portable-vX.X.X.exe` | 포터블: 설치 없이 바로 실행 |
| `FlowKeys-setup-vX.X.X.exe` | 설치판: 시작 메뉴 등록 + 제거 지원 |

요구 사항: Windows 10 / 11 (시스템 WebView2 사용; 구형 시스템은 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 설치).

> 코드 서명이 없어 첫 실행 시 SmartScreen 경고가 뜰 수 있습니다 — "추가 정보 → 실행"을 선택하세요.

## 사용 팁

- MIDI 키보드는 실행 시 자동 인식; 없으면 PC 키보드(A-K)나 마우스로 연주
- 설정 → 음색: SoundFont 음색팩 선택, 음색 검색·즐겨찾기; 드럼 패드는 자동으로 드럼킷 사용
- "곡" 모드는 박자에 맞춰 채점, "따라치기" 모드는 자유 속도 연습
- 설정 → 연습: 점수 결산, A-B 반복, 양손 분리 활성화

### 반주 음원(선택)

저장소 용량과 저작권을 위해 곡 반주 mp3(`app/songs/*.mp3`)는 배포하지 않습니다. 악보 데이터는 그대로 사용 가능하며, 반주가 필요하면 같은 이름의 mp3를 `app/songs/`에 넣으세요(예: `xiaoban.mp3`).

## 기술 스택

- 프런트엔드: 바닐라 JavaScript + [Three.js](https://threejs.org/)(3D 건반) + [VexFlow](https://www.vexflow.com/)(오선보) + Web Audio / Web MIDI
- 데스크톱: Tauri 2 (Rust)
- 사운드: 자체 제작 미니 SF2 파서/플레이어(`app/src/sf2Player.js`) + 내장 신디

## 프로젝트 구조

```
app/                 프런트엔드(데스크톱 빌드에 내장)
  index.html         메인 페이지: 3D 건반 / 설정 / 녹음 / 진단
  src/
    createKeyboardModel.js  3D 건반 모델링
    soundEngine.js          내장 신디
    sf2Player.js            SoundFont 엔진
    followPlay.js           곡 목록 / 악보 / 따라치기 / 가져오기
    i18n.js                 UI 번역(6개 언어)
  songs/             곡 목록(악보 JSON; 음원은 사용자 준비)
  sounds/            내장 사운드폰트
src-tauri/           데스크톱 셸(Rust / Tauri)
tests/               Playwright 스모크 테스트
docs/                스크린샷
```

## 로컬 개발

프런트엔드(아무 정적 서버):

```bash
python -m http.server 9200 --directory app
# 브라우저에서 http://127.0.0.1:9200/index.html 열기
```

데스크톱(Rust + MSVC 빌드 환경 필요):

```bash
cd src-tauri
cargo tauri dev      # 개발 모드(먼저 9200 포트에 프런트엔드 서비스)
cargo tauri build    # NSIS 설치 파일 빌드
```

## 테스트

`tests/` 에 기능별 Playwright 스모크 스크립트가 있습니다(Playwright 환경 필요):

```bash
python -m http.server 9200 --directory app
node tests/features.js
```

## 연락처

- 커스터마이징 / 기능 요청 / 피드백: **348741976@qq.com**
- GitHub [Issue](../../issues) 도 환영합니다

## 라이선스 & 크레딧

서드파티 리소스(사운드폰트, 프레임워크)는 [CREDITS.md](CREDITS.md) 참고. 코드는 [MIT](LICENSE) 라이선스입니다.

> 고지: 개인 학습 프로젝트입니다. 건반의 외형과 인터랙션 디자인은 **M-VAVE SMK-25** MIDI 키보드에서 영감을 받았으며, 학습과 오마주 목적입니다. M-VAVE와는 무관합니다.
