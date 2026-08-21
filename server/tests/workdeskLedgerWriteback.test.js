/**
 * 회귀가드 — 작업보드 셀 편집 → **주문 원장 되쓰기** (사용자 확정 2026-08-21)
 *
 * 실행: node tests/workdeskLedgerWriteback.test.js
 *
 * ★ 이 가드가 지키는 것(완화 금지):
 *   ① 원장 칸(결제금액·은행·계좌·예금주…)을 표에서 고치면 **원장도 같은 값**이 된다
 *      — 담당자가 두 화면을 오가지 않는다(이 요구가 이 기능의 존재 이유다).
 *   ② 원장 칸이 **아닌** 열(비고 등)·주문이 없는 줄은 종전대로 오버레이만 — 없는 원장을 만들지 않는다.
 *   ③ 원장 반영이 실패해도 **담당자의 셀 편집은 살아남고**, 실패 사실을 응답에 실어 보낸다.
 *   ④ 열↔원장칸 매핑은 `orderLedger._fieldToCol` 단일 출처(헤더 키워드 사본 금지).
 *   ⑤ 쓰기는 `applyOrderEdit` 한 벌 — 주문원장 화면과 같은 경로(라우트에 사본 부활 금지).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const svc = require('../src/services/trackB.service');
const ol = require('../src/services/orderLedger.service');
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const RF = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; } };
const ta = async (name, fn) => { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; } };

// 실제 작업보드 헤더 줄(위드프렌즈 탭 실측 구성)
const HEADERS = ['참여자', '연락처', '번호', '담당자', '구매일자', '인애드명단', '주문번호',
  '주문자제출', '수취인', 'id', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고(닉네임)'];

function makeConnectPool(scn) {
  const q = [];
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/^BEGIN|^ROLLBACK|^COMMIT/.test(s)) return { rows: [] };
      if (/FROM campaign_participants WHERE id=\$1 .* FOR UPDATE/.test(s)) return { rows: scn.row ? [scn.row] : [] };
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: scn.dupCount || 1 }] };
      if (/FROM raw_sheet_tabs/.test(s)) return { rows: [{ detected_headers: scn.headers || HEADERS }] };
      if (/UPDATE participant_edits SET reverted_at/.test(s)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO participant_edits/.test(s)) return { rows: [{ id: 7 }] };
      return { rows: [] };
    },
    release() {},
  };
  return { q, client, async connect() { return client; } };
}

const ORDER_ROW = {
  id: 'r53', source: 'import', order_submission_id: 'ord-53', identity_key: 'phone8:88969249',
  phone8: '88969249', recipient_name: '나재형', option_text: null, tab_gid: '7', row_json: { '결제금액': '99000' },
};

/** applyOrderEdit 를 가로채 호출 인자를 잡아 둔다(원장은 건드리지 않는다) */
function stubLedger(result) {
  const calls = [];
  const orig = ol.applyOrderEdit;
  ol.applyOrderEdit = async (p) => { calls.push(p); return typeof result === 'function' ? result(p) : (result || { ok: true }); };
  return { calls, restore: () => { ol.applyOrderEdit = orig; } };
}

