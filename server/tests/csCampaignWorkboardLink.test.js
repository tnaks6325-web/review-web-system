// C/S 문의방 제목 → 그 작업의 작업보드(새 탭·해당 리뷰어 행 강조) 가드.
//
// ★ 정적 grep 은 스코프·실행경로를 못 본다(CLAUDE.md '#361 핫픽스' 교훈) → cs-inquiry.js 에서
//   대상 함수를 추출해 **최소 DOM 스텁 위에서 실제 호출**하고, 렌더 결과도 실행으로 확인한다.
// ★ 이 기능의 핵심 규율 = **실행부 사본 0** — 작업보드 딥링크(`#go=`) 계약을 그대로 쓴다.
//   그래서 workdesk.html 의 수신부(`_consumeGo`)가 읽는 키와 **같은 키를 보내는지** 대조한다.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const CS = fs.readFileSync(path.join(__dirname, '../../frontend/js/cs-inquiry.js'), 'utf8');
const WD = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// ── 함수 추출(중괄호 균형) ─────────────────────────────────────
function grab(src, name) {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  assert.ok(m, 'function not found: ' + name);
  let i = src.indexOf('{', m.index + m[0].length - 1), depth = 0, q = null;
  for (; i < src.length; i++) {
    const c = src[i], p = src[i - 1];
    if (q) { if (c === q && p !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index + 1, i + 1);
}

// ── 스텁 위에서 실행 ───────────────────────────────────────────
function run(opts) {
  opts = opts || {};
  const opened = [];
  const sandbox = {
    location: { origin: 'https://review-web-system.pages.dev',
                pathname: opts.pathname || '/workdesk.html' },
    sessionStorage: { getItem: k => (k === 'admin_token' ? (opts.token === undefined ? 'jwt.abc' : opts.token) : null) },
    window: { open: (url, target, feat) => { opened.push({ url, target, feat }); return null; } },
    console,
  };
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  const src = ['_csGoParseKey', '_csWorkdeskPath', 'csOpenWorkboard'].map(n => grab(CS, n)).join('\n');
  vm.runInContext('var _csGoCtx = null;\n' + src, sandbox);
  return { sandbox, opened };
}

console.log('\n[C/S 문의방 → 작업보드 링크]');

// ══ 1. campaignKey 해석 — 추측하지 않는다 ══════════════════════
t('1. campaignKey("시트ID||작업명") 을 시트·작업으로 가른다', () => {
  const { sandbox } = run();
  const r = sandbox._csGoParseKey('1AbC_sheet||7/22(네이버)모키위키_모기기피제');
  // ★ vm 컨텍스트 객체는 realm 이 달라 deepStrictEqual 이 프로토타입에서 어긋난다 → 필드로 본다
  assert.strictEqual(r.sheetId, '1AbC_sheet');
  assert.strictEqual(r.tabName, '7/22(네이버)모키위키_모기기피제');
});

t('2. 작업명에 "||" 가 또 있어도 첫 구분자만 쓴다(작업명 보존)', () => {
  const { sandbox } = run();
  const r = sandbox._csGoParseKey('sid||A||B');
  assert.strictEqual(r.tabName, 'A||B', '뒤쪽 구분자까지 자르면 작업명이 깨진다');
});

t('3. 형식이 아니거나 한쪽이 비면 null — 추측해서 엉뚱한 작업을 열지 않는다', () => {
  const { sandbox } = run();
  ['', null, undefined, '구분자없음', '||작업만', '시트만||'].forEach(v => {
    assert.strictEqual(sandbox._csGoParseKey(v), null, '허용하면 안 되는 값: ' + JSON.stringify(v));
  });
});

// ══ 2. 목적지 경로 — 확장자 유무 유지 ══════════════════════════
t('4. 목적지 경로는 확장자 유무를 유지한다(Pages=/workdesk · 테섭=/workdesk.html)', () => {
  const a = run({ pathname: '/admin.html' });
  assert.strictEqual(a.sandbox._csWorkdeskPath(), '/workdesk.html');
  const b = run({ pathname: '/admin' });
  assert.strictEqual(b.sandbox._csWorkdeskPath(), '/workdesk');
  const c = run({ pathname: '/workdesk' });
  assert.strictEqual(c.sandbox._csWorkdeskPath(), '/workdesk', '리뷰웹시스템[3버전] 자신에서도 같은 경로');
  const d = run({ pathname: '/sub/dir/admin.html' });
  assert.strictEqual(d.sandbox._csWorkdeskPath(), '/sub/dir/workdesk.html', '하위 경로 보존');
});

// ══ 3. 실제 열기 ═══════════════════════════════════════════════
function openWith(ctx, opts) {
  const r = run(opts);
  r.sandbox._csGoCtx = ctx;
  let stopped = 0, prevented = 0;
  r.sandbox.csOpenWorkboard({ preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; } });
  return Object.assign(r, { stopped, prevented });
}
const CTX = { sheetId: 'sid1', tabName: '7/22(네이버)모키위키_모기기피제',
              phone8: '41425414', name: '심인선', sheetTitle: '어니스트캄_업무시트 2' };

t('5. 새 탭으로 열고 noopener 를 건다(새 탭이 이 창을 조작하지 못하게)', () => {
  const r = openWith(CTX);
  assert.strictEqual(r.opened.length, 1, '정확히 한 번 열려야 한다');
  assert.strictEqual(r.opened[0].target, '_blank');
  assert.ok(/noopener/.test(r.opened[0].feat || ''), 'noopener 누락');
});

t('6. 헤더의 접기/펼치기와 분리된다(stopPropagation·preventDefault)', () => {
  const r = openWith(CTX);
  assert.strictEqual(r.stopped, 1, 'stopPropagation 없으면 클릭이 주문정보를 접어버린다');
  assert.strictEqual(r.prevented, 1, 'preventDefault 없으면 href="#" 로 주소가 바뀐다');
});

t('7. 시트·작업·연락처·이름이 실려 왕복 복원된다(한글·괄호 안전)', () => {
  const r = openWith(CTX);
  const m = r.opened[0].url.match(/#go=([^&]+)/);
  assert.ok(m, '#go= 프래그먼트 누락');
  const p = JSON.parse(decodeURIComponent(m[1]));
  assert.strictEqual(p.s, 'sid1');
  assert.strictEqual(p.t, '7/22(네이버)모키위키_모기기피제', '한글·괄호·슬래시가 그대로 복원돼야 한다');
  assert.strictEqual(p.p, '41425414', '연락처가 없으면 그 리뷰어 행을 못 찾는다');
  assert.strictEqual(p.n, '심인선');
});

t('7b. 줄 번호가 문맥에 있으면 그 값이 실제로 실린다(키만 있고 값이 비면 무의미)', () => {
  const r = openWith(Object.assign({}, CTX, { row: '115' }));
  const p = JSON.parse(decodeURIComponent(r.opened[0].url.match(/#go=([^&]+)/)[1]));
  assert.strictEqual(p.r, '115', '줄 번호를 안 실으면 여러 번 참여한 사람의 "그 건"을 못 짚는다');
});

t('7c. 줄 번호가 없으면 빈 값 — 종전 동작(연락처·이름)으로 자연 폴백', () => {
  const r = openWith(CTX);   // row 없음
  const p = JSON.parse(decodeURIComponent(r.opened[0].url.match(/#go=([^&]+)/)[1]));
  assert.strictEqual(p.r, '', '없는 줄 번호를 지어내면 엉뚱한 행을 짚는다');
});

t('8. 정보는 프래그먼트(#)로만 — 서버 로그·Referer 에 연락처가 안 실린다', () => {
  const r = openWith(CTX);
  const url = r.opened[0].url;
  const before = url.split('#')[0];
  assert.ok(!/41425414|심인선/.test(before), '해시 앞(경로·쿼리)에 개인정보가 실리면 안 된다');
  assert.ok(!/[?]/.test(before), '쿼리스트링을 쓰면 서버 로그에 남는다');
});

t('9. 토큰이 있으면 함께 실어 새 탭이 로그인 화면으로 안 떨어진다', () => {
  const r = openWith(CTX, { token: 'jwt.zzz' });
  assert.ok(/&sso=jwt\.zzz/.test(r.opened[0].url), 'sso 토큰 누락');
});

t('10. 토큰이 없으면 sso= 를 붙이지 않는다(빈 값 주입 방지)', () => {
  const r = openWith(CTX, { token: '' });
  assert.ok(!/[&?]sso=/.test(r.opened[0].url), '빈 토큰을 실으면 안 된다');
});

t('11. 문맥이 없으면(작업 미지정 문의) 아무 것도 열지 않는다', () => {
  const r = run();
  r.sandbox._csGoCtx = null;
  r.sandbox.csOpenWorkboard(null);
  assert.strictEqual(r.opened.length, 0, '빈 작업보드를 열면 안 된다');
});

// ══ 4. 실행부 사본 0 — 수신부(#go=)와 같은 계약 ═════════════════
t('12. 보내는 키가 workdesk 수신부(_consumeGo)가 읽는 키와 같다', () => {
  const consume = grab(WD, '_consumeGo');
  // 수신부는 g.s / g.t / g.g / g.p / g.n / g.st 를 읽는다 — 하나라도 어긋나면 조용히 안 열리거나 행을 못 찾는다
  ['g.s', 'g.t', 'g.p', 'g.n'].forEach(k => {
    assert.ok(consume.includes(k), '수신부 계약이 바뀌었다: ' + k + ' — 발신부(csOpenWorkboard)를 함께 고칠 것');
  });
  const r = openWith(CTX);
  const p = JSON.parse(decodeURIComponent(r.opened[0].url.match(/#go=([^&]+)/)[1]));
  ['s', 't', 'g', 'p', 'n', 'st'].forEach(k => {
    assert.ok(Object.prototype.hasOwnProperty.call(p, k), '페이로드에 ' + k + ' 가 없다');
  });
});

t('13. 행 찾기·강조 실행부를 여기서 다시 만들지 않는다(사본 금지)', () => {
  // ★ 주석을 지우고 본다 — "여기서 만들지 않는다"는 **설명문**이 스스로를 걸리게 하면 검사가 무의미해진다
  const code = CS.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  ['rowhit', 'scrollIntoView', 'pendingFocus', 'data-p8'].forEach(sym => {
    assert.ok(!code.includes(sym),
      'cs-inquiry.js 가 행 강조를 자체 구현하고 있다(' + sym + ') — 작업보드의 _applyPendingFocus 한 벌만 쓴다');
  });
});

// ══ 5. 화면 배선 ═══════════════════════════════════════════════
t('14. 작업이 지정된 문의만 링크 — 일반 문의는 종전대로 글자', () => {
  assert.ok(/const go = _csGoParseKey\(t\.campaignKey\)/.test(CS), 'campaignKey 로 판정하지 않는다');
  assert.ok(/if \(go\) \{[\s\S]{0,600}cs-camp-link/.test(CS), '판정 통과 시에만 링크를 그려야 한다');
  assert.ok(/_csGoCtx = null;[\s\S]{0,400}camp\.innerHTML/.test(CS),
    '작업 미지정 방을 열 때 직전 방의 문맥이 남으면 엉뚱한 작업이 열린다');
});

t('15. onclick 에 시트발 문자열을 보간하지 않는다(따옴표 탈출 차단)', () => {
  const m = CS.match(/onclick="csOpenWorkboard\(([^)]*)\)"/);
  assert.ok(m, 'csOpenWorkboard onclick 배선 없음');
  assert.strictEqual(m[1].trim(), 'event', 'event 외의 값을 넘기면 시트발 문자열이 코드로 새어 들어온다');
});

t('16. 표시 문자열은 escape 한다(작업명은 시트에서 온 값)', () => {
  assert.ok(/const label = escHtml\(t\.campaignLabel/.test(CS), '작업명 escape 누락');
  assert.ok(/\$\{label\}/.test(CS), 'escape 한 값을 써야 한다');
});

t('17. 전역으로 공개된다(안 하면 클릭이 "함수 없음"으로 조용히 죽는다)', () => {
  assert.ok(/csOpenWorkboard: csOpenWorkboard/.test(CS), 'EXPORTS 누락');
});

t('18. 링크 스타일이 모듈 CSS 에 있다(테마 없는 호스트에서도 링크로 보인다)', () => {
  assert.ok(/\.cs-camp-link\{[^}]*color:#/.test(CS), '.cs-camp-link 색 리터럴 누락');
  assert.ok(/\.cs-camp-link\{[^}]*cursor:pointer/.test(CS), '누를 수 있어 보여야 한다');
});

// ══ 6. 행 찾기 우선순위 — workdesk `_applyPendingFocus` 실제 실행 ═══════════════
//   ★★ 타계정 참여 건은 표의 **연락처가 어긋난다**(주문 연락처 = 그 명의 번호).
//      대신 **참여자 칸은 로그인 본계정 이름**이라(sheetlessOrder: reviewer_name = loginName)
//      이름 폴백이 그 건을 잡는다 — 이 계약이 깨지면 타계정 문의가 행을 영영 못 찾는다.
function focusRun(rows, focus) {
  const src = grab(WD, '_applyPendingFocus');
  const TRS = rows.map(r => ({ seq: String(r.seq == null ? '' : r.seq), p8: r.p8 || '', nm: r.nm || '',
    hit: false, scrolled: false,
    getAttribute(a) { return a === 'data-p8' ? this.p8 : a === 'data-nm' ? this.nm : a === 'data-seq' ? this.seq : null; },
    classList: { _o: null, add(c) { if (c === 'rowhit') this._o.hit = true; }, remove() { } },
    scrollIntoView() { this.scrolled = true; } }));
  TRS.forEach(t => { t.classList._o = t; });
  const toasts = [];
  const sandbox = {
    STATE: { pendingFocus: focus },
    document: { getElementById: id => (id === 'gbody' ? {
      querySelector(sel) {
        const m = String(sel).match(/tr\[data-(p8|nm|seq)="((?:[^"\\]|\\.)*)"\]/);
        if (!m) return null;
        const v = m[2].replace(/\\(.)/g, '$1');
        return TRS.find(t => (m[1] === 'p8' ? t.p8 : m[1] === 'nm' ? t.nm : t.seq) === v) || null;
      } } : null) },
    _toast: msg => { toasts.push(msg); },
    setTimeout: () => 0, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox._applyPendingFocus(true);
  return { hit: TRS.find(t => t.hit) || null, toasts, TRS };
}

t('19. 줄 번호가 오면 그 줄을 정확히 짚는다(같은 사람이 여러 번 참여해도)', () => {
  const rows = [{ seq: 40, p8: '41425414', nm: '심인선' }, { seq: 115, p8: '41425414', nm: '심인선' }];
  const r = focusRun(rows, { row: '115', phone8: '41425414', name: '심인선' });
  assert.ok(r.hit, '행을 못 찾았다');
  assert.strictEqual(r.hit.seq, '115', '줄 번호를 안 보면 첫 참여 행이 잡혀 "이 문의의 그 건"이 아니게 된다');
});

t('20. ★ 타계정 참여 — 연락처가 어긋나도 참여자 이름으로 찾는다', () => {
  // 표: 참여자=본계정(심인선) · 수취인=명의(명지수) · 연락처=명의 번호
  const rows = [{ seq: 77, p8: '99998888', nm: '심인선' }];
  const r = focusRun(rows, { row: '', phone8: '41425414', name: '심인선' });
  assert.ok(r.hit, '타계정 건을 못 찾으면 이 기능의 절반이 죽는다');
  assert.strictEqual(r.hit.seq, '77');
});

t('21. 줄 번호가 가리키는 사람이 다르면 채택하지 않고 폴백한다(엉뚱한 행 금지)', () => {
  const rows = [{ seq: 115, p8: '11112222', nm: '다른사람' }, { seq: 200, p8: '41425414', nm: '심인선' }];
  const r = focusRun(rows, { row: '115', phone8: '41425414', name: '심인선' });
  assert.ok(r.hit, '폴백이 동작해야 한다');
  assert.strictEqual(r.hit.seq, '200', '재배정·줄정리로 번호가 밀린 표에서 남의 행을 짚으면 안 된다');
});

t('22. 못 찾으면 조용히 넘어가지 않고 사유를 말한다', () => {
  const r = focusRun([{ seq: 1, p8: '00000000', nm: '갑' }], { row: '9', phone8: '41425414', name: '심인선' });
  assert.ok(!r.hit, '없는 사람을 짚으면 안 된다');
  assert.strictEqual(r.toasts.length, 1, '안내 없이 아무 일도 안 일어나면 고장으로 읽힌다');
  assert.ok(/심인선/.test(r.toasts[0]), '누구를 못 찾았는지 말해야 한다');
});

t('23. 줄 번호가 없으면 종전 동작 그대로(로그 딥링크 무회귀)', () => {
  const rows = [{ seq: 5, p8: '41425414', nm: '심인선' }];
  const r = focusRun(rows, { row: '', phone8: '41425414', name: '심인선' });
  assert.ok(r.hit && r.hit.seq === '5');
});

t('24. 표의 행에 줄 번호가 심어져 있다(없으면 1순위가 영영 안 맞는다)', () => {
  assert.ok(/data-seq="\$\{esc\(r\.seq/.test(WD), '그리드 <tr> 의 data-seq 누락');
});

t('25. 주문정보가 오면 줄 번호를 문맥에 덧붙인다 — 문맥 자체를 만들지는 않는다', () => {
  assert.ok(/if \(_csGoCtx\) \{[\s\S]{0,400}_csGoCtx\.row =/.test(CS),
    '작업 미지정 문의에 링크가 생기면 안 되므로 **덧붙이기만** 해야 한다');
  assert.ok(/o\.sheetRow \|\| sh\.rowIndex/.test(CS), '주문 원장 → 명단 순 폴백 누락');
});

console.log('\n' + (fail ? `❌ ${fail} failed / ${pass} passed` : `✅ ${pass} checks passed`));
process.exit(fail ? 1 : 0);
