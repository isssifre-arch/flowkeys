/* 流光钢琴 内置合成音色引擎（纯 WebAudio，无外部依赖）
 * window.SMK25Engine: setTimbre(name) / noteOn(midi,vel) / noteOff(midi) /
 *   drum(i,vel) / blip(freq) / setVolume(v) / setSustain(b) / timbreList
 */
(function () {
'use strict';

var AC = null, master = null, delaySend = null, noiseBuf = null;
var voices = {}; // midi -> {oscs:[], gain, timbre}
var currentTimbre = 'piano';
var volume = 0.8, sustained = false, sustainedVoices = {};

function ac() {
  if (!AC) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    AC = new Ctx();
    master = AC.createGain(); master.gain.value = volume; master.connect(AC.destination);
    // 简单空间感：共享 Delay 发送
    var dly = AC.createDelay(1); dly.delayTime.value = 0.27;
    var fb = AC.createGain(); fb.gain.value = 0.32;
    var wet = AC.createGain(); wet.gain.value = 0.16;
    dly.connect(fb); fb.connect(dly); dly.connect(wet); wet.connect(master);
    delaySend = dly;
    var len = AC.sampleRate * 1;
    noiseBuf = AC.createBuffer(1, len, AC.sampleRate);
    var ch = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function freq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

var TIMBRES = {
  piano: { label: '钢琴', oscs: [{ t: 'triangle', o: 0, g: 0.6 }, { t: 'sine', o: 12, g: 0.25 }], a: 0.005, d: 0.5, s: 0.25, r: 0.4, hd: 1.0, cutoff: 3800, send: 0.25 },
  ep: { label: '电钢', oscs: [{ t: 'sine', o: 0, g: 0.55 }, { t: 'triangle', o: 12, g: 0.2 }], a: 0.008, d: 0.7, s: 0.35, r: 0.6, hd: 1.6, cutoff: 2600, tremolo: 4.5, send: 0.45 },
  lead: { label: '合成主音', oscs: [{ t: 'sawtooth', o: 0, g: 0.4 }, { t: 'square', o: -12, g: 0.2, det: 6 }], a: 0.02, d: 0.15, s: 0.8, r: 0.25, hd: 3.5, cutoff: 2400, cutoffEnv: 2600, send: 0.5 },
  bass: { label: '贝斯', oscs: [{ t: 'sine', o: -12, g: 0.65 }, { t: 'sawtooth', o: -12, g: 0.25 }], a: 0.005, d: 0.25, s: 0.7, r: 0.2, hd: 1.0, cutoff: 900, send: 0.1 },
  pluck: { label: '拨弦', oscs: [{ t: 'square', o: 0, g: 0.4 }], a: 0.003, d: 0.28, s: 0.05, r: 0.15, hd: 0.5, cutoff: 5200, cutoffEnv: -4600, send: 0.3 },
  strings: { label: '弦乐', oscs: [{ t: 'sawtooth', o: 0, g: 0.3, det: -7 }, { t: 'sawtooth', o: 0, g: 0.3, det: 7 }], a: 0.25, d: 0.4, s: 0.85, r: 0.7, hd: 5.0, cutoff: 2200, send: 0.55 }
};

function noteOn(midi, vel) {
  var c = ac(); if (!c) return;
  noteOff(midi, true);
  var T = TIMBRES[currentTimbre] || TIMBRES.piano;
  var t = c.currentTime, f = freq(midi);
  var vv = Math.max(0, Math.min(1, vel == null ? 0.8 : vel));
  var v = Math.max(0.05, Math.pow(vv, 1.6));
  var co = T.cutoff * (0.45 + 0.55 * vv);
  var g = c.createGain();
  var flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = co; flt.Q.value = 0.8;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.5 * v, t + T.a);
  g.gain.exponentialRampToValueAtTime(Math.max(0.02, T.s) * v + 0.001, t + T.a + T.d);
  g.gain.setTargetAtTime(0.0001, t + T.a + T.d, Math.max(0.1, T.hd || 2));
  if (T.cutoffEnv) {
    flt.frequency.setValueAtTime(Math.max(200, co + Math.abs(T.cutoffEnv) * vv), t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(200, co + T.cutoffEnv * vv), t + T.a + T.d);
  }
  var oscs = T.oscs.map(function (o) {
    var osc = c.createOscillator();
    osc.type = o.t; osc.frequency.value = f * Math.pow(2, (o.o || 0) / 12);
    if (o.det) osc.detune.value = o.det;
    var og = c.createGain(); og.gain.value = o.g;
    osc.connect(og); og.connect(flt); osc.start(t);
    return osc;
  });
  flt.connect(g);
  var send = c.createGain(); send.gain.value = T.send || 0;
  g.connect(master); g.connect(send); send.connect(delaySend);
  var trem = null;
  if (T.tremolo) {
    trem = c.createOscillator(); trem.frequency.value = T.tremolo;
    var tg = c.createGain(); tg.gain.value = 0.12 * v;
    trem.connect(tg); tg.connect(g.gain); trem.start(t);
  }
  voices[midi] = { oscs: oscs, gain: g, filter: flt, send: send, trem: trem, timbre: T, vel: v };
}

function noteOff(midi, quick) {
  var c = AC; if (!c || !voices[midi]) return;
  if (sustained && !quick) { sustainedVoices[midi] = true; return; }
  var V = voices[midi]; delete voices[midi]; delete sustainedVoices[midi];
  var t = c.currentTime, r = quick ? 0.03 : V.timbre.r;
  try {
    V.gain.gain.cancelScheduledValues(t);
    V.gain.gain.setTargetAtTime(0.0001, t, r / 3);
    var stopAt = t + r * 4 + 0.1;
    V.oscs.forEach(function (o) { o.stop(stopAt); });
    if (V.trem) V.trem.stop(stopAt);
  } catch (_) {}
}

function releaseSustain() {
  Object.keys(sustainedVoices).forEach(function (m) {
    if (voices[m]) { var keep = sustained; sustained = false; noteOff(+m); sustained = keep; }
  });
  sustainedVoices = {};
}

/* ---- 鼓组（打击垫 1-8） ---- */
function noiseHit(t, dur, type, fval, q, peak) {
  var c = ac(); if (!c) return;
  var src = c.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  var f = c.createBiquadFilter(); f.type = type; f.frequency.value = fval; f.Q.value = q || 1;
  var g = c.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t); src.stop(t + dur + 0.05);
}
function toneHit(t, f0, f1, dur, peak, type) {
  var c = ac(); if (!c) return;
  var o = c.createOscillator(); o.type = type || 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  var g = c.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}
function drum(i, vel) {
  var c = ac(); if (!c) return;
  var t = c.currentTime, v = 0.4 + 0.6 * (vel == null ? 0.9 : vel);
  switch (i % 8) {
    case 0: toneHit(t, 150, 42, 0.16, 0.9 * v); break;                    // Kick
    case 1: noiseHit(t, 0.14, 'bandpass', 1900, 0.8, 0.6 * v); toneHit(t, 190, 150, 0.08, 0.4 * v, 'triangle'); break; // Snare
    case 2: noiseHit(t, 0.05, 'highpass', 7500, 1, 0.35 * v); break;       // Hat
    case 3: noiseHit(t, 0.18, 'bandpass', 1200, 1.6, 0.5 * v); noiseHit(t + 0.02, 0.12, 'bandpass', 900, 1.6, 0.4 * v); break; // Clap
    case 4: toneHit(t, 210, 95, 0.22, 0.7 * v); break;                     // Tom
    case 5: toneHit(t, 1750, 1700, 0.05, 0.3 * v, 'square'); break;        // Rim
    case 6: noiseHit(t, 0.09, 'highpass', 5200, 1, 0.3 * v); break;        // Shaker
    default: noiseHit(t, 0.7, 'highpass', 4200, 1, 0.35 * v); break;       // Crash
  }
}
function blip(f) {
  var c = ac(); if (!c) return;
  var t = c.currentTime, o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = f;
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.15);
}

window.SMK25Engine = {
  get timbre() { return currentTimbre; },
  timbreList: Object.keys(TIMBRES).map(function (k) { return { id: k, label: TIMBRES[k].label }; }),
  setTimbre: function (name) { if (TIMBRES[name]) currentTimbre = name; },
  setVolume: function (v) { volume = v; if (master) master.gain.value = v; },
  setSustain: function (b) { sustained = !!b; if (!sustained) releaseSustain(); },
  noteOn: noteOn, noteOff: noteOff, drum: drum, blip: blip,
  unlock: ac
};
})();

