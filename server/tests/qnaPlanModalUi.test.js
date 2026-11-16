'use strict';
/* 결정 377 — 화면 두 곳을 실제 모듈 그대로(vm + 가짜 DOM) 그려 본다. 응답 모양 = 실제 서비스로 만든 fixtures/qnaPlanOverview.json.
 *  U1 Q&A 공고 조절 창: 자리표 화면(안내·[추가 모집 정하기]·0명 휴무 경고) · [＋]/[−]·이월 방식·차수 없음 · [기본으로]는 남음
 *  U2 [기본으로] → [확정 저장] = 그 날짜 remove 만 보낸다(종전 저장 길) · 미리보기(preview) 호출 없음
 *  U3 배포 스큐: Q&A 공고라도 서버가 qna 칸을 안 주면(구버전 서버) 종전 화면 · 일반 공고는 Q&A 문구 0
 *  U4 [추가 모집 정하기] → 정규 일정 끝 팝업을 그 공고 하나만 · 조절 창보다 위(z-index) · 못 찾으면 안내
 *  U5 팝업: 시작일 선택(오늘부터 기본) · 내일부터로 바꾸면 그 값을 보냄 · 마감 뒤 오늘 버튼 잠김 · 서버가 선택지를 안 주면 종전 버튼·시작일 안 보냄
 *  U6 정적: 조절 창 모듈에 'input' 이벤트 금지(IME 7w) 유지 · onclick 보간 없음
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadModule, fakeFetch, tick } = require('./helpers/fakeDomVm');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'js');
const CDP = fs.readFileSync(path.join(FRONT, 'campaign-daily-plan.js'), 'utf8');
const SEP = fs.readFileSync(path.join(FRONT, 'sequential-end-prompt.js'), 'utf8');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qnaPlanOverview.json'), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

function openCdp(overview, { extra = {}, calls = [] } = {}) {
  const fetchImpl = fakeFetch([
    [/\/daily-plan\/preview$/, async (u, o) => { calls.push({ u, body: JSON.parse(o.body || '{}') }); return { ok: true, projection: overview.projection }; }],
    [/\/daily-plan$/, async (u, o) => { calls.push({ u, method: o.method, body: o.body ? JSON.parse(o.body) : null }); return overview; }],
  ]);
  const m = loadModule(CDP, { fetchImpl, extra });
  return m;
}
const body = m => m.dom.document.getElementById('cdpBody').innerHTML;
const clickRows = (m, sel, i) => {
  const rows = m.dom.document.getElementById('cdpRows');
  const target = { closest: s => (s === sel ? { dataset: { i: String(i) } } : null) };
  (rows._listeners.click || []).forEach(fn => fn({ target }));
};

(async () => {
  console.log('\n[결정 377 · 조절 창 Q&A 인식 · 추가 모집 시작일 화면]');

  await t('U1 Q&A 조절 창 = 자리표 화면 · 막다른 [＋]/[−]·이월 방식·차수 없음 · [기본으로] 2곳(11/16 계획 1 · 11/17 0명)', async () => {
    const m = openCdp(clone(FX.qna));
    await m.win.CampaignDailyPlan.open(FX.qna.campaignId); await tick();
    const h = body(m);
    assert.match(h, /Q&amp;A 자리표가 하루 인원을 정합니다/);
    assert.ok(!/class="cdp-st"/.test(h), '[＋]/[−] 버튼이 없어야 한다');
    assert.ok(!/이월 보충 방식|다음날에 더하기|cdp-seg/.test(h), '이월 방식 고르기가 없어야 한다');
    assert.ok(!/차수|cdpRoundForm|_roundAdd/.test(h.replace('차수 추가는 Q&amp;A 공고에 쓰지 않습니다', '')), '차수 추가(서버가 막는 버튼)가 없어야 한다');
    assert.equal((h.match(/class="cdp-reset"/g) || []).length, 2);
    assert.match(h, /id="cdpQnaExtra"/);
    assert.match(h, /자리표가 <b>11\/12 \(목\)<\/b>에 끝났고 못 채운 자리 <b>1개<\/b>/);
    assert.match(h, /<b>오늘부터<\/b> 다시 열 수 있습니다/);
    assert.match(h, /11\/17 \(화\)[\s\S]{0,200}0명\(휴무\)으로 정해 둔 날 — 추가 모집은 이 날을 건너뜁니다/);
    assert.match(h, /자리표 마지막 날: <b>11\/12 \(목\)<\/b>/);
    assert.ok(!/규칙 1|>규칙</.test(h), '실제로 안 열리는 「규칙」 값을 보이지 않는다');
    assert.equal(m.dom.document.getElementById('cdpSaveBtn').disabled, true);
    assert.match(m.dom.document.getElementById('cdpHint').textContent, /자리표가 정합니다/);
  });

  await t('U2 [기본으로](11/17 0명) → [확정 저장] = remove 11/17 만 · 미리보기 호출 없음', async () => {
    const calls = [];
    const m = openCdp(clone(FX.qna), { calls });
    await m.win.CampaignDailyPlan.open(FX.qna.campaignId); await tick();
    const dates = ['2026-11-16', '2026-11-17'];
    clickRows(m, '.cdp-reset', dates.indexOf('2026-11-17')); await tick();
    assert.match(body(m), /0명\(휴무\) 해제 — 저장 전/);
    assert.equal(m.dom.document.getElementById('cdpSaveBtn').disabled, false);
    await m.win.CampaignDailyPlan._save(); await tick();
    const post = calls.filter(c => c.method === 'POST' && /\/daily-plan$/.test(c.u));
    assert.equal(post.length, 1);
    assert.deepEqual(post[0].body.set, []); assert.deepEqual(post[0].body.remove, ['2026-11-17']);
    assert.ok(!calls.some(c => /preview$/.test(c.u)), 'Q&A 화면은 앞날 예상을 다시 계산하지 않는다');
  });

  await t('U3 배포 스큐: 구버전 서버(qna 칸 없음)면 종전 화면 · 일반 공고는 Q&A 문구 0', async () => {
    const old = clone(FX.qna); delete old.qna;
    const m = openCdp(old);
    await m.win.CampaignDailyPlan.open(old.campaignId); await tick();
    assert.match(body(m), /class="cdp-st"/); assert.match(body(m), /이월 보충 방식/);
    assert.ok(!/cdp-q|자리표/.test(body(m)));
    const r = openCdp(clone(FX.review));
    await r.win.CampaignDailyPlan.open(FX.review.campaignId); await tick();
    assert.match(body(r), /class="cdp-st"/);
    assert.ok(!/cdp-q|자리표|Q&amp;A/.test(body(r)));
  });

  await t('U4 [추가 모집 정하기] → 팝업을 그 공고 하나만 · 조절 창 위 · 못 찾으면 안내 · 반영 뒤 조절 창 다시 불러옴', async () => {
    const opened = [];
    const fakePrompt = { openFor: async (id, o) => { opened.push(id); fakePrompt._o = o; return { ok: true }; } };
    const calls = [];
    const m = openCdp(clone(FX.qna), { calls, extra: { SequentialEndPrompt: fakePrompt } });
    await m.win.CampaignDailyPlan.open(FX.qna.campaignId); await tick();
    await m.win.CampaignDailyPlan._qnaExtra();
    assert.deepEqual(opened, [FX.qna.campaignId]);
    const gets = () => calls.filter(c => c.method === 'GET').length;
    const before = gets();
    fakePrompt._o.onDone([{ ok: true }]); await tick(40);
    assert.equal(gets(), before + 1, '반영 뒤 조절 창 자료를 다시 받는다');
    // 진짜 팝업 모듈: 그 공고 하나만 · over(조절 창 위)
    const apiCalls = [];
    const P = loadModule(SEP, {});
    const items = clone(FX.popup.items).concat([{ campaignId: 'other', title: '다른 공고', kind: 'qna', end: '2026-11-10', shortages: [], total: 2 }]);
    P.win.SequentialEndPrompt.start({ api: async (u, o) => { apiCalls.push(u); return { ok: true, items }; }, name: '망고' });
    await tick();
    const r = await P.win.SequentialEndPrompt.openFor(FX.qna.campaignId, {});
    assert.equal(r.ok, true);
    const ov = P.dom.document.getElementById('seOv');
    assert.ok(ov.classList.contains('over'));
    assert.ok(/11\/3더로우/.test(ov.innerHTML) && !/다른 공고/.test(ov.innerHTML), '그 공고 하나만 보인다');
    const miss = await P.win.SequentialEndPrompt.openFor('nope', {});
    assert.equal(miss.ok, false); assert.equal(miss.reason, 'not_listed');
    assert.match(CDP, /not_listed' \? '이 공고의 추가 모집은 공고 담당자·오더를 보낸 사람·마스터가 정합니다/);
    assert.match(SEP, /'#seOv\.over\{z-index:10100\}/);
    assert.match(CDP, /#cdpModal\{position:fixed;inset:0;z-index:10050;/);
  });

  await t('U5 팝업 시작일: 오늘부터 기본 → 내일부터로 바꿔 보냄 · 마감 뒤 오늘 잠김 · 선택지 없음(구버전 서버) = 종전 버튼·시작일 안 보냄', async () => {
    const sent = [];
    const mk = items => {
      const P = loadModule(SEP, { extra: { confirm: () => true } });
      P.win.SequentialEndPrompt.start({ api: async (u, o) => {
        if (/\/apply$/.test(u)) { const b = JSON.parse(o.body); sent.push(b.decisions); return { ok: true, results: b.decisions.map(d => ({ campaignId: d.campaignId, ok: true })) }; }
        return { ok: true, items: clone(items) };
      }, name: '망고' });
      return P;
    };
    const click = (P, attrs) => {
      const ov = P.dom.document.getElementById('seOv');
      const btn = { disabled: false, getAttribute: k => (attrs[k] == null ? null : String(attrs[k])) };
      (ov._listeners.click || []).forEach(fn => fn({ target: { closest: () => btn } }));
    };
    const P = mk(FX.popup.items); await tick();
    let h = P.dom.document.getElementById('seOv').innerHTML;
    assert.match(h, /data-s="today" aria-pressed="true">오늘부터/);
    assert.match(h, /오늘 23:50까지 신청을 받습니다 · 11\/16\(월\)에 다시 엽니다/);
    assert.match(h, />추가 모집 — 같은 하루 건수로</);
    click(P, { 'data-i': 0, 'data-s': 'tomorrow' }); await tick();
    h = P.dom.document.getElementById('seOv').innerHTML;
    assert.match(h, /data-s="tomorrow" aria-pressed="true">내일부터/);
    assert.match(h, /11\/18\(수\)에 다시 엽니다 · 0명\(휴무\)으로 닫아 둔 11\/17\(화\)은 건너뜁니다/);
    click(P, { 'data-i': 0, 'data-a': 'extra' }); await tick();
    click(P, { 'data-apply': 1 }); await tick(40);
    assert.equal(sent[0][0].start, 'tomorrow');
    // 마감 뒤
    const L = mk(FX.popupLate.items); await tick();
    h = L.dom.document.getElementById('seOv').innerHTML;
    assert.match(h, /data-s="today" aria-pressed="false" disabled title="오늘 신청 마감 시각이 지나/);
    assert.match(h, /data-s="tomorrow" aria-pressed="true"/);
    // 구버전 서버 = start 없음
    const oldItems = clone(FX.popup.items).map(x => { delete x.start; return x; });
    const O = mk(oldItems); await tick();
    h = O.dom.document.getElementById('seOv').innerHTML;
    assert.ok(!/se-start|data-s=/.test(h));
    assert.match(h, />추가 모집 — 다음 영업일부터 같은 하루 건수로</);
    click(O, { 'data-i': 0, 'data-a': 'extra' }); await tick();
    click(O, { 'data-apply': 1 }); await tick(40);
    assert.ok(!('start' in sent[1][0]), '구버전 서버에는 시작일을 보내지 않는다(서버 종전 = 내일부터)');
  });

  await t('U6 정적: 조절 창 모듈 \'input\' 이벤트 금지 유지 · onclick 서버 문자열 보간 없음', async () => {
    assert.ok(!/addEventListener\('input'/.test(CDP));
    assert.ok(!/onclick="[^"]*\$\{/.test(CDP));
    assert.ok(/onclick="CampaignDailyPlan\._qnaExtra\(\)"/.test(CDP));
  });

  console.log(`\n${passed}개 통과`);
  process.exit(0);
})().catch(e => { console.error('✗', e && e.stack || e); process.exit(1); });
