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
    // 打开设置 �?网格�?    $('bSet').click();
    r.setShown = $('setPop').classList.contains('show');
    r.gridVisible = $('setGrid').style.display !== 'none';
    const cards = Array.from(document.querySelectorAll('#setGrid .card')).map(c => c.getAttribute('data-pane'));
    r.cards = cards;
    // 逐个进入分类
    r.panes = {};
    for (const name of cards) {
      const card = document.querySelector('#setGrid .card[data-pane="' + name + '"]');
      card.click();
      const pane = document.querySelector('.pane[data-pane="' + name + '"]');
      r.panes[name] = { shown: pane.classList.contains('on'), rows: pane.querySelectorAll('.row').length };
    }
    // 返回按钮
    $('setBack').click();
    r.backWorks = $('setGrid').style.display !== 'none';
    // 新开关默认�?    r.defaults = { scores: $('setScores').checked, loop: $('setLoop2').checked, reverb: $('setRev').checked, pedal: $('setPedal').checked, kb: $('setKb').checked, hands: $('setHands').value, vel: $('setVel').value };
    // 打开几个开关并检查持久化
    $('setScores').checked = true; $('setScores').onchange();
    $('setLoop2').checked = true; $('setLoop2').onchange();
    $('setRev').checked = true; $('setRev').onchange();
    $('setPedal').checked = true; $('setPedal').onchange();
    await new Promise(z => setTimeout(z, 100));
    const saved = JSON.parse(localStorage.getItem('smk25set') || '{}');
    r.persisted = { scores: saved.scores, loopAB: saved.loopAB, reverb: saved.reverb, pedalLed: saved.pedalLed };
    r.loopBtnsVisible = $('bSA').style.display !== 'none' && $('bSLoop').style.display !== 'none';
    r.recBtnHidden = $('bRec').style.display === 'none' || getComputedStyle($('bRec')).display === 'none';
    // 录音开�?    $('setRecOn').checked = true; $('setRecOn').onchange();
    r.recBtnShown = $('bRec').style.display !== 'none';
    // 诊断
    r.diagLen = (function () { try { return window.__ui ? 1 : 0; } catch (e) { return -1; } })();
    // 音色包加�?+ 预设分组/搜索/收藏
    $('setOut').value = '__sf2b:GeneralUserGS.sf2'; $('setOut').onchange();
    for (let i = 0; i < 60; i++) { await new Promise(z => setTimeout(z, 400)); if (window.__sf2 && window.__sf2.presets.length) break; }
    r.sf2Loaded = !!(window.__sf2 && window.__sf2.presets.length);
    if (r.sf2Loaded) {
      r.optgroups = Array.from($('setSf2').querySelectorAll('optgroup')).map(g => g.label);
      r.optCount = $('setSf2').options.length;
      // 收藏当前（Grand Piano�?      $('sf2FavBtn').click();
      await new Promise(z => setTimeout(z, 80));
      r.favGroups = Array.from($('setSf2').querySelectorAll('optgroup')).map(g => g.label);
      r.favCount = (JSON.parse(localStorage.getItem('smk25set') || '{}').sf2fav || []).length;
      // 搜索过滤
      $('sf2Search').value = 'trumpet';
      $('sf2Search').oninput();
      await new Promise(z => setTimeout(z, 80));
      r.searchCount = $('setSf2').options.length;
      r.searchFirst = $('setSf2').options[0] ? $('setSf2').options[0].textContent : '';
      $('sf2Search').value = ''; $('sf2Search').oninput();
      // 混响应用
      r.revOn = !!(window.__sf2 && window.__sf2.reverb && window.__sf2.reverb.on);
    }
    return r;
  });
  console.log(JSON.stringify(out, null, 1).slice(0, 2500));
  console.log('PAGE_ERRORS', JSON.stringify(errs));
  await b.close();
})().catch(e => { console.error('SCRIPT_FAIL ' + e); process.exit(1); });

