'use strict';
/* 결정 349 ④ 안전망 — 동시진행 작업표의 줄인데 묶음 주문(구매처 기록 2·묶음 버전)이 아니면
   보통 주문으로 지급하지 않는다(지급 보류 'dual_bundle_incomplete').
   운영 사고: 결정 344 차단 전에 외부모집 수동제출로 들어간 보통 주문 3건(한쪽 금액·캡처 1장)이
   일반 지급 경로로 「제품비 9,900 + 리뷰비」가 나갈 수 있었다.
   ① 판정 함수(PGlite 실제 SQL · 동시진행 fixture) ② 입금 대상 목록 배선 ③ 다운로드(이미 만든 회차) 배선. */
require('./helpers/dualChannelDependencies.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { fixture, id } = require('./helpers/dualChannelRealFixture');
const plain = '00000000-0000-4000-8000-0000000000a3';

async function withPlainOrder(run) {
  const db = await fixture();
  try {
    // 수동제출로 들어간 보통 주문(묶음 아님) — 같은 동시진행 작업표 3번 줄
    await db.query(`INSERT INTO order_submissions(id,price,sheet_id,tab_name,gid) VALUES($1,'9900','s','t','g')`, [plain]);
    await db.query(`INSERT INTO campaign_participants(id,order_submission_id,sheet_id,tab_name,seq,row_json) VALUES(gen_random_uuid(),$1,'s','t',3,'{"결제금액":"9900"}')`, [plain]);
    // 동시진행이 아닌 다른 작업표의 보통 주문
    await db.exec(`INSERT INTO recruit_campaigns VALUES('normal','{}','s','other','',NULL)`);
    return await run(db);
  } finally { await db.close(); }
}

test('① 동시진행 작업표의 묶음 아닌 줄은 dual_bundle_incomplete · 묶음 줄·다른 작업표는 그대로', async () => {
  await withPlainOrder(async db => {
    const payout = require(root + '/src/services/dualChannelPayout.service');
    const out = await payout.dualBundleIncompleteRows(db, [
      { sheetId: 's', tabName: 't', rowIndex: 2 },
      { sheetId: 's', tabName: 't', rowIndex: 3 },
      { sheetId: 's', tabName: 't', rowIndex: 9 },   // 주문 없이 손으로 적은 줄도 동시진행 작업표면 보류
      { sheetId: 's', tabName: 'other', rowIndex: 3 },
    ]);
    assert.equal(out.get(['s', 't', 3].join('\u0000')), 'dual_bundle_incomplete');
    assert.equal(out.get(['s', 't', 9].join('\u0000')), 'dual_bundle_incomplete');
    assert.equal(out.has(['s', 't', 2].join('\u0000')), false, '묶음 주문은 동시진행 지급 판정이 따로 본다');
    assert.equal(out.has(['s', 'other', 3].join('\u0000')), false, '일반 작업표는 종전대로');
  });
});

test('① 판정이 실패하면 막는다(fail-closed · 돈 걸린 경로)', async () => {
  const payout = require(root + '/src/services/dualChannelPayout.service');
  const broken = { query: async () => { throw new Error('db down'); } };
  const out = await payout.dualBundleIncompleteRows(broken, [{ sheetId: 's', tabName: 't', rowIndex: 3 }]);
  assert.equal(out.get(['s', 't', 3].join('\u0000')), 'dual_bundle_check_failed');
});

// 입금 대상 목록 · 다운로드 배선은 가짜 DB(문자열 응답)로 본다 — 판정 자체는 위 PGlite 시험이 본다.
async function withStubPool(handler, run) {
  const poolPath = require.resolve(root + '/src/db/pool');
  const mods = ['services/payment.service', 'services/trackB.service', 'services/dualChannelPayout.service', 'services/dualChannelReview.service']
    .map(p => require.resolve(root + '/src/' + p));
  const stub = {
    query: async (sql, params) => (await handler(sql, params)) || { rows: [], rowCount: 0 },
    connect: async () => ({ query: stub.query, release() {} }),
  };
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  mods.forEach(m => delete require.cache[m]);
  try { return await run(require(mods[0])); }
  finally {
    mods.forEach(m => delete require.cache[m]);
    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
  }
}
const dualCampaign = { id: 'dc', work_detail: { dualChannelProduct: { channels: { naver: {}, coupang: {} } } }, linked_sheet_id: 'S1', linked_tab_name: '동시' };
function handler(sql) {
  if (/FROM recruit_campaigns c\s+WHERE c\.linked_sheet_id/.test(sql)) return { rows: [] };
  if (/FROM review_index ri/.test(sql)) return { rows: [
    { sheetId: 'S1', tabName: '동시', rowIndex: 3, reviewerName: '김리뷰', phone8: '11112222', startDate: '', productName: '', amountCells: { '결제금액': '9,900' } },
    { sheetId: 'S2', tabName: '보통', rowIndex: 4, reviewerName: '김리뷰', phone8: '11112222', startDate: '', productName: '', amountCells: { '결제금액': '9,900' } },
  ] };
  if (/FROM tab_configs tc/.test(sql)) return { rows: [
    { sheetId: 'S1', tabName: '동시', tabGid: '1', label: '동시', transferBank: '케이뱅크', depositName: '망고', goodsCostType: '' },
    { sheetId: 'S2', tabName: '보통', tabGid: '2', label: '보통', transferBank: '케이뱅크', depositName: '망고', goodsCostType: '' },
  ] };
  if (/FROM reviewers WHERE phone8/.test(sql) && !/AS "subAccounts"/.test(sql))
    return { rows: [{ reviewerId: 'r1', phone8: '11112222', name: '김리뷰', bankName: '국민은행', bankAccount: '123456789', accountHolder: '김리뷰' }] };
  return { rows: [] };
}
function dualHandler(sql, params) {
  if (/FROM recruit_campaigns c\s+WHERE c\.linked_sheet_id/.test(sql))
    return { rows: params[0] === 'S1' && params[1] === '동시' ? [{ campaign: dualCampaign }] : [] };
  return handler(sql, params);
}

test('② 입금 대상 목록: 동시진행 작업표의 보통 주문 줄은 지급 불가(dual_bundle_incomplete) · 일반 작업표는 그대로', async () => {
  await withStubPool(dualHandler, async svc => {
    const r = await svc.listPaymentTargets({ includeFinished: true });
    const dual = r.items.find(i => i.tabName === '동시');
    const normal = r.items.find(i => i.tabName === '보통');
    assert.ok(dual && normal);
    assert.equal(dual.payable, false);
    assert.ok(dual.issues.includes('dual_bundle_incomplete'), JSON.stringify(dual.issues));
    assert.equal(normal.issues.includes('dual_bundle_incomplete'), false);
  });
  // 동시진행 작업표가 없으면 결과가 종전과 같다(배선이 일반 지급을 바꾸지 않는다)
  await withStubPool(handler, async svc => {
    const r = await svc.listPaymentTargets({ includeFinished: true });
    assert.ok(r.items.every(i => !i.issues.includes('dual_bundle_incomplete')));
  });
});

test('③ 다운로드: 이미 만든 회차의 보통 항목이 동시진행 작업표 줄이면 막는다', async () => {
  await withStubPool(dualHandler, async svc => {
    const items = [
      { id: 'i1', status: 'pending', sheet_id: 'S1', tab_name: '동시', row_index: 3, reviewer_name: '김리뷰' },
      { id: 'i2', status: 'pending', sheet_id: 'S2', tab_name: '보통', row_index: 4, reviewer_name: '김리뷰' },
    ];
    const svcPath = require.resolve(root + '/src/services/payment.service');
    // 현금영수증 판정은 이 시험 범위가 아니다 — 두 줄 모두 통과로 둔다(배선만 본다).
    const r = await svc.checkBatchReceiptEligibility({ items }, { db: { query: async (sql, p) => {
      if (/receipt|tab_configs|review_submissions/i.test(sql) && !/recruit_campaigns/.test(sql)) return { rows: [] };
      return dualHandler(sql, p);
    } } });
    assert.ok(svcPath);
    const ids = r.blocked.map(b => b.itemId);
    assert.ok(ids.includes('i1'), JSON.stringify(r.blocked));
    assert.equal(r.ok, false);
    const b = r.blocked.find(x => x.itemId === 'i1');
    assert.ok((b.reasons || []).includes('dual_bundle_incomplete'));
  });
});
