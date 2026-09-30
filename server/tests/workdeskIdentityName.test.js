/**
 * workdeskIdentityName.test.js — 작업표 '주문자'·'수취인' 칸 편집 = 리뷰내역 실제 반영 (2026-08-24)
 *
 * 배경(실사고): 작업보드 그리드에서 이름 칸을 우클릭 편집하면 `participant_edits` 오버레이
 * (표시 전용)에만 저장되고 `review_index`(리뷰어 홈 "리뷰 내역" 카드가 읽는 원천)에는 전혀
 * 닿지 않았다 — 타계정 오타("박저은"→"박정은")를 고쳐도 그 리뷰어의 참여내역 카드는 그대로였다.
 * 리뷰 내역 카드 이름의 진짜 원천은 `review_index.reviewer_name`이고, 그 값은 그 탭의
 * `orderLedger._fieldToCol(headers,'orderer')`가 찾는 '주문자' 계열 칸(흔히 '주문자제출')에서
 * 온다 — '수취인' 칸(=recipient)이 아니다. 구매일자와 같은 패턴으로 원장 → 작업표 → 장부까지
 * 실제로 반영하게 만든다.
 *
 * 고정하는 것:
 *   A. setWorkdeskIdentityField — 주문 연결 줄은 원장(orderer/recipient) 먼저 + writeOrderToWorktable 한 벌
 *   B. 주문 없는 줄 = markSheetlessIdentityName(row_json 직접 기록)
 *   C. fail-closed — bad field·빈 값·시트 기반 탭·행 없음 = 쓰기 0건
 *   D. markSheetlessIdentityName — 칸 판정 = orderLedger._fieldToCol 단일 출처(사본 0)
 *   E. _fieldToCol 이 실제 이 사고 탭 헤더에서 '주문자제출'을 orderer 칸으로 찾는다(재현)
 *   F. 프론트 배선 — beginEditCell 의 identity 분기가 구매일자 분기 뒤·input 생성 앞
 *   G. 라우트 배선 — identity-name = 셀 편집과 같은 스코프 게이트
 *
 * 실행: node tests/workdeskIdentityName.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/trackB.service');
const st = require('../src/services/sheetlessStatus.service');
const so = require('../src/services/sheetlessOrder.service');
const ledger = require('../src/services/sheetlessLedger.service');
const { _fieldToCol } = require('../src/services/orderLedger.service');

function makePool(sc) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/COALESCE\(sheetless, FALSE\) AS s FROM tab_configs/.test(s)) return { rows: [{ s: sc.sheetless !== false }] };
      if (/SELECT id, seq, tab_gid, order_submission_id FROM campaign_participants/.test(s))
        return { rows: sc.noRow ? [] : [{ id: params[0], seq: 579, tab_gid: 'g1', order_submission_id: sc.orderId || null }] };
      if (/UPDATE order_submissions SET orderer/.test(s)) return { rowCount: sc.updateFails ? 0 : 1, rows: [] };
      if (/UPDATE order_submissions SET recipient/.test(s)) return { rowCount: sc.updateFails ? 0 : 1, rows: [] };
      if (/SELECT \* FROM order_submissions/.test(s))
        return { rows: [{ id: sc.orderId, orderer: '박정은', recipient: '박정은', phone: '010-8228-9388' }] };
      if (/COALESCE\(detected_headers, headers\) AS h FROM raw_sheet_tabs/.test(s))
        return { rows: [{ h: sc.headers || ['번호', '담당자', '구매일자', '리뷰옵션', '인애드명단', '주문자제출', '수취인', 'id', '연락처'] }] };
      if (/UPDATE campaign_participants SET row_json/.test(s)) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

async function run() {
  const realWrite = so.writeOrderToWorktable;
  const realMarkIdentity = st.markSheetlessIdentityName;
  const realRebuild = ledger.rebuildLedgers;
  let writeCalls = [];
  so.writeOrderToWorktable = async (a) => { writeCalls.push(a); return { ok: true, written: true, seq: a.sheetRow }; };
  // 장부 재생성은 다른 모듈의 자체 pool 을 쓴다(구매일자 회귀가드와 같은 이유로 여기서 stub —
  // 안 하면 스텁 pool 없이 real getPool()이 호출돼 실 네트워크 시도가 나간다).
  ledger.rebuildLedgers = async () => ({ ok: true });

  try {
    // ── A. 주문 연결 줄 = 원장(orderer) 먼저 + writeOrderToWorktable 한 벌 ──
    let pool = makePool({ orderId: 'os-1' });
    svc.__setPoolForTest(pool);
    writeCalls = [];
    let r = await svc.setWorkdeskIdentityField({ sheetId: 'S', tabName: 'T', rowId: 'row-1', field: 'orderer', value: '박정은', by: 'm' });
    assert.equal(r.ok, true); assert.equal(r.via, 'order');
    const up = pool.q.find(x => /UPDATE order_submissions SET orderer/.test(x.s));
    assert.ok(up, '원장 orderer 를 먼저 고친다(안 고치면 다음 재기록이 옛 이름을 도로 덮는다)');
    assert.equal(up.params[1], '박정은');
    assert.ok(/last_edit_seq = GREATEST/.test(up.s), 'last_edit_seq 단조증가(stale 편집 보호 — 구매일자와 동일)');
    assert.equal(writeCalls.length, 1, '실행부 = writeOrderToWorktable 한 벌(사본 0)');
    assert.equal(writeCalls[0].sheetRow, 579, '기존 연결 행을 지목(빈 슬롯을 새로 먹지 않는다)');
    console.log('  A. 주문 연결 줄(원장 우선·한 벌) — orderer 통과');

    // recipient 필드도 같은 패턴(원장 recipient 컬럼)
    pool = makePool({ orderId: 'os-1' });
    svc.__setPoolForTest(pool);
    writeCalls = [];
    r = await svc.setWorkdeskIdentityField({ sheetId: 'S', tabName: 'T', rowId: 'row-1', field: 'recipient', value: '박정은', by: 'm' });
    assert.equal(r.ok, true);
    assert.ok(pool.q.find(x => /UPDATE order_submissions SET recipient/.test(x.s)), '원장 recipient 컬럼을 고친다');
    console.log('  A′. 주문 연결 줄 — recipient 통과');

    // ── B. 주문 없는 줄 = markSheetlessIdentityName(row_json 직접 기록) ──
    st.markSheetlessIdentityName = async (a) => ({ handled: true, ok: true, column: '주문자제출', value: a.name, _a: a });
    pool = makePool({ orderId: null });
    svc.__setPoolForTest(pool);
    writeCalls = [];
    r = await svc.setWorkdeskIdentityField({ sheetId: 'S', tabName: 'T', rowId: 'row-2', field: 'orderer', value: '박정은', by: 'm' });
    assert.equal(r.ok, true); assert.equal(r.via, 'cell');
    assert.equal(writeCalls.length, 0, '주문 없는 줄은 원장 경로를 타지 않는다');
    st.markSheetlessIdentityName = realMarkIdentity;
    console.log('  B. 주문 없는 줄(칸 직접 기록) 통과');

    // ── C. fail-closed ──
    pool = makePool({}); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskIdentityField({ sheetId: 'S', tabName: 'T', rowId: 'r', field: 'bogus', value: 'x', by: 'm' });
    assert.equal(r.error, 'bad_field');
    assert.equal(pool.q.length, 0, '모르는 field = 쿼리 0');

    pool = makePool({}); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskIdentityField({ sheetId: 'S', tabName: 'T', rowId: 'r', field: 'orderer', value: '   ', by: 'm' });
    assert.equal(r.error, 'empty_value');
    assert.equal(pool.q.length, 0, '빈 값 = 쿼리 0');

    pool = makePool({ sheetless: false }); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskIdentityField({ sheetId: 'S', tabName: 'T', rowId: 'r', field: 'orderer', value: '박정은', by: 'm' });
    assert.equal(r.error, 'not_sheetless', '시트 기반 탭 거부(시트가 진실원본)');
    assert.ok(!pool.q.some(x => /UPDATE/.test(x.s)), '거부 시 쓰기 0건');

    pool = makePool({ noRow: true }); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskIdentityField({ sheetId: 'S', tabName: 'T', rowId: 'r', field: 'orderer', value: '박정은', by: 'm' });
    assert.equal(r.error, 'row_not_found');
    console.log('  C. fail-closed 통과');

    // ── D. markSheetlessIdentityName — 칸 판정 = _fieldToCol 단일 출처 ──
    pool = makePool({ headers: ['번호', '담당자', '주문자제출', '수취인'] });
    st.__setPoolForTest(pool);
    r = await st.markSheetlessIdentityName({ sheetId: 'S', tabName: 'T', rowIndex: 579, field: 'orderer', name: '박정은', by: 'm' });
    assert.equal(r.ok, true); assert.equal(r.column, '주문자제출', '칸 = _fieldToCol(headers,"orderer") 판정');
    const w = pool.q.find(x => /UPDATE campaign_participants SET row_json/.test(x.s));
    assert.ok(w, 'row_json 에 쓴다(오버레이 아님 — 장부 재생성이 읽는 자리)');

    pool = makePool({ headers: ['번호', '연락처'] }); st.__setPoolForTest(pool);
    r = await st.markSheetlessIdentityName({ sheetId: 'S', tabName: 'T', rowIndex: 579, field: 'orderer', name: '박정은', by: 'm' });
    assert.equal(r.reason, 'no_orderer_column', '주문자 칸 없는 표는 거부(조용히 아무 칸에나 쓰지 않는다)');

    r = await st.markSheetlessIdentityName({ sheetId: 'S', tabName: 'T', rowIndex: 579, field: 'bogus', name: 'x', by: 'm' });
    assert.deepEqual(r, { handled: false }, '모르는 field = 관여하지 않는다');
    st.__setPoolForTest(null);
    console.log('  D. markSheetlessIdentityName 통과');

    // ── E. 이 사고 탭 헤더 재현 — '주문자제출' 이 orderer 칸으로 잡히는지 직접 실행 ──
    const H = ['참여자', '연락처', '번호', '담당자', '구매일자', '리뷰옵션', '인애드명단', '주문자제출', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰제출', '입금', '주문번호', '비고(닉네임)'];
    const oi = _fieldToCol(H, 'orderer');
    const ri = _fieldToCol(H, 'recipient');
    assert.equal(H[oi], '주문자제출', "리뷰내역 카드 이름의 원천은 '수취인'이 아니라 '주문자제출' 칸(사고 재현)");
    assert.equal(H[ri], '수취인');
    console.log('  E. 사고 헤더 재현(_fieldToCol) 통과');

    // ── F. 프론트 배선 ──
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
    assert.ok(html.includes('function _identityFieldKind(h){'), '판정 함수 존재');
    assert.ok(/STATE\.wd&&STATE\.wd\.identityCols/.test(html), '서버가 실어 준 identityCols 단일 출처(사본 금지)');
    const be = html.indexOf('function beginEditCell(td){');
    const beBody = html.slice(be, html.indexOf('function commitIdentityEdit', be));
    const dateBranch = beBody.indexOf("openWdDatePicker(td); return;");
    const idBranch = beBody.indexOf('_identityFieldKind(field.slice(4))');
    const inp = beBody.indexOf('einp');
    assert.ok(dateBranch >= 0 && idBranch > dateBranch, '구매일자 분기 뒤에 identity 판정');
    assert.ok(idBranch >= 0 && idBranch < inp, 'identity 판정이 input 생성보다 앞(같은 편집칸을 재사용하되 커밋 경로만 갈린다)');
    assert.ok(/commitIdentityEdit\(rowId, field, idKind, val, td\)/.test(beBody), '변경 시 identity 커밋 경로로 분기');
    assert.ok(html.includes("api('/api/trackb/workdesk/identity-name'"), '무시트 저장 = 전용 API(진짜 기록)');
    const cie = html.slice(html.indexOf('function commitIdentityEdit'), html.indexOf('function commitIdentityEdit') + 1800);
    assert.ok(/not_sheetless[\s\S]*commitCellEdit\(rowId, field, value, td\)/.test(cie), '시트 기반 탭은 서버 거부 시 종전 오버레이로 폴백');
    console.log('  F. 프론트 배선 통과');

    // ── G. 라우트 배선 ──
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
    const ir = routes.indexOf("router.post('/workdesk/identity-name'");
    assert.ok(ir >= 0, 'identity-name 라우트 존재');
    const irBody = routes.slice(ir, routes.indexOf('router.post', ir + 10));
    assert.ok(/_ensureWorkdeskCellEditScope\(req, \{ sheetId, tabName, field:/.test(irBody), '스코프 = 셀 편집과 동일(광고주는 신원열 접근 불가)');
    assert.ok(/svc\.setWorkdeskIdentityField/.test(irBody), '서비스 위임');
    console.log('  G. 라우트 배선 통과');
  } finally {
    so.writeOrderToWorktable = realWrite;
    st.markSheetlessIdentityName = realMarkIdentity;
    ledger.rebuildLedgers = realRebuild;
    svc.__setPoolForTest(null); st.__setPoolForTest(null);
  }
  console.log('✅ workdeskIdentityName: 전부 통과');
  process.exit(0);
}
run().catch(e => { console.error('❌', e); process.exit(1); });
