// 리뷰어 로그 → 연락처 표기 + 작업대 딥링크 런타임 가드.
// workdesk.html 인라인 스크립트에서 대상 함수를 추출해 최소 DOM 스텁 위에서 실제 호출한다
// (문자열 grep은 스코프·실행경로를 못 본다 — CLAUDE.md '#361 핫픽스' 교훈).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const script = (HTML.match(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i) || [])[1];
assert.ok(script, 'inline script block not found');

// ── 함수 추출(중괄호 균형) ─────────────────────────────────────
function grab(name) {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\(', 'g');
  const m = re.exec(script);
  assert.ok(m, 'function not found: ' + name);
  let i = script.indexOf('{', m.index + m[0].length - 1), depth = 0, q = null;
  for (; i < script.length; i++) {
    const c = script[i], p = script[i - 1];
    if (q) { if (c === q && p !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return script.slice(m.index + 1, i + 1);
}
const WANT = ['_logOpenWorkdesk', '_consumeGo', '_applyPendingFocus', '_fmtPhone', '_toast'];
const bodies = WANT.map(grab).join('\n');

// ── 스텁 ──────────────────────────────────────────────────────
function mkTr(p8, nm) {
  return { _p8: p8, _nm: nm, scrolledTo: null, classList: { _s: new Set(),
    add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} },
    scrollIntoView(o){ this.scrolledTo = o || {}; } };
}
let TRS = [];
const gbody = {
  // tr[data-p8="..."] / tr[data-nm="..."] 셀렉터를 파싱해 매칭(실제 DOM 동작 근사)
  querySelector(sel){
    const m = String(sel).match(/tr\[data-(p8|nm)="((?:[^"\\]|\\.)*)"\]/);
    if (!m) return null;
    const val = m[2].replace(/\\(.)/g, '$1');
    return TRS.find(t => (m[1] === 'p8' ? t._p8 : t._nm) === val) || null;
  },
};
let toasts = [];
const document = {
  getElementById: id => (id === 'gbody' ? gbody : null),
  createElement: () => ({ classList:{ add(){}, remove(){} }, set textContent(v){ toasts.push(v); }, get textContent(){ return ''; } }),
  body: { appendChild(){} },
};
let opened = [];
const window = { open: (url, target, feat) => { opened.push({ url, target, feat }); return null; } };
let replaced = 0;
const history = { replaceState: () => { replaced++; } };
const location = { origin: 'https://review-web-system.pages.dev', pathname: '/workdesk.html', search: '', hash: '' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

let STATE = { logs: [], pendingTab: null, pendingFocus: null, view: 'logs', _pendingBody: null };
let TOKEN = 'jwt.abc.def';
const token = () => TOKEN;
let _GO = null;
const setGo = v => { _GO = v; };

// eslint-disable-next-line no-new-func
const load = new Function('STATE','document','window','history','location','esc','token','setTimeout','clearTimeout',
  'let _GO=null;\nconst __setGo=v=>{_GO=v;};\n' + bodies +
  '\n return {' + WANT.join(',') + ', __setGo, __getGo:()=>_GO};');
const F = load(STATE, document, window, history, location, esc, token, (fn)=>0, ()=>{});

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok   ' + name); pass++; };

// ── 1) 연락처 표기(표 컬럼) ────────────────────────────────────
t('1. _fmtPhone: phone8 → 010-XXXX-XXXX (로그 전화번호 칸 표기)', () => {
  assert.strictEqual(F._fmtPhone('12345678'), '010-1234-5678');
});

t('2. _fmtPhone: 빈 값·형식 불명은 원본 유지(가짜 번호 생성 안 함)', () => {
  assert.strictEqual(F._fmtPhone(''), '');
  assert.strictEqual(F._fmtPhone(null), '');
  assert.strictEqual(F._fmtPhone('없음'), '없음');
});

// ── 2) 딥링크 생성 ─────────────────────────────────────────────
t('4. _logOpenWorkdesk: 새 탭 + noopener + 프래그먼트(#)로 전달', () => {
  opened = [];
  STATE.logs = [{ id: 7, sheetId: 'S1', tabName: '0721)장수돌침대_쿠팡_탄소매트 900건',
                  tabGid: '55', phone8: '12345678', reviewerName: '손아리', campaignName: 'C' }];
  F._logOpenWorkdesk(7);
  assert.strictEqual(opened.length, 1, '새 탭이 안 열림');
  assert.strictEqual(opened[0].target, '_blank');
  assert.strictEqual(opened[0].feat, 'noopener');
  const u = opened[0].url;
  assert.ok(u.indexOf('#') > 0, '프래그먼트를 안 씀');
  assert.ok(u.indexOf('?') === -1, '쿼리스트링이면 연락처가 서버 로그·Referer에 남는다');
  // 연락처·탭명이 물음표 앞(=서버로 가는 부분)에 노출되지 않아야 함
  assert.ok(u.split('#')[0].indexOf('12345678') === -1, '연락처가 프래그먼트 밖에 있음');
});

t('5. _logOpenWorkdesk: 페이로드에 시트·탭·연락처·이름이 실려 왕복 복원된다(한글 안전)', () => {
  opened = [];
  F._logOpenWorkdesk(7);
  const frag = opened[0].url.split('#')[1];
  const go = JSON.parse(decodeURIComponent(frag.match(/(?:^|&)go=([^&]+)/)[1]));
  assert.strictEqual(go.s, 'S1');
  assert.strictEqual(go.t, '0721)장수돌침대_쿠팡_탄소매트 900건', '한글·특수문자 탭명이 깨짐');
  assert.strictEqual(go.p, '12345678');
  assert.strictEqual(go.n, '손아리');
});

t('6. _logOpenWorkdesk: 토큰이 있으면 함께 실어 새 탭이 로그인 화면으로 안 떨어진다', () => {
  opened = []; TOKEN = 'jwt.abc.def';
  F._logOpenWorkdesk(7);
  assert.ok(/[#&]sso=/.test(opened[0].url), '토큰 핸드오프 누락');
});

t('7. _logOpenWorkdesk: 토큰이 없으면 sso= 를 붙이지 않는다(빈 값 주입 방지)', () => {
  opened = []; TOKEN = '';
  F._logOpenWorkdesk(7);
  assert.ok(!/[#&]sso=/.test(opened[0].url));
  TOKEN = 'jwt.abc.def';
});

t('8. _logOpenWorkdesk: 시트/탭 없는 로그는 아무 것도 열지 않음(빈 작업대 방지)', () => {
  opened = [];
  STATE.logs = [{ id: 9, sheetId: '', tabName: '', phone8: '1' }];
  F._logOpenWorkdesk(9);
  F._logOpenWorkdesk(999);            // 없는 id
  assert.strictEqual(opened.length, 0);
  STATE.logs = [{ id: 7, sheetId: 'S1', tabName: 'T', tabGid: '', phone8: '12345678', reviewerName: '손아리' }];
});

// ── 3) 딥링크 수신 ─────────────────────────────────────────────
t('9. _consumeGo: 탭 예약 + 강조 대상 지정 + 주소창 해시 제거(새로고침 재발동·URL 공유 차단)', () => {
  replaced = 0;
  STATE.pendingTab = null; STATE.pendingFocus = null; STATE.view = 'logs';
  F.__setGo({ s: 'S1', t: '탄소매트 900건', g: '55', p: '12345678', n: '손아리' });
  F._consumeGo();
  assert.strictEqual(STATE.view, 'workdesk', '작업대 뷰로 안 감');
  assert.deepStrictEqual(STATE.pendingTab.sheetId, 'S1');
  assert.deepStrictEqual(STATE.pendingTab.tabName, '탄소매트 900건');
  assert.deepStrictEqual(STATE.pendingFocus, { phone8: '12345678', name: '손아리' });
  assert.strictEqual(replaced, 1, '해시를 안 지우면 새로고침마다 재발동하고 연락처가 주소창에 남는다');
  assert.strictEqual(F.__getGo(), null, '1회 소비 후 비워야 중복 적용 안 됨');
});

t('10. _consumeGo: 딥링크가 없으면 아무 것도 건드리지 않음(평상시 진입 불변)', () => {
  replaced = 0;
  STATE.pendingTab = null; STATE.pendingFocus = null; STATE.view = 'logs';
  F.__setGo(null);
  F._consumeGo();
  assert.strictEqual(STATE.view, 'logs');
  assert.strictEqual(STATE.pendingTab, null);
  assert.strictEqual(replaced, 0);
});

// ── 4) 행 강조 ────────────────────────────────────────────────
t('11. _applyPendingFocus: 연락처로 행을 찾아 스크롤 + 강조', () => {
  TRS = [mkTr('99999999', '다른사람'), mkTr('12345678', '손아리')];
  STATE.pendingFocus = { phone8: '12345678', name: '손아리' };
  F._applyPendingFocus(true);
  assert.ok(TRS[1].classList.contains('rowhit'), '대상 행이 강조되지 않음');
  assert.ok(TRS[1].scrolledTo, '스크롤되지 않음');
  assert.ok(!TRS[0].classList.contains('rowhit'), '엉뚱한 행이 강조됨');
  assert.strictEqual(STATE.pendingFocus, null, '1회 적용 후 비워야 재렌더마다 튀지 않음');
});

t('12. _applyPendingFocus: 연락처가 안 맞으면 이름으로 폴백(연락처 수정된 행)', () => {
  TRS = [mkTr('', '손아리')];
  STATE.pendingFocus = { phone8: '12345678', name: '손아리' };
  F._applyPendingFocus(true);
  assert.ok(TRS[0].classList.contains('rowhit'));
});

t('13. _applyPendingFocus: 아직 덜 그려졌으면(final=false) 못 찾음으로 확정하지 않는다', () => {
  TRS = []; toasts = [];
  STATE.pendingFocus = { phone8: '12345678', name: '손아리' };
  F._applyPendingFocus(false);
  assert.ok(STATE.pendingFocus, '청크 렌더 중인데 포기하면 뒤에 오는 행을 놓친다');
  assert.strictEqual(toasts.length, 0, '아직 오탐 안내를 띄우면 안 됨');
});

t('14. _applyPendingFocus: 마지막까지 없으면 안내 후 종료(조용히 실패하지 않음)', () => {
  TRS = []; toasts = [];
  STATE.pendingFocus = { phone8: '12345678', name: '손아리' };
  F._applyPendingFocus(true);
  assert.strictEqual(STATE.pendingFocus, null);
  assert.strictEqual(toasts.length, 1, '못 찾았으면 사용자에게 알려야 함');
  assert.ok(/손아리/.test(toasts[0]));
});

t('15. _applyPendingFocus: 예약이 없으면 무동작(평상시 그리드 렌더 불변)', () => {
  TRS = [mkTr('12345678', '손아리')]; toasts = [];
  STATE.pendingFocus = null;
  F._applyPendingFocus(true);
  assert.ok(!TRS[0].classList.contains('rowhit'));
  assert.strictEqual(toasts.length, 0);
});

t('16. _applyPendingFocus: 셀렉터 주입 방지(따옴표 포함 값이 있어도 크래시·오매칭 없음)', () => {
  TRS = [mkTr('a"b', 'X')]; toasts = [];
  STATE.pendingFocus = { phone8: 'a"b', name: 'X' };
  F._applyPendingFocus(true);
  assert.ok(TRS[0].classList.contains('rowhit'), '이스케이프 후에도 정상 매칭되어야 함');
});

// ── 5) 서버 응답 계약 ──────────────────────────────────────────
t('17. listReviewerEvents가 phone8·tabGid를 내려준다(프론트 계약)', () => {
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/reviewerEventLog.service.js'), 'utf8');
  const sel = svc.slice(svc.indexOf('SELECT id, occurred_at'), svc.indexOf('FROM reviewer_event_logs'));
  assert.ok(/\bphone8\b/.test(sel), 'phone8 미반환 → 로그에 연락처 표기 불가');
  assert.ok(/tab_gid AS "tabGid"/.test(sel), 'tabGid 미반환 → 딥링크 탭 지정 폴백 불가');
});

// ── 6) 관리자 대시보드 중요알림 → 작업대 딥링크 ────────────────
//   좌측하단 빨간 알림의 버튼이 통합작업대를 "작업 미선택" 상태로만 열던 문제.
//   ★ workdesk 의 리뷰어 로그 탭과 **같은 #go= 계약**을 써야 한다(사본을 두면 한쪽만 고쳐진다).
const APP = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-app.js'), 'utf8');
const RA_FN = APP.slice(APP.indexOf('function _raOpenWorkdesk'), APP.indexOf('async function _raCheckAlerts'));

t('18. 중요알림 버튼이 딥링크 함수를 호출한다(맨 목록 열기 금지)', () => {
  const card = APP.slice(APP.indexOf('async function _raCheckAlerts'), APP.indexOf('async function _raResolve'));
  assert.ok(/onclick="_raOpenWorkdesk\(/.test(card), '알림 카드가 _raOpenWorkdesk 를 호출해야 함');
  assert.ok(!/window\.open\(/.test(card), '문맥 없이 workdesk.html 만 여는 옛 배선이 남아 있으면 안 됨');
});

t('19. 딥링크 문맥을 알림 목록에서 캐시한다', () => {
  assert.ok(/_raCache = r\.items;/.test(APP), '알림 원본을 보관해야 id 로 문맥을 찾을 수 있다');
  assert.ok(/const canGo = !!\(l\.sheetId && l\.tabName\)/.test(APP),
    '문맥 유무로 버튼 문구·동작을 갈라야 한다(옛 로그는 막다른 길 금지)');
});

t('20. ★ admin 이 만든 #go= URL 을 workdesk 파서가 그대로 읽는다(계약 왕복)', () => {
  assert.ok(/s: l\.sheetId, t: l\.tabName, g: l\.tabGid/.test(RA_FN), 'payload 키가 #go= 계약과 달라짐');
  assert.ok(/p: l\.phone8 \|\| "", n: l\.reviewerName/.test(RA_FN), 'phone8·이름 키가 계약과 달라짐');

  const l = { sheetId: 'sheet1', tabName: '0721)장수돌침대_쿠팡_탄소매트 900건', tabGid: '123',
              phone8: '81121348', reviewerName: '손아리', campaignName: '장수산업' };
  const payload = { s: l.sheetId, t: l.tabName, g: l.tabGid, p: l.phone8, n: l.reviewerName, st: l.campaignName };
  const url = new URL('workdesk.html', 'https://x.pages.dev/admin.html');
  url.hash = 'go=' + encodeURIComponent(JSON.stringify(payload));
  assert.strictEqual(url.pathname, '/workdesk.html', 'admin.html 기준 상대경로가 어긋남');
  assert.strictEqual(new URL('workdesk.html', 'https://x.pages.dev/admin').pathname, '/workdesk.html',
    '확장자 없는 /admin 경로에서도 같은 곳을 가리켜야 함');

  // workdesk 의 initGoLink 정규식 원문으로 되읽기
  const href = url.toString();
  const m = href.slice(href.indexOf('#')).match(/[#&]go=([^&]+)/);
  assert.ok(m, 'workdesk 파서가 #go= 를 못 찾음');
  const got = JSON.parse(decodeURIComponent(m[1]));
  assert.strictEqual(got.t, l.tabName, '한글·괄호 탭명이 왕복에서 깨짐');
  assert.strictEqual(got.s, l.sheetId);
  assert.strictEqual(got.p, l.phone8);
  assert.ok(got && got.s && got.t, '_consumeGo 가 채택하지 않는 payload');
});

t('21. 토큰을 URL 에 싣지 않는다(기존 raw_sso 핸드오프 재사용)', () => {
  assert.ok(/localStorage\.setItem\("raw_sso"/.test(RA_FN), 'raw_sso 핸드오프가 있어야 새 탭이 로그인 화면으로 안 떨어진다');
  assert.ok(!/sso=/.test(RA_FN), 'admin 경로에선 토큰을 URL 로 넘길 필요가 없다');
});

t('22. 문맥 없는 옛 로그는 평소대로 목록만 연다(막다른 길 방지)', () => {
  assert.ok(/openWorkdesk\(\); return;/.test(RA_FN), '문맥이 없으면 openWorkdesk() 폴백이어야 함');
});

// ── 7) 형식오류 캡처 — 제출 사진 바로 확인 ──────────────────
t('23. 캡처 형식오류 알림에 제출 사진 인라인 미리보기 + 라이트박스', () => {
  // context.fileId(리뷰어 업로드 Drive 파일)를 카드에 썸네일로 렌더하고 클릭 시 크게 본다
  assert.ok(/function _raCaptureFileId/.test(APP), '캡처 fileId 추출 헬퍼가 있어야 함');
  assert.ok(/ctx\.fileId/.test(APP), 'context.fileId 를 읽어야 함');
  assert.ok(/\/api\/drive\/image\//.test(APP), '무인증 Drive 이미지 프록시로 표시해야 함');
  const card = APP.slice(APP.indexOf('async function _raCheckAlerts'), APP.indexOf('async function _raResolve'));
  assert.ok(/_raCaptureFileId\(l\)/.test(card), '카드가 캡처 fileId 를 조회해야 함');
  assert.ok(/onclick="_raViewImage\(/.test(card), '썸네일 클릭이 라이트박스를 열어야 함');
  assert.ok(/function _raViewImage/.test(APP), '라이트박스 함수가 있어야 함');
  // 유효 Drive id(추측불가 20+)만 렌더 — 임의 문자열 img src 주입 방지
  assert.ok(/\/\^\[-\\w\]\{20,\}\$\//.test(APP), 'fileId 는 Drive id 형식 검증 후에만 렌더해야 함');
});

console.log('\n' + pass + ' runtime checks passed');
