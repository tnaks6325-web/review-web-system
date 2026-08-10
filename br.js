const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e.message)));
  // 인트라넷 사용자 프록시만 스텁 — 퇴사자 3명 포함
  await p.route('**/api/**', r => r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ ok:true, items:[], tabs:[], advertisers:[] }) }));
  await p.route('**/api/trackb/intranet/users*', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ ok:true, items:[{name:'재직A',username:'a1',department:'AE'},{name:'재직B',username:'a2',department:'AE'}],
      resignedNames:['퇴사A','비활성C'] }) }));
  await p.goto('http://127.0.0.1:8899/frontend/workdesk.html', { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(400);

  const out = await p.evaluate(async () => {
    const res = {};
    // ① 업체추가 폼 문맥 재현
    document.body.insertAdjacentHTML('beforeend',
      '<div id="t1"><input id="advPm"><span id="advPmChk"></span><datalist id="aelist2"></datalist></div>');
    const r = await window.api('/api/trackb/intranet/users?dept=AE');
    window._aeApply(r);

    document.getElementById('advPm').value = '재직A'; window._advPmCheck();
    res.ok = document.getElementById('advPmChk').textContent;
    document.getElementById('advPm').value = '퇴사A'; window._advPmCheck();
    res.resigned = document.getElementById('advPmChk').textContent;
    document.getElementById('advPm').value = '홍길동'; window._advPmCheck();
    res.unknown = document.getElementById('advPmChk').textContent;

    // ② [변경] 박스 문맥
    document.body.insertAdjacentHTML('beforeend', '<div id="t2"><input id="aein"><span id="aeWarn"></span></div>');
    document.getElementById('aein').value = '비활성C'; window._aeWarnCheck();
    res.warnResigned = document.getElementById('aeWarn').textContent;
    document.getElementById('aein').value = '재직B'; window._aeWarnCheck();
    res.warnOk = JSON.stringify(document.getElementById('aeWarn').textContent);
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  console.log('pageerrors:', errs.filter(e=>!/Failed to fetch|NetworkError/.test(e)));
  await b.close();
})();
