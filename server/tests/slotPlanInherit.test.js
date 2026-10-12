/**
 * slotPlanInherit.test.js — 결정 227 (2026-10-12 제주도아 · 위드프렌즈 50건)
 *
 * 사고:
 *   ① 행 삭제(리뷰어 주문 취소·담당자 줄 삭제) 보충 줄이 상품·옵션·리뷰옵션을 전부 비운 채 만들어져
 *      "어느 상품 자리인지"가 사라졌다 — 순차진행 제주도아에서 옥돔 자리 5개가 상품 없는 빈 줄이 되어 맨 뒤 날짜로 밀렸다.
 *   ② 담당자가 빈 줄 상품 칸에 손으로 적은 값(물리행 앵커 편집)을 줄 고르기가 보지 않았고, 다른 상품 주문이 그 줄에
 *      들어가면 화면에는 손 글씨가 그대로 보였다(위드프렌즈 10/1 사고와 같은 모양).
 *   ③ 공고 총원과 상품별 남은 자리 합이 어긋나도(1번 상품 6/5) 아무도 몰랐다 — 마지막 날 10명이 아니라 9명에서 닫혔다.
 * 고정:
 *   [1] 계획 칸 판정(planCellHeaders) — 상품·옵션·리뷰옵션·배송구분·회수·차수 / 결제금액·옵션금액·비고(옵션확인) 제외
 *   [2] 보충 줄이 계획 칸·배정 표식을 잇는다(편집 오버레이 → 줄 값) · 조회 실패 = 줄 값만 · 끄는 스위치 = 종전 빈 줄
 *   [3] 줄 고르기가 손 글씨 상품을 계획으로 본다 · 다른 상품 손 글씨 줄은 뒤로 · 옵션 키 선택은 무접촉
 *   [4] 손 글씨 내림 배선(지우지 않고 reverted · 상품 2종 짝지은 경우만 · SAVEPOINT)
 *   [5] 총원 ↔ 상품별 남은 자리 대조(optionTotalBalance) — 실측 값 그대로 · 모르면 null
 *   [6] 관리자 화면 안내 문장(vm 실행) · 배선
 * 실행: node tests/slotPlanInherit.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, n = 0;
const ok = (msg, cond) => { n++; if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };

const { planCellHeaders } = require('../src/utils/worktablePlan');
const S = require('../src/services/sheetlessOrder.service');
const { optionTotalBalance } = require('../src/services/campaignState.service');

// 커밋 뒤 날짜 맞추기는 실제 DB 를 여므로 기록만 하는 가짜로 바꾼다.
const cpSvc = require('../src/services/campaignPlan.service');
cpSvc.relayCampaignWorktable = async () => ({ ok: true, moved: 0 });

const PLAN_HEADERS = ['번호', '구매일자', '상품', '옵션', '리뷰옵션', '수취인', '연락처', '주소', '결제금액', '주문번호', '송장번호', '비고', '리뷰', '입금일'];

function makeHidePool({ row, edits = [], editsThrow = false, tabRows }) {
  const log = [];
  const answer = (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    log.push({ sql: q, params });
    if (q.includes('SELECT id, seq, phone8, row_json, order_submission_id')) return { rows: [row] };
    if (q.includes('COALESCE(sheetless,FALSE) AS sheetless')) return { rows: [{ sheetless: true }] };
    if (q.includes('SELECT rc.id AS campaign_id')) return { rows: [{ campaign_id: 'camp-1', is_open: true, is_linked: false }] };
    if (q.includes('SELECT seq, tab_gid, row_json')) return { rows: tabRows };
    if (q.includes('FROM participant_edits') && q.includes('UNNEST')) {
      if (editsThrow) throw new Error('boom');
      return { rows: edits };
    }
    if (q.includes('DELETE FROM campaign_participants')) return { rowCount: 1, rows: [] };
    if (q.includes('INSERT INTO campaign_participants')) return { rowCount: 1, rows: [{ id: 'row-new', seq: 99 }] };
    return { rowCount: 0, rows: [] };
  };
  const client = { query: async (sql, params) => answer(sql, params), release() {} };
  return { log, pool: { query: async (sql, params) => answer(sql, params), connect: async () => client } };
}
const insertOf = log => log.find(l => l.sql.startsWith('INSERT INTO campaign_participants'));

(async () => {
  console.log('[1] 계획 칸 판정');
  ok('상품·옵션·리뷰옵션만(번호·날짜·주문 칸 제외)', JSON.stringify(planCellHeaders(PLAN_HEADERS)) === '["상품","옵션","리뷰옵션"]');
  const v2 = planCellHeaders(['번호', '구매일자', '상품', '1차옵션', '2차옵션', '리뷰옵션', '배송구분', '회수택배사', '회수상품명칭', '차수', '수취인', '옵션금액', '비고(옵션확인)', '결제금액']);
  ok('V2 단계형 옵션·배송구분·회수·차수 포함', ['상품', '1차옵션', '2차옵션', '리뷰옵션', '배송구분', '회수택배사', '회수상품명칭', '차수'].every(h => v2.includes(h)));
  ok('★ 옵션금액(결제금액 칸)·비고(옵션확인)(메모 칸)·결제금액은 잇지 않는다', !v2.includes('옵션금액') && !v2.includes('비고(옵션확인)') && !v2.includes('결제금액'));
  ok('빈 입력은 []', planCellHeaders([]).length === 0 && planCellHeaders(null).length === 0);

  console.log('[2] 보충 줄이 지운 줄의 계획을 잇는다');
  const svc = require('../src/services/trackB.service');
  svc.__setLedgerRebuildForTest(async () => {});
  const tabRows = [
    { seq: 32, tab_gid: '9', row_json: Object.fromEntries(PLAN_HEADERS.map(h => [h, ''])) },
    { seq: 33, tab_gid: '9', row_json: { ...Object.fromEntries(PLAN_HEADERS.map(h => [h, ''])), 구매일자: '10 / 13 (화)' } },
  ];
  const emptyRow = (over = {}) => ({
    id: 'row-32', seq: 32, phone8: '', recipient_name: '', option_text: '', source: 'worktable', identity_key: null,
    order_submission_id: null, row_json: { ...Object.fromEntries(PLAN_HEADERS.map(h => [h, ''])), 구매일자: '10 / 12 (월)' }, ...over,
  });
  {
    const row = emptyRow({ option_text: '3. 고등어살', row_json: { ...emptyRow().row_json, 상품: '3. 고등어살', 리뷰옵션: '포토', 결제금액: '2000', 수취인: '' } });
    const { pool, log } = makeHidePool({ row, tabRows });
    svc.__setPoolForTest(pool);
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-32', by: '망고', actorRole: 'staff' });
    const ins = insertOf(log);
    const rj = ins && JSON.parse(ins.params[4]);
    ok('삭제 성공 + 보충', out.ok === true && out.replenished === 1);
    ok('★ 보충 줄이 상품·리뷰옵션을 잇는다', rj && rj['상품'] === '3. 고등어살' && rj['리뷰옵션'] === '포토');
    ok('★ 배정 표식(option_text)을 잇는다', ins && ins.params[6] === '3. 고등어살' && /option_text/.test(ins.sql));
    ok('결제금액·수취인 같은 주문 칸은 잇지 않는다', rj && rj['결제금액'] === '' && rj['수취인'] === '');
  }
  {
    // 제주도아 실측 모양: 배정 표식은 비고, 담당자가 손으로 「옥돔」을 적어 둔 빈 줄
    const row = emptyRow();
    const edits = [{ anchor_type: 'manual', anchor_value: 'row-32', field: 'col:상품', value_text: '2. 참옥돔' },
      { anchor_type: 'manual', anchor_value: 'row-32', field: 'col:리뷰옵션', value_text: '텍스트' }];
    const { pool, log } = makeHidePool({ row, edits, tabRows });
    svc.__setPoolForTest(pool);
    await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-32', by: '망고', actorRole: 'staff' });
    const rj = JSON.parse(insertOf(log).params[4]);
    ok('★ 화면에 보이던 손 글씨(편집 오버레이)를 잇는다', rj['상품'] === '2. 참옥돔' && rj['리뷰옵션'] === '텍스트');
    ok('편집 조회는 SAVEPOINT 안에서', log.some(l => l.sql === 'SAVEPOINT slot_plan_inherit') && log.some(l => l.sql === 'RELEASE SAVEPOINT slot_plan_inherit'));
  }
  {
    // 채워진 줄: 주문 앵커 편집(담당자가 산 상품을 고쳐 둠)이 물리행 손 글씨보다 앞선다
    const row = emptyRow({ order_submission_id: '11111111-2222-3333-4444-555555555555', recipient_name: '홍*', option_text: 'A',
      row_json: { ...emptyRow().row_json, 상품: 'A', 수취인: '홍*' } });
    const edits = [
      { anchor_type: 'manual', anchor_value: 'row-32', field: 'col:상품', value_text: 'C' },
      { anchor_type: 'order', anchor_value: '11111111-2222-3333-4444-555555555555', field: 'col:상품', value_text: 'B' },
    ];
    const { pool, log } = makeHidePool({ row, edits, tabRows });
    svc.__setPoolForTest(pool);
    const cancelPath = require.resolve('../src/services/orderCancellation.service');
    require.cache[cancelPath] = { id: cancelPath, filename: cancelPath, loaded: true,
      exports: { cancelOrderSubmission: async (a) => { await a.beforeCancelCommit(await pool.connect()); return { ok: true, cleared: true }; } } };
    await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-32', by: '망고', actorRole: 'staff' });
    delete require.cache[cancelPath];
    const ins = insertOf(log);
    const rj = ins && JSON.parse(ins.params[4]);
    ok('★ 화면 합성과 같은 순서 — 현재(주문) 앵커 편집이 물리행 손 글씨보다 앞선다', rj && rj['상품'] === 'B');
    ok('그 주문의 수취인은 잇지 않는다', rj && rj['수취인'] === '');
  }
  {
    const row = emptyRow({ option_text: 'A', row_json: { ...emptyRow().row_json, 상품: 'A' } });
    const { pool, log } = makeHidePool({ row, editsThrow: true, tabRows });
    svc.__setPoolForTest(pool);
    const out = await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-32', by: '망고', actorRole: 'staff' });
    const rj = JSON.parse(insertOf(log).params[4]);
    ok('★ 편집 조회 실패 = 삭제는 성공 + 줄 값만 잇는다(SAVEPOINT 되돌림)', out.ok === true && rj['상품'] === 'A'
      && log.some(l => l.sql === 'ROLLBACK TO SAVEPOINT slot_plan_inherit'));
  }
  {
    process.env.WORKTABLE_SLOT_PLAN_INHERIT = '0';
    const row = emptyRow({ option_text: 'A', row_json: { ...emptyRow().row_json, 상품: 'A' } });
    const { pool, log } = makeHidePool({ row, tabRows });
    svc.__setPoolForTest(pool);
    await svc.hideWorkdeskRow({ sheetId: 's1', tabName: 't1', rowId: 'row-32', by: '망고', actorRole: 'staff' });
    delete process.env.WORKTABLE_SLOT_PLAN_INHERIT;
    const ins = insertOf(log);
    ok('끄는 스위치 = 종전(전부 빈 줄 · 표식 없음)', JSON.parse(ins.params[4])['상품'] === '' && ins.params[6] === null
      && !log.some(l => l.sql.includes('FROM participant_edits')));
  }

  console.log('[3] 줄 고르기가 손 글씨 상품을 본다');
  const HEADERS = ['번호', '구매일자', '상품', '리뷰옵션', '수취인', '연락처'];
  const row = (id, seq, ot, prod = ot, rv = '') => ({ id, seq, option_text: ot, row_json: { 구매일자: '', 상품: prod, 리뷰옵션: rv } });
  function stubClient({ cands = [], overlays = [], overlayThrow = false } = {}) {
    const locked = new Set();
    const seen = [];
    return {
      seen,
      async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, ' ');
        seen.push(q.trim());
        if (/WHERE cp\.id = \$1/.test(q) && /FOR UPDATE SKIP LOCKED/.test(q)) {
          const r = cands.find(x => x.id === params[0]);
          if (!r || locked.has(r.id)) return { rows: [] };
          locked.add(r.id); return { rows: [r] };
        }
        if (/FROM participant_edits/.test(q) && /DISTINCT ON \(anchor_value\)/.test(q)) {
          if (overlayThrow) throw new Error('boom');
          return { rows: overlays.filter(o => params[3].includes(o.anchor_value)) };
        }
        if (/SELECT DISTINCT btrim\(option_text\) AS l/.test(q)) {
          return { rows: [...new Set(cands.map(c => c.option_text).filter(Boolean))].map(l => ({ l })) };
        }
        if (/LIMIT 500/.test(q)) return { rows: [] };
        if (/ORDER BY cp\.seq LIMIT 3000/.test(q)) return { rows: cands };
        return { rows: [] };
      },
    };
  }
  const pick = (client, productPick, key = '') => S.__pickOpenSlotForTest(client, {
    sheetId: 'S', tabName: 'T', workboardId: null, scheduledOptionKey: key,
    orderSubmissionId: '00000000-0000-0000-0000-000000000001', headers: HEADERS, where: 'WHERE 1=1', productPick,
  });
  // 제주도아 모양: 고등어 줄(표식 있음) + 표식 없는 빈 줄들, 그중 하나에 손 글씨 「2. 참옥돔」
  const jeju = () => [row('g1', 21, '3. 고등어살'), row('b36', 36, ''), row('b37', 37, ''), row('b41', 41, '')];
  {
    const c = stubClient({ cands: jeju(), overlays: [{ anchor_value: 'b37', value_text: '2. 참옥돔' }] });
    const r = await pick(c, '2. 참옥돔');
    ok('★ 옥돔 주문은 손 글씨가 「옥돔」인 빈 줄로(번호가 뒤여도)', r.rows[0] && r.rows[0].id === 'b37' && r.productKey === '2. 참옥돔');
    ok('그 줄의 손 글씨를 돌려준다(쓰기 단계 대조용)', r.rowOverlay === '2. 참옥돔');
    ok('손 글씨 조회는 SAVEPOINT 안에서', c.seen.includes('SAVEPOINT slot_pick_overlay') && c.seen.includes('RELEASE SAVEPOINT slot_pick_overlay'));
  }
  {
    const c = stubClient({ cands: [row('b36', 36, ''), row('b37', 37, '')], overlays: [{ anchor_value: 'b36', value_text: '2. 참옥돔' }] });
    const r = await pick(c, '3. 고등어살');
    ok('★ 고등어 주문은 손 글씨 「옥돔」 줄을 피해 진짜 빈 줄로', r.rows[0] && r.rows[0].id === 'b37' && r.rowOverlay === '');
  }
  {
    // 고등어 줄은 동났고(리뷰옵션 포토), 남은 것은 오늘 날짜 손 글씨 「옥돔」 줄과 내일 날짜 계획 없는 빈 줄 — 둘 다 리뷰옵션 없음
    const g = { id: 'g9', seq: 9, option_text: '3. 고등어살', row_json: { 구매일자: '', 상품: '3. 고등어살', 리뷰옵션: '포토' } };
    const today = require('../src/services/campaignState.service').kstTodayStr();
    const [y, m, d] = today.split('-').map(Number);
    const lab = dd => `${dd.getUTCMonth() + 1} / ${dd.getUTCDate()} (${'일월화수목금토'[dd.getUTCDay()]})`;
    const t0 = new Date(Date.UTC(y, m - 1, d)); const t1 = new Date(Date.UTC(y, m - 1, d + 1));
    const cands = [{ id: 'b1', seq: 4, option_text: '', row_json: { 구매일자: lab(t0), 상품: '', 리뷰옵션: '' } },
      { id: 'b3', seq: 6, option_text: '', row_json: { 구매일자: lab(t1), 상품: '', 리뷰옵션: '' } }];
    const c = stubClient({ cands, overlays: [{ anchor_value: 'b1', value_text: '2. 참옥돔' }] });
    const q0 = c.query.bind(c);
    c.query = async (sql, params) => {
      const q = String(sql);
      if (/LIMIT 500/.test(q)) return { rows: [g] };
      if (/SELECT DISTINCT btrim\(option_text\) AS l/.test(q)) return { rows: [{ l: '1. 은갈치' }, { l: '3. 고등어살' }] };
      return q0(sql, params);
    };
    const r = await pick(c, '3. 고등어살');
    ok('★ 리뷰옵션이 달라도 계획 없는 빈 줄을 다른 상품 자리(손 글씨)보다 먼저 — 날짜가 늦어도', r.rows[0] && r.rows[0].id === 'b3' && r.productKey === '3. 고등어살');
  }
  {
    const c = stubClient({ cands: [row('b36', 36, '')], overlays: [{ anchor_value: 'b36', value_text: '2. 참옥돔' }] });
    const r = await pick(c, '3. 고등어살');
    ok('다른 줄이 없으면 손 글씨 줄이라도 쓰고(정원 밖으로 밀지 않음) 그 손 글씨를 알린다', r.rows[0] && r.rows[0].id === 'b36' && r.rowOverlay === '2. 참옥돔');
  }
  {
    const c = stubClient({ cands: [row('e1', 11, '1. 은갈치'), ...jeju()], overlayThrow: true });
    const r = await pick(c, '3. 고등어살');
    ok('★ 손 글씨 조회 실패 = 종전 판정(표식만) + SAVEPOINT 되돌림', r.rows[0] && r.rows[0].id === 'g1' && c.seen.includes('ROLLBACK TO SAVEPOINT slot_pick_overlay'));
  }
  {
    const c = stubClient({ cands: jeju(), overlays: [{ anchor_value: 'b37', value_text: '2. 참옥돔' }] });
    await pick(c, '2. 참옥돔', '옵션키');
    ok('옵션 키가 있는 선택은 손 글씨를 조회하지 않는다(무접촉)', !c.seen.some(q => /FROM participant_edits/.test(q)));
    const c2 = stubClient({ cands: jeju() });
    await pick(c2, '');
    ok('상품을 고르지 않은 주문도 조회하지 않는다(종전)', !c2.seen.some(q => /FROM participant_edits/.test(q)));
  }
  {
    process.env.WORKTABLE_SLOT_OVERLAY_PLAN = '0';
    const c = stubClient({ cands: jeju(), overlays: [{ anchor_value: 'b37', value_text: '2. 참옥돔' }] });
    await pick(c, '2. 참옥돔');
    delete process.env.WORKTABLE_SLOT_OVERLAY_PLAN;
    ok('끄는 스위치 = 손 글씨를 보지 않는다', !c.seen.some(q => /FROM participant_edits/.test(q)));
  }

  console.log('[4] 손 글씨 내림 배선');
  const sl = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sheetlessOrder.service.js'), 'utf8');
  const blk = sl.slice(sl.indexOf('결정 227 — 처음 채운 빈 줄에'), sl.indexOf('결정 227 — 처음 채운 빈 줄에') + 2200);
  ok('★ 상품 단위로 짝지어 처음 채운 줄만', /if \(productOverwrite && claimedRowOverlay && cur\[0\] && cur\[0\]\.id\)/.test(blk));
  ok('★ 지우지 않고 취소 표시만(기록 보존)', /UPDATE participant_edits SET reverted_at = NOW\(\), reverted_by = 'system:order-fill'/.test(blk) && !/DELETE FROM participant_edits/.test(blk));
  ok('그 줄의 물리행 앵커 상품 칸만', /anchor_type = 'manual' AND anchor_value = \$3[\s\S]{0,80}field = \$4/.test(blk) && /'col:' \+ PRODUCT_HEADER/.test(blk));
  ok('같은 상품(표기만 다름)이면 그대로 둔다', /sameProduct/.test(blk) && /if \(!sameProduct\)/.test(blk));
  ok('SAVEPOINT 격리(주문 기록을 실패시키지 않는다)', /SAVEPOINT slot_overlay_retire/.test(blk) && /ROLLBACK TO SAVEPOINT slot_overlay_retire/.test(blk));

  console.log('[5] 총원 ↔ 상품별 남은 자리');
  const usage = (cap, used, known = true) => ({ cap, used, known });
  const view = (optKey, recruitTotal, used, status = 'soldout') => ({ optKey, recruitTotal, used, status });
  // 위드프렌즈 50건 10/12 시작 시점 실측: 총 50 · 사용 41 / 1번 6/5 · 2~4번 5/5 · HD2200 20/30
  const wf = [view('1번', 5, 6), view('2번', 5, 5), view('3번', 5, 5), view('4번', 5, 5), view('HD2200', 30, 20, 'open')];
  const b = optionTotalBalance(usage(50, 41), wf);
  ok('★ 실측: 상품별 10 · 총원 9 → gap 1 · 1번 1명 초과', b && b.optionRemaining === 10 && b.totalRemaining === 9 && b.gap === 1
    && b.over.length === 1 && b.over[0].optKey === '1번' && b.over[0].overBy === 1);
  ok('어긋남 없음 = null', optionTotalBalance(usage(50, 40), [view('1번', 5, 5), view('2번', 45, 35, 'open')]) === null);
  const neg = optionTotalBalance(usage(30, 10), [view('은갈치', 10, 10), view('옥돔', 5, 0, 'closed'), view('고등어', 15, 0, 'open')]);
  ok('★ 닫은 상품 때문에 총원을 못 채움 = gap 음수', neg && neg.gap === -5 && neg.optionRemaining === 15 && neg.totalRemaining === 20);
  ok('모르면 말하지 않는다 — 총량 사용량 모름', optionTotalBalance(usage(50, 41, false), wf) === null);
  ok('모르면 말하지 않는다 — 총원 0·선택지 없음', optionTotalBalance(usage(0, 0), wf) === null && optionTotalBalance(usage(50, 41), []) === null);
  ok('모르면 말하지 않는다 — 정원 무제한 선택지', optionTotalBalance(usage(50, 41), [view('A', 0, 3, 'open'), view('B', 10, 2, 'open')]) === null);
  ok('입력 없음 = null(throw 없음)', optionTotalBalance(null, null) === null);

  console.log('[6] 관리자 화면 안내 · 배선');
  const fe = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-recruit.js'), 'utf8');
  const fnSrc = fe.slice(fe.indexOf('function _campQuotaBalanceNote'), fe.indexOf('function _campOptionTable'));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc + '\nthis.f=_campQuotaBalanceNote;', ctx);
  ok('값 없음(구버전 서버·어긋남 없음) = 빈 문자열', ctx.f(null) === '' && ctx.f(undefined) === '' && ctx.f({ gap: 0, over: [] }) === '');
  const html = ctx.f(b);
  ok('★ gap>0: 남은 자리 두 숫자 + 넘친 상품 + 할 일', /10자리/.test(html) && /9자리/.test(html) && /1번<\/b> 6\/5명\(정원보다 1명 많음\)/.test(html) && /총원을 늘릴지/.test(html));
  ok('gap<0: 총원을 못 채운다는 문장', /총원을 5자리 못 채웁니다/.test(ctx.f(neg)));
  ok('상품 이름은 이스케이프', !/<x>/.test(ctx.f({ gap: 1, optionRemaining: 1, totalRemaining: 0, over: [{ optKey: '<x>', used: 2, recruitTotal: 1, overBy: 1 }] })));
  ok('옵션별 현황 표 바로 위에 붙는다', /_campQuotaBalanceNote\(j\.quotaBalance\) \+ _campOptionTable\(/.test(fe));
  const rt = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'latin1');
  ok('관제 응답이 quotaBalance 를 싣는다(판정은 서버 단일 출처)', /quotaBalance = optionTotalBalance\(totalQuotaUsage\(camps\[0\], _cnt \|\| \{\}, _sch\), options\)/.test(rt)
    && /quotaBalance, options, sheetInfo \}\)/.test(rt));
  ok('대조 실패는 무표시(관제 응답을 깨지 않는다)', /catch \(balErr\)/.test(rt));

  console.log(`\n${failed ? '❌' : '✅'} slotPlanInherit: ${n - failed}/${n}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
