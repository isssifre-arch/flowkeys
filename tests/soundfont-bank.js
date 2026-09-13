const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8333/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  const out = await page.evaluate(async () => {
    const r = {};
    const sel = document.getElementById('setOut');
    r.options = Array.from(sel.options).map(o => o.textContent);
    // 选内置音色包
    sel.value = '__sf2b:GeneralUserGS.sf2';
    sel.onchange();
    for (let i = 0; i < 60; i++) { await new Promise(z => setTimeout(z, 500)); if (window.__sf2 && window.__sf2.presets.length) break; }
    r.loaded = !!(window.__sf2 && window.__sf2.presets.length);
    if (r.loaded) {
      r.presetCount = window.__sf2.presets.length;
      r.src = window.__sf2src;
      r.outport = (JSON.parse(localStorage.getItem('smk25set') || '{}') || {}).outport;
      const ps = document.getElementById('setSf2');
      r.presetOptions = ps.options.length;
      r.first5 = Array.from(ps.options).slice(0, 5).map(o => o.textContent);
      r.selected = ps.options[ps.selectedIndex] ? ps.options[ps.selectedIndex].textContent : '';
      // 力度对比：软/硬各弹一下
      const before = window.__sf2.stats.notes;
      window.SMK25Engine.noteOn(60, 0.25);
      window.SMK25Engine.noteOn(64, 1.0);
      window.SMK25Engine.noteOff(60); window.SMK25Engine.noteOff(64);
      r.velNotes = window.__sf2.stats.notes - before;
    }
    // 内置合成器路由切回
    sel.value = '';
    sel.onchange();
    r.builtinBack = (JSON.parse(localStorage.getItem('smk25set') || '{}')).outport === '';
    return r;
  });
  console.log(JSON.stringify(out, null, 1).slice(0, 2200));
  console.log('PAGE_ERRORS', JSON.stringify(errs));
  await b.close();
})().catch(e => { console.error('SCRIPT_FAIL ' + e); process.exit(1); });