(async function main() {
  console.log('\n§1 열 ↔ 원장 칸 매핑(단일 출처)');

  t('1a ★ 원장 칸은 원장 칸으로 해석된다(결제금액→price · 예금주→depositor · 계좌번호→account)', () => {
    const expect = { '결제금액': 'price', '예금주': 'depositor', '계좌번호': 'account', '은행': 'bank',
      '주문번호': 'order_num', '주소': 'address', '수취인': 'recipient' };
    for (const [header, field] of Object.entries(expect)) {
      const idx = HEADERS.indexOf(header);
      assert.strictEqual(ol._fieldToCol(HEADERS, field), idx, `${header} ↔ ${field} 매핑이 어긋났다`);
    }
  });

  t('1b ★ 작업표 자체 칸은 원장에 대응하지 않는다(리뷰·입금·번호·담당자)', () => {
    const ledgerCols = new Set(ol.ORDER_LEDGER_EDIT_FIELDS.map(f => ol._fieldToCol(HEADERS, f)).filter(i => i >= 0));
    for (const own of ['리뷰', '입금', '번호', '담당자']) {
      assert.ok(!ledgerCols.has(HEADERS.indexOf(own)), `${own} 이 원장 칸으로 잡혔다 — 없는 원장을 쓰게 된다`);
    }
  });

  t('1c 되쓰기 화이트리스트는 역동기화 필드와 한 벌이다(사본 금지)', () => {
    for (const f of ol.REVERSE_SYNC_FIELDS) {
      assert.ok(ol.ORDER_LEDGER_EDIT_FIELDS.includes(f), f + ' 가 편집 화이트리스트에서 빠졌다');
    }
  });

  console.log('\n§2 셀 편집 → 원장 되쓰기(editWorkdeskRow 실행)');

  await ta('2a ★★ 결제금액을 표에서 고치면 원장 price 도 같은 값이 된다', async () => {
    const cp = makeConnectPool({ row: ORDER_ROW });
    svc.__setPoolForTest(cp);
    const st = stubLedger({ ok: true });
    try {
      const e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r53', field: 'col:결제금액', value: '9900', by: '망고' });
      assert.strictEqual(e.ok, true);
      assert.strictEqual(st.calls.length, 1, '★ 원장 되쓰기가 호출되지 않았다 — 화면만 고쳐지고 원장은 옛 값으로 남는다');
      assert.strictEqual(st.calls[0].orderSubmissionId, 'ord-53');
      assert.deepStrictEqual(st.calls[0].edits, [{ field: 'price', newValue: '9900' }]);
      assert.strictEqual(st.calls[0].source, 'workdesk_cell', '어디서 고쳤는지 이력에 남아야 한다');
      assert.strictEqual(e.ledgerSync.ok, true);
    } finally { st.restore(); }
  });

  await ta('2b 계좌·예금주도 같은 규칙으로 원장까지 간다', async () => {
    for (const [header, field, val] of [['계좌번호', 'account', '3333014800508'], ['예금주', 'depositor', '나재형']]) {
      const cp = makeConnectPool({ row: ORDER_ROW });
      svc.__setPoolForTest(cp);
      const st = stubLedger({ ok: true });
      try {
        await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r53', field: 'col:' + header, value: val });
        assert.strictEqual(st.calls.length, 1, header + ' 가 원장으로 안 갔다');
        assert.strictEqual(st.calls[0].edits[0].field, field);
      } finally { st.restore(); }
    }
  });

  await ta('2c ★ 원장 칸이 아닌 열은 종전대로 오버레이만(없는 원장을 만들지 않는다)', async () => {
    const cp = makeConnectPool({ row: ORDER_ROW });
    svc.__setPoolForTest(cp);
    const st = stubLedger({ ok: true });
    try {
      const e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r53', field: 'col:담당자', value: '망고' });
      assert.strictEqual(e.ok, true);
      assert.strictEqual(st.calls.length, 0, '작업표 자체 칸이 원장을 건드렸다');
      assert.strictEqual(e.ledgerSync, null);
    } finally { st.restore(); }
  });

  await ta('2c2 ★ 비고는 **원장 칸이 맞다**(정방향이 memo 를 그 열에 쓴다) — 되쓰기도 대칭이다', async () => {
    // ⚠ 헷갈리기 쉬운 자리라 의도를 못박는다: `비고(닉네임)` 은 작업표 자체 칸처럼 보이지만
    //    `mapOrderToSheetRow` 가 주문 memo 를 쓰는 칸이고, 시트 역동기화도 memo 를 안전필드로 둔다.
    const cp = makeConnectPool({ row: ORDER_ROW });
    svc.__setPoolForTest(cp);
    const st = stubLedger({ ok: true });
    try {
      await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r53', field: 'col:비고(닉네임)', value: '닉네임메모' });
      assert.strictEqual(st.calls.length, 1);
      assert.strictEqual(st.calls[0].edits[0].field, 'memo');
    } finally { st.restore(); }
  });

  await ta('2d ★ 주문이 붙지 않은 줄은 원장을 만들지 않는다(수기 줄·빈 슬롯)', async () => {
    const cp = makeConnectPool({ row: { ...ORDER_ROW, id: 'm1', source: 'manual', order_submission_id: null, identity_key: null } });
    svc.__setPoolForTest(cp);
    const st = stubLedger({ ok: true });
    try {
      const e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'm1', field: 'col:결제금액', value: '9900' });
      assert.strictEqual(e.ok, true);
      assert.strictEqual(st.calls.length, 0);
    } finally { st.restore(); }
  });

  await ta('2e ★★ 원장 반영이 실패해도 셀 편집은 살아남고, 실패 사실을 말한다(조용한 실패 금지)', async () => {
    const cp = makeConnectPool({ row: ORDER_ROW });
    svc.__setPoolForTest(cp);
    const st = stubLedger({ disabled: true });
    try {
      const e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r53', field: 'col:결제금액', value: '9900' });
      assert.strictEqual(e.ok, true, '★ 원장이 막혔다고 담당자의 편집을 버리면 안 된다');
      assert.ok(e.ledgerSync && !e.ledgerSync.ok && e.ledgerSync.disabled, '실패 사실이 응답에 없다');
    } finally { st.restore(); }
  });

  await ta('2f ★ 원장 되쓰기가 예외를 던져도 편집은 성공으로 남는다', async () => {
    const cp = makeConnectPool({ row: ORDER_ROW });
    svc.__setPoolForTest(cp);
    const st = stubLedger(() => { throw new Error('boom'); });
    try {
      const e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r53', field: 'col:결제금액', value: '9900' });
      assert.strictEqual(e.ok, true);
      assert.strictEqual(e.ledgerSync.ok, false);
    } finally { st.restore(); }
  });

  await ta('2g ★ 중복 앵커(같은 주문이 여러 줄)는 편집 자체가 거부된다 — 원장도 안 건드린다', async () => {
    const cp = makeConnectPool({ row: ORDER_ROW, dupCount: 2 });
    svc.__setPoolForTest(cp);
    const st = stubLedger({ ok: true });
    try {
      const e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r53', field: 'col:결제금액', value: '9900' });
      assert.strictEqual(e.ok, false);
      assert.strictEqual(e.error, 'ambiguous_order');
      assert.strictEqual(st.calls.length, 0, '★ 어느 줄의 값인지 모르는 채로 원장을 덮으면 안 된다');
    } finally { st.restore(); }
  });

  console.log('\n§3 쓰기 경로 단일 출처 · 이력 · 화면 배선');

  t('3a ★ 원장 쓰기는 applyOrderEdit 한 벌 — 라우트에 UPDATE 사본이 없다', () => {
    const src = R('src/routes/diag.routes.js');
    const seg = src.slice(src.indexOf("router.post('/order-edit'"), src.indexOf("router.post('/reverse-sync-detect'"));
    assert.ok(/applyOrderEdit\(/.test(seg), '라우트가 공용 서비스를 쓰지 않는다');
    assert.ok(!/UPDATE order_submissions SET/.test(seg), '★ 라우트에 원장 UPDATE 사본이 되살아났다');
    assert.ok(!/const _ORDER_LEDGER_EDIT_FIELDS/.test(src), '★ 화이트리스트 사본이 되살아났다');
  });

  t('3b ★ 셀 편집도 같은 함수를 쓴다(editWorkdeskRow 안에 원장 UPDATE 사본 금지)', () => {
    const src = R('src/services/trackB.service.js');
    // ★ 함수 본문만 본다 — 고정 길이로 자르면 함수가 자랄 때 가드가 조용히 빨개진다(paymentBatch 교훈).
    const i = src.indexOf('async function editWorkdeskRow(');
    const j = src.indexOf('\nasync function revertWorkdeskEdit(');
    assert.ok(i > 0 && j > i, 'editWorkdeskRow 본문을 찾지 못했다');
    const fn = src.slice(i, j);
    assert.ok(/applyOrderEdit\(/.test(fn), '셀 편집이 공용 서비스를 쓰지 않는다');
    assert.ok(!/UPDATE order_submissions SET/.test(fn), '★ 셀 편집 안에 원장 UPDATE 사본이 생겼다');
    assert.ok(/source: 'workdesk_cell'/.test(fn), '편집 출처를 이력에 남기지 않는다');
    assert.ok(/await client\.query\('COMMIT'\)[\s\S]*applyOrderEdit\(/.test(fn),
      '★ 원장 반영은 **커밋 뒤**여야 한다 — 원장이 막혀도 담당자의 편집은 잃지 않는다');
  });

  t('3c ★★ 원장 덮어쓰기 전 값이 이력으로 남는다(리뷰어 제출 원본 소실 방지)', () => {
    const src = R('src/services/orderLedger.service.js');
    assert.ok(/INSERT INTO order_ledger_edit_log/.test(src), '편집 이력 기록이 없다');
    assert.ok(/SELECT \$\{cols\.join\(', '\)\} FROM order_submissions/.test(src)
      || /FROM order_submissions WHERE id = \$1 AND deleted_at IS NULL/.test(src),
      '덮어쓰기 직전 값을 DB 에서 읽지 않는다(요청이 준 값만 믿으면 이력이 거짓이 된다)');
    const mig = R('migrations/134_order_ledger_edit_log.sql');
    assert.ok(/CREATE TABLE IF NOT EXISTS order_ledger_edit_log/.test(mig), '마이그레이션이 없다');
    assert.ok(/old_value/.test(mig) && /new_value/.test(mig));
  });

  t('3d ★ 화면은 성공을 떠들지 않고 실패만 말한다(담당자 마찰 0 · 조용한 실패 금지)', () => {
    const html = RF('workdesk.html');
    assert.ok(/function _warnLedgerSync\(/.test(html), '원장 반영 실패 안내가 없다');
    assert.ok(/_warnLedgerSync\(resp\.ledgerSync\)/.test(html), '셀 저장 경로에 배선되지 않았다');
    const fn = html.slice(html.indexOf('function _warnLedgerSync('), html.indexOf('function commitCellEdit('));
    assert.ok(/if\(!ls \|\| ls\.ok\) return;/.test(fn), '★ 성공했을 때도 토스트를 띄우면 그게 곧 마찰이다');
    assert.ok(/주문원장/.test(fn), '무엇이 안 됐는지 사람 말로 설명하지 않는다');
  });

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
