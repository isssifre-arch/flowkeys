/* 极简 SoundFont2 (SF2) 播放引擎（零依赖）
 * - 解析 RIFF/sfbk：phdr/pbag/pgen/inst/ibag/igen/shdr/smpl
 * - 采样播放：变调、循环、ADSR、声像、衰减、基础低通
 * - 用法：
 *   var p = new SF2Player();
 *   p.load(arrayBuffer, '名字') -> {presets:[...]}
 *   p.setPreset(i) / p.noteOn(midi,vel) / p.noteOff(midi) / p.drum(i,vel) / p.setVolume(0..1)
 */
(function () {
  'use strict';
  function str(u8, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) {
      var c = u8[off + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.replace(/\s+$/, '');
  }
  function mergeGens(dst, src) {
    for (var i = 0; i < src.length; i++) {
      var op = src[i][0], amt = src[i][1];
      var found = -1;
      for (var j = 0; j < dst.length; j++) if (dst[j][0] === op) { found = j; break; }
      if (found >= 0) dst[found] = [op, amt]; else dst.push([op, amt]);
    }
    return dst;
  }
  function SF2Player() {
    this.ctx = null;
    this.master = null;
    this.bank = null;
    this.name = '';
    this.presets = [];
    this.presetIndex = 0;
    this.percIndex = -1;
    this.bufCache = {};
    this.voices = {};
    this.volume = 0.8;
    this.sustain = false;
    this.pendingOff = {};
    this.reverb = { on: false, amt: 'mid' };
    this.revSend = null;
    this.stats = { notes: 0 };
  }
  SF2Player.prototype.unlock = function () {
    var self = this;
    this._ensureCtx();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(function () {});
    }
  };
  SF2Player.prototype._ensureCtx = function () {
    if (this.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    try {
      this.revSend = this.ctx.createGain();
      this.revSend.gain.value = 0;
      var conv = this.ctx.createConvolver();
      conv.buffer = this._impulse(2.6, 2.8);
      var wet = this.ctx.createGain(); wet.gain.value = 1;
      this.revSend.connect(conv); conv.connect(wet); wet.connect(this.master);
    } catch (_) { this.revSend = null; }
    this._applyRev();
  };
  SF2Player.prototype._impulse = function (dur, decay) {
    var rate = this.ctx.sampleRate, len = Math.max(1, Math.round(rate * dur));
    var buf = this.ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  };
  SF2Player.prototype._applyRev = function () {
    if (!this.revSend) return;
    var lvl = { small: 0.10, mid: 0.20, big: 0.34 }[this.reverb.amt] || 0.20;
    this.revSend.gain.value = this.reverb.on ? lvl : 0;
  };
  SF2Player.prototype.setReverb = function (on, amt) {
    this.reverb.on = !!on;
    if (amt) this.reverb.amt = amt;
    this._ensureCtx();
    this._applyRev();
  };
  SF2Player.prototype.setVolume = function (v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  };
  SF2Player.prototype.setSustain = function (on) {
    this.sustain = !!on;
    if (!on) {
      var p = this.pendingOff;
      this.pendingOff = {};
      for (var k in p) this.noteOff(+k);
    }
  };
  /* ---------- 解析 ---------- */
  SF2Player.prototype.load = function (buf, name) {
    var u8 = new Uint8Array(buf), dv = new DataView(buf);
    function tag(off) { return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]); }
    if (tag(0) !== 'RIFF' || tag(8) !== 'sfbk') throw new Error('不是有效的 SF2 文件');
    var smpl = null, smplOff = 0, smplLen = 0;
    var pdta = {};
    var pos = 12;
    while (pos + 8 <= u8.length) {
      var id = tag(pos), size = dv.getUint32(pos + 4, true), body = pos + 8;
      if (id === 'LIST') {
        var sub = tag(body);
        if (sub === 'sdta') {
          var p2 = body + 4, end2 = body + size;
          while (p2 + 8 <= end2) {
            var id2 = tag(p2), sz2 = dv.getUint32(p2 + 4, true);
            if (id2 === 'smpl') { smplOff = p2 + 8; smplLen = sz2; }
            p2 += 8 + sz2 + (sz2 & 1);
          }
        } else if (sub === 'pdta') {
          var p3 = body + 4, end3 = body + size;
          while (p3 + 8 <= end3) {
            var id3 = tag(p3), sz3 = dv.getUint32(p3 + 4, true);
            if (id3 === 'phdr' || id3 === 'pbag' || id3 === 'pgen' || id3 === 'inst' || id3 === 'ibag' || id3 === 'igen' || id3 === 'shdr') {
              pdta[id3] = { off: p3 + 8, size: sz3 };
            }
            p3 += 8 + sz3 + (sz3 & 1);
          }
        }
      }
      pos += 8 + size + (size & 1);
    }
    if (!smplLen || !pdta.phdr) throw new Error('SF2 缺少 smpl/phdr');
    this.smpl = new Int16Array(buf, smplOff, smplLen >> 1);
    var phdr = pdta.phdr, pbag = pdta.pbag, pgen = pdta.pgen, inst = pdta.inst, ibag = pdta.ibag, igen = pdta.igen, shdr = pdta.shdr;
    function rdPhdr(i) {
      var o = phdr.off + i * 38;
      return { name: str(u8, o, 20), preset: dv.getUint16(o + 20, true), bank: dv.getUint16(o + 22, true), bagIdx: dv.getUint16(o + 24, true) };
    }
    function rdInst(i) {
      var o = inst.off + i * 22;
      return { name: str(u8, o, 20), bagIdx: dv.getUint16(o + 20, true) };
    }
    function rdShdr(i) {
      var o = shdr.off + i * 46;
      return {
        name: str(u8, o, 20),
        start: dv.getUint32(o + 20, true), end: dv.getUint32(o + 24, true),
        loopStart: dv.getUint32(o + 28, true), loopEnd: dv.getUint32(o + 32, true),
        sampleRate: dv.getUint32(o + 36, true),
        originalKey: u8[o + 40], correction: dv.getInt8(o + 41),
        sampleLink: dv.getUint16(o + 42, true), sampleType: dv.getUint16(o + 44, true)
      };
    }
    this.shdr = rdShdr;
    function collectGens(genChunk, bagChunk, bIdx, nextBIdx) {
      var gens = [];
      if (!genChunk || !bagChunk) return gens;
      var g0 = dv.getUint16(bagChunk.off + bIdx * 4, true);
      var g1 = dv.getUint16(bagChunk.off + nextBIdx * 4, true);
      if (g1 > genChunk.size >> 2) g1 = genChunk.size >> 2;
      for (var g = g0; g < g1; g++) {
        var o = genChunk.off + g * 4;
        var op = dv.getUint16(o, true);
        var amt = dv.getInt16(o + 2, true);
        gens.push([op, amt]);
      }
      return gens;
    }
    this.mergeGens = mergeGens;
    // instruments
    var insts = [];
    for (var ii = 0; ; ii++) {
      var iRec = rdInst(ii);
      var iNext = rdInst(ii + 1);
      var zones = [];
      var bag0 = iRec.bagIdx, bagN = iNext.bagIdx;
      for (var b = bag0; b < bagN; b++) {
        var gg = collectGens(igen, ibag, b, b + 1);
        var zone = { gens: gg };
        zones.push(zone);
      }
      insts.push({ name: iRec.name, zones: zones });
      if (iRec.name === 'EOP' || iRec.name === 'EOI' || zones.length === 0 && iRec.name.length === 0) break;
      if (ii > 9000) break;
    }
    // presets
    var presets = [];
    for (var pi = 0; ; pi++) {
      var pRec = rdPhdr(pi);
      var pNext = rdPhdr(pi + 1);
      if (pRec.name === 'EOP' || pRec.name === '') break;
      var pzones = [];
      var pb0 = pRec.bagIdx, pbN = pNext.bagIdx;
      for (var pb = pb0; pb < pbN; pb++) {
        var pg = collectGens(pgen, pbag, pb, pb + 1);
        var instIdx = null;
        for (var k = 0; k < pg.length; k++) if (pg[k][0] === 41) instIdx = pg[k][1];
        pzones.push({ gens: pg, inst: instIdx });
      }
      presets.push({ name: pRec.name, preset: pRec.preset, bank: pRec.bank, zones: pzones });
      if (pi > 9000) break;
    }
    this.insts = insts;
    this.presets = presets;
    this.name = name || 'SoundFont';
    this.presetIndex = 0;
    this.percIndex = -1;
    for (var q = 0; q < presets.length; q++) {
      if (presets[q].bank >= 128) { this.percIndex = q; break; }
    }
    this.bufCache = {};
    this.voices = {};
    this._ensureCtx();
    return { presets: presets.map(function (p) { return p.bank + ':' + p.preset + ' ' + p.name; }) };
  };
  SF2Player.prototype.setPreset = function (i) {
    if (i >= 0 && i < this.presets.length) this.presetIndex = i;
  };
  SF2Player.prototype._sampleBuffer = function (si) {
    var cached = this.bufCache[si];
    if (cached) return cached;
    var sh = this.shdr(si);
    var len = sh.end - sh.start;
    if (len <= 1) return null;
    var buf = this.ctx.createBuffer(1, len, sh.sampleRate || 44100);
    var f = buf.getChannelData(0);
    var src = this.smpl, base = sh.start;
    for (var i = 0; i < len; i++) f[i] = src[base + i] / 32768;
    var info = { buffer: buf, loopStart: (sh.loopStart - sh.start) / (sh.sampleRate || 44100), loopEnd: (sh.loopEnd - sh.start) / (sh.sampleRate || 44100), sh: sh };
    this.bufCache[si] = info;
    return info;
  };
  SF2Player.prototype._findVoice = function (midi, vel, presetIdx) {
    var p = this.presets[presetIdx != null ? presetIdx : this.presetIndex];
    if (!p) return null;
    var pGlobal = [], pzStart = 0;
    if (p.zones.length && p.zones[0].inst == null) { pGlobal = p.zones[0].gens.slice(); pzStart = 1; }
    for (var z = pzStart; z < p.zones.length; z++) {
      var pz = p.zones[z];
      if (pz.inst == null) continue;
      var pInst = this.insts[pz.inst];
      if (!pInst) continue;
      var iGlobal = [], izStart = 0;
      if (pInst.zones.length) {
        var hasSample0 = false;
        for (var t = 0; t < pInst.zones[0].gens.length; t++) if (pInst.zones[0].gens[t][0] === 53) hasSample0 = true;
        if (!hasSample0) { iGlobal = pInst.zones[0].gens.slice(); izStart = 1; }
      }
      for (var iz = izStart; iz < pInst.zones.length; iz++) {
        var zone = pInst.zones[iz];
        var gens = mergeGens(mergeGens(mergeGens(mergeGens([], pGlobal), iGlobal), pz.gens), zone.gens);
        var lo = 0, hi = 127, vlo = 0, vhi = 127, sample = null;
        for (var g = 0; g < gens.length; g++) {
          var op = gens[g][0], amt = gens[g][1];
          if (op === 43) { lo = amt & 0xff; hi = (amt >> 8) & 0xff; }
          else if (op === 44) { vlo = amt & 0xff; vhi = (amt >> 8) & 0xff; }
          else if (op === 53) { sample = amt; }
        }
        if (sample == null) continue;
        if (midi < lo || midi > hi) continue;
        var vInt = Math.round(vel * 127);
        if (vInt < vlo || vInt > vhi) continue;
        var gen = {};
        for (var g2 = 0; g2 < gens.length; g2++) gen[gens[g2][0]] = gens[g2][1];
        return { si: sample, gen: gen, sh: this.shdr(sample) };
      }
    }
    return null;
  };
  SF2Player.prototype.noteOn = function (midi, vel) {
    this._ensureCtx();
    if (!this.ctx || !this.presets.length) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(function () {});
    var v = this._findVoice(midi, vel == null ? 0.85 : vel, null);
    if (!v) return;
    var info = this._sampleBuffer(v.si);
    if (!info) return;
    var ctx = this.ctx, now = ctx.currentTime;
    var sh = info.sh, gen = v.gen;
    var root = gen[58] != null ? gen[58] : sh.originalKey;
    var tune = (sh.correction || 0) + (gen[52] || 0) * 1 + (gen[51] || 0) * 100;
    var rate = Math.pow(2, ((midi - root) * 100 + tune) / 1200);
    var src = ctx.createBufferSource();
    src.buffer = info.buffer;
    src.playbackRate.value = rate;
    var mode = gen[54] || 0;
    if ((mode === 1 || mode === 3) && info.loopEnd > info.loopStart) {
      src.loop = true;
      src.loopStart = info.loopStart;
      src.loopEnd = info.loopEnd;
    }
    var env = ctx.createGain();
    var att = gen[34] != null ? Math.pow(2, gen[34] / 1200) : 0.002;
    var dec = gen[35] != null ? Math.pow(2, gen[35] / 1200) : 0.05;
    var sus = gen[36] != null ? Math.pow(10, -gen[36] / 200) : 1;
    var rel = gen[37] != null ? Math.pow(2, gen[37] / 1200) : 0.12;
    att = Math.max(0.001, Math.min(4, att));
    dec = Math.max(0.005, Math.min(6, dec));
    rel = Math.max(0.01, Math.min(6, rel));
    var vv = Math.max(0, Math.min(1, vel == null ? 0.85 : vel));
    var atten = gen[48] != null ? Math.pow(10, -gen[48] / 200) : 1;
    var peak = Math.max(0.02, Math.pow(vv, 1.5)) * atten * 0.9;
    var g = env.gain;
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(peak, now + att);
    g.linearRampToValueAtTime(Math.max(0.0001, peak * sus), now + att + dec);
    g.setTargetAtTime(0.0001, now + att + dec + 4.0, 1.6);
    var node = src;
    var filt = null;
    if (gen[8] != null) {
      try {
        filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = Math.max(200, Math.min(16000, 8.176 * Math.pow(2, gen[8] / 1200)));
        filt.Q.value = 0.7;
        node.connect(filt);
        node = filt;
      } catch (_) { filt = null; }
    }
    var pan = gen[17] != null ? Math.max(-1, Math.min(1, gen[17] / 500)) : 0;
    var out = env;
    if (pan !== 0 && ctx.createStereoPanner) {
      var sp = ctx.createStereoPanner();
      sp.pan.value = pan;
      env.connect(sp);
      out = sp;
    }
    node.connect(env);
    out.connect(this.master);
    if (this.revSend) out.connect(this.revSend);
    try { src.start(now); } catch (_) {}
    var voice = { src: src, env: env, rel: rel, released: false };
    var prev = this.voices[midi];
    if (prev) this._kill(prev, 0.03);
    this.voices[midi] = voice;
    this.stats.notes++;
  };
  SF2Player.prototype._kill = function (voice, t) {
    try {
      var now = this.ctx.currentTime;
      voice.env.gain.cancelScheduledValues(now);
      voice.env.gain.setValueAtTime(Math.max(0.0001, voice.env.gain.value), now);
      voice.env.gain.linearRampToValueAtTime(0.0001, now + t);
      voice.src.stop(now + t + 0.05);
    } catch (_) {}
  };
  SF2Player.prototype.noteOff = function (midi) {
    var voice = this.voices[midi];
    if (!voice) return;
    if (this.sustain) { this.pendingOff[midi] = 1; return; }
    delete this.voices[midi];
    voice.released = true;
    this._kill(voice, voice.rel);
  };
  SF2Player.prototype.drum = function (i, vel) {
    var note = 36 + (i | 0);
    if (this.percIndex >= 0) {
      var saved = this.presetIndex;
      this.presetIndex = this.percIndex;
      this.noteOn(note, vel == null ? 0.9 : vel);
      this.presetIndex = saved;
      var self = this;
      setTimeout(function () { self.noteOff(note); }, 300);
    } else {
      this.noteOn(note, vel == null ? 0.9 : vel);
      var self2 = this;
      setTimeout(function () { self2.noteOff(note); }, 300);
    }
  };
  SF2Player.prototype.stopAll = function () {
    var vs = this.voices;
    this.voices = {};
    for (var k in vs) this._kill(vs[k], 0.05);
  };
  window.SF2Player = SF2Player;
})();
