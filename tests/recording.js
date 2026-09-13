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
    function kd(k) { dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); }
    function ku(k) { dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true })); }
    // 键盘弹奏开关（默认开）验证：输入框聚焦时应忽略
    const before = { notes: 0 };
    kd('a'); await new Promise(z => setTimeout(z, 60)); ku('a');
    // 开始录音
    $('bRecToggle').click();
    await new Promise(z => setTimeout(z, 120));
    kd('a'); ku('a');
    await new Promise(z => setTimeout(z, 100));
    kd('s'); ku('s');
    await new Promise(z => setTimeout(z, 260));
    kd('d'); ku('d');
    await new Promise(z => setTimeout(z, 120));
    $('bRecToggle').click();
    r.info = $('recInfo').textContent;
    // 回放
    $('bRecPlay').click();
    await new Promise(z => setTimeout(z, 300));
    r.playBtnDuring = $('bRecPlay').textContent;
    await new Promise(z => setTimeout(z, 700));
    r.playBtnAfter = $('bRecPlay').textContent;
    // 八度测试：+2 后按 a 应发出比原来高 14 半音的音（记录到录音）
    $('setKbOct').value = '2'; $('setKbOct').onchange();
    $('bRecToggle').click();
    await new Promise(z => setTimeout(z, 120));
    kd('a'); ku('a');
    await new Promise(z => setTimeout(z, 150));
    $('bRecToggle').click();
    r.info2 = $('recInfo').textContent;
    // 键盘弹奏关闭后不发声（不新增录音）
    $('setKb').checked = false; $('setKb').onchange();
    $('bRecToggle').click();
    await new Promise(z => setTimeout(z, 120));
    kd('a'); ku('a');
    await new Promise(z => setTimeout(z, 150));
    $('bRecToggle').click();
    r.info3 = $('recInfo').textContent;
    return r;
  });
  console.log(JSON.stringify(out, null, 1));
  console.log('ERR', JSON.stringify(errs));
  await b.close();
})().catch(e => { console.error('SCRIPT_FAIL ' + e); process.exit(1); });

