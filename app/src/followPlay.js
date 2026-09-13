/* 跟弹：本地曲库 + 谱面（五线谱/简谱/钢琴块）+ 3D 联动 + 打分
 * 依赖 window.__smk25（3D）、Vex.Flow（CDN，可缺省）、./songs/index.json
 */
(function () {
'use strict';
function S() { return window.__smk25; }
function T(k) { return window.__T ? window.__T.apply(null, Array.prototype.slice.call(arguments)) : k; }
var NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
var JP = ['1', '#1', '2', '#2', '3', '4', '#4', '5', '#5', '6', '#6', '7'];

var st = {
  els: null, list: [], song: null,
  playing: false, paused: false, atEnd: false, idx: 0,
  hits: 0, missed: 0, combo: 0, maxCombo: 0, bpm: 120, audio: new Audio(),
  raf: 0, vStart: 0, vOffset: 0, _barX: null, _sysRows: null
};
st.audio.preload = 'auto';

var SCOREMODE = 'staff', ACC = false;
try { SCOREMODE = localStorage.getItem('smk25score') || 'staff'; } catch (_) {}
try { ACC = localStorage.getItem('smk25acc') === '1'; } catch (_) {}
if (SCOREMODE !== 'jianpu' && SCOREMODE !== 'tiles') SCOREMODE = 'staff';

function rateVal() { return (st.els && parseFloat(st.els.rate.value)) || 1; }
var loopA = null, loopB = null, loopOn = false;
function setLoopPoint(which) {
  if (!st.song) return;
  var t = nowT();
  if (which === 'A') { loopA = t; if (loopB != null && loopB <= loopA) loopB = null; }
  else { loopB = t; if (loopA != null && loopB <= loopA) loopA = null; }
  updateLoopUI();
  if (window.__ui) window.__ui.toast((which === 'A' ? T('fp.loopA') : T('fp.loopB')) + '：' + t.toFixed(1) + 's' + ((loopA == null || loopB == null) ? T('fp.loopMore') : ''));
}
function toggleLoop() {
  if (loopA == null || loopB == null) { if (window.__ui) window.__ui.toast(T('fp.loopNeed')); return; }
  loopOn = !loopOn; updateLoopUI();
  if (window.__ui) window.__ui.toast(T(loopOn ? 'fp.loopOn' : 'fp.loopOff'));
}
function updateLoopUI() {
  if (!st.els) return;
  if (st.els.bSA) { st.els.bSA.classList.toggle('set', loopA != null); }
  if (st.els.bSB) { st.els.bSB.classList.toggle('set', loopB != null); }
  if (st.els.bSLoop) { st.els.bSLoop.classList.toggle('looped', loopOn); }
}
function resetLoop() { loopA = null; loopB = null; loopOn = false; updateLoopUI(); }
function songParts() {
  if (!st.song) return [];
  var mode = (S() && S().handsMode) ? S().handsMode() : 'both';
  if (mode === 'acc' && st.song.acc && st.song.acc.length) return st.song.acc;
  return st.song.melody;
}
function fitPart(midi) {
  var map = {};
  S().model.whiteKeys.concat(S().model.blackKeys).forEach(function (p) { map[p.midi] = p; });
  var n = midi;
  if (map[n] !== undefined) return map[n];
  while (n < 48) n += 12;
  while (n > 72) n -= 12;
  return map[n] || null;
}

/* ---------------- 初始化 ---------------- */
async function init(els) {
  st.els = els;
  try {
    var r = await fetch('./songs/index.json');
    st.list = await r.json();
  } catch (e) { st.list = []; }
  st.list = st.list.concat(localMetas());
  renderPicker();
  els.playToggle.onclick = function () { toggle(); };
  els.exit.onclick = function () { exitSong(); };
  try { var rv = parseFloat(localStorage.getItem('smk25rate') || '1'); if (rv && els.rate.querySelector('option[value="' + rv + '"]')) els.rate.value = String(rv); } catch (_) {}
  els.rate.onchange = function () { setRate(parseFloat(els.rate.value) || 1); try { localStorage.setItem('smk25rate', els.rate.value); } catch (_) {} };
  if (els.bSA) els.bSA.onclick = function () { setLoopPoint('A'); };
  if (els.bSB) els.bSB.onclick = function () { setLoopPoint('B'); };
  if (els.bSLoop) els.bSLoop.onclick = function () { toggleLoop(); };
  els.prog.addEventListener('input', function () { seek(this.value / 1000 * (st.song ? st.song.duration : 0)); });
  if (els.scoreMode) { els.scoreMode.value = SCOREMODE; els.scoreMode.onchange = function () { setScoreMode(els.scoreMode.value); }; }
  if (els.acc) { els.acc.onclick = function () { setAcc(!ACC); }; updateAccBtn(); }
  if (els.bFollow && els.followPop) {
    els.bFollow.onclick = function (e) { e.stopPropagation(); els.followPop.classList.toggle('show'); };
    document.addEventListener('click', function (e) { if (!els.followPop.contains(e.target) && e.target !== els.bFollow) els.followPop.classList.remove('show'); });
    renderFollowPicker();
  }
  if (els.pExit) els.pExit.onclick = function () { exitPractice(); };
  if (els.pRestart) els.pRestart.onclick = function () { restartPractice(); };
  var fileIn = document.createElement('input');
  fileIn.type = 'file';
  fileIn.accept = '.mid,.midi,audio/midi';
  fileIn.multiple = true;
  fileIn.style.display = 'none';
  document.body.appendChild(fileIn);
  fileIn.addEventListener('change', function () { importMidiFiles(fileIn.files); fileIn.value = ''; });
  st.fileIn = fileIn;
  st.audio.addEventListener('ended', function () {
    if (st.playing) endSong(true);
  });
  st.audio.addEventListener('error', function () {
    if (!st.audio.src) return;
    if (window.__ui) window.__ui.toast(T('toast.audioMissing'));
    if (ACC) setAcc(false);
  });
}

function renderPicker() {
  var pop = st.els.pop;
  pop.innerHTML = '';
  pop.style.maxHeight = '';
  pop.style.overflowY = '';
  var imp = document.createElement('div');
  imp.className = 'item';
  var imn = document.createElement('span'); imn.textContent = T('fp.import');
  var iar = document.createElement('small'); iar.textContent = T('fp.importSub');
  imp.appendChild(imn); imp.appendChild(iar);
  imp.onclick = function (e) { e.stopPropagation(); if (st.fileIn) st.fileIn.click(); };
  pop.appendChild(imp);
  var search = document.createElement('div');
  search.className = 'item';
  var snm = document.createElement('span'); snm.textContent = T('fp.online');
  var sar = document.createElement('small'); sar.textContent = T('fp.onlineSub');
  search.appendChild(snm); search.appendChild(sar);
  search.onclick = function (e) { e.stopPropagation(); renderSearchView(); };
  pop.appendChild(search);
  if (!st.list.length) {
    var em0 = document.createElement('div');
    em0.style.cssText = 'padding:10px 12px;color:#9ca3af;font-size:12px';
    em0.textContent = T('fp.empty');
    pop.appendChild(em0);
    return;
  }
  var filterBox = document.createElement('div');
  filterBox.style.cssText = 'padding:2px 8px 8px';
  var fin = document.createElement('input');
  fin.type = 'text';
  fin.placeholder = T('fp.searchSong');
  fin.style.cssText = 'width:100%;box-sizing:border-box;background:#111827;border:1px solid #374151;color:#e5e7eb;border-radius:8px;padding:6px 10px;font-size:12.5px;outline:none;font-family:inherit';
  filterBox.appendChild(fin);
  pop.appendChild(filterBox);
  var songList = document.createElement('div');
  pop.appendChild(songList);
  function renderSongs(q) {
    songList.innerHTML = '';
    var ql = String(q || '').toLowerCase();
    var list = st.list.filter(function (s) {
      return !ql || String(s.name).toLowerCase().indexOf(ql) >= 0 || String(s.artist || '').toLowerCase().indexOf(ql) >= 0;
    });
    if (!list.length) {
      var em = document.createElement('div');
      em.style.cssText = 'padding:10px 12px;color:#9ca3af;font-size:12px';
      em.textContent = T('fp.noMatch');
      songList.appendChild(em);
      return;
    }
    list.forEach(function (song) {
      var d = document.createElement('div');
      d.className = 'item';
      var nm = document.createElement('span'); nm.textContent = song.name;
      var right = document.createElement('span');
      right.style.cssText = 'display:flex;gap:10px;align-items:center';
      var ar = document.createElement('small'); ar.textContent = song.artist || '';
      right.appendChild(ar);
      if (song.isLocal) {
        var del = document.createElement('span');
        del.textContent = '×'; del.title = T('fp.del');
        del.style.cssText = 'color:#9ca3af;font-size:14px;padding:0 2px';
        del.onclick = function (e) { e.stopPropagation(); deleteLocalSong(song.id); };
        right.appendChild(del);
      }
      d.appendChild(nm); d.appendChild(right);
      d.onclick = function () { window.__ui.hidePop(); loadById(song.id); };
      songList.appendChild(d);
    });
  }
  fin.oninput = function () { renderSongs(fin.value); };
  renderSongs('');
}

async function loadById(id) {
  var meta = st.list.filter(function (s) { return s.id === id; })[0];
  if (!meta) return;
  if (meta.isLocal) {
    var ls = loadLocalSong(id);
    if (!ls) { if (window.__ui) window.__ui.toast(T('fp.songMissing')); return; }
    ls.name = meta.name; ls.artist = T('fp.artistImport');
    loadSong(ls);
    return;
  }
  try {
    var r = await fetch('./songs/' + meta.file);
    var song = await r.json();
    song.name = meta.name;
    song.artist = meta.artist;
    if (meta.audio) song.audio = meta.audio;
    loadSong(song);
  } catch (e) {
    if (window.__ui) window.__ui.toast(T('fp.songFail'));
  }
}

/* ---------------- 载入曲目 ---------------- */
function loadSong(song) {
  st.song = song; st.bpm = song.bpm || 120;
  st.hits = 0; st.missed = 0; st.combo = 0; st.maxCombo = 0; st.idx = 0; st.atEnd = false; st.vOffset = 0;
  resetLoop();
  song.melody.forEach(function (n) { n.consumed = false; n.missed = false; n.pc = n.midi % 12; n._key = fitPart(n.midi); n._holding = false; });
  if (song.acc) song.acc.forEach(function (n) { n.consumed = false; n.missed = false; n.pc = n.midi % 12; n._key = fitPart(n.midi); n._holding = false; });
  st.els.title.textContent = song.name;
  st.els.songName.textContent = song.name + (song.artist ? ' · ' + song.artist : '');
  st.els.chord.textContent = '';
  if (song.audio) st.audio.src = './songs/' + song.audio;
  else st.audio.removeAttribute('src');
  try { st.audio.pause(); st.audio.currentTime = 0; } catch (_) {}
  applyScoreMode();
  updateTransport();
  updateScore();
  document.body.classList.add('playmode');
  window.__ui.dockMode('song');
  st.els.playToggle.textContent = '▶';
}

function exitSong() {
  stopPlay();
  stopTiles();
  setKeysOnly(false);
  st.song = null;
  document.body.classList.remove('playmode');
  window.__ui.dockMode('idle');
  st.els.title.textContent = '';
  if (SCOREMODE === 'tiles' && S() && S().setView) S().setView('idle');
}

/* ---------------- 谱面模式 ---------------- */
function applyScoreMode() {
  if (st.els && st.els.scoreMode) st.els.scoreMode.value = SCOREMODE;
  document.body.classList.toggle('score-tiles', SCOREMODE === 'tiles');
  document.body.classList.toggle('score-jianpu', SCOREMODE === 'jianpu');
  if (!st.song) return;
  if (SCOREMODE === 'tiles') {
    setKeysOnly(true);
    ensureTiles(); layoutTiles(); startTiles();
    if (S() && S().setHint) S().setHint(null);
    if (S() && S().setView) S().setView('tiles');
  } else {
    setKeysOnly(false);
    stopTiles();
    if (SCOREMODE === 'jianpu') buildJianpu(); else buildStaff();
    if (S() && S().setView) S().setView('play');
  }
}
function setScoreMode(m) {
  SCOREMODE = (m === 'jianpu' || m === 'tiles') ? m : 'staff';
  try { localStorage.setItem('smk25score', SCOREMODE); } catch (_) {}
  applyScoreMode();
}

/* ---------------- 五线谱 ---------------- */
function midiKey(m) {
  var n = NAMES[m % 12], o = Math.floor(m / 12) - 1;
  return { key: n + '/' + o, acc: n.indexOf('#') >= 0 ? '#' : null };
}
function durSym(beats) {
  if (beats >= 3.5) return 'w';
  if (beats >= 1.75) return 'h';
  if (beats >= 0.75) return 'q';
  if (beats >= 0.375) return '8';
  if (beats >= 0.18) return '16';
  return '32';
}
function mkNote(midi, sym, isRest) {
  var VF = Vex.Flow, k = isRest ? 'd/5' : midiKey(midi).key;
  var n = new VF.StaveNote({ clef: 'treble', keys: [k], duration: sym + (isRest ? 'r' : '') });
  try { if (n.setStyle) n.setStyle({ fillStyle: '#e2e8f0', strokeStyle: '#e2e8f0' }); } catch (_) {}
  if (!isRest && midiKey(midi).acc) {
    try {
      var a = new VF.Accidental('#');
      if (a.setStyle) a.setStyle({ fillStyle: '#e2e8f0', strokeStyle: '#e2e8f0' });
      n.addAccidental(0, a);
    } catch (_) {}
  }
  return n;
}
function resolveChords(chords, barSec) {
  var last = null, out = [];
  (chords || []).forEach(function (c) {
    var v = c.chord === '=' ? last : c.chord;
    if (c.chord && c.chord !== '=') last = c.chord;
    out.push({ bar: c.bar, chord: v, time: (c.time != null ? c.time : c.bar * barSec) });
  });
  return out;
}
function barsOf(song, barSec) {
  var bars = {};
  song.melody.forEach(function (n) {
    var b = Math.floor(n.start / barSec);
    (bars[b] = bars[b] || []).push(n);
  });
  return bars;
}
function buildStaff() {
  var VF = window.Vex && window.Vex.Flow;
  var host = st.els.sheets; host.innerHTML = '';
  if (!VF) { host.innerHTML = '<div style="padding:20px;color:#666">' + T('fp.vexFail') + '</div>'; return; }
  var song = st.song, bpm = st.bpm, beat = 60 / bpm, barSec = 4 * beat;
  var chords = resolveChords(song.chords, barSec);
  song._chordsR = chords;
  var bars = barsOf(song, barSec);
  var maxBar = Math.max.apply(null, [0].concat(Object.keys(bars).map(Number))
    .concat(chords.map(function (c) { return Math.floor(c.time / barSec); })));
  var MPS = 4, W = 268;
  st.els.meta.textContent = T('fp.bars', Math.round(bpm), maxBar + 1);
  for (var s0 = 0; s0 <= maxBar; s0 += MPS) {
    (function (s0) {
      var row = document.createElement('div'); row.className = 'sysRow';
      host.appendChild(row);
      var renderer = new VF.Renderer(row, VF.Renderer.Backends.SVG);
      var widths = [];
      for (var wi = 0; wi < MPS; wi++) widths.push((s0 === 0 && wi === 0) ? W + 70 : W - 24);
      var totW = widths.reduce(function (a, b) { return a + b; }, 0);
      renderer.resize(totW + 20, 150);
      var ctx = renderer.getContext();
      var voices = [], staves = [], xx = 10;
      for (var i = 0; i < MPS; i++) {
        var b = s0 + i;
        if (b > maxBar && i > 0) break;
        var stave = new VF.Stave(xx, 30, widths[i] - 8);
        if (s0 === 0 && i === 0) { stave.addClef('treble'); stave.addTimeSignature('4/4'); }
        try { if (stave.setStyle) stave.setStyle({ fillStyle: '#94a3b8', strokeStyle: '#94a3b8' }); } catch (_) {}
        stave.setContext(ctx).draw();
        staves.push({ stave: stave, bar: b });
        var notes = [], cursor = b * barSec;
        (bars[b] || []).slice().sort(function (a, c2) { return a.start - c2.start; }).forEach(function (n) {
          if (n.start - cursor > beat * 0.4) {
            var gap = n.start - cursor, g = gap / beat;
            while (g > 0.2) {
              var take = g >= 3.5 ? 4 : g >= 1.75 ? 2 : g >= 0.75 ? 1 : g >= 0.375 ? 0.5 : 0.25;
              notes.push(mkNote(0, durSym(take), true)); g -= take;
            }
          }
          notes.push(mkNote(n.midi, durSym(n.dur / beat), false));
          n._bar = b;
          cursor = Math.max(cursor, n.start + n.dur);
        });
        if (!notes.length) notes.push(mkNote(0, 'w', true));
        var v = new VF.Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
        v.addTickables(notes); voices.push(v);
        var ch = null;
        chords.forEach(function (c) { if (Math.floor(c.time / barSec) === b && c.chord) ch = c.chord; });
        if (ch) {
          var cd = document.createElement('div'); cd.className = 'barChord';
          cd.style.left = (xx + 22) + 'px'; cd.textContent = ch;
          row.appendChild(cd);
        }
        xx += widths[i];
      }
      try { new VF.Formatter().joinVoices(voices).format(voices, totW - 120); } catch (_) {}
      voices.forEach(function (v, vi) { try { v.draw(ctx, staves[vi].stave); } catch (_) {} });
      row._bar0 = s0; row._widths = widths;
    })(s0);
  }
  computeX();
  updateCursor(-1, '');
}

/* ---------------- 简谱 ---------------- */
function buildJianpu() {
  var host = st.els.sheets; host.innerHTML = '';
  var song = st.song, bpm = st.bpm, beat = 60 / bpm, barSec = 4 * beat;
  var chords = song._chordsR || resolveChords(song.chords, barSec);
  song._chordsR = chords;
  var bars = barsOf(song, barSec);
  var maxBar = Math.max.apply(null, [0].concat(Object.keys(bars).map(Number))
    .concat(chords.map(function (c) { return Math.floor(c.time / barSec); })));
  var MPS = 4, W = 268;
  st.els.meta.textContent = T('fp.barsJp', Math.round(bpm), maxBar + 1);
  for (var s0 = 0; s0 <= maxBar; s0 += MPS) {
    (function (s0) {
      var row = document.createElement('div'); row.className = 'sysRow jpRow';
      host.appendChild(row);
      var widths = [];
      for (var wi = 0; wi < MPS; wi++) widths.push((s0 === 0 && wi === 0) ? W + 70 : W - 24);
      var xx = 10;
      for (var i = 0; i < MPS; i++) {
        var b = s0 + i;
        if (b > maxBar && i > 0) break;
        var bar = document.createElement('div'); bar.className = 'jpBar';
        bar.style.left = xx + 'px'; bar.style.width = (widths[i] - 8) + 'px';
        var ch = null;
        chords.forEach(function (c) { if (Math.floor(c.time / barSec) === b && c.chord) ch = c.chord; });
        if (ch) { var cd = document.createElement('div'); cd.className = 'barChord'; cd.style.left = '12px'; cd.textContent = ch; bar.appendChild(cd); }
        var list = (bars[b] || []).slice().sort(function (a, c2) { return a.start - c2.start; });
        if (!list.length) {
          var rr = document.createElement('span'); rr.className = 'jpRest'; rr.textContent = '0';
          bar.appendChild(rr);
        }
        list.forEach(function (n) {
          var frac = (n.start - b * barSec) / barSec;
          var el = document.createElement('span'); el.className = 'jpNote';
          el.style.left = (30 + frac * (widths[i] - 60)) + 'px';
          var pc = n.midi % 12, oct = Math.floor(n.midi / 12) - 1;
          var up = oct > 4 ? Math.min(oct - 4, 2) : 0, dn = oct < 4 ? Math.min(4 - oct, 2) : 0;
          var html = '';
          if (up) html += '<i class="oct up">' + new Array(up + 1).join('•') + '</i>';
          var beats = n.dur / beat;
          var dashN = beats >= 1.75 ? Math.min(3, Math.max(1, Math.round(beats) - 1)) : 0;
          html += '<span class="num">' + JP[pc] + (dashN ? '<i class="dash">' + new Array(dashN + 1).join(' -') + '</i>' : '') + '</span>';
          if (dn) html += '<i class="oct dn">' + new Array(dn + 1).join('•') + '</i>';
          el.innerHTML = html;
          if (beats < 0.75) el.classList.add(beats < 0.375 ? 'jp16' : 'jp8');
          n._bar = b;
          bar.appendChild(el);
        });
        row.appendChild(bar);
        xx += widths[i];
      }
      row._bar0 = s0; row._widths = widths;
    })(s0);
  }
  computeX();
  updateCursor(-1, '');
}

/* 谱面坐标（光标/自动滚动共用） */
function computeX() {
  var MPS = 4, W = 268;
  var body = st.els.body, host = st.els.sheets;
  var brect = body.getBoundingClientRect();
  st._sysRows = Array.prototype.slice.call(host.children);
  st._barX = {};
  st._sysRows.forEach(function (row) {
    var r = row.getBoundingClientRect(), acc = 10;
    for (var i = 0; i < MPS; i++) {
      var b = row._bar0 + i;
      var w = (row._widths && row._widths[i]) || W;
      st._barX[b] = { left: r.left - brect.left + acc, row: row, w: w };
      acc += w;
    }
  });
  var barSec = 4 * (60 / st.bpm);
  st.song.melody.forEach(function (n) {
    var b = Math.floor(n.start / barSec);
    var info = st._barX[b];
    if (info) n._x = info.left + 30 + ((n.start - b * barSec) / barSec) * (info.w - 60);
  });
}
function updateCursor(t, chord) {
  var cur = st.els.cursor, body = st.els.body;
  if (t < 0 || !st.song) { cur.style.display = 'none'; return; }
  var bpm = st.bpm, barSec = 4 * (60 / bpm);
  var bar = Math.floor(t / barSec);
  var best = null, bd = 1e9;
  st.song.melody.forEach(function (n) {
    if (n._x == null) return;
    var d = Math.abs(n.start - t);
    if (d < bd) { bd = d; best = n; }
  });
  if (best && bd < barSec) {
    cur.style.display = 'block';
    cur.style.left = best._x + 'px';
    Array.prototype.forEach.call(st.els.sheets.children, function (row) {
      row.classList.toggle('playing', row._bar0 <= bar && bar < row._bar0 + 4);
    });
    var row = st._barX[bar] && st._barX[bar].row;
    if (row && row._lastBar !== bar) {
      row._lastBar = bar;
      var rb = row.getBoundingClientRect(), bb = body.getBoundingClientRect();
      if (rb.top < bb.top || rb.bottom > bb.bottom) body.scrollTop += rb.top - bb.top - 60;
    }
  }
  if (chord !== undefined) st.els.chord.textContent = chord || '';
}

/* ---------------- 钢琴块（以琴键为判定区，音符无缝落到键上） ---------------- */
var tiles = { cv: null, ctx: null, raf: 0, held: null, flashes: [], speed: 260 };
function tilesActive() { return SCOREMODE === 'tiles' && !!st.song && document.body.classList.contains('playmode'); }
function setKeysOnly(on) {
  var parts = (S() && S().parts) || [];
  parts.forEach(function (p) { p.group.visible = on ? (p.kind === 'white' || p.kind === 'black') : true; });
}
function ensureTiles() {
  if (tiles.cv) return;
  var host = document.getElementById('tiles');
  if (!host) return;
  host.innerHTML = '';
  var cv = document.createElement('canvas');
  host.appendChild(cv);
  tiles.cv = cv; tiles.ctx = cv.getContext('2d');
  window.addEventListener('resize', layoutTiles);
  layoutTiles();
}
function layoutTiles() {
  if (!tiles.cv) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  tiles.cv.width = Math.floor(innerWidth * dpr);
  tiles.cv.height = Math.floor(innerHeight * dpr);
  tiles.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function startTiles() { if (tiles.cv && !tiles.raf) tiles.raf = requestAnimationFrame(tilesFrame); }
function stopTiles() {
  if (tiles.raf) cancelAnimationFrame(tiles.raf);
  tiles.raf = 0; tiles.held = null; tiles.flashes = [];
}
function gameT() {
  if (st.playing || st.paused) return nowT();
  return st.vOffset || 0;
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
var _tv = new THREE.Vector3();
function keyRect(k) {
  var b = new THREE.Box3().setFromObject(k.group);
  var y = b.max.y, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  [[b.min.x, b.min.z], [b.max.x, b.min.z], [b.min.x, b.max.z], [b.max.x, b.max.z]].forEach(function (c2) {
    _tv.set(c2[0], y, c2[1]).project(S().camera);
    var sx = (_tv.x * 0.5 + 0.5) * innerWidth, sy = (-_tv.y * 0.5 + 0.5) * innerHeight;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  });
  return { l: minX, r: maxX, y: minY, y2: maxY, w: maxX - minX };
}
function tilesFrame() {
  tiles.raf = requestAnimationFrame(tilesFrame);
  var ctx = tiles.ctx;
  if (!ctx) return;
  var W = innerWidth, H = innerHeight;
  ctx.clearRect(0, 0, W, H);
  var song = st.song;
  if (!song) return;
  var t = gameT();
  var rects = {}, whiteY = 0, frontY = 0;
  var keys = S().model.whiteKeys.concat(S().model.blackKeys);
  keys.forEach(function (k) {
    var r = keyRect(k);
    rects[k.id] = r;
    if (k.kind === 'white' && r.y > whiteY) whiteY = r.y;
    if (k.kind === 'white' && r.y2 > frontY) frontY = r.y2;
  });
  if (whiteY > 60) tiles.speed = (whiteY - 10) / 2.0;
  var speed = tiles.speed;
  if (!frontY) frontY = H;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, -80, W, frontY + 4 + 80);
  ctx.clip();
  song.melody.forEach(function (n) {
    var k = n._key;
    var r = k && rects[k.id];
    if (!r) return;
    var yb = r.y + (t - n.start) * speed;
    var hFull = Math.max(24, Math.min(n.dur || 0.3, 1.2) * speed);
    var yt = yb - hFull;
    if (yt > H + 60 || yb < -60) return;
    var x = r.l + 2, w = Math.max(10, r.w - 4);
    var c0, c1;
    if (n.missed) { c0 = 'rgba(239,68,68,.40)'; c1 = 'rgba(239,68,68,.5)'; }
    else if (n.consumed) { c0 = 'rgba(74,222,128,.7)'; c1 = 'rgba(34,197,94,.9)'; }
    else { c0 = 'rgba(103,232,249,.92)'; c1 = 'rgba(34,211,238,.98)'; }
    if (n._holding) { c0 = 'rgba(236,254,255,.96)'; c1 = 'rgba(103,232,249,.98)'; }
    var hHead = Math.min(hFull, 120);
    if (hFull - hHead > 14) {
      ctx.fillStyle = n.missed ? 'rgba(239,68,68,.22)' : (n.consumed ? 'rgba(34,197,94,.34)' : 'rgba(34,211,238,.38)');
      var tw = w * 0.22;
      var tailTop = yt + 8, tailBot = yb - hHead;
      if (tailBot > tailTop) ctx.fillRect(x + (w - tw) / 2, tailTop, tw, tailBot - tailTop);
      ctx.fillStyle = c1;
      roundRect(ctx, x + w * 0.25, yt, w * 0.5, 18, 7); ctx.fill();
    }
    var grad = ctx.createLinearGradient(0, yb - hHead, 0, yb);
    grad.addColorStop(0, c0); grad.addColorStop(1, c1);
    ctx.fillStyle = grad;
    roundRect(ctx, x, yb - hHead, w, hHead, Math.min(9, w / 2)); ctx.fill();
  });
  var noww = performance.now();
  for (var f = tiles.flashes.length - 1; f >= 0; f--) {
    var fl = tiles.flashes[f], age = (noww - fl.wall) / 1000;
    if (age > 0.35) { tiles.flashes.splice(f, 1); continue; }
    if (!fl.rect) continue;
    var a = 1 - age / 0.35;
    var fr = fl.rect;
    ctx.fillStyle = fl.ok ? 'rgba(103,232,249,' + (0.3 * a).toFixed(3) + ')' : 'rgba(248,113,113,' + (0.34 * a).toFixed(3) + ')';
    roundRect(ctx, fr.l - 2, fr.y - 6, fr.w + 4, 40 + 10 * (1 - a), 8); ctx.fill();
  }
  ctx.restore();
}
function playKeyFx(p) {
  if (!p) return;
  if (S().hitKey) S().hitKey(p.midi);
  if (S().pressVisual) S().pressVisual(p);
  if (window.SMK25Engine) window.SMK25Engine.noteOn(p.midi, 0.9);
}
function stopKeyFx(p) {
  if (!p) return;
  if (window.SMK25Engine) window.SMK25Engine.noteOff(p.midi);
}
function tilesDown(p) {
  if (!tilesActive()) return false;
  if (!st.playing || !st.song) { playKeyFx(p); return true; }
  var t = gameT(), best = null, bd = 1e9, tol = diffTol();
  var pc = p ? (((p.midi % 12) + 12) % 12) : -1;
  if (p) st.song.melody.forEach(function (n) {
    if (n.consumed || n.missed || !n._key) return;
    var exact = (n._key === p);
    var near = (tol > 0 && icDist(pc, n.pc) <= tol);
    if (!exact && !near) return;
    var d = Math.abs(n.start - t);
    if (d < 0.45 && d < bd) { bd = d; best = n; }
  });
  var kp = best ? best._key : p;
  playKeyFx(kp);
  var r = kp ? keyRect(kp) : null;
  if (!best) {
    if (r) tiles.flashes.push({ rect: r, ok: false, wall: performance.now() });
    setTimeout(function () { stopKeyFx(kp); }, 350);
    return true;
  }
  best.consumed = true; st.hits++; updateScore();
  tiles.flashes.push({ rect: r, ok: true, wall: performance.now() });
  if ((best.dur || 0) > 0.55) {
    best._holding = true;
    tiles.held = { n: best, key: kp };
  } else {
    setTimeout(function () { stopKeyFx(kp); }, 350);
  }
  return true;
}
function tilesUp() {
  var h = tiles.held;
  if (!h) return;
  tiles.held = null;
  var n = h.n; n._holding = false;
  stopKeyFx(h.key);
  if (gameT() < n.start + Math.min(n.dur || 0, 3) - 0.15) {
    st.hits = Math.max(0, st.hits - 1); st.missed++; updateScore();
    n.missed = true;
  }
}
window.__tilesDown = tilesDown;
window.__tilesUp = tilesUp;

/* ---------------- 跟弹练习（独立板块 · 自定节奏，无谱面/无速度限制） ---------------- */
var pr = { on: false, song: null, idx: 0, list: [], right: 0, wrong: 0, combo: 0, maxCombo: 0 };
function prName(m) { return NAMES[m % 12].toUpperCase() + (Math.floor(m / 12) - 1); }
function renderFollowPicker() {
  var pop = st.els.followPop;
  if (!pop) return;
  pop.innerHTML = '';
  if (!st.list.length) {
    pop.innerHTML = '<div style="padding:10px 12px;color:#9ca3af;font-size:12px">' + T('fp.empty') + '</div>';
    return;
  }
  st.list.forEach(function (song) {
    var d = document.createElement('div'); d.className = 'item';
    var nm = document.createElement('span'); nm.textContent = song.name;
    var ar = document.createElement('small'); ar.textContent = song.artist || '';
    d.appendChild(nm); d.appendChild(ar);
    d.onclick = function () { pop.classList.remove('show'); startPractice(song.id); };
    pop.appendChild(d);
  });
}
async function startPractice(id) {
  var meta = st.list.filter(function (s) { return s.id === id; })[0];
  if (!meta) return;
  if (st.song) exitSong();
  var song;
  if (meta.isLocal) {
    song = loadLocalSong(id);
    if (!song) { if (window.__ui) window.__ui.toast(T('fp.songMissing')); return; }
    song.name = meta.name;
  } else {
    try {
      var r = await fetch('./songs/' + meta.file);
      song = await r.json();
      song.name = meta.name; song.artist = meta.artist;
    } catch (e) { if (window.__ui) window.__ui.toast(T('fp.songFail')); return; }
  }
  var acc = (song.acc && song.acc.length) ? song.acc : null;
  var mode = (S() && S().handsMode) ? S().handsMode() : 'both';
  var pick = song.melody;
  if (mode === 'acc') { if (acc) pick = acc; else if (window.__ui) window.__ui.toast(T('fp.accFallback')); }
  song.melody.forEach(function (n) { n.pc = n.midi % 12; n._key = fitPart(n.midi); });
  if (song.acc) song.acc.forEach(function (n) { n.pc = n.midi % 12; n._key = fitPart(n.midi); });
  pr.on = true; pr.song = song; pr.idx = 0; pr.list = pick;
  pr.right = 0; pr.wrong = 0; pr.combo = 0; pr.maxCombo = 0;
  document.body.classList.add('practice');
  if (S() && S().setView) S().setView('play');
  window.__ui.dockMode('practice');
  if (st.els.pName) st.els.pName.textContent = song.name;
  prUpdate();
}
function prUpdate() {
  if (!st.els) return;
  var list = (pr.song && pr.list && pr.list.length) ? pr.list : (pr.song ? pr.song.melody : []);
  var t = (pr.on && pr.song) ? list[pr.idx] : null;
  if (st.els.pProg) st.els.pProg.textContent = pr.song ? (pr.idx + '/' + list.length) : '';
  if (st.els.pNext) st.els.pNext.textContent = pr.on ? (t ? T('practice.next', prName(t.midi)) : T('practice.done')) : '';
  if (S() && S().setHint) S().setHint((pr.on && t && t._key) ? t._key : null);
}
function prInput(midi) {
  if (!pr.on || !pr.song) return false;
  var list = pr.list || pr.song.melody;
  var t = list[pr.idx];
  if (!t) return true;
  if (midi % 12 === t.pc) {
    pr.idx++; pr.right++; pr.combo++;
    if (pr.combo > pr.maxCombo) pr.maxCombo = pr.combo;
    if (S() && S().hintFlash) S().hintFlash('#4ade80', 260);
    prUpdate();
    if (pr.idx >= list.length && window.__ui) {
      if (S() && S().scoresOn && S().scoresOn() && (pr.right + pr.wrong) > 0) {
        var acc2 = pr.right / (pr.right + pr.wrong);
        window.__ui.showResult({
          title: T('result.practiceDone', pr.song.name),
          acc: acc2, maxCombo: pr.maxCombo, total: list.length,
          stars: acc2 >= 0.95 ? 3 : acc2 >= 0.85 ? 2 : acc2 >= 0.7 ? 1 : 0,
          retry: function () { restartPractice(); },
          exit: function () { exitPractice(); }
        });
      } else {
        window.__ui.toast(T('result.practiceDone', pr.song.name));
      }
    }
  } else {
    pr.wrong++; pr.combo = 0;
    if (S() && S().hintFlash) S().hintFlash('#f87171', 240);
    if (window.SMK25Engine) window.SMK25Engine.blip(220);
  }
  return true;
}
function exitPractice() {
  if (!pr.on) return;
  pr.on = false; pr.song = null; pr.idx = 0; pr.list = [];
  document.body.classList.remove('practice');
  if (window.__ui) window.__ui.hideResult();
  if (S() && S().setHint) S().setHint(null);
  if (window.__ui) window.__ui.dockMode('idle');
}
function restartPractice() {
  if (!pr.on) return;
  pr.idx = 0; pr.right = 0; pr.wrong = 0; pr.combo = 0; pr.maxCombo = 0;
  if (window.__ui) window.__ui.hideResult();
  prUpdate();
}

/* ---------------- 跟弹难度：邻近键辅助（弹错到附近音自动按目标音发声/计分） ---------------- */
function icDist(a, b) { var d = Math.abs(a - b) % 12; return d > 6 ? 12 - d : d; }
function diffTol() {
  var o = (S() && S().getDiffOpts) ? S().getDiffOpts() : null;
  return (o && o.tol > 0) ? o.tol : 0;
}
function snapFor(midi) {
  var tol = diffTol();
  if (!tol) return null;
  var pc = ((midi % 12) + 12) % 12;
  if (pr.on && pr.song) {
    var t = pr.song.melody[pr.idx];
    if (t && t.pc !== pc && icDist(pc, t.pc) <= tol) return { on: true, midi: t.midi, pc: t.pc };
    return null;
  }
  if (st.playing && st.song) {
    var now = nowT(), best = null, bd = 1e9;
    st.song.melody.forEach(function (n) {
      if (n.consumed || n.missed) return;
      var d = Math.abs(n.start - now);
      if (d < 0.45 && d < bd) { bd = d; best = n; }
    });
    if (best && best.pc !== pc && icDist(pc, best.pc) <= tol) return { on: true, midi: best.midi, pc: best.pc };
  }
  return null;
}
window.__followSnap = snapFor;

/* ---------------- MIDI 导入（一键批量，本地曲库） ---------------- */
var LOCAL_KEY = 'smk25midi';
function localMap() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch (_) { return {}; }
}
function localMetas() {
  var m = localMap(), out = [];
  for (var k in m) if (m[k] && m[k].meta) out.push(m[k].meta);
  out.sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
  return out;
}
function loadLocalSong(id) { var m = localMap(); return m[id] ? m[id].song : null; }
function saveLocalSong(meta, song) {
  var m = localMap(); m[meta.id] = { meta: meta, song: song };
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(m)); } catch (e) { return false; }
  return true;
}
function deleteLocalSong(id) {
  var m = localMap(); delete m[id];
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(m)); } catch (_) {}
  st.list = st.list.filter(function (s) { return s.id !== id; });
  renderPicker();
  renderFollowPicker();
}
function parseMidiToSong(buf, filename) {
  var dv = new DataView(buf);
  if (dv.byteLength < 14 || dv.getUint32(0) !== 0x4D546864) return null;
  var pos = 4;
  var hlen = dv.getUint32(pos); pos += 4;
  pos += 2; // format
  var ntrks = dv.getUint16(pos); pos += 2;
  var div = dv.getUint16(pos); pos += 2;
  pos = 8 + hlen;
  if (div & 0x8000) return null;
  var ppq = div || 480;
  var tracks = [], tempos = [];
  for (var t = 0; t < ntrks && pos + 8 <= dv.byteLength; t++) {
    if (dv.getUint32(pos) !== 0x4D54726B) break;
    pos += 4;
    var len = dv.getUint32(pos); pos += 4;
    var end = Math.min(dv.byteLength, pos + len);
    var tick = 0, run = 0, notes = [], active = {};
    while (pos < end) {
      var b, delta = 0;
      do { b = dv.getUint8(pos++); delta = (delta << 7) | (b & 0x7F); } while (b & 0x80);
      tick += delta;
      var status = dv.getUint8(pos);
      if (status & 0x80) { pos++; run = status; } else status = run;
      if (status === 0xFF) {
        var type = dv.getUint8(pos++); var l = 0;
        do { b = dv.getUint8(pos++); l = (l << 7) | (b & 0x7F); } while (b & 0x80);
        if (type === 0x51 && l === 3 && pos + 3 <= end) {
          tempos.push([tick, (dv.getUint8(pos) << 16) | (dv.getUint8(pos + 1) << 8) | dv.getUint8(pos + 2)]);
        }
        pos += l;
        continue;
      }
      if (status === 0xF0 || status === 0xF7) {
        var l2 = 0;
        do { b = dv.getUint8(pos++); l2 = (l2 << 7) | (b & 0x7F); } while (b & 0x80);
        pos += l2;
        continue;
      }
      var hi = status & 0xF0, ch = status & 0x0F;
      var d1 = dv.getUint8(pos++), d2 = 0;
      if (hi !== 0xC0 && hi !== 0xD0) d2 = dv.getUint8(pos++);
      if (ch === 9) continue;
      if (hi === 0x90 && d2 > 0) { if (active[d1] == null) active[d1] = tick; }
      else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
        if (active[d1] != null) { notes.push({ p: d1, s: active[d1], e: Math.max(tick, active[d1] + 5) }); delete active[d1]; }
      }
    }
    pos = end;
    if (notes.length) tracks.push(notes);
  }
  if (!tracks.length) return null;
  tempos.sort(function (a, b) { return a[0] - b[0]; });
  if (!tempos.length) tempos = [[0, 500000]];
  if (tempos[0][0] > 0) tempos.unshift([0, tempos[0][1]]);
  var bpm = 60000000 / tempos[0][1];
  if (bpm < 40) bpm = 40;
  if (bpm > 200) bpm = 200;
  function sec(tk) {
    var s = 0, lt = 0, us = tempos[0][1];
    for (var i = 0; i < tempos.length; i++) {
      var t0 = tempos[i][0];
      if (tk <= t0) break;
      s += (t0 - lt) / ppq * (us / 1e6);
      lt = t0; us = tempos[i][1];
    }
    s += (tk - lt) / ppq * (us / 1e6);
    return s;
  }
  var events = [];
  tracks.forEach(function (ns) {
    ns.forEach(function (n) { events.push({ t: n.s, on: 1, p: n.p }); events.push({ t: n.e, on: 0, p: n.p }); });
  });
  events.sort(function (a, b) { return a.t - b.t || b.on - a.on; });
  var active = {}, mel = [], accB = [], cur = null, cur2 = null;
  function flush(tEnd) {
    if (cur) {
      var e = Math.max(tEnd, cur.s + ppq * 0.05);
      if (e > cur.s) mel.push({ p: cur.p, s: cur.s, e: e });
      cur = null;
    }
  }
  function flush2(tEnd) {
    if (cur2) {
      var e = Math.max(tEnd, cur2.s + ppq * 0.05);
      if (e > cur2.s) accB.push({ p: cur2.p, s: cur2.s, e: e });
      cur2 = null;
    }
  }
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.on) active[ev.p] = (active[ev.p] || 0) + 1;
    else { active[ev.p]--; if (active[ev.p] <= 0) delete active[ev.p]; }
    var top = null, bot = null;
    for (var k in active) { var kk = +k; if (top === null || kk > top) top = kk; if (bot === null || kk < bot) bot = kk; }
    if (top === null) { flush(ev.t); flush2(ev.t); }
    else {
      if (!cur || cur.p !== top) { flush(ev.t); cur = { p: top, s: ev.t }; }
      if (bot === top) flush2(ev.t);
      else if (!cur2 || cur2.p !== bot) { flush2(ev.t); cur2 = { p: bot, s: ev.t }; }
    }
  }
  if (cur) mel.push({ p: cur.p, s: cur.s, e: cur.s + ppq / 2 });
  if (cur2) accB.push({ p: cur2.p, s: cur2.s, e: cur2.s + ppq / 2 });
  if (!mel.length) return null;
  function mergeVoices(src) {
    var merged = [];
    src.forEach(function (n) {
      var last = merged[merged.length - 1];
      if (last && last.p === n.p && n.s - last.e < ppq * 0.08) last.e = n.e;
      else merged.push({ p: n.p, s: n.s, e: n.e });
    });
    return merged;
  }
  mel = mergeVoices(mel);
  accB = mergeVoices(accB);
  var t0 = sec(mel[0].s);
  function mkNotes(arr) {
    return arr.map(function (n) {
      return { midi: n.p, start: Math.max(0, sec(n.s) - t0), dur: Math.max(0.08, sec(n.e) - sec(n.s)) };
    });
  }
  var notes = mkNotes(mel);
  var notesAcc = mkNotes(accB);
  var bestShift = 0, bestScore = 1e9;
  for (var sh = -36; sh <= 36; sh += 12) {
    var out = 0, sum = 0;
    notes.forEach(function (n) { var m = n.midi + sh; if (m < 48 || m > 72) out++; sum += Math.abs(m - 64); });
    var score = out * 1000 + sum / notes.length;
    if (score < bestScore) { bestScore = score; bestShift = sh; }
  }
  function fixup(arr) {
    arr.forEach(function (n) {
      n.midi += bestShift;
      while (n.midi < 48) n.midi += 12;
      while (n.midi > 72) n.midi -= 12;
      n.start = Math.round(n.start * 1000) / 1000;
      n.dur = Math.round(n.dur * 1000) / 1000;
    });
  }
  fixup(notes); fixup(notesAcc);
  var lastN = notes[notes.length - 1];
  var lastA = notesAcc.length ? notesAcc[notesAcc.length - 1] : null;
  var endT = Math.max(lastN.start + lastN.dur, lastA ? lastA.start + lastA.dur : 0);
  var name = String(filename || 'MIDI').replace(/\.(mid|midi)$/i, '').slice(0, 40);
  var out = { name: name, artist: T('fp.artistImport'), bpm: Math.round(bpm), duration: Math.round((endT + 1.5) * 100) / 100, melody: notes, chords: [] };
  if (notesAcc.length >= 3) out.acc = notesAcc;
  return out;
}
function importMidiFiles(files) {
  var arr = Array.prototype.slice.call(files || []);
  if (!arr.length) return;
  var imported = 0, failed = 0, pending = arr.length;
  arr.forEach(function (f, idx) {
    var fr = new FileReader();
    fr.onload = function () {
      var song = null;
      try { song = parseMidiToSong(fr.result, f.name); } catch (_) { song = null; }
      if (song && song.melody.length > 3) {
        var id = 'local:' + Date.now() + '_' + idx;
        var meta = { id: id, name: song.name, artist: T('fp.artistImport') + ' · ' + song.melody.length, isLocal: true, added: Date.now(), bpm: song.bpm, duration: song.duration };
        if (saveLocalSong(meta, song)) { st.list = st.list.concat([meta]); imported++; }
        else failed++;
      } else failed++;
      if (--pending === 0) {
        renderPicker();
        renderFollowPicker();
        if (window.__ui) window.__ui.toast(T('fp.imported', imported) + (failed ? T('fp.importedFail', failed) : ''));
      }
    };
    fr.readAsArrayBuffer(f);
  });
}

