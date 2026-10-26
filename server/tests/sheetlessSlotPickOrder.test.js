/**
 * sheetlessSlotPickOrder.test.js — 구매 한 건이 쓸 빈 줄 고르기 (결정 182 · 2026-09-26 2단계).
 *
 * 사고: 빈 줄을 번호(seq) 순으로 골라 오늘 산 사람이 앞날 줄을 먹고 그 줄 날짜를 오늘로 바꿔 써서,
 *   날짜별 줄 수가 주문마다 틀어졌다. 옵션 A 줄이 동나면 정원 밖 줄을 새로 붙이고 옵션 B 빈 줄은
 *   영영 남았다.
 * 고정:
 *   [1] 옵션 일치 → 오늘 날짜 → 날짜 없음·지난 날 → 앞날(가까운 날부터) → 번호
 *   [2] 옵션이 맞는 줄이 앞날에 있으면 옵션 칸이 빈 오늘 줄보다 먼저(옵션이 날짜보다 우선)
 *   [3] 맞는 줄이 없으면 그 공고의 **다른 옵션** 이름이 적힌 빈 줄을 쓴다 — 마감 옵션 줄부터
 *   [4] 옵션을 고르지 않은 구매·킬스위치·옵션 조회 실패 = 바꿔 쓰지 않는다
 *   [5] 실제 기록: 옛 옵션 이름 칸만 새 옵션으로 · 작업지시(포토리뷰) 칸은 그대로 · option_text 갱신
 * 실행: node tests/sheetlessSlotPickOrder.test.js
 */
const assert = require('assert');
const S = require('../src/services/sheetlessOrder.service');
const { kstTodayStr, addIsoDays } = require('../src/services/campaignState.service');

let failed = 0, n = 0;
const ok = (msg, cond) => { n++; if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const label = iso => { const [y, m, d] = iso.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return `${m} / ${d} (${DOW[w]})`; };
const T = kstTodayStr();
const HEADERS = ['번호', '구매일자', '리뷰옵션', '옵션', '수취인', '연락처'];
const row = (id, seq, date, opt = '', extra = {}) => ({
  id, seq, option_text: opt, row_json: Object.assign({ 구매일자: date ? label(date) : '', 옵션: opt, 리뷰옵션: '' }, extra),
});

function stubClient({ cands = [], others = [], opts = [], optsFail = false } = {}) {
  const seen = [];
  const locked = new Set();
  return {
    seen,
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ');
      seen.push({ q, params });
      if (/JOIN campaign_options co/.test(q)) { if (optsFail) throw new Error('boom'); return { rows: opts }; }
      if (/WHERE cp\.id = \$1/.test(q) && /FOR UPDATE SKIP LOCKED/.test(q)) {
        const all = [...cands, ...others];
        const r = all.find(x => x.id === params[0]);
        if (!r || locked.has(r.id)) return { rows: [] };
        locked.add(r.id);
        return { rows: [r] };
      }
      if (/ANY\(\$4::text\[\]\)/.test(q)) return { rows: others.filter(x => params[3].includes(String(x.option_text).trim())) };
      if (/ORDER BY cp\.seq LIMIT 3000/.test(q)) return { rows: cands };
      return { rows: [] };
    },
  };
}
const pick = (client, key = '') => S.__pickOpenSlotForTest(client, {
  sheetId: 'S', tabName: 'T', workboardId: null, scheduledOptionKey: key,
  orderSubmissionId: '00000000-0000-0000-0000-000000000001', headers: HEADERS, where: 'WHERE 1=1',
});

