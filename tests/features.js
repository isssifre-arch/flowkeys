const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 250)));
  await page.goto('http://127.0.0.1:9200/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  // 注入带伴奏声部的本地曲目后刷新
  await page.evaluate(() => {
    const m = {
      id: 'local:test', meta: { id: 'local:test', name: '分离测试曲', artist: 'test', isLocal: true, added: Date.now(), bpm: 120, duration: 10 },
      song: {
        name: '分离测试曲', bpm: 120, duration: 10,
        melody: [{ midi: 72, start: 0, dur: 0.5 }, { midi: 74, start: 1, dur: 0.5 }],
        acc: [{ midi: 48, start: 0, dur: 0.5 }, { midi: 50, start: 1, dur: 0.5 }, { midi: 52, start: 2, dur: 0.5 }]
      }
    };
    localStorage.setItem('smk25midi', JSON.stringify({ 'local:test': m }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const out = await page.evaluate(async () => {
    const r = {};
    const $ = id => document.getElementById(id);
    const F = window.SMK25Follow;
    const wait = ms => new Promise(z => setTimeout(z, ms));
    // ---- 评分 + 曲目模式 ----
    $('setScores').checked = true; $('setScores').onchange();
    await F.loadById('abc');
    await wait(300);
    F.play();
    await wait(300);
    const mel = F.state.song.melody[0];
    window.__followScore(mel.midi);
    await wait(100);
    r.scoreText = $('score').textContent;
    F.pause();
    // ---- A-B 循环 ----
    F.seek(1.0); window.SMK25Follow.state.vOffset = 1;
    $('bSA').click();
    $('bSB').click();
    // B 当前在 ~1.0，手动把 B 挪后：seek 到 2 再按 B
    F.seek(2.0); $('bSB').click();
    $('bSLoop').click();
    F.seek(1.2); F.play();
    await wait(2500);
    r.loopWrapped = (F.state.vOffset !== null) && (F.state.vOffset < 2.1);
    r.loopBClass = $('bSLoop').className;
    F.stop();
    // ---- 左右手分离 ----
    const hs = $('setHands');
    hs.value = 'melody'; hs.onchange();
    await F.loadById('local:test');
    await wait(200);
    F.seek(0); F.play();
    await wait(200);
    const h0 = F.state.hits;
    window.__followScore(48);
    await wait(80);
    r.melodyNoAcc = F.state.hits === h0;
    F.stop();
    hs.value = 'acc'; hs.onchange();
    await F.loadById('local:test');
    await wait(200);
    F.seek(0); F.play();
    await wait(200);
    const h1 = F.state.hits;
    window.__followScore(48);
    await wait(80);
    r.accCounted = F.state.hits === h1 + 1;
    F.stop();
    // 练习模式用伴奏声部
    hs.value = 'acc'; hs.onchange();
    await F.startPractice('local:test');
    await wait(300);
    r.practiceNext = $('pNext').textContent;
    r.practiceProg = $('pProg').textContent;
    F.exitPractice();
    hs.value = 'both'; hs.onchange();
    // ---- 八度 + 力度曲线 ----
    const calls = [];
    const orig = window.SMK25Engine.noteOn;
    window.SMK25Engine.noteOn = function (m, v) { calls.push({ m: m, v: +v.toFixed(3) }); return orig.apply(this, arguments); };
    function kd(k) { dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); }
    function ku(k) { dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true })); }
    $('setKbOct').value = '0'; $('setKbOct').onchange();
    kd('a'); await wait(60); ku('a');
    $('setKbOct').value = '1'; $('setKbOct').onchange();
    kd('a'); await wait(60); ku('a');
    r.octNotes = calls.filter(c => c.m).map(c => c.m);
    calls.length = 0;
    $('setKbOct').value = '0'; $('setKbOct').onchange();
    $('setVel').value = 'soft'; $('setVel').onchange();
    kd('a'); await wait(60); ku('a');
    $('setVel').value = 'hard'; $('setVel').onchange();
    kd('a'); await wait(60); ku('a');
    r.vels = calls.map(c => c.v);
    window.SMK25Engine.noteOn = orig;
    // ---- 诊断 ----
    $('bDiag').click();
    await wait(400);
    r.diagToast = $('toast').textContent;
    try { r.clipLen = (await navigator.clipboard.readText()).length; } catch (e) { r.clipLen = -1; }
    // ---- 设置项默认值检查（新功能全关） ----
    r.def = { scores: $('setScores').checked, loop: $('setLoop2').checked, rev: $('setRev').checked, pedal: $('setPedal').checked, kb: $('setKb').checked, rec: $('setRecOn').checked };
    return r;
  });
  console.log(JSON.stringify(out, null, 1).slice(0, 2500));
  console.log('ERR', JSON.stringify(errs));
  await b.close();
})().catch(e => { console.error('SCRIPT_FAIL ' + e); process.exit(1); });