/* ---------------- 在线搜索 MIDI（BitMidi，一键适配导入） ---------------- */
function hasTauri() { return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke); }
async function netGetText(url) {
  if (hasTauri()) return await window.__TAURI__.core.invoke('net_get', { url: url });
  var r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}
async function netGetBytes(url) {
  if (hasTauri()) {
    var b64 = await window.__TAURI__.core.invoke('net_get_b64', { url: url });
    var bin = atob(b64), len = bin.length, u8 = new Uint8Array(len);
    for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  var r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.arrayBuffer();
}
function searchMidi(query, cb) {
  var url = 'https://bitmidi.com/search?q=' + encodeURIComponent(query);
  netGetText(url).then(function (html) {
    var out = [], seen = {};
    var re = /<a[^>]+href="\/([a-z0-9\-]+-mid)"[^>]*>([\s\S]*?)<\/a>/gi, m;
    while ((m = re.exec(html))) {
      var slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = 1;
      var title = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (!title) title = slug.replace(/-mid$/, '').replace(/-/g, ' ');
      out.push({ slug: slug, title: title });
      if (out.length >= 25) break;
    }
    cb(out);
  }).catch(function (e) { cb(null, e); });
}
async function importFromBitmidi(slug) {
  var html = await netGetText('https://bitmidi.com/' + slug);
  var m = html.match(/\/uploads\/\d+\.mid/);
  if (!m) throw new Error(T('fp.dlMissing'));
  var buf = await netGetBytes('https://bitmidi.com' + m[0]);
  var song = parseMidiToSong(buf, slug.replace(/-mid$/, ''));
  if (!song || song.melody.length <= 3) throw new Error(T('fp.midiFail'));
  var id = 'local:' + Date.now();
  var meta = { id: id, name: song.name, artist: T('fp.artistImport') + ' · ' + song.melody.length, isLocal: true, added: Date.now(), bpm: song.bpm, duration: song.duration };
  saveLocalSong(meta, song);
  st.list = st.list.concat([meta]);
  renderPicker();
  renderFollowPicker();
  return meta;
}
function renderSearchView() {
  var pop = st.els.pop;
  pop.innerHTML = '';
  pop.style.maxHeight = '62vh';
  pop.style.overflowY = 'auto';
  var back = document.createElement('div');
  back.className = 'item';
  var bs = document.createElement('span'); bs.textContent = T('fp.back');
  back.appendChild(bs);
  back.onclick = function () { renderPicker(); };
  pop.appendChild(back);
  var box = document.createElement('div');
  box.style.cssText = 'display:flex;gap:6px;padding:6px 8px 8px';
  var inp = document.createElement('input');
  inp.placeholder = '搜索 MIDI（如 fur elise、yesterday）';
  inp.style.cssText = 'flex:1;background:#111827;border:1px solid #374151;color:#e5e7eb;border-radius:8px;padding:7px 10px;font-size:13px;outline:none;font-family:inherit';
  var btn = document.createElement('button');
  btn.textContent = '搜索';
  btn.style.cssText = 'border:1px solid #374151;background:#0e7490;color:#fff;font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer;font-family:inherit';
  box.appendChild(inp); box.appendChild(btn);
  pop.appendChild(box);
  var list = document.createElement('div');
  pop.appendChild(list);
  var hint = document.createElement('div');
  hint.style.cssText = 'padding:0 12px 8px;color:#6b7280;font-size:11.5px;line-height:1.5';
  hint.textContent = 'BitMidi 以欧美老歌/游戏/影视为主，中文流行较少；中文歌可到 MIDI 网站下载 .mid 后用「＋ 导入 MIDI」导入。';
  pop.insertBefore(hint, list);
  function doSearch() {
    var q = inp.value.trim();
    if (!q) return;
    list.innerHTML = '<div style="padding:10px 12px;color:#9ca3af;font-size:12px">' + T('fp.searchingNet') + '</div>';
    searchMidi(q, function (res, err) {
      if (!res) {
        list.innerHTML = '';
        var d0 = document.createElement('div');
        d0.style.cssText = 'padding:10px 12px;color:#9ca3af;font-size:12px';
        d0.textContent = hasTauri() ? T('fp.searchFailNet') : T('fp.searchFailCors');
        list.appendChild(d0);
        return;
      }
      if (!res.length) {
        list.innerHTML = '<div style="padding:10px 12px;color:#9ca3af;font-size:12px">' + T('fp.searchEmpty') + '</div>';
        return;
      }
      list.innerHTML = '';
      res.forEach(function (it) {
        var d = document.createElement('div');
        d.className = 'item';
        var nm = document.createElement('span');
        nm.textContent = it.title;
        nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px';
        var ar = document.createElement('small');
        ar.textContent = T('fp.importBtn');
        d.appendChild(nm); d.appendChild(ar);
        d.onclick = function () {
          if (d._busy) return;
          d._busy = 1;
          ar.textContent = T('fp.downloading');
          importFromBitmidi(it.slug).then(function (meta) {
            if (window.__ui) {
              window.__ui.toast(T('fp.addedOne', meta.name));
              window.__ui.hidePop();
            }
            loadById(meta.id);
          }).catch(function (e) {
            d._busy = 0;
            ar.textContent = T('fp.failed');
            if (window.__ui) window.__ui.toast(T('fp.addFail', (e && e.message ? e.message : e)));
          });
        };
        list.appendChild(d);
      });
    });
  }
  btn.onclick = doSearch;
  inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };
  setTimeout(function () { try { inp.focus(); } catch (_) {} }, 50);
}