(async () => {
  console.log('[1] 날짜 순서');
  {
    const c = stubClient({ cands: [
      row('fut2', 1, addIsoDays(T, 2)), row('fut1', 2, addIsoDays(T, 1)),
      row('today', 3, T), row('past', 4, addIsoDays(T, -3)), row('none', 5, ''),
    ] });
    const r = await pick(c);
    ok('오늘 날짜 줄을 먼저 고른다(번호가 뒤여도)', r.rows[0] && r.rows[0].id === 'today' && r.relabelFrom === '');
  }
  {
    const c = stubClient({ cands: [row('fut1', 1, addIsoDays(T, 1)), row('none', 9, ''), row('past', 7, addIsoDays(T, -2))] });
    const r = await pick(c);
    ok('오늘 줄이 없으면 날짜 없음·지난 줄(번호 순)이 앞날 줄보다 먼저', r.rows[0].id === 'past');
  }
  {
    const c = stubClient({ cands: [row('fut3', 1, addIsoDays(T, 3)), row('fut1', 2, addIsoDays(T, 1))] });
    const r = await pick(c);
    ok('앞날 줄끼리는 가까운 날부터', r.rows[0].id === 'fut1');
  }
  {
    // 앞 후보가 이미 잠겨 있으면 다음 후보
    const c = stubClient({ cands: [row('today', 1, T), row('fut1', 2, addIsoDays(T, 1))] });
    await c.query('SELECT cp.id FROM campaign_participants cp WHERE cp.id = $1 FOR UPDATE SKIP LOCKED', ['today']);
    const r = await pick(c);
    ok('앞 후보가 잠겨 있으면 다음 후보를 잠근다', r.rows[0].id === 'fut1');
  }

  console.log('[2] 옵션이 날짜보다 우선');
  {
    const c = stubClient({ cands: [row('emptyToday', 1, T, ''), row('aFuture', 2, addIsoDays(T, 2), 'A')] });
    const r = await pick(c, 'A');
    ok('옵션 A 가 적힌 앞날 줄 > 옵션 칸이 빈 오늘 줄', r.rows[0].id === 'aFuture');
  }

  console.log('[3] 옵션 이름 바꿔 쓰기');
  const OPTS = [{ opt_key: 'A', status: 'active' }, { opt_key: 'B', status: 'active' }, { opt_key: 'C', status: 'closed' }];
  {
    const c = stubClient({ cands: [], opts: OPTS, others: [row('b1', 1, T, 'B'), row('c1', 5, addIsoDays(T, 1), 'C')] });
    const r = await pick(c, 'A');
    ok('마감된 옵션(C) 줄부터 쓴다(날짜보다 우선)', r.rows[0] && r.rows[0].id === 'c1' && r.relabelFrom === 'C');
    const q = c.seen.find(x => /ANY\(\$4::text\[\]\)/.test(x.q));
    ok('후보는 그 공고의 다른 옵션 이름만(A 자신 제외)', q && q.params[3].sort().join(',') === 'B,C');
  }
  {
    const c = stubClient({ cands: [], opts: OPTS, others: [row('b1', 3, addIsoDays(T, 1), 'B'), row('b0', 4, T, 'B')] });
    const r = await pick(c, 'A');
    ok('같은 등급이면 오늘 날짜 줄부터', r.rows[0].id === 'b0' && r.relabelFrom === 'B');
  }
  {
    const c = stubClient({ cands: [], opts: [{ opt_key: '엉뚱', status: 'active', unit_kind: 'product' }].filter(() => false), others: [row('x', 1, T, '모르는값')] });
    const r = await pick(c, 'A');
    ok('그 공고 옵션 목록이 비면 바꿔 쓰지 않는다(모르는 이름은 건드리지 않음)', r.rows.length === 0 && r.relabelFrom === '');
  }

  console.log('[4] 바꿔 쓰지 않는 경우');
  {
    const c = stubClient({ cands: [], opts: OPTS, others: [row('b1', 1, T, 'B')] });
    const r = await pick(c, '');
    ok('옵션을 고르지 않은 구매는 바꿔 쓰지 않는다', r.rows.length === 0 && !c.seen.some(x => /campaign_options co/.test(x.q)));
  }
  {
    process.env.WORKTABLE_OPTION_RELABEL = '0';
    const c = stubClient({ cands: [], opts: OPTS, others: [row('b1', 1, T, 'B')] });
    const r = await pick(c, 'A');
    delete process.env.WORKTABLE_OPTION_RELABEL;
    ok('킬스위치 WORKTABLE_OPTION_RELABEL=0 = 종전 동작', r.rows.length === 0);
  }
  {
    const c = stubClient({ cands: [], optsFail: true, others: [row('b1', 1, T, 'B')] });
    const r = await pick(c, 'A');
    ok('옵션 조회 실패 = 바꿔 쓰지 않는다(모르면 건드리지 않음)', r.rows.length === 0);
  }

  console.log('[5] 실제 기록 — 옛 옵션 칸만 바꾸고 작업지시는 보존');
  {
    const ledgerSvc = require('../src/services/orderLedger.service');
    const rowNumbering = require('../src/services/rowNumbering.service');
    const sheetlessLedger = require('../src/services/sheetlessLedger.service');
    const participation = require('../src/services/participation.service');
    const saved = { l: ledgerSvc.loadRawTabContext, w: ledgerSvc.markOrderWritten, i: ledgerSvc.recordReviewIdentity,
      r: rowNumbering.renumberTabInTx, b: sheetlessLedger.rebuildLedgers, p: participation.recordParticipationLink };
    const slot = row('b1', 7, addIsoDays(T, 2), 'B', { 리뷰옵션: '포토리뷰' });
    let update = null;
    const client = {
      async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, ' ').trim();
        if (/^BEGIN|^COMMIT|^ROLLBACK|pg_advisory_xact_lock/.test(q)) return { rows: [] };
        if (/JOIN campaign_options co/.test(q)) return { rows: OPTS };
        if (/ANY\(\$4::text\[\]\)/.test(q)) return { rows: [slot] };
        if (/WHERE cp\.id = \$1/.test(q) && /SKIP LOCKED/.test(q)) return { rows: [slot] };
        if (/^UPDATE campaign_participants SET row_json/.test(q)) { update = params; return { rows: [], rowCount: 1 }; }
        if (/SELECT id FROM campaign_participants/.test(q)) return { rows: [{ id: 'b1' }] };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    S.__setPoolForTest({ connect: async () => client, query: async () => ({ rows: [{}] }) });
    ledgerSvc.loadRawTabContext = async () => ({ headers: HEADERS, tabGid: '1' });
    ledgerSvc.markOrderWritten = async () => {}; ledgerSvc.recordReviewIdentity = async () => {};
    rowNumbering.renumberTabInTx = async () => {}; sheetlessLedger.rebuildLedgers = async () => ({ ok: true });
    participation.recordParticipationLink = async () => {};
    try {
      const out = await S.writeOrderToWorktable({ sheetId: 'S', tabName: 'T', orderSubmissionId: '00000000-0000-0000-0000-000000000001',
        orderData: { selectedOptKey: 'A', orderer: '구매자', recipient: '수취인', phone: '010-1234-5678', orderNum: '', dateStr: label(T) } });
      ok('기록 성공(정원 밖 줄을 새로 붙이지 않음)', out.ok === true && out.written === true && Number(out.seq) === 7);
      const rj = update ? JSON.parse(update[3]) : {};
      ok('옵션 칸이 옛 이름(B)에서 새 옵션(A)으로', rj.옵션 === 'A');
      ok('작업지시 칸(리뷰옵션=포토리뷰)은 그대로', rj.리뷰옵션 === '포토리뷰');
      ok('줄의 옵션 표시값(option_text)도 A', update && update[7] === 'A');
    } finally {
      S.__setPoolForTest(null);
      Object.assign(ledgerSvc, { loadRawTabContext: saved.l, markOrderWritten: saved.w, recordReviewIdentity: saved.i });
      rowNumbering.renumberTabInTx = saved.r; sheetlessLedger.rebuildLedgers = saved.b; participation.recordParticipationLink = saved.p;
    }
  }

  /* [6] v2 작업표(상품 1개 + 옵션 여러 개) — 빈 줄 표식 「상품 · 옵션」 ↔ 주문 옵션 키 「옵션」
     (2026-10-26 로컬 전과정 실테스트: 빈 줄 10개를 두고 주문 5건이 전부 정원 밖 새 줄로 붙었다) */
  console.log('[6] v2 「상품 · 옵션」 빈 줄');
  function stagedClient({ staged = [], product = [], stagedFail = false } = {}) {
    const seen = []; const locked = new Set();
    return {
      seen,
      async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, ' ');
        seen.push({ q, params });
        if (/SAVEPOINT/.test(q)) return { rows: [] };
        if (/SELECT co\.product_name/.test(q)) return { rows: product };
        if (/JOIN campaign_options co/.test(q)) return { rows: [] };   // 옵션 이름 바꿔 쓰기 후보 없음
        if (/LIKE '% · %'/.test(q)) { if (stagedFail) throw new Error('boom'); return { rows: staged }; }
        if (/WHERE cp\.id = \$1/.test(q) && /FOR UPDATE SKIP LOCKED/.test(q)) {
          const r = staged.find(x => x.id === params[0]);
          if (!r || locked.has(r.id)) return { rows: [] };
          locked.add(r.id); return { rows: [r] };
        }
        return { rows: [] };   // 첫 후보(옵션 키 일치·빈 표식) 없음
      },
    };
  }
  const P = '에코 미니 가습기 300ml';
  const V2 = [row('w1', 2, '', `${P} · 화이트`), row('k1', 3, '', `${P} · 블랙`), row('w2', 4, T, `${P} · 화이트`), row('k2', 5, '', `${P} · 블랙`)];
  {
    const c = stagedClient({ staged: V2, product: [{ product_name: P }] });
    const r = await pick(c, '화이트');
    ok('같은 상품·같은 옵션의 빈 줄을 고른다(오늘 날짜 줄 먼저)', r.rows[0] && r.rows[0].id === 'w2' && r.stagedFrom === `${P} · 화이트`);
    ok('옵션 이름 바꿔 쓰기로 처리하지 않는다', r.relabelFrom === '');
  }
  {
    const c = stagedClient({ staged: V2, product: [{ product_name: '에코 미니 가습기' }] });
    const r = await pick(c, '블랙');
    ok('공고에서 상품 표기만 고쳤어도(작업표 상품이 하나뿐) 옵션으로 짝짓는다', r.rows[0] && r.rows[0].id === 'k1');
  }
  {
    const two = [row('a', 2, '', '가습기 · 화이트'), row('b', 3, '', '필터 · 화이트')];
    const r1 = await pick(stagedClient({ staged: two, product: [{ product_name: '필터' }] }), '화이트');
    ok('상품이 여럿이면 그 주문의 상품 줄만', r1.rows[0] && r1.rows[0].id === 'b');
    const r2 = await pick(stagedClient({ staged: two, product: [{ product_name: '모르는 상품' }] }), '화이트');
    ok('상품이 여럿인데 상품을 못 짝지으면 쓰지 않는다(엉뚱한 상품 줄 금지)', r2.rows.length === 0);
  }
  {
    const r = await pick(stagedClient({ staged: [row('x', 2, '', `${P} · 화이트 · 대형`), row('y', 3, '', `${P} · 화이트 · 소형`)], product: [{ product_name: P }] }), '화이트 + 소형');
    ok('2단 옵션(「1차 + 2차」)도 같은 선택만', r.rows[0] && r.rows[0].id === 'y');
  }
  {
    const r = await pick(stagedClient({ staged: V2, product: [{ product_name: P }] }), '레드');
    ok('없는 옵션은 고르지 않는다', r.rows.length === 0);
  }
  {
    process.env.WORKTABLE_STAGED_OPTION_MATCH = '0';
    const c = stagedClient({ staged: V2, product: [{ product_name: P }] });
    const r = await pick(c, '화이트');
    delete process.env.WORKTABLE_STAGED_OPTION_MATCH;
    ok('킬스위치 WORKTABLE_STAGED_OPTION_MATCH=0 = 종전 동작(조회도 안 함)', r.rows.length === 0 && !c.seen.some(x => /LIKE '% · %'/.test(x.q)));
  }
  {
    const c = stagedClient({ staged: V2, stagedFail: true });
    const r = await pick(c, '화이트');
    ok('조회 실패 = 종전 동작(SAVEPOINT 로 되돌리고 계속)', r.rows.length === 0 && c.seen.some(x => /ROLLBACK TO SAVEPOINT slot_pick_staged/.test(x.q)));
  }
  {
    const r = await pick(stagedClient({ staged: V2, product: [{ product_name: P }] }), '');
    ok('옵션을 고르지 않은 구매는 이 갈래를 타지 않는다', r.rows.length === 0);
  }

  console.log('[7] 실제 기록 — 「상품 · 옵션」 빈 줄을 채우고 정원 밖 줄을 만들지 않는다');
  {
    const ledgerSvc = require('../src/services/orderLedger.service');
    const rowNumbering = require('../src/services/rowNumbering.service');
    const sheetlessLedger = require('../src/services/sheetlessLedger.service');
    const participation = require('../src/services/participation.service');
    const saved = { l: ledgerSvc.loadRawTabContext, w: ledgerSvc.markOrderWritten, i: ledgerSvc.recordReviewIdentity,
      r: rowNumbering.renumberTabInTx, b: sheetlessLedger.rebuildLedgers, p: participation.recordParticipationLink };
    const H2 = ['번호', '구매일자', '상품', '1차옵션', '리뷰옵션', '수취인', '연락처'];
    const slot = { id: 'w9', seq: 9, option_text: `${P} · 화이트`, row_json: { 구매일자: label(T), 상품: P, '1차옵션': '화이트', 리뷰옵션: '포토' } };
    let update = null; let appended = false;
    const client = {
      async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, ' ').trim();
        if (/^BEGIN|^COMMIT|^ROLLBACK|^SAVEPOINT|^RELEASE|pg_advisory_xact_lock/.test(q)) return { rows: [] };
        if (/SELECT co\.product_name/.test(q)) return { rows: [{ product_name: P }] };
        if (/JOIN campaign_options co/.test(q)) return { rows: [] };
        if (/LIKE '% · %'/.test(q)) return { rows: [slot] };
        if (/WHERE cp\.id = \$1/.test(q) && /SKIP LOCKED/.test(q)) return { rows: [slot] };
        if (/^INSERT INTO campaign_participants/.test(q)) { appended = true; return { rows: [{ seq: 99 }], rowCount: 1 }; }
        if (/^UPDATE campaign_participants SET row_json/.test(q)) { update = params; return { rows: [], rowCount: 1 }; }
        if (/SELECT id FROM campaign_participants/.test(q)) return { rows: [{ id: 'w9' }] };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    S.__setPoolForTest({ connect: async () => client, query: async () => ({ rows: [{}] }) });
    ledgerSvc.loadRawTabContext = async () => ({ headers: H2, tabGid: '1' });
    ledgerSvc.markOrderWritten = async () => {}; ledgerSvc.recordReviewIdentity = async () => {};
    rowNumbering.renumberTabInTx = async () => {}; sheetlessLedger.rebuildLedgers = async () => ({ ok: true });
    participation.recordParticipationLink = async () => {};
    try {
      const out = await S.writeOrderToWorktable({ sheetId: 'S', tabName: 'T', orderSubmissionId: '00000000-0000-0000-0000-000000000001',
        orderData: { selectedOptKey: '화이트', selectedProduct: P, orderer: '구매자', recipient: '수취인', phone: '010-1234-5678', orderNum: '', dateStr: label(T) } });
      ok('기록 성공 — 그 빈 줄(9번)을 채운다', out.ok === true && out.written === true && Number(out.seq) === 9);
      ok('정원 밖 줄을 새로 붙이지 않는다', !appended);
      const rj = update ? JSON.parse(update[3]) : {};
      ok('작업지시 칸(리뷰옵션=포토)은 그대로', rj.리뷰옵션 === '포토');
      ok('채운 줄의 표식은 주문 옵션 키(지금의 정원 밖 줄과 같은 값 — 표식을 읽는 곳의 의미 불변)', update && update[7] === '화이트');
    } finally {
      S.__setPoolForTest(null);
      Object.assign(ledgerSvc, { loadRawTabContext: saved.l, markOrderWritten: saved.w, recordReviewIdentity: saved.i });
      rowNumbering.renumberTabInTx = saved.r; sheetlessLedger.rebuildLedgers = saved.b; participation.recordParticipationLink = saved.p;
    }
  }

  console.log(failed ? `sheetlessSlotPickOrder: FAILED (${failed}/${n})` : `sheetlessSlotPickOrder: passed (${n})`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ 실행 실패: ' + (e && e.stack)); process.exit(1); });
