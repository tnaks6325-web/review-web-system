/**
 * workdeskOpsChecks.test.js — 결정 302 「오늘 확인할 것」 화면 규칙(홈·입금관리)
 *   · 같은 목록·같은 그리기(두 자리) · onclick 에는 인덱스만 · [바로 가기]는 새 탭(로그인 이어받기 = noopener 없음)
 *   · #view=payment 딥링크는 admin/master 만 · 홈 자리는 admin/master 만
 *   · 결과 파일 업로드 버튼은 숨김(기능은 남김) · 고르기 힌트 표시
 *   · 실제로 그려 본다(vm) — 열린 것은 줄·답 버튼, 끝난 것은 한 줄로 접힘
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
function sourceOf(name) {
  let start = workdesk.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  if (workdesk.slice(start - 6, start) === 'async ') start -= 6;   // async 함수는 async 째로(vm 실행용)
  let depth = 0; let started = false;
  for (let i = start; i < workdesk.length; i++) {
    if (workdesk[i] === '{') { depth++; started = true; }
    else if (workdesk[i] === '}' && started && --depth === 0) return workdesk.slice(start, i + 1);
  }
  throw new Error(name + ' is incomplete');
}
let n = 0;
function t(name, fn) { fn(); n++; console.log('  ✓ ' + name); }

const TCK_FNS = ['_tckLoad', '_tckPaint', '_tckTitle', '_tckSub', '_tckNum', '_tckWhen', '_tckVisible', '_tckHtml', '_tckCardHtml', '_tckSetMgr', '_tckGo', '_tckPick', '_tckSave', '_tckAnswer', '_tckMemo', '_tckMessage', '_tckCopy'];
const tckSrc = TCK_FNS.map(sourceOf).join('\n');

t('onclick 에는 인덱스만 — 작업명·키·id 를 문자열로 끼우지 않는다', () => {
  for (const m of tckSrc.matchAll(/onclick="([^"]*)"/g)) {
    assert.ok(!/\$\{esc\(|JSON\.stringify|\.key|\.id/.test(m[1]), 'onclick 보간: ' + m[1]);
  }
  assert.ok(!/onchange="[^"]*\$\{esc\(/.test(tckSrc));
});
t('홈·입금관리 두 자리가 같은 그리기 함수를 쓴다', () => {
  const paint = sourceOf('_tckPaint');
  assert.match(paint, /getElementById\('tckHomeMount'\)[\s\S]*_tckHtml\('home'\)/);
  assert.match(paint, /getElementById\('pmTodayChecks'\)[\s\S]*_tckHtml\('payment'\)/);
  assert.match(workdesk, /<div id="pmTodayChecks"><\/div>/);
});
t('홈 자리는 admin/master 만 · 홈 블록은 _tckLoad 만 부른다(새 API 문자열 없음)', () => {
  assert.match(workdesk, /\$\{isAdmin\?'<div id="tckHomeMount"><\/div>':''\}/);
  assert.match(sourceOf('_homeLoad'), /document\.getElementById\('tckHomeMount'\) && typeof _tckLoad==='function'\) \? _tckLoad\(\)/);
});
t('[바로 가기] = 새 탭 · 로그인을 이어받도록 noopener 없음 · 입금관리 + 그 대량이체', () => {
  const go = sourceOf('_tckGo');
  assert.match(go, /window\.open\(url,'_blank'\)/);
  assert.doesNotMatch(go, /noopener/);
  assert.match(go, /#view=payment/);
  assert.match(go, /&pick='\+encodeURIComponent\(f\.batch\.id\)/);
});
t('#view=payment 딥링크는 admin/master 만 · pick 은 대량이체 id 모양만', () => {
  assert.match(workdesk, /if\(_VIEW==='payment' && \(STATE\.role==='master'\|\|STATE\.role==='admin'\)\)\{ STATE\.view='payment'; STATE\.pmPickBatch=_PICK\|\|'';/);
  assert.match(workdesk, /\[#&\]pick=\(\[0-9a-fA-F-\]\{36\}\)/);
});
t('결과 파일 업로드 버튼은 숨김(스위치 false) · 기능은 남김', () => {
  assert.match(workdesk, /const _PM_RESULT_UPLOAD_ON=false;/);
  assert.match(sourceOf('_pmBatchActions'), /const resultUpload = _PM_RESULT_UPLOAD_ON && /);
  assert.match(sourceOf('_pmUploadResultFile'), /result-auto-apply/);
});
t('고르기 창에 힌트를 보여 준다(서버가 준 문구 그대로)', () => {
  assert.match(sourceOf('_pmBankPickRender'), /\(it\.hints\|\|\[\]\)\.map\(h=>`<span class="pmbp-hint">\$\{esc\(h\)\}<\/span>`\)/);
});
t('실제로 그려 본다 — 열린 것은 줄·답 버튼·메모, 끝난 것은 한 줄', () => {
  const ctx = { STATE: {}, esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    document: { getElementById: () => null }, toast() {}, location: { pathname: '/workdesk' } };
  vm.createContext(ctx);
  vm.runInContext('const TCK_CHOICES=[["direct","리뷰비·페이백 직접 보냄"],["not_reviewer","리뷰어 돈 아님"],["unknown","모르겠음"]];\n' + tckSrc, ctx);
  const facts = { cluster: { date: '10/27', time: '12:41', rowCount: 118, total: 2687370 }, batch: { id: 'x', seq: 84 },
    short: [{ amount: 19800, failures: 2 }], shortUnknown: [], outside: [{ key: 'out:1000', amount: 1000, count: 22 }] };
  ctx.STATE.tckItems = [
    { id: 1, status: 'open', manager: '만두', textSource: 'ai', facts,
      lines: [{ key: 'short', text: '통장에서 3명이 안 나갔습니다' }, { key: 'out', text: '기록 없이 23건' }, { key: 'out:1000', text: '1,000원 × 22건 <b>' }],
      answers: { 'out:1000': { choice: 'direct', memo: '누룽칩', by: '망고', at: '2026-10-27T13:00:00Z' } } },
    { id: 2, status: 'done', manager: '망고', facts: { ...facts, batch: { id: 'y', seq: 83 } }, lines: [], answers: {}, doneBy: '망고' },
  ];
  const home = ctx._tckHtml('home');
  assert.match(home, /오늘 확인할 것<\/span><span class="tck-n">1<\/span>/);
  assert.match(home, /#84 대량이체/);
  assert.match(home, /onclick="_tckGo\(0\)">바로 가기/);
  assert.match(home, /class="tck-choice on" onclick="_tckAnswer\(0,0,0\)">리뷰비·페이백 직접 보냄/);
  assert.match(home, /1,000원 × 22건 &lt;b&gt;/, '문장은 이스케이프');
  assert.match(home, /AI 정리/);
  assert.match(home, /✓ 처리 완료<\/span><span>#83 대량이체/);
  const pay = ctx._tckHtml('payment');
  assert.match(pay, /onclick="_tckPick\(0\)">뺀 사람 고르기/);
  ctx._tckSetMgr(1);   // 정렬된 담당자 [만두, 망고] 의 두 번째
  assert.strictEqual(ctx.STATE.tckMgr, '망고');
  assert.doesNotMatch(ctx._tckHtml('home'), /#84 대량이체/);
  const msg = ctx._tckMessage(ctx.STATE.tckItems[0]);
  assert.match(msg, /\[#84 대량이체\] 확인 부탁드립니다/);
  assert.match(msg, /1,000원 × 22건 <b> → 리뷰비·페이백 직접 보냄 \(누룽칩\)/);
});
console.log(`workdeskOpsChecks: ${n} passed`);