/* ---------------- 播放 ---------------- */
function nowT() {
  if (st.audio.src && ACC) return st.audio.currentTime;
  if (!st.playing && st.paused) return st.vOffset || 0;
  return (performance.now() / 1000 - st.vStart) * rateVal();
}
function tick() {
  if (!st.playing) return;
  var t = nowT();
  if (loopOn && loopA != null && loopB != null && loopB > loopA && t >= loopB) { seek(loopA); t = nowT(); }
  var song = st.song, bpm = st.bpm, barSec = 4 * (60 / bpm);
  while (st.idx < song.melody.length && song.melody[st.idx].start <= t + 0.03) {
    var n = song.melody[st.idx++];
    if (SCOREMODE !== 'tiles') {
      var p = fitPart(n.midi);
      if (p && S().pressVisual) S().pressVisual(p);
    }
  }
  songParts().forEach(function (n) {
    if (!n.consumed && !n.missed && n.start < t - 0.45) { n.missed = true; st.missed++; st.combo = 0; }
  });
  var bar = Math.floor(t / barSec), ch = null;
  (song._chordsR || []).forEach(function (c) { if (Math.floor(c.time / barSec) <= bar) ch = c.chord; });
  updateCursor(t, ch);
  updateHint(t);
  var pr = st.els.prog;
  if (document.activeElement !== pr) pr.value = Math.round(t / song.duration * 1000);
  updateScore();
  if (song.duration && t >= song.duration + 0.2) { endSong(true); return; }
  st.raf = requestAnimationFrame(tick);
}
function endSong(finished) {
  if (!st.playing) return;
  st.playing = false;
  cancelAnimationFrame(st.raf);
  st.vOffset = (st.song && st.song.duration) ? st.song.duration : nowT();
  st.atEnd = true;
  updateTransport();
  if (!finished || !window.__ui) return;
  var tot = st.hits + st.missed;
  if (S() && S().scoresOn && S().scoresOn() && tot > 0) {
    var acc = st.hits / tot;
    window.__ui.showResult({
      title: T('result.songDone', (st.song ? st.song.name : '')),
      acc: acc, maxCombo: st.maxCombo, total: tot,
      stars: acc >= 0.95 ? 3 : acc >= 0.85 ? 2 : acc >= 0.7 ? 1 : 0,
      retry: function () { seek(0); play(); },
      exit: function () { exitSong(); }
    });
  } else {
    window.__ui.toast(st.els.score.textContent !== '—' ? T('fp.scoreHit', st.els.score.textContent) : T('fp.songDoneShort'));
  }
}
function updateScore() {
  var tot = st.hits + st.missed;
  var txt = tot ? (Math.round(st.hits / tot * 100) + '%') : '—';
  if (tot && S() && S().scoresOn && S().scoresOn()) txt += ' · x' + st.combo;
  st.els.score.textContent = txt;
}
/* 跟弹流光：提示下一个要按的键 */
function updateHint(t) {
  if (!S() || !S().setHint) return;
  var opt = S().getHintOpts ? S().getHintOpts() : null;
  if (!opt || !opt.on || SCOREMODE === 'tiles' || !st.playing) { S().setHint(null); return; }
  var nn = null;
  songParts().forEach(function (n) {
    if (n.consumed || n.missed || !n._key) return;
    if (!nn || n.start < nn.start) nn = n;
  });
  if (nn && (nn.start - t) <= opt.lead) S().setHint(nn._key);
  else S().setHint(null);
}
function updateTransport() {
  st.els.playToggle.textContent = st.playing ? '❚❚' : '▶';
}
function play() {
  if (!st.song || st.playing) return;
  if (st.atEnd) { seek(0); st.atEnd = false; }
  st.playing = true; st.paused = false;
  if (ACC && st.audio.src) {
    st.audio.playbackRate = rateVal();
    st.audio.play().catch(function () { st.playing = false; updateTransport(); if (window.__ui) window.__ui.toast(T('fp.audioBlocked')); });
  } else {
    st.vStart = performance.now() / 1000 - (st.vOffset || 0) / rateVal();
  }
  document.body.classList.add('playmode');
  updateTransport();
  startTiles();
  cancelAnimationFrame(st.raf); tick();
}
function pause() {
  if (!st.playing) return;
  st.playing = false; st.paused = true;
  if (st.audio.src) { try { st.audio.pause(); } catch (_) {} }
  st.vOffset = nowT();
  cancelAnimationFrame(st.raf); updateTransport();
}
function toggle() { st.playing ? pause() : play(); }
function stopPlay() {
  st.playing = false; st.paused = false; st.atEnd = false;
  cancelAnimationFrame(st.raf);
  if (st.audio.src) { try { st.audio.pause(); } catch (_) {} try { st.audio.currentTime = 0; } catch (_) {} }
  st.vOffset = 0; st.idx = 0; st.hits = 0; st.missed = 0; st.combo = 0; st.maxCombo = 0;
  if (tiles.held) { if (window.SMK25Engine) window.SMK25Engine.noteOff(tiles.held.n.midi); tiles.held = null; }
  if (st.song) {
    st.song.melody.forEach(function (n) { n.consumed = false; n.missed = false; n._holding = false; });
    if (st.song.acc) st.song.acc.forEach(function (n) { n.consumed = false; n.missed = false; n._holding = false; });
    st.els.prog.value = 0;
    updateCursor(-1, '');
    updateScore();
  }
  if (window.__ui) window.__ui.hideResult();
  if (S() && S().setHint) S().setHint(null);
  updateTransport();
}
function setRate(r) {
  if (ACC && st.audio.src) st.audio.playbackRate = r;
  if (st.playing && !(ACC && st.audio.src)) {
    st.vOffset = nowT();
    st.vStart = performance.now() / 1000 - st.vOffset / (r || 1);
  }
}
function seek(t) {
  if (!st.song || !st.song.duration) return;
  t = Math.max(0, Math.min(st.song.duration, t));
  if (st.audio.src) { try { st.audio.currentTime = t; } catch (_) {} }
  st.vOffset = t; st.vStart = performance.now() / 1000 - t / rateVal();
  st.atEnd = false;
  st.idx = 0;
  while (st.idx < st.song.melody.length && st.song.melody[st.idx].start < t) st.idx++;
  st.song.melody.forEach(function (n) { n.consumed = n.start < t; n.missed = false; n._holding = false; });
  if (st.song.acc) st.song.acc.forEach(function (n) { n.consumed = n.start < t; n.missed = false; n._holding = false; });
  var parts = songParts();
  st.hits = parts.filter(function (n) { return n.consumed; }).length; st.missed = 0; st.combo = 0;
  if (tiles.held) tiles.held = null;
  updateScore();
}

