'use strict';
/* 결정 379 — 조절 창 Q&A 빈 자리 옮기기 화면(실제 모듈 그대로 · vm + 가짜 DOM). 응답 모양 = 실제 서비스로 만든 fixtures/qnaMoveOverview.json
 *  (tests/helpers/qnaMoveFixtureGen.js · 운영 사례 본뜸: 오늘 11/17 = 0명 계획 · 11/18 = 빈 자리 1).
 *  V1 옮기기 화면: 날짜 줄마다 [−]/[＋] · 「휴무」·[기본으로]·휴무 경고 없음 · 0명 계획 날(11/17)도 자리 수만 · 저장 잠김
 *  V2 11/18 [−] 만 = 저장 잠김 + 「같아야」 안내 → 11/17 [＋] = 저장 열림 → [확정 저장] = qna-move 하나(날짜별 계획 저장 없음) · 다시 그림
 *  V3 409(그사이 바뀜) = 최신 자리로 다시 받아 그림 · 고른 이동 버림 · 안내
 *  V4 다른 거절(상품별 하루 건수 등) = 안내 + 고른 이동 유지 · 다시 저장 가능
 *  V5 오늘 마감 뒤·쉬는 날 = [＋] 잠김(눌러도 안 바뀌고 이유 안내) · 옮길 빈 자리가 없는 날 = [−] 잠김
 *  V6 배포 스큐: 서버가 move 칸을 안 주면(구버전) [−]/[＋] 없음 = 결정 377 화면 그대로 · 일반 공고 무영향
 *  V7 이력 「빈 자리 옮김」 · 닫을 때 저장 안 한 옮기기 확인 · [바꾼 내용 되돌리기] = 고른 이동만 버림
 *  V8 정적: 화면 파일 버전 표기를 올렸다 · 'input' 이벤트 금지 유지
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadModule, fakeFetch, tick } = require('./helpers/fakeDomVm');

const FRONT = path.join(__dirname, '..', '..', 'frontend');
const CDP = fs.readFileSync(path.join(FRONT, 'js', 'campaign-daily-plan.js'), 'utf8');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qnaMoveOverview.json'), 'utf8'));
const FX377 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qnaPlanOverview.json'), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));

let passed = 0;
const failed = [];
// 하나가 실패해도 나머지를 돌려 실패한 것을 모두 보인다(끝에서 실패 1개 이상 = exit 1)
const t = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed.push(name); console.log('  ✗ ' + name + '\n      ' + String((e && e.message) || e).split('\n').slice(0, 3).join(' / ')); }
};

function openCdp(overview, { calls = [], moveReply = null, extra = {} } = {}) {
  const fetchImpl = fakeFetch([
    [/\/qna-move$/, async (u, o) => { calls.push({ u, method: o.method, body: JSON.parse(o.body || '{}') }); return moveReply ? moveReply() : clone(FX.after); }],
    [/\/daily-plan\/preview$/, async (u, o) => { calls.push({ u, method: o.method }); return { ok: true }; }],
    [/\/daily-plan$/, async (u, o) => { calls.push({ u, method: o.method, body: o.body ? JSON.parse(o.body) : null }); return typeof overview === 'function' ? overview() : clone(overview); }],
  ]);
  return loadModule(CDP, { fetchImpl, extra });
}
const doc = m => m.dom.document;
const body = m => doc(m).getElementById('cdpBody').innerHTML;
const saveBtn = m => doc(m).getElementById('cdpSaveBtn');
const toastText = m => (doc(m).getElementById('cdpToast') || {}).textContent || '';
/** 날짜 줄의 [−]/[＋] 를 누른다 — 줄 번호는 그려진 HTML 에서 찾는다(화면이 쓰는 번호 그대로) */
function step(m, md, dir) {
  const h = body(m);
  const re = new RegExp('data-i="(\\d+)" data-d="' + (dir < 0 ? '-1' : '1') + '" aria-label="' + md.replace(/[()]/g, '\\$&') + ' 빈 자리 ' + (dir < 0 ? '빼기' : '더하기') + '"([^>]*)>');
  const g = h.match(re);
  assert.ok(g, md + ' 줄의 버튼이 없다');
  const rows = doc(m).getElementById('cdpRows');
  const target = { closest: s => (s === '.cdp-qst' ? { dataset: { i: g[1], d: String(dir < 0 ? -1 : 1) } } : null) };
  (rows._listeners.click || []).forEach(fn => fn({ target }));
  return / disabled/.test(g[2]);   // 누르기 전 그 버튼이 잠겨 있었나
}
const rowOf = (m, md) => {
  const h = body(m);
  const g = new RegExp('<span class="cdp-d[^"]*"[^>]*>' + md.replace(/[()]/g, '\\$&')).exec(h);
  assert.ok(g, md + ' 줄이 없다');
  return h.slice(h.lastIndexOf('<div class="cdp-row', g.index), h.indexOf('</div>', g.index) + 6);
};

