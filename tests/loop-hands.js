const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 250)));
  await page.goto('http://127.0.0.1:9200/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const out = await page.evaluate(async () => {
    const r = {};
    const $ = id => document.getElementById(id);
    const F = window.SMK25Follow;
    const wait = ms => new Promise(z => setTimeout(z, ms));
    function virtualT() { return performance.now() / 1000 - F.state.vStart; }
    // A-B 循环：A=1s, B=3s
    await F.loadById('abc');
    await wait(250);
    F.seek(1.0); await wait(50); $('bSA').click();
    F.seek(3.0); await wait(50); $('bSB').click();
    $('bSLoop').click();
    r.loopClass = $('bSLoop').className;
    F.seek(1.2); F.play();
    await wait(4000);
    r.virtualAfter4s = +virtualT().toFixed(2);
    r.stillPlaying = F.state.playing;
    r.wrapped = virtualT() < 3.1;
    F.pause();
    // 关闭循环并停止
    $('bSLoop').click();
    r.loopOffClass = $('bSLoop').className;
    F.stop();
    return r;
  });
  // 左右手分离用独立 pitch class 判别（E 音 pc=4 只在伴奏里）
  const out2 = await page.evaluate(async () => {
    const r = {};
    const $ = id => document.getElementById(id);
    const F = window.SMK25Follow;
    const wait = ms => new Promise(z => setTimeout(z, ms));
    const hs = $('setHands');
    hs.value = 'melody'; hs.onchange();
    await F.loadById('local:test');
    await wait(200);
    F.seek(0); F.play(); await wait(250);
    let h0 = F.state.hits;
    window.__followScore(52); // E，伴奏声部才有
    await wait(80);
    r.melodyCountsAccNote = F.state.hits > h0;
    F.stop();
    hs.value = 'acc'; hs.onchange();
    await F.loadById('local:test');
    await wait(200);
    F.seek(0); F.play(); await wait(250);
    h0 = F.state.hits;
    window.__followScore(52);
    await wait(80);
    r.accCountsAccNote = F.state.hits === h0 + 1;
    F.stop();
    hs.value = 'both'; hs.onchange();
    return r;
  });
  console.log(JSON.stringify({ ...out, ...out2 }, null, 1));
  console.log('ERR', JSON.stringify(errs));
  await b.close();
})().catch(e => { console.error('SCRIPT_FAIL ' + e); process.exit(1); });

