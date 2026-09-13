/* FlowKeys · 程序化 Three.js 工厂（r128 全局 THREE，无外部依赖）
 * 每个琴键 / Pad / 旋钮 / 按钮都是独立 Group，可单独拆分（explode）、点击隔离、按下动效。
 * 工件单位：1 = 约10mm。X=宽(32)，Y=高，Z=深（+Z=演奏者一侧/正面）。
 */
(function () {
'use strict';

var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// 25 键：C3(48)..C5(72)
var KEY_MIDIS = [];
(function () {
  var midi = 48;
  KEY_MIDIS.push(midi);
  while (KEY_MIDIS.length < 25) { midi++; var pc = midi % 12; if (pc !== 1 && pc !== 3 && pc !== 6 && pc !== 8 && pc !== 10) { /* white continues */ } KEY_MIDIS.push(midi); }
})();
function midiFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function midiName(m) { return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1); }

function roundedRectShape(w, h, r) {
  var s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function canvasTex(w, h, draw) {
  var c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  var t = new THREE.CanvasTexture(c);
  t.anisotropy = 4; t.encoding = THREE.sRGBEncoding;
  return t;
}
function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }

function createKeyboardModel() {
  /* 可调参数：页面微调面板通过 window.KEYBOARD_PARAMS 覆盖，改完即时重建 */
  var P = Object.assign({
    whiteW: 1.9, whiteH: 0.85, whiteD: 5.6, whiteY: 0.77, pitch: 2.0, whiteX: 0,
    blackW: 1.0, blackH: 0.7, blackD: 3.0, blackX: 0,
    knobSize: 1.0, padGlow: 0.85
  }, window.KEYBOARD_PARAMS || {});
  var root = new THREE.Group();
  root.name = 'keyboard-root';
  var parts = [];            // 全部可拆分部件 {id,label,kind,group,assembled,explodeDir,explodeDist}
  var byId = {};
  var whiteKeys = [], blackKeys = [], pads = [], knobs = [], buttons = [];

  /* ---------------- 材质 ---------------- */
  var MAT = {
    body: new THREE.MeshStandardMaterial({ color: 0xf2f3f4, roughness: 0.46, metalness: 0.0 }),
    deck: new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.5, metalness: 0.0 }),
    keybed: new THREE.MeshStandardMaterial({ color: 0xc9cdd2, roughness: 0.7, metalness: 0.0 }),
    keyWhite: new THREE.MeshStandardMaterial({ color: 0xf7f8f9, roughness: 0.34, metalness: 0.0 }),
    keyBlack: new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.45, metalness: 0.0 }),
    knob: new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.55, metalness: 0.1, flatShading: true }),
    knobTop: new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.45, metalness: 0.15 }),
    pointer: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    button: new THREE.MeshStandardMaterial({ color: 0xd9dee4, roughness: 0.5, metalness: 0.0 }),
    buttonBlue: new THREE.MeshStandardMaterial({ color: 0xc7d8ff, roughness: 0.5, metalness: 0.0 }),
    buttonWell: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.7, metalness: 0.0 }),
    stripBase: new THREE.MeshStandardMaterial({ color: 0xb4bac2, roughness: 0.65, metalness: 0.0 }),
    stripInlay: new THREE.MeshStandardMaterial({ color: 0xf6f7f8, roughness: 0.4, metalness: 0.0 }),
    bezel: new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.6, metalness: 0.1 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.16, metalness: 0.2 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.7 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x232527, roughness: 0.9 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.9 })
  };

  function regPart(id, label, kind, group, ex, ey, ez, dist) {
    group.userData.partId = id;
    group.userData.label = label;
    group.userData.kind = kind;
    var p = { id: id, label: label, kind: kind, group: group,
      assembled: group.position.clone(),
      explodeDir: new THREE.Vector3(ex, ey, ez).normalize(), explodeDist: dist };
    group.userData.part = p;
    parts.push(p); byId[id] = p;
    root.add(group);
    return p;
  }

  /* ---------------- 主机身（圆角平板） ---------------- */
  (function chassis() {
    var g = new THREE.Group(); g.position.set(0, 0, 0);
    var shape = roundedRectShape(32, 18, 1.2);
    var geo = new THREE.ExtrudeGeometry(shape, { depth: 2.4, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 2 });
    geo.rotateX(-Math.PI / 2); geo.translate(0, 0, 0);
    var m = shadowed(new THREE.Mesh(geo, MAT.body));
    m.position.y = -1.2; g.add(m); // 顶面≈1.3，与面板基板底部咬合
    // 底板 + 脚垫
    var base = shadowed(new THREE.Mesh(new THREE.BoxGeometry(30.5, 0.3, 16.5), MAT.body));
    base.position.y = -1.35; g.add(base);
    [[-14, -7], [14, -7], [-14, 7], [14, 7]].forEach(function (p) {
      var f = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.35, 16), MAT.rubber);
      f.position.set(p[0], -1.6, p[1]); g.add(f);
    });
    regPart('chassis', '主机身 Chassis', 'body', g, 0, -1, 0, 0);
  })();

  /* ---------------- 控制面板基板 ---------------- */
  (function deck() {
    var g = new THREE.Group(); g.position.set(0, 1.32, -2.9);
    var m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(31.2, 0.22, 11.9), MAT.deck));
    g.add(m);
    regPart('deck', '控制面板 Deck', 'body', g, 0, 1, 0, 0.6);
  })();
  var DECK_Y = 1.43;

  /* ---------------- 键床凹槽 ---------------- */
  (function keybed() {
    var g = new THREE.Group(); g.position.set(0, 1.18, 6.05);
    var m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(30.6, 0.5, 5.9), MAT.keybed));
    g.add(m);
    regPart('keybed', '键床 Keybed', 'body', g, 0, -0.3, 1, 0.8);
  })();

  /* ---------------- 白键 x15（挤出侧面轮廓：前端唇边） ---------------- */
  var WHITE_N = 15, PITCH = P.pitch, KEY_W = P.whiteW, KEY_D = P.whiteD, KEY_H = P.whiteH;
  var keybedFrontZ = 8.95, keyRearZ = keybedFrontZ - KEY_D; // 3.35
  var whiteProfile = (function () {
    var s = new THREE.Shape(); // x=深度方向(0..D)，y=高度；端面齐平无前唇
    s.moveTo(0, 0); s.lineTo(KEY_D, 0); s.lineTo(KEY_D, -0.5);
    s.lineTo(0, -0.5); s.lineTo(0, 0);
    return s;
  })();
  var whiteGeo = new THREE.ExtrudeGeometry(whiteProfile, { depth: KEY_W, bevelEnabled: false });
  whiteGeo.rotateY(-Math.PI / 2); // 挤出轴转到 X：x'∈[-W,0]，需 +W/2 回正
  whiteGeo.translate(KEY_W / 2, 0, 0);
  var whiteX0 = -(WHITE_N - 1) * PITCH / 2 + P.whiteX;
  var WHITE_BASE_Y = P.whiteY; // 键顶=WHITE_BASE_Y+KEY_H；键身下沉嵌进键床
  var whiteMidiFilter = KEY_MIDIS.filter(function (m) { var pc = m % 12; return pc !== 1 && pc !== 3 && pc !== 6 && pc !== 8 && pc !== 10; });
  for (var i = 0; i < WHITE_N; i++) {
    (function (i) {
      var g = new THREE.Group();
      g.position.set(whiteX0 + i * PITCH, WHITE_BASE_Y, keyRearZ);
      var m = shadowed(new THREE.Mesh(whiteGeo, MAT.keyWhite));
      m.position.set(0, KEY_H, 0);
      g.add(m);
      var midi = whiteMidiFilter[i] || 60;
      var p = regPart('white-' + (i < 10 ? '0' + i : i), '白键 ' + midiName(midi) + '（W' + (i + 1) + '）', 'white', g, (i - 7) * 0.06, 0.45, 1, 3.2);
      p.midi = midi; p.freq = midiFreq(midi); p.keyIndex = i;
      whiteKeys.push(p);
    })(i);
  }

  /* ---------------- 黑键 x10（前端倒角轮廓） ---------------- */
  var BLACK_SLOTS = [0, 1, 3, 4, 5, 7, 8, 10, 11, 12]; // 白键缝隙序号
  var BK_W = P.blackW, BK_D = P.blackD, BK_H = P.blackH;
  var blackProfile = (function () {
    var s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(BK_D - 0.5, 0); s.lineTo(BK_D, -0.35); s.lineTo(BK_D, -BK_H);
    s.lineTo(0, -BK_H); s.lineTo(0, 0);
    return s;
  })();
  var blackGeo = new THREE.ExtrudeGeometry(blackProfile, { depth: BK_W, bevelEnabled: false });
  blackGeo.rotateY(-Math.PI / 2); blackGeo.translate(BK_W / 2, 0, 0);
  var blackMidis = KEY_MIDIS.filter(function (m) { var pc = m % 12; return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10; });
  BLACK_SLOTS.forEach(function (slot, k) {
    (function (k) {
      var g = new THREE.Group();
      var x = whiteX0 + slot * PITCH + PITCH / 2 + P.blackX;
      g.position.set(x, WHITE_BASE_Y + KEY_H, keyRearZ + 0.15);
      var m = shadowed(new THREE.Mesh(blackGeo, MAT.keyBlack));
      m.position.set(0, BK_H, 0);
      g.add(m);
      var midi = blackMidis[k] || 61;
      var p = regPart('black-' + (k < 10 ? '0' + k : k), '黑键 ' + midiName(midi) + '（B' + (k + 1) + '）', 'black', g, (x / 16) * 0.8, 0.75, 0.9, 4.2);
      p.midi = midi; p.freq = midiFreq(midi); p.keyIndex = k;
      blackKeys.push(p);
    })(k);
  });

  /* ---------------- 打击垫 x8（圆角硅胶 + 发光芯） ---------------- */
  var padGeo = new THREE.ExtrudeGeometry(roundedRectShape(2.9, 2.6, 0.35), { depth: 0.42, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2 });
  padGeo.rotateX(-Math.PI / 2);
  var coreGeo = new THREE.CylinderGeometry(0.75, 0.75, 0.12, 24);
  var padColsX = [3.2, 6.5, 9.8, 13.1], padRowsZ = [-6.9, -3.6];
  var padNames = ['Pad 1', 'Pad 2', 'Pad 3', 'Pad 4', 'Pad 5', 'Pad 6', 'Pad 7', 'Pad 8'];
  for (var r = 0; r < 2; r++) for (var c = 0; c < 4; c++) {
    (function (r, c) {
      var idx = r * 4 + c;
      var cyan = r === 0;
      var g = new THREE.Group();
      g.position.set(padColsX[c], DECK_Y, padRowsZ[r]);
      var lensMat = new THREE.MeshStandardMaterial({
        color: cyan ? 0x8fe8e8 : 0xc9a6f2, roughness: 0.5, metalness: 0,
        transparent: true, opacity: 0.95, emissive: cyan ? 0x1fa0a0 : 0x7a4fc0, emissiveIntensity: P.padGlow
      });
      var lens = shadowed(new THREE.Mesh(padGeo, lensMat));
      lens.position.y = 0.05; g.add(lens);
      var coreMat = new THREE.MeshBasicMaterial({ color: cyan ? 0x35e0e0 : 0xb46bff, transparent: true, opacity: 0.95 });
      var core = new THREE.Mesh(coreGeo, coreMat);
      core.position.y = 0.5; g.add(core);
      var p = regPart('pad-' + (idx + 1), '打击垫 ' + padNames[idx] + (cyan ? ' · 青' : ' · 紫'), 'pad', g, (c - 1.5) * 0.25, 1, -0.25, 3.4);
      p.padIndex = idx; p.lensMat = lensMat; p.coreMat = coreMat; p.baseEmissive = P.padGlow;
      pads.push(p);
    })(r, c);
  }

  /* ---------------- 旋钮 x8（八角 + 指向线） ---------------- */
  var knobNames = ['MODE', 'OCT', 'LATCH', 'GATE', 'SWING', 'TEMPO', 'RATE', 'TRANSPOSE'];
  var knobColsX = [-8.4, -5.8, -3.2, -0.6], knobRowsZ = [-3.6, -0.9];
  var knobBodyGeo = new THREE.CylinderGeometry(0.72, 0.8, 1.05, 8);
  var knobTopGeo = new THREE.CylinderGeometry(0.5, 0.62, 0.22, 8);
  var pointerGeo = new THREE.BoxGeometry(0.12, 0.06, 0.55);
  for (var kr = 0; kr < 2; kr++) for (var kc = 0; kc < 4; kc++) {
    (function (kr, kc) {
      var idx = kr * 4 + kc;
      var g = new THREE.Group();
      g.position.set(knobColsX[kc], DECK_Y, knobRowsZ[kr]);
      g.scale.set(P.knobSize, P.knobSize, P.knobSize);
      var spin = new THREE.Group(); g.add(spin);
      var body = shadowed(new THREE.Mesh(knobBodyGeo, MAT.knob));
      body.position.y = 0.62; spin.add(body);
      var top = shadowed(new THREE.Mesh(knobTopGeo, MAT.knobTop));
      top.position.y = 1.2; spin.add(top);
      var pt = new THREE.Mesh(pointerGeo, MAT.pointer);
      pt.position.set(0, 1.32, -0.28); spin.add(pt);
      var skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.08, 24), MAT.bezel);
      skirt.position.y = 0.06; g.add(skirt);
      spin.rotation.y = (idx * 0.7 + 0.4);
      var p = regPart('knob-' + (idx + 1), '旋钮 ' + knobNames[idx] + '（K' + (idx + 1) + '）', 'knob', g, (kc - 1.5) * 0.2, 1, 0.15, 5.0);
      p.knobIndex = idx; p.knobName = knobNames[idx]; p.spin = spin;
      knobs.push(p);
    })(kr, kc);
  }

  /* ---------------- 按钮：走带 8 + OCT 2 ---------------- */
  var btnGeo = new THREE.ExtrudeGeometry(roundedRectShape(1.9, 1.0, 0.22), { depth: 0.26, bevelEnabled: false });
  btnGeo.rotateX(-Math.PI / 2);
  var btnNames = ['PLAY', 'STOP', 'REC', 'BT', 'ARP', 'SC/CH', 'KNOB-B', 'PAD-B'];
  var btnColsX = [-8.4, -5.8, -3.2, -0.6], btnRowsZ = [-7.3, -5.9];
  var btnWellGeo = new THREE.BoxGeometry(2.1, 0.08, 1.2);
  for (var br = 0; br < 2; br++) for (var bc = 0; bc < 4; bc++) {
    (function (br, bc) {
      var idx = br * 4 + bc;
      var isBT = btnNames[idx] === 'BT';
      var g = new THREE.Group();
      g.position.set(btnColsX[bc], DECK_Y, btnRowsZ[br]);
      var well = new THREE.Mesh(btnWellGeo, MAT.buttonWell);
      well.position.y = 0.0; g.add(well);
      var cap = shadowed(new THREE.Mesh(btnGeo, isBT ? MAT.buttonBlue : MAT.button));
      cap.position.y = 0.05; g.add(cap);
      var p = regPart('btn-' + (idx + 1), '按钮 ' + btnNames[idx], 'button', g, (bc - 1.5) * 0.2, 1, -0.3, 2.4);
      p.btnName = btnNames[idx];
      buttons.push(p);
    })(br, bc);
  }
  // OCT- / OCT+
  [['oct-minus', 'OCT-', -15.0], ['oct-plus', 'OCT+', -13.4]].forEach(function (o) {
    var g = new THREE.Group(); g.position.set(o[2], DECK_Y, 2.1);
    var well = new THREE.Mesh(btnWellGeo, MAT.buttonWell); well.position.y = 0.0; g.add(well);
    var cap = shadowed(new THREE.Mesh(btnGeo, MAT.button)); cap.position.y = 0.05; g.add(cap);
    var p = regPart(o[0], '按钮 ' + o[1], 'button', g, -0.5, 1, 0.4, 2.2);
    p.btnName = o[1]; buttons.push(p);
  });

  /* ---------------- PITCH / MOD 触条 ---------------- */
  [['strip-pitch', '触条 PITCH', -15.0], ['strip-mod', '触条 MOD', -13.4]].forEach(function (s) {
    var g = new THREE.Group(); g.position.set(s[2], DECK_Y, -3.0);
    var base = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.18, 8.2), MAT.stripBase));
    base.position.y = 0.02; g.add(base);
    var inlay = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.1, 7.6), MAT.stripInlay);
    inlay.position.y = 0.12; g.add(inlay);
    regPart(s[0], s[1], 'strip', g, -0.4, 1, 0, 1.8);
  });

  /* ---------------- LCD 显示屏 ---------------- */
  (function display() {
    var g = new THREE.Group(); g.position.set(-11.2, DECK_Y, -7.35);
    var bezel = shadowed(new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.34, 2.1), MAT.bezel));
    bezel.position.y = 0.1; g.add(bezel);
    var glass = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.5), MAT.glass);
    glass.rotation.x = -Math.PI / 2; glass.position.y = 0.29; g.add(glass);
    var glyphTex = canvasTex(256, 112, function (ctx, w, h) {
      ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#cfe6ff'; ctx.font = 'bold 64px "Courier New",monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = '#6fb7ff'; ctx.shadowBlur = 16;
      ctx.fillText('Pr 1', w / 2, h / 2 + 2);
    });
    var glyph = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.3),
      new THREE.MeshBasicMaterial({ map: glyphTex, transparent: false }));
    glyph.rotation.x = -Math.PI / 2; glyph.position.y = 0.30; g.add(glyph);
    regPart('display', '显示屏 LCD（Pr 1）', 'display', g, -0.3, 1, -0.4, 2.6);
  })();

  /* ---------------- 背面接口 ---------------- */
  (function rearSwitch() {
    var g = new THREE.Group(); g.position.set(6.5, -0.3, -9.05);
    var plate = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.15), MAT.button);
    g.add(plate);
    var lever = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.4, 0.35), MAT.bezel));
    lever.position.z = -0.2; g.add(lever);
    regPart('rear-switch', '背面 电源开关', 'rear', g, 0, 0.2, -1, 3.0);
  })();
  (function rearLed() {
    var g = new THREE.Group(); g.position.set(7.6, -0.25, -9.05);
    var dot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xff3030 }));
    dot.position.z = -0.08; g.add(dot);
    regPart('rear-led', '背面 电源指示灯', 'rear', g, 0, 0.3, -1, 3.0);
  })();
  (function rearUsb() {
    var g = new THREE.Group(); g.position.set(9.3, -0.35, -9.05);
    var shell = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 0.5), MAT.metal));
    shell.position.z = -0.1; g.add(shell);
    var bore = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.55, 0.2), MAT.dark);
    bore.position.z = -0.35; g.add(bore);
    regPart('rear-usb', '背面 USB 接口', 'rear', g, 0, 0.1, -1, 3.4);
  })();
  (function rearSustain() {
    var g = new THREE.Group(); g.position.set(11.6, -0.35, -9.05);
    var ring = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 20), MAT.metal));
    ring.rotation.x = Math.PI / 2; ring.position.z = -0.1; g.add(ring);
    var bore = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.5, 16), MAT.dark);
    bore.rotation.x = Math.PI / 2; bore.position.z = -0.12; g.add(bore);
    regPart('rear-sustain', '背面 延音踏板接口', 'rear', g, 0, 0.1, -1, 3.4);
  })();

  /* ---------------- 面板丝印（透明贴片，几何体可随爆炸上浮） ---------------- */
  (function graphics() {
    var tex = canvasTex(2048, 768, function (ctx, W, H) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#3a4048'; ctx.textAlign = 'center';
      function X(x) { return (x + 16) / 32 * W; }
      function Z(z) { return (z + 8.75) / 11.9 * H; } // deck: z -8.75..3.05? 映射到面板
      ctx.font = '600 21px "Microsoft YaHei",sans-serif';
      // Pad 编号（远排 1-4，近排 5-8）
      for (var c = 0; c < 4; c++) {
        ctx.fillText('Pad ' + (c + 1), X(padColsX[c]), Z(-8.45));
        ctx.fillText('Pad ' + (c + 5), X(padColsX[c]), Z(-5.15));
      }
      // 旋钮名 + 圆环（环半径超出旋钮裙边以便可见）
      ctx.font = '600 22px "Microsoft YaHei",sans-serif';
      for (var k = 0; k < 8; k++) {
        var kx = knobColsX[k % 4], kz = knobRowsZ[Math.floor(k / 4)];
        ctx.strokeStyle = '#6a7076'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(kx), Z(kz), 70, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#3a4048';
        ctx.fillText(knobNames[k], X(kx), Z(kz + 1.35));
      }
      // 走带按钮名
      ctx.font = '600 20px "Microsoft YaHei",sans-serif';
      for (var b = 0; b < 8; b++) {
        ctx.fillText(btnNames[b], X(btnColsX[b % 4]), Z(btnRowsZ[Math.floor(b / 4)] - 0.95));
      }
      // PITCH / MOD / OCT
      ctx.fillText('PITCH', X(-15.0), Z(-7.5)); ctx.fillText('MOD', X(-13.4), Z(-7.5));
      ctx.fillText('OCT-', X(-15.0), Z(1.15)); ctx.fillText('OCT+', X(-13.4), Z(1.15));
      ctx.font = '600 14px "Microsoft YaHei",sans-serif';
      ctx.fillText('TRANSPOSE', X(-14.2), Z(3.0));
      // FLOWKEYS
      ctx.fillStyle = '#2e3440'; ctx.font = '700 64px "Arial Black",Arial,sans-serif';
      ctx.fillText('FLOWKEYS', X(7.2), Z(0.15));
      // 琴键功能行（小字）
      ctx.font = '500 15px "Microsoft YaHei",sans-serif'; ctx.fillStyle = '#5a6068';
      var fns = ['SC ARP', 'C UP', 'C# DOWN', 'D INCL', 'D# EXCL', 'E RAND', 'F ORDER', 'F# REPEAT', 'G OCT+', 'G# LATCH', 'A GATE+', 'A# GATE-', 'B TAP', 'OFF SWING+', 'SWING- TEMPO+'];
      for (var f = 1; f < 15; f++) ctx.fillText(fns[f], X(whiteX0 + f * PITCH), Z(2.7));
    });
    var g = new THREE.Group(); g.position.set(0, DECK_Y + 0.015, -2.85);
    var plane = new THREE.Mesh(new THREE.PlaneGeometry(31.2, 11.9),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    plane.rotation.x = -Math.PI / 2; g.add(plane);
    regPart('graphics', '面板丝印 Graphics', 'graphics', g, 0, 1, 0, 1.2);
  })();

  /* ---------------- 背面丝印 ---------------- */
  (function rearPrint() {
    var tex = canvasTex(1024, 128, function (ctx, W, H) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#2e3440'; ctx.textAlign = 'left';
      ctx.font = '700 72px "Arial Black",Arial,sans-serif';
      ctx.fillText('FLOWKEYS', 30, 88);
      ctx.font = '400 56px Arial,sans-serif';
      ctx.fillText('MIDI KEYBOARD', 380, 86);
      ctx.font = '500 26px "Microsoft YaHei",sans-serif'; ctx.fillStyle = '#6a7076';
      ctx.fillText('POWER', 700, 60); ctx.fillText('USB', 800, 60); ctx.fillText('SUSTAIN', 890, 60);
    });
    var g = new THREE.Group(); g.position.set(-4, -0.35, -9.12);
    var plane = new THREE.Mesh(new THREE.PlaneGeometry(16, 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    plane.rotation.y = Math.PI; g.add(plane);
    regPart('rear-print', '背面丝印', 'graphics', g, 0, 0, -1, 1.0);
  })();

  root.userData.factory = 'createKeyboardModel';
  return { group: root, parts: parts, byId: byId, whiteKeys: whiteKeys, blackKeys: blackKeys, pads: pads, knobs: knobs, buttons: buttons };
}

window.createKeyboardModel = createKeyboardModel;
})();