(async () => {
  console.log('\n[결정 379 · 조절 창 Q&A 빈 자리 옮기기 화면]');

  await t('V1 옮기기 화면 — 날짜 줄 [−]/[＋] · 휴무·[기본으로]·휴무 경고 없음 · 0명 계획 날(11/17)도 자리 수만 · 저장 잠김', async () => {
    const m = openCdp(FX.qna);
    await m.win.CampaignDailyPlan.open(FX.qna.campaignId); await tick();
    const h = body(m);
    assert.match(h, /class="cdp-qst"/);
    assert.ok(!/class="cdp-st"/.test(h), '일반 공고의 [−]/[＋](날짜별 인원)는 없다');
    assert.ok(!/cdp-reset|기본으로/.test(h), '[기본으로]가 없어야 한다');
    assert.ok(!/휴무/.test(h.replace('0명 휴무 포함', '')), '「휴무」 글자·경고가 없어야 한다');
    assert.match(h, /빈 자리<\/b>\(아직 신청이 없는 자리\)를 다른 날로 옮길 수 있습니다/);
    const r17 = rowOf(m, '11/17 (화)');
    assert.match(r17, /cdp-state">오늘</); assert.match(r17, /cdp-num">0</);
    assert.match(r17, /aria-label="11\/17 \(화\) 빈 자리 빼기" disabled/, '빈 자리가 없는 날은 [−] 잠김');
    assert.ok(!/aria-label="11\/17 \(화\) 빈 자리 더하기" disabled/.test(r17), '오늘(마감 전)은 [＋] 가능');
    const r18 = rowOf(m, '11/18 (수)');
    assert.match(r18, /cdp-num">1</); assert.match(r18, /남은 자리 1 \/ 1/);
    assert.ok(!/빈 자리 빼기" disabled/.test(r18));
    assert.ok(!/>11\/12 \(목\)/.test(h), '옮길 빈 자리가 없는 지난 날 줄은 그리지 않는다');
    assert.equal(saveBtn(m).disabled, true);
    assert.match(doc(m).getElementById('cdpHint').textContent, /자리표가 정합니다/);
  });

  await t('V2 11/18 [−] 만 = 잠김 + 「같아야」 → 11/17 [＋] = 열림 → [확정 저장] = qna-move 하나 · 날짜별 계획 저장 없음 · 다시 그림', async () => {
    const calls = [];
    const m = openCdp(FX.qna, { calls });
    await m.win.CampaignDailyPlan.open(FX.qna.campaignId); await tick();
    step(m, '11/18 (수)', -1); await tick();
    assert.equal(saveBtn(m).disabled, true);
    assert.match(body(m), /뺀 자리 <b>1개<\/b> · 더한 자리 <b>0개<\/b> — 둘이 같아야 저장할 수 있습니다/);
    assert.match(doc(m).getElementById('cdpHint').textContent, /같아야 저장됩니다/);
    assert.match(rowOf(m, '11/18 (수)'), /cdp-state">변경<[\s\S]*cdp-num">0<[\s\S]*빈 자리 1개 빼기 — 저장 전/);
    step(m, '11/17 (화)', 1); await tick();
    assert.equal(saveBtn(m).disabled, false);
    assert.match(doc(m).getElementById('cdpHint').textContent, /빈 자리 1개를 옮깁니다/);
    await m.win.CampaignDailyPlan._save(); await tick(40);
    const mv = calls.filter(c => /qna-move$/.test(c.u));
    assert.equal(mv.length, 1); assert.equal(mv[0].method, 'POST');
    assert.deepEqual(mv[0].body, { days: [{ date: '2026-11-17', n: 1 }, { date: '2026-11-18', n: -1, movable: 1 }], total: 50 });   // 리뷰 반영 — 날짜별 증감(검사 의미 불변: 보내는 모양만)
    assert.ok(!calls.some(c => c.method === 'POST' && /daily-plan$/.test(c.u)), '날짜별 계획을 저장하지 않는다');
    assert.ok(!calls.some(c => /preview$/.test(c.u)));
    assert.match(rowOf(m, '11/17 (화)'), /cdp-num">1</, '응답(실제 서비스 결과)으로 다시 그렸다');
    assert.match(toastText(m), /빈 자리 1개를 옮겼습니다 — 11\/18 → 11\/17 벨벳틴 부티크 상품 1개/);
    assert.equal(saveBtn(m).disabled, true, '저장 뒤 고른 이동이 비었다');
    assert.match(body(m), /빈 자리 옮김: 11\/18 \(수\) → 11\/17 \(화\) 1개/, '이력에 남는다');
  });

  await t('V3 409(그사이 바뀜) = 최신 자리로 다시 받아 그림 · 고른 이동 버림 · 안내', async () => {
    const calls = [];
    const m = openCdp(FX.qna, { calls, moveReply: () => ({ ok: false, code: 'qna_move_stale', error: '그사이 11/18의 빈 자리가 바뀌었습니다(지금 0개) — 최신 자리로 다시 불러왔으니 다시 옮겨 주세요.' }) });
    await m.win.CampaignDailyPlan.open(FX.qna.campaignId); await tick();
    const gets = () => calls.filter(c => c.method === 'GET').length;
    const before = gets();
    step(m, '11/18 (수)', -1); step(m, '11/17 (화)', 1); await tick();
    await m.win.CampaignDailyPlan._save(); await tick(40);
    assert.equal(gets(), before + 1, '최신 자료를 다시 받는다');
    assert.match(toastText(m), /다시 옮겨 주세요/);
    assert.equal(saveBtn(m).disabled, true);
    assert.ok(!/cdp-state">변경</.test(body(m)), '고른 이동은 버렸다(옛 숫자로 다시 409 나는 막다른 길 금지)');
  });

  await t('V4 다른 거절(상품별 하루 건수) = 안내 + 고른 이동 유지 · 다시 저장 가능', async () => {
    const m = openCdp(FX.qna, { moveReply: () => ({ ok: false, code: 'qna_move_no_room', error: '11/17은 상품별 하루 건수가 이미 차서 11/18의 빈 자리 1개를 다 옮길 수 없습니다(들어갈 수 있는 수 0개).' }) });
    await m.win.CampaignDailyPlan.open(FX.qna.campaignId); await tick();
    step(m, '11/18 (수)', -1); step(m, '11/17 (화)', 1); await tick();
    await m.win.CampaignDailyPlan._save(); await tick(40);
    assert.match(toastText(m), /옮기지 못했습니다: 11\/17은 상품별 하루 건수가 이미 차서/);
    assert.match(body(m), /cdp-state">변경</);
    assert.equal(saveBtn(m).disabled, false);
  });

  await t('V5 오늘 마감 뒤·쉬는 날 = [＋] 잠김(눌러도 그대로 · 이유 안내) · 빈 자리 없는 날 = [−] 잠김', async () => {
    const late = clone(FX.qna);
    late.qna.move.today = { ok: false, code: 'cutoff', why: '오늘 신청 마감 시각이 지나 오늘부터 열 수 없습니다' };
    late.qna.move.closed = ['2026-11-21', '2026-11-22'];
    const m = openCdp(late);
    await m.win.CampaignDailyPlan.open(late.campaignId); await tick();
    assert.match(rowOf(m, '11/17 (화)'), /빈 자리 더하기" disabled[\s\S]*오늘 신청 마감 시각이 지나 오늘로는 옮길 수 없습니다/);
    assert.match(rowOf(m, '11/21 (토)'), /cdp-state">쉬는 날<[\s\S]*빈 자리 더하기" disabled[\s\S]*오더 휴무일·주말 — 자리를 둘 수 없습니다/);
    step(m, '11/17 (화)', 1); await tick();
    assert.match(toastText(m), /오늘로는 옮길 수 없습니다/);
    step(m, '11/21 (토)', 1); await tick();
    assert.match(toastText(m), /11\/21 \(토\)은 오더 휴무일·주말이라 자리를 둘 수 없습니다/);
    step(m, '11/19 (목)', -1); await tick();
    assert.match(toastText(m), /11\/19 \(목\)에는 옮길 빈 자리\(아직 신청이 없는 자리\)가 없습니다/);
    assert.ok(!/cdp-state">변경</.test(body(m)), '잠긴 버튼은 아무것도 바꾸지 않는다');
  });

  await t('V6 배포 스큐 — 서버가 move 칸을 안 주면(구버전) [−]/[＋] 없음 = 결정 377 화면 그대로 · 일반 공고 무영향', async () => {
    const old = clone(FX.qna); delete old.qna.move;
    const m = openCdp(old);
    await m.win.CampaignDailyPlan.open(old.campaignId); await tick();
    assert.ok(!/cdp-qst/.test(body(m)));
    assert.match(body(m), /0명\(휴무\)으로 닫아 둔 날만 그날 모집이 멈춥니다/, '구버전 서버에서는 결정 377 화면(그 서버는 아직 0명 휴무를 쓴다)');
    const m377 = openCdp(FX377.qna);
    await m377.win.CampaignDailyPlan.open(FX377.qna.campaignId); await tick();
    assert.ok(!/cdp-qst/.test(body(m377)) && /class="cdp-reset"/.test(body(m377)));
    const r = openCdp(FX377.review);
    await r.win.CampaignDailyPlan.open(FX377.review.campaignId); await tick();
    assert.match(body(r), /class="cdp-st"/); assert.ok(!/cdp-q/.test(body(r)));
  });

  await t('V7 닫을 때 저장 안 한 옮기기 확인 · [바꾼 내용 되돌리기] = 고른 이동만 버림', async () => {
    let asked = 0;
    const m = openCdp(FX.qna, { extra: { confirm: () => { asked++; return false; } } });
    await m.win.CampaignDailyPlan.open(FX.qna.campaignId); await tick();
    step(m, '11/18 (수)', -1); await tick();
    m.win.CampaignDailyPlan.close();
    assert.equal(asked, 1, '저장하지 않은 옮기기가 있으면 묻는다');
    m.win.CampaignDailyPlan._revert(); await tick();
    assert.ok(!/cdp-state">변경</.test(body(m)));
    assert.equal(saveBtn(m).disabled, true);
  });

  await t('V8 정적 — 화면 파일 버전 표기를 올렸다 · \'input\' 이벤트 금지 유지 · onclick 서버 문자열 보간 없음', async () => {
    const wd = fs.readFileSync(path.join(FRONT, 'workdesk.html'), 'utf8');
    assert.match(wd, /js\/campaign-daily-plan\.js\?v=20261118-qnamove2/);
    assert.ok(!/addEventListener\('input'/.test(CDP));
    assert.ok(!/onclick="[^"]*\$\{/.test(CDP));
  });

  /* ── PR #1839 리뷰 반영(Codex P2) ── */
  await t('V9 리뷰 P2② 화면은 날짜별 증감만 보낸다(짝짓기 없음) — 어느 날 빈 자리를 어느 날로 보낼지는 서버가 잠근 뒤 정한다', async () => {
    const calls = [];
    const two = clone(FX.qna);
    two.qna.days.push({ date: '2026-11-19', slots: 1, filled: 0, open: 1, movable: 1 });
    const m = openCdp(two, { calls });
    await m.win.CampaignDailyPlan.open(two.campaignId); await tick();
    step(m, '11/18 (수)', -1); step(m, '11/19 (목)', -1); step(m, '11/20 (금)', 1); step(m, '11/21 (토)', 1); await tick();
    assert.equal(saveBtn(m).disabled, false);
    await m.win.CampaignDailyPlan._save(); await tick(40);
    const mv = calls.filter(c => /qna-move$/.test(c.u));
    assert.equal(mv.length, 1);
    assert.deepEqual(mv[0].body, { days: [
      { date: '2026-11-18', n: -1, movable: 1 }, { date: '2026-11-19', n: -1, movable: 1 },
      { date: '2026-11-20', n: 1 }, { date: '2026-11-21', n: 1 }], total: 50 });
  });

  await t('V10 리뷰 P2③ 공고 시작일 전 날 = [＋] 잠김(눌러도 그대로 · 이유 안내) · 시작일 당일은 가능', async () => {
    const fut = clone(FX.qna);
    fut.qna.move.start = '2026-11-20';
    fut.qna.move.today = { ok: false, code: 'not_started', why: '공고 시작일(11/20) 전이라 오늘부터 열 수 없습니다' };
    const m = openCdp(fut);
    await m.win.CampaignDailyPlan.open(fut.campaignId); await tick();
    assert.match(rowOf(m, '11/19 (목)'), /빈 자리 더하기" disabled[\s\S]*공고 시작일\(11\/20\) 전 — 자리를 둘 수 없습니다/);
    assert.ok(!/빈 자리 더하기" disabled/.test(rowOf(m, '11/20 (금)')), '시작일 당일은 [＋] 가능');
    step(m, '11/19 (목)', 1); await tick();
    assert.match(toastText(m), /공고 시작일\(11\/20\) 전으로는 옮길 수 없습니다/);
    assert.ok(!/cdp-state">변경</.test(body(m)));
  });

  console.log(`\n${passed}개 통과` + (failed.length ? ` · ${failed.length}개 실패` : ''));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('✗', e && e.stack || e); process.exit(1); });
