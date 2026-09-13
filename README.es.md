# FlowKeys 流光钢琴

[简体中文](README.zh-CN.md) ｜ [English](README.md) ｜ [한국어](README.ko.md) ｜ [日本語](README.ja.md) ｜ [Русский](README.ru.md) ｜ **Español**

App de escritorio para aprender piano siguiendo tu teclado MIDI: visualización 3D de teclas + partitura / notación numérica / azulejos + motor SoundFont integrado (sin host). Interfaz en 简体中文 / English / 한국어 / 日本語 / Русский / Español.

![Vista principal](docs/screenshot-main.png)

![Ajustes](docs/screenshot-settings.png)

![Modo seguir](docs/screenshot-follow.png)

## Funciones

**Interpretación**
- Teclado 3D (arrastrar para girar, rueda para zoom, clic para probar); las teclas se iluminan con nombre de nota (nombre / solfa / números / MIDI)
- Toca con el teclado del PC (A-K), ±2 octavas — sin teclado MIDI
- Sensibilidad a la velocidad; tres curvas (suave / estándar / dura)
- 8 pads de batería, perillas animadas; indicador de pedal de sustain

**Sonido**
- Motor SoundFont integrado (lee .sf2 directamente): incluye el banco GeneralUser GS, 288 presets con búsqueda y favoritos
- Tres salidas: sintetizador interno / banco SoundFont / puerto MIDI externo (tu VST, DAW o hardware)
- Carga cualquier .sf2 local; reverb SF2 (poca / media / mucha)
- Decaimiento natural tipo piano — las notas se apagan en vez de sonar para siempre

**Práctica**
- Biblioteca: canciones incluidas + importación por lotes de MIDI + búsqueda online (BitMidi)
- Cuatro modos de notación: partitura / números / azulejos / seguir puro
- Modo seguir: a tu ritmo, con una luz que fluye hacia la siguiente tecla
- 5 niveles de dificultad (tolerancia a teclas cercanas); puntuación y resultados (combo / estrellas)
- Bucle A-B, velocidad 0.25x–1x, separación de manos (canciones importadas con acompañamiento)
- Graba y reproduce tu interpretación (incluido el pedal)

**Otros**
- Ajustes por categorías: aspecto / sonido / práctica / teclado / grabación / general
- Interfaz multilingüe: 简体中文 / English / 한국어 / 日本語 / Русский / Español (Ajustes → General → Idioma; detecta el idioma del sistema al primer inicio)
- Cuatro fondos; copia de diagnóstico con un clic
- Todas las funciones opcionales están desactivadas por defecto

## Descarga

La última versión está en [Releases](../../releases):

| Archivo | Descripción |
| --- | --- |
| `FlowKeys-portable-vX.X.X.exe` | Portátil: se ejecuta sin instalar |
| `FlowKeys-setup-vX.X.X.exe` | Instalador: menú Inicio y desinstalación |

Requiere Windows 10 / 11 (usa WebView2 del sistema; en equipos antiguos instala el [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)).

> La app no está firmada; SmartScreen puede avisar de editor desconocido la primera vez — pulsa "Más información → Ejecutar de todas formas".

## Consejos

- El teclado MIDI se detecta automáticamente; también puedes tocar con el teclado del PC (A-K) o el ratón
- Ajustes → Sonido: elige un banco SoundFont, busca y marca favoritos; los pads usan la batería automáticamente
- "Canciones" puntúa al tempo; "Seguir" practica a tu ritmo
- Ajustes → Práctica: activa puntuación, bucle A-B y separación de manos

### Audio de acompañamiento (opcional)

Por tamaño del repositorio y derechos de autor, el audio de las canciones (`app/songs/*.mp3`) no se distribuye. La notación funciona directamente; para la pista, coloca un mp3 con el mismo nombre en `app/songs/` (p. ej. `xiaoban.mp3`).

## Tecnologías

- Frontend: JavaScript puro + [Three.js](https://threejs.org/) (teclado 3D) + [VexFlow](https://www.vexflow.com/) (partituras) + Web Audio / Web MIDI
- Escritorio: Tauri 2 (Rust)
- Sonido: parser/reproductor SF2 minimalista propio (`app/src/sf2Player.js`) + sintetizador interno

## Estructura del proyecto

```
app/                 Frontend (embebido en la versión de escritorio)
  index.html         Página principal: teclado 3D / ajustes / grabación / diagnóstico
  src/
    createKeyboardModel.js  Modelado 3D del teclado
    soundEngine.js          Sintetizador interno
    sf2Player.js            Motor SoundFont
    followPlay.js           Biblioteca / notación / seguir / importar
    i18n.js                 Traducciones de la interfaz (6 idiomas)
  songs/             Biblioteca (notación JSON; el audio es tuyo)
  sounds/            Banco de sonido incluido
src-tauri/           Cáscara de escritorio (Rust / Tauri)
tests/               Pruebas de humo con Playwright
docs/                Capturas
```

## Desarrollo local

Frontend (cualquier servidor estático):

```bash
python -m http.server 9200 --directory app
# abre http://127.0.0.1:9200/index.html
```

Escritorio (requiere Rust + MSVC):

```bash
cd src-tauri
cargo tauri dev      # modo desarrollo (sirve el frontend en el puerto 9200)
cargo tauri build    # genera el instalador NSIS
```

## Pruebas

En `tests/` hay scripts de humo de Playwright por función:

```bash
python -m http.server 9200 --directory app
node tests/features.js
```

## Contacto

- Personalización / sugerencias / comentarios: **348741976@qq.com**
- O abre un [Issue](../../issues) en GitHub

## Licencia y créditos

Los recursos de terceros (banco de sonido, frameworks) están en [CREDITS.md](CREDITS.md). El código usa licencia [MIT](LICENSE).

> Aviso: proyecto personal de aprendizaje. El aspecto y la interacción del teclado se inspiran en el teclado MIDI **M-VAVE SMK-25**, con fines de aprendizaje y homenaje. No está afiliado a M-VAVE.
