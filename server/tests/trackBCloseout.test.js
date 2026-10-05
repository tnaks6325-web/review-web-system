/**
 * P3 마감자료 자동 생성(리뷰완료 증빙 스냅샷) 회귀가드.
 *   (생성 generateCloseout · CSV closeoutCsv 는 2026-09-28 제거 — 결정 186 9번.)
 *   1. _closeoutRoster(활성 명단 합성) — 살아 있는 소비처 pendingParticipants 로 검증: 옛 _hidden 무시 · 읽기만.
 *   2. latestCloseout — 최신 1건(기존 마감 행 읽기). settlementForTab closeoutAvailable 라이브.
 * 실행: node tests/trackBCloseout.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}
// 물리행(campaign_participants). id/source/order_submission_id 는 오버레이 앵커(_deriveAnchor)용.
//   p3 은 이름에 수식 인젝션 페이로드(=HYPERLINK) — SF-2 검증용.
const physRows = [
  { id: 'p1', seq: 1, name: '김철수', recipient: '김철수', phone8: '12345678', round: '1', option: 'A', product: '샴푸', submitted: true, paid: true, submittedAt: '2026-07-28T10:00:00Z', source: 'manual', order_submission_id: null, identity_key: null },
  { id: 'p2', seq: 2, name: '이영희', recipient: '이영희', phone8: '87654321', round: '1', option: 'B', product: '샴푸', submitted: false, paid: false, submittedAt: null, source: 'manual', order_submission_id: null, identity_key: null },
  { id: 'p3', seq: 3, name: '=HYPERLINK("http://evil")', recipient: '박', phone8: '11112222', round: '1', option: 'C', product: '샴푸', submitted: true, paid: false, submittedAt: '2026-07-29T10:00:00Z', source: 'manual', order_submission_id: null, identity_key: null },
];
/* ★★ 회귀 방향이 뒤집혔다(사용자 확정 2026-08-23 — 행 숨김 기능 폐기): 옛 `_hidden` 오버레이가
   남아 있어도 **마감자료에서 빼지 않는다**. 화면·표·마감자료가 서로 다른 사실을 말하던 원인이다. */
const editsHidden = [{ anchor_type: 'manual', anchor_value: 'p2', field: '_hidden', kind: 'bool', value_bool: true, value_text: null }];

async function run() {
  // ═══ 1. generateCloseout — 오버레이 반영(옛 _hidden 은 무시) ═══
  const rosterRoutes = (hidden) => [
    [/FROM campaign_participants WHERE sheet_id=\$1 AND tab_name=\$2 AND active=TRUE/, () => ({ rows: physRows })],
    [/FROM participant_edits WHERE sheet_id=\$1 AND tab_name=\$2 AND reverted_at IS NULL/, () => ({ rows: hidden ? editsHidden : [] })],
  ];
  let p = pool([...rosterRoutes(true)]); svc.__setPoolForTest(p);
  let r = await svc.pendingParticipants({ sheetId: 'S1', tabName: 'T', kind: 'submit' });
  assert.equal(r.ok, true); assert.equal(r.filled, 3, '1a: 옛 _hidden(p2) 도 명단에 남는다(숨김 폐기)');
  assert.equal(r.done, 2, '1b: 제출완료 2건(p1,p3)');
  assert.deepEqual(r.items.map(x => x.seq), [2], '1c: 안 낸 사람 = p2');
  assert.ok(!p.q.some(x => /INSERT|UPDATE|DELETE|review_index|order_submissions|raw_sheet/.test(x.s)), '1d: 읽기만 · Track A·시트 무접촉');
  console.log('  1. _closeoutRoster(→ pendingParticipants) — 옛 숨김 무시·읽기만 ✓');

  // ═══ 2. latestCloseout (정의 존재 = closeoutAvailable 라이브) ═══
  assert.equal(typeof svc.latestCloseout, 'function', '2a: latestCloseout 정의됨');
  p = pool([[/FROM trackb_tab_closeouts WHERE sheet_id=\$1 AND tab_name=\$2 AND deleted_at IS NULL ORDER BY created_at DESC/, () => ({ rows: [{ id: 9, date: '2026-07-28', rowCount: 50, subCount: 50 }] })]]);
  svc.__setPoolForTest(p);
  r = await svc.latestCloseout({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.rowCount, 50, '2b: 최신 마감 반환');
  // settlementForTab 이 이제 closeoutAvailable=true (링크 없어도)
  p = pool([
    [/FROM trackb_settlement_links WHERE/, () => ({ rows: [] })],
    [/FROM trackb_tab_closeouts WHERE/, () => ({ rows: [{ id: 9, date: '2026-07-28', rowCount: 50, subCount: 50 }] })],
  ]); svc.__setPoolForTest(p);
  const s = await svc.settlementForTab({ sheetId: 'S1', tabName: 'T', role: 'master' });
  assert.equal(s.closeoutAvailable, true, '2c: P3 도착 → closeoutAvailable=true');
  assert.ok(s.closeout && s.closeout.rowCount === 50, '2d: 스텝퍼 ① 마감자료 병합');
  console.log('  2. latestCloseout — 최신 반환 + settlementForTab closeoutAvailable 라이브 ✓');

  svc.__setPoolForTest(null);
  console.log('✅ trackBCloseout 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
