const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await page.goto('http://127.0.0.1:8333/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const out = await page.evaluate(async () => {
    const r = {};
    const sn = document.getElementById('setOut');
    sn.value = '__sf2b:GeneralUserGS.sf2'; sn.onchange();
    for (let i = 0; i < 60; i++) { await new Promise(z => setTimeout(z, 400)); if (window.__sf2 && window.__sf2.presets.length) break; }
    r.loaded = !!(window.__sf2 && window.__sf2.presets.length);
    if (!r.loaded) return r;
    const p = window.__sf2;
    // 直接调用（异常不吞）
    try {
      p.noteOn(60, 0.9);
      r.note60 = 'ok';
      r.voices = Object.keys(p.voices);
      const v = p.voices[60];
      r.hasVoice = !!v;
    } catch (e) { r.noteErr = String(e && e.stack || e).slice(0, 300); }
    // 采样非静音检查（取当前琴键 voice 的 buffer）
    try {
      const vv = p._findVoice(60, 0.9, null);
      const info = p._sampleBuffer(vv.si);
      const d = info.buffer.getChannelData(0);
      let mx = 0; for (let i = 0; i < d.length; i += 7) { const a = Math.abs(d[i]); if (a > mx) mx = a; }
      r.samplePeak = +mx.toFixed(3);
      r.sampleLen = d.length;
    } catch (e) { r.bufErr = String(e && e.message || e); }
    // 力度增益差异（读 env 的 peak 自动化不可行；改测两次 noteOn 的 voices 存在 + stats）
    const s0 = p.stats.notes;
    try { p.noteOn(64, 0.2); p.noteOn(67, 1.0); } catch (e) { r.note2Err = String(e).slice(0, 200); }
    r.velNotes = p.stats.notes - s0;
    p.noteOff(60); p.noteOff(64); p.noteOff(67);
    // 切音色：弦乐
    try { window.__sf2.setPreset(56); p.noteOn(57, 0.85); r.strings = Object.keys(p.voices).length > 0; p.noteOff(57); } catch (e) { r.stringsErr = String(e).slice(0, 200); }
    r.ctxState = p.ctx && p.ctx.state;
    // 内置引擎新参数无异常
    try {
      const E = window.SMK25Engine; E.setTimbre('piano'); E.noteOn(60, 0.2); E.noteOn(64, 1); E.noteOff(60); E.noteOff(64);
      E.setTimbre('strings'); E.noteOn(62, 0.7); E.noteOff(62); E.setTimbre('piano');
      r.builtin = 'ok';
    } catch (e) { r.builtinErr = String(e && e.stack || e).slice(0, 300); }
    return r;
  });
  console.log(JSON.stringify(out, null, 1).slice(0, 2000));
  console.log('PAGE_ERRORS', JSON.stringify(errs));
  await b.close();
})().catch(e => { console.error('SCRIPT_FAIL ' + e); process.exit(1); });

