/**
 * workdeskPurchaseDate.test.js — 구매일자 달력 편집 + 리뷰제출일 백필 회귀가드 (2026-08-21)
 *
 * 배경: 무시트 탭의 그리드 셀 편집은 오버레이(표시 전용)라 구매일자를 고쳐도 재번호·장부가
 * 인식하지 못했다. 달력 편집은 row_json(+주문 원장 date_str)까지 진짜로 쓴다.
 *
 * 고정하는 것:
 *   A. setWorkdeskPurchaseDate — 주문 연결 줄은 **원장 먼저 + writeOrderToWorktable 한 벌**(사본 0)
 *   B. 주문 없는 줄은 markSheetlessPurchaseDate + 재번호(fail-soft)
 *   C. fail-closed — 잘못된 날짜·시트 기반 탭 = 쓰기 0건
 *   D. backfillWorkdeskReviewSubmitDate — markStatusCell(submit) 한 벌 + 날짜 해석 게이트
 *   E. markSheetlessPurchaseDate — 칸 판정 = findDateColumnIndex · 표기 = sheetDateStr 단일 출처
 *   F. 프론트 배선 — 날짜 키워드 사본 ≡ 서버 · 달력 분기 · 무시트/시트 저장 경로 · onclick 숫자만
 *   G. 라우트 — purchase-date(셀 편집 스코프) · review-submit-date(adminOrMaster)
 *
 * 실행: node tests/workdeskPurchaseDate.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/trackB.service');
const st = require('../src/services/sheetlessStatus.service');
const so = require('../src/services/sheetlessOrder.service');
const rn = require('../src/services/rowNumbering.service');
const ledger = require('../src/services/sheetlessLedger.service');
const { DATE_HEADER_KEYWORDS } = require('../src/services/campaignSchedule.service');

function makePool(sc) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/COALESCE\(sheetless, FALSE\) AS s FROM tab_configs/.test(s)) return { rows: [{ s: sc.sheetless !== false }] };
      if (/SELECT id, seq, tab_gid, order_submission_id FROM campaign_participants/.test(s))
        return { rows: sc.noRow ? [] : [{ id: params[0], seq: 84, tab_gid: 'g1', order_submission_id: sc.orderId || null }] };
      if (/SELECT id, seq FROM campaign_participants/.test(s))
        return { rows: sc.noRow ? [] : [{ id: params[0], seq: 113 }] };
      if (/UPDATE order_submissions SET date_str/.test(s)) return { rowCount: 1, rows: [] };
      if (/SELECT \* FROM order_submissions/.test(s))
        return { rows: [{ id: sc.orderId, orderer: '박은비', recipient: '박은비', phone: '010-8221-7191', date_str: params && '7 / 27 (월)' }] };
      if (/COALESCE\(detected_headers, headers\) AS h FROM raw_sheet_tabs/.test(s))
        return { rows: [{ h: sc.headers || ['번호', '구매일자', '수취인', '연락처'] }] };
      if (/UPDATE campaign_participants SET row_json/.test(s)) return { rowCount: 1, rows: [] };
      if (/UPDATE campaign_participants SET is_submitted = TRUE/.test(s)) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

async function run() {
  const realWrite = so.writeOrderToWorktable;
  const realMarkDate = st.markSheetlessPurchaseDate;
  const realMarkStatus = st.markStatusCell;
  const realRenumber = rn.renumberTab;
  const realRebuild = ledger.rebuildLedgers;
  let writeCalls = [], renumCalls = [], markStatusCalls = [];
  so.writeOrderToWorktable = async (a) => { writeCalls.push(a); return { ok: true, written: true, seq: a.sheetRow }; };
  rn.renumberTab = async (a) => { renumCalls.push(a); return { ok: true }; };
  ledger.rebuildLedgers = async () => ({ ok: true });

  try {
    // ── A. 주문 연결 줄 = 원장 먼저 + writeOrderToWorktable 한 벌 ──
    let pool = makePool({ orderId: 'os-1' });
    svc.__setPoolForTest(pool); st.__setPoolForTest(pool);
    writeCalls = [];
    let r = await svc.setWorkdeskPurchaseDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '2026-07-27', by: 'm' });
    assert.equal(r.ok, true); assert.equal(r.via, 'order');
    const up = pool.q.find(x => /UPDATE order_submissions SET date_str/.test(x.s));
    assert.ok(up, '원장 date_str 를 먼저 고친다(안 고치면 다음 재기록이 옛 날짜를 도로 덮는다)');
    assert.equal(up.params[1], '7 / 27 (월)', '표기 = sheetDateStr(M / D (요일)) — 재번호 파서가 그대로 읽는다');
    assert.ok(/last_edit_seq = GREATEST/.test(up.s), 'last_edit_seq 단조증가(stale 편집 보호 — order-edit 와 동일)');
    assert.equal(writeCalls.length, 1, '실행부 = writeOrderToWorktable 한 벌(사본 0)');
    assert.equal(writeCalls[0].sheetRow, 84, '기존 연결 행을 지목(빈 슬롯을 새로 먹지 않는다)');
    console.log('  A. 주문 연결 줄(원장 우선·한 벌) 통과');

    // ── B. 주문 없는 줄 = markSheetlessPurchaseDate + 재번호 ──
    st.markSheetlessPurchaseDate = async (a) => ({ handled: true, ok: true, column: '구매일자', value: '7 / 29 (수)', _a: a });
    pool = makePool({ orderId: null });
    svc.__setPoolForTest(pool);
    writeCalls = []; renumCalls = [];
    r = await svc.setWorkdeskPurchaseDate({ sheetId: 'S', tabName: 'T', rowId: 'row-2', date: '2026-07-29', by: 'm' });
    assert.equal(r.ok, true); assert.equal(r.via, 'cell');
    assert.equal(writeCalls.length, 0, '주문 없는 줄은 주문 경로를 타지 않는다');
    assert.equal(renumCalls.length, 1, '기록 후 재번호(날짜 순 자리 이동)');
    st.markSheetlessPurchaseDate = realMarkDate;
    console.log('  B. 주문 없는 줄(칸 기록·재번호) 통과');

    // ── C. fail-closed — 잘못된 날짜·시트 기반 = 쓰기 0건 ──
    pool = makePool({}); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskPurchaseDate({ sheetId: 'S', tabName: 'T', rowId: 'r', date: '7/27', by: 'm' });
    assert.equal(r.ok, false); assert.equal(r.error, 'bad_date');
    assert.equal(pool.q.length, 0, '형식 밖 날짜 = 쿼리 0');
    pool = makePool({ sheetless: false }); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskPurchaseDate({ sheetId: 'S', tabName: 'T', rowId: 'r', date: '2026-07-27', by: 'm' });
    assert.equal(r.error, 'not_sheetless', '시트 기반 탭 거부(시트가 진실원본)');
    assert.ok(!pool.q.some(x => /UPDATE/.test(x.s)), '거부 시 쓰기 0건');
    console.log('  C. fail-closed 통과');

    // ── D. 리뷰제출일 백필 — markStatusCell(submit) 한 벌 + 날짜 해석 게이트 ──
    st.markStatusCell = async (a) => { markStatusCalls.push(a); return { handled: true, ok: true, column: '리뷰제출일' }; };
    pool = makePool({}); svc.__setPoolForTest(pool);
    markStatusCalls = [];
    r = await svc.backfillWorkdeskReviewSubmitDate({ sheetId: 'S', tabName: 'T', rowId: 'row-3', value: '8/1', by: 'm' });
    assert.equal(r.ok, true); assert.equal(r.seq, 113);
    assert.equal(markStatusCalls.length, 1, '기록 실행부 = markStatusCell 한 벌(리뷰어 제출과 같은 경로)');
    assert.equal(markStatusCalls[0].kind, 'submit');
    assert.equal(markStatusCalls[0].value, '8/1', '명시 날짜가 그대로 칸에 기록된다');
    assert.ok(pool.q.some(x => /UPDATE campaign_participants SET is_submitted = TRUE/.test(x.s)), '물리 토글 즉시 일치');
    assert.ok(!pool.q.some(x => /source\s*=/.test(x.s)), "source 는 건드리지 않는다('manual' 이면 투영이 얼린다)");
    markStatusCalls = [];
    r = await svc.backfillWorkdeskReviewSubmitDate({ sheetId: 'S', tabName: 'T', rowId: 'row-3', value: '완료', by: 'm' });
    assert.equal(r.ok, false); assert.equal(r.error, 'bad_date', '날짜로 안 읽히는 값 거부');
    assert.equal(markStatusCalls.length, 0, '거부 시 기록 0건');
    st.markStatusCell = realMarkStatus;
    console.log('  D. 리뷰제출일 백필 통과');

    // ── E. markSheetlessPurchaseDate 실행 — 칸 판정·표기 단일 출처 ──
    pool = makePool({ headers: ['번호', '담당자', '구매일자', '수취인'] });
    st.__setPoolForTest(pool);
    r = await st.markSheetlessPurchaseDate({ sheetId: 'S', tabName: 'T', rowIndex: 84, dateYmd: '2026-07-27', by: 'm' });
    assert.equal(r.ok, true); assert.equal(r.column, '구매일자', '칸 = findDateColumnIndex 판정');
    assert.equal(r.value, '7 / 27 (월)', '표기 = sheetDateStr');
    const w = pool.q.find(x => /UPDATE campaign_participants SET row_json/.test(x.s));
    assert.ok(w, 'row_json 에 쓴다(오버레이 아님 — 장부·재번호가 읽는 자리)');
    r = await st.markSheetlessPurchaseDate({ sheetId: 'S', tabName: 'T', rowIndex: 84, dateYmd: '2026-02-30', by: 'm' });
    assert.equal(r.ok, false, '실존하지 않는 날짜 거부');
    pool = makePool({ headers: ['번호', '수취인'] }); st.__setPoolForTest(pool);
    r = await st.markSheetlessPurchaseDate({ sheetId: 'S', tabName: 'T', rowIndex: 84, dateYmd: '2026-07-27', by: 'm' });
    assert.equal(r.reason, 'no_date_column', '날짜 칸 없는 표는 거부(조용히 아무 칸에나 쓰지 않는다)');
    console.log('  E. markSheetlessPurchaseDate 통과');

    // ── F. 프론트 배선 ──
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
    const kwm = /_WD_DATE_KEYWORDS = \[([^\]]*)\]/.exec(html);
    assert.ok(kwm, '클라 날짜 키워드 목록 존재');
    const clientKw = kwm[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepEqual(clientKw, DATE_HEADER_KEYWORDS, '클라 키워드 사본 ≡ 서버 DATE_HEADER_KEYWORDS(드리프트 차단)');
    // 달력 분기가 input 생성보다 앞(직접 타이핑 편집 X)
    const be = html.indexOf('function beginEditCell(td){');
    const beBody = html.slice(be, html.indexOf('function commitCellEdit', be));
    const branch = beBody.indexOf("_isPurchaseDateHeader(field.slice(4))){ openWdDatePicker(td); return; }");
    const inp = beBody.indexOf('einp');
    assert.ok(branch >= 0 && inp > branch, '구매일자 칸은 입력창 대신 달력(분기가 input 생성보다 앞)');
    // 무시트 = 전용 API / 시트 = 종전 오버레이
    assert.ok(html.includes("api('/api/trackb/workdesk/purchase-date'"), '무시트 저장 = 전용 API(진짜 기록)');
    const pick = html.slice(html.indexOf('function _wdDpPick'), html.indexOf('function _wdDpPick') + 1600);
    assert.ok(/if\(!sheetless\)\{[\s\S]*commitCellEdit\(S\.rowId, S\.field, iso, td\)/.test(pick), '시트 기반 = 종전 오버레이 경로 유지');
    assert.ok(/onclick="_wdDpPick\(\$\{d\}\)"/.test(html), 'onclick 은 숫자만(문자열 보간 금지)');
    assert.ok(/#wdDatePick\{position:fixed/.test(html), '오버레이 body 직속(fixed)');
    // 인라인 앵커(사용자 확정 2026-08-21): 셀 rect 기준 배치 + 스크롤 시 닫기(따라가지 못하는 팝오버는 닫는다)
    assert.ok(/const rect=td\.getBoundingClientRect\(\)/.test(html), '달력은 편집 셀에 붙는다(앵커 rect)');
    assert.ok(/function _wdDpPlace\(/.test(html) && /_wdDpPlace\(\);/.test(html), '렌더마다 앵커 배치·클램프');
    assert.ok(/addEventListener\('scroll',\(\)=>\{ if\(document\.getElementById\('wdDatePick'\)\) _wdDpClose\(\); \}, true\)/.test(html), '스크롤 시 닫기(캡처 — 그리드 내부 스크롤 포함)');
    assert.ok(/\.wdp-box\{position:fixed/.test(html), '박스가 셀 좌표에 고정(중앙 flex 아님)');
    assert.ok(!/#wdDatePick\{[^}]*align-items:center/.test(html), '중앙 정렬 백드롭 부활 금지');
    console.log('  F. 프론트 배선 통과');

    // ── G. 라우트 배선 ──
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
    const pd = routes.indexOf("router.post('/workdesk/purchase-date'");
    assert.ok(pd >= 0, 'purchase-date 라우트 존재');
    const pdBody = routes.slice(pd, routes.indexOf('router.post', pd + 10));
    assert.ok(/_ensureWorkdeskCellEditScope\(req, \{ sheetId, tabName, field: 'col:구매일자' \}\)/.test(pdBody), '스코프 = 셀 편집과 동일');
    const rs = routes.indexOf("router.post('/workdesk/review-submit-date'");
    assert.ok(rs >= 0, 'review-submit-date 라우트 존재');
    assert.ok(/review-submit-date', authMiddleware, adminOrMasterMiddleware/.test(routes), '리뷰제출일 백필 = adminOrMaster(증빙 없는 상태 확정)');
    console.log('  G. 라우트 배선 통과');
  } finally {
    so.writeOrderToWorktable = realWrite;
    st.markSheetlessPurchaseDate = realMarkDate;
    st.markStatusCell = realMarkStatus;
    rn.renumberTab = realRenumber;
    ledger.rebuildLedgers = realRebuild;
    svc.__setPoolForTest(null); st.__setPoolForTest(null);
  }
  console.log('✅ workdeskPurchaseDate: 전부 통과');
  process.exit(0);
}
run().catch(e => { console.error('❌', e); process.exit(1); });
