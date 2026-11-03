'use strict';
// 결정 324 — 홈 「오늘 확인할 것」의 「작업표 꽉 참」 항목을 실제로 그려 본다(vm · homeManagerQuestionsUI 와 같은 방식).
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const src = html.slice(html.indexOf('const TCK_CHOICES='), html.indexOf('/** nav 뱃지', html.indexOf('const TCK_CHOICES=')));
const opened = [];
const ctx = { STATE: {}, window: { addEventListener() {}, open: (u, t) => { opened.push([u, t]); return {}; } },
  location: { pathname: '/workdesk' }, document: { getElementById: () => null },
  esc: s => String(s == null ? '' : s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  toast() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
vm.createContext(ctx); vm.runInContext(src, ctx);
(async () => {
  const item = { id: 701, kind: 'workboard_no_slot', status: 'open', canAnswer: true, queueState: 'blocked',
    facts: { orderSubmissionId: 'os-1', sheetId: 'wt_x', tabName: '9/7 비타민 <200건>', tabGid: '838', title: '9/7 비타민 <200건>' },
    lines: [{ key: 'no_slot', text: '작업표가 꽉 차서(줄 200개 모두 참) 구매양식 1건이 작업표에 들어가지 못했습니다.' },
      { key: 'who', text: '10/26 11:48 주문 · 가짜<리뷰어> · 연락처 끝 7564' }, { key: 'how', text: '작업보드에서 줄을 추가한 뒤 [다시 넣기]' }],
    answers: {} };
  ctx.STATE.tckItems = []; ctx.STATE.tckManagerItems = []; ctx.STATE.tckSlotItems = [item];
  let home = ctx._tckHtml('home');
  assert.match(home, /작업표가 꽉 차서\(줄 200개 모두 참\) 구매양식 1건이 작업표에 들어가지 못했습니다/, '서버 문장을 그대로 그린다');
  assert.match(home, /9\/7 비타민 &lt;200건>/, '제목 escape');
  assert.match(home, /가짜&lt;리뷰어>/, '문장 escape');
  assert.match(home, /작업보드로 가기/); assert.match(home, /다시 넣기/); assert.match(home, /확인함/);
  assert.match(home, /<span class="tck-n">1<\/span>/, '건수에 센다');
  assert.doesNotMatch(home, /케이뱅크|대량이체|_tckGo\(/, '은행 카드로 잘못 그리지 않는다');
  for (const m of home.matchAll(/onclick="([^"]*)"/g)) assert.ok(/^_tck\w+\(\d+(,\d+)?\)$/.test(m[1]), 'onclick 은 인덱스만: ' + m[1]);
  assert.doesNotMatch(ctx._tckHtml('payment'), /비타민|작업표/, '입금관리에는 안 나온다');
  // 휴대폰 한 줄
  assert.match(ctx._tckRowHtml(item, 0), /onclick="_tckSheetOpen\(0\)"><b>9\/7 비타민 &lt;200건><\/b><span class="tck-rs">작업표 꽉 참 · 구매양식 1건 못 들어감/);
  assert.match(ctx._tckRowHtml({ ...item, queueState: 'retrying' }, 0), /다시 넣는 중/);
  // 권한 없음 → 답 버튼 없음(가기는 있음)
  item.canAnswer = false; home = ctx._tckHtml('home');
  assert.doesNotMatch(home, /_tckSlotAnswer/); assert.match(home, /_tckSlotGo\(0\)/); item.canAnswer = true;
  // 작업보드로 가기 = 새 탭 · 작업만(#go= s/t/g · 리뷰어 정보 없음)
  ctx._tckHtml('home'); ctx._tckSlotGo(0);
  assert.equal(opened.length, 1); assert.equal(opened[0][1], '_blank');
  const go = JSON.parse(decodeURIComponent(opened[0][0].split('#go=')[1]));
  assert.deepEqual(go, { s: 'wt_x', t: '9/7 비타민 <200건>', g: '838' });
  // 다시 넣기 — 중복 클릭 막기 · 서버 답으로 바꿔 그림
  let calls = 0, resolve;
  ctx.api = async (url, opts) => { calls++; assert.match(url, /\/701\/slot-answer$/); assert.deepEqual(JSON.parse(opts.body), { choice: 'retry' }); return new Promise(r => { resolve = r; }); };
  const p = ctx._tckSlotAnswer(0, 0); await ctx._tckSlotAnswer(0, 0);
  assert.equal(calls, 1, 'double click blocked');
  resolve({ ok: true, item: { ...item, queueState: 'retrying' } }); await p;
  home = ctx._tckHtml('home');
  assert.match(home, /다시 넣는 중 — 들어가면 저절로 닫힙니다/);
  assert.match(home, /disabled onclick="_tckSlotAnswer\(0,0\)"/, '다시 넣는 중에는 다시 넣기 잠금');
  // 빈 줄 없음 거부 → 열린 그대로 · 서버 안내를 보여 준다
  let msg = ''; ctx.toast = m => { msg = m; };
  ctx.STATE.tckSlotItems = [{ ...item }]; ctx._tckHtml('home');
  ctx.api = async () => ({ ok: false, code: 'no_room', error: '작업표에 아직 빈 줄이 없습니다 — 작업보드에서 줄을 먼저 추가해 주세요.' });
  await ctx._tckSlotAnswer(0, 0);
  assert.match(msg, /아직 빈 줄이 없습니다/); assert.equal(ctx.STATE.tckSlotItems[0].status, 'open');
  // 확인함 → 끝난 한 줄
  ctx.api = async () => ({ ok: true, item: { ...item, status: 'done', doneBy: '가짜 직원' } });
  await ctx._tckSlotAnswer(0, 1);
  home = ctx._tckHtml('home');
  assert.match(home, /✓ 처리 완료<\/span><span>9\/7 비타민 &lt;200건><\/span>/, '끝난 줄 제목 = 작업명');
  // 불러오기 실패는 숨기지 않는다 · 다른 항목은 그대로
  ctx.STATE.tckSlotItems = []; ctx.STATE.tckSlotError = true;
  assert.match(ctx._tckHtml('home'), /작업표 빈 줄 확인 항목을 불러오지 못했습니다/);
  // 은행 목록 실패여도 이 항목은 보인다
  ctx.STATE.tckSlotError = false; ctx.STATE.tckSlotItems = [{ ...item }]; ctx.STATE.tckItems = null; ctx.STATE.tckError = 'x';
  home = ctx._tckHtml('home');
  assert.match(home, /구매양식 1건이 작업표에 들어가지 못했습니다/); assert.match(home, /통장 확인 항목을 불러오지 못했습니다/);
  // 불러오기 — 홈에서는 담당자 질문과 함께 이 목록도 부른다
  const urls = []; ctx.STATE.tckItems = []; ctx.document = { getElementById: id => (id === 'tckHomeMount' ? { innerHTML: '' } : null) };
  ctx.api = async u => { urls.push(u); return u.includes('/slots') ? { ok: true, items: [item] } : u.includes('/managers') ? { ok: true, items: [], hasMore: false, nextAfter: 0 } : { ok: true, items: [] }; };
  await ctx._tckLoad();
  assert.ok(urls.includes('/api/trackb/ops-checks/slots?after=0'), urls.join(','));
  assert.equal(ctx.STATE.tckSlotItems.length, 1);
  // 50건 넘음 — 서버 hasMore 를 버리지 않는다: 「더 보기」로 다음 쪽(after=nextAfter)을 이어 붙인다(Codex P2 · 담당자 질문과 같은 방식)
  const item2 = { ...item, id: 702, facts: { ...item.facts, orderSubmissionId: 'os-2' } };
  ctx.api = async u => { urls.push(u);
    if (u.includes('/slots')) return u.endsWith('after=0') ? { ok: true, items: [item], hasMore: true, nextAfter: 701 } : { ok: true, items: [item2, item], hasMore: false, nextAfter: 702 };
    return u.includes('/managers') ? { ok: true, items: [], hasMore: false, nextAfter: 0 } : { ok: true, items: [] }; };
  await ctx._tckLoad();
  home = ctx._tckHtml('home');
  assert.match(home, /onclick="_tckLoadSlots\(true\)"[^>]*>작업표 꽉 참 더 보기</, '더 보기 버튼');
  await ctx._tckLoadSlots(true);
  assert.equal(urls[urls.length - 1], '/api/trackb/ops-checks/slots?after=701');
  assert.deepEqual(ctx.STATE.tckSlotItems.map(x => x.id), [701, 702], '이어 붙이고 중복은 하나로');
  assert.doesNotMatch(ctx._tckHtml('home'), /작업표 꽉 참 더 보기/, '끝까지 받으면 더 보기 없음');
  // 더 보기 실패 — 이미 받은 항목은 지우지 않는다
  ctx.STATE.tckSlotMore = true; ctx.STATE.tckSlotAfter = 702; ctx.api = async () => { throw Error('net'); };
  await ctx._tckLoadSlots(true);
  assert.equal(ctx.STATE.tckSlotItems.length, 2); assert.equal(ctx.STATE.tckSlotError, true);
  console.log('home slot ops-check UI: server lines, escape, home-only, compact, permission, new-tab go, retry/ack, failure PASS');
})().catch(e => { console.error(e); process.exit(1); });