/* ---------------- 背景伴奏 ---------------- */
function setAcc(on) {
  ACC = !!on;
  try { localStorage.setItem('smk25acc', ACC ? '1' : '0'); } catch (_) {}
  updateAccBtn();
  if (!st.song || !st.audio.src) return;
  if (!ACC) {
    var t = nowT();
    try { st.audio.pause(); } catch (_) {}
    st.vOffset = t;
    st.vStart = performance.now() / 1000 - t / rateVal();
  } else if (st.playing) {
    try { st.audio.currentTime = Math.max(0, Math.min(st.audio.duration || 1e9, nowT())); } catch (_) {}
    st.audio.playbackRate = rateVal();
    st.audio.play().catch(function () {});
  }
}
function updateAccBtn() { if (st.els && st.els.acc) st.els.acc.classList.toggle('off', !ACC); }

/* ---------------- 打分钩子（MIDI/电脑键盘共用） ---------------- */
window.__followScore = function (midi) {
  if (pr.on) { prInput(midi); return; }
  if (!st.playing || !st.song) return;
  var t = nowT(), pc = midi % 12, best = null, bd = 1e9;
  songParts().forEach(function (n) {
    if (n.consumed || n.pc !== pc) return;
    var d = Math.abs(n.start - t);
    if (d < 0.45 && d < bd) { bd = d; best = n; }
  });
  if (best) { best.consumed = true; st.hits++; st.combo++; if (st.combo > st.maxCombo) st.maxCombo = st.combo; updateScore(); }
};

window.SMK25Follow = {
  init: init, loadById: loadById, loadSong: loadSong,
  play: play, pause: pause, toggle: toggle, stop: stopPlay, seek: seek,
  setScoreMode: setScoreMode, setAcc: setAcc,
  startPractice: startPractice, exitPractice: exitPractice, practice: pr,
  state: st
};
})();
