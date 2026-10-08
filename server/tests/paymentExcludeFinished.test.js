/**
 * 입금관리 — 마감(🏁)된 작업은 입금 대상에서 뺀다 (사용자 확정 2026-09-30)
 *
 * ★ 조용히 빼지 않는다(finishedExcluded 건수) · 모르면 빼지 않는다(fail-open) ·
 *   회차 만들기는 마감 작업도 포함해 계산(펼쳐 고른 건을 튕기지 않게) · 마감 판정은 trackB.service 한 곳.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = p => path.join(__dirname, '..', 'src', p);
const FE = p => path.join(__dirname, '..', '..', 'frontend', p);
let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

// ★ async 여야 한다 — trackB.service 는 지연 require 라 run 이 끝나기 전에 스텁을 걷으면 진짜 DB 로 간다.
async function withStubPool(handler, run) {
  const poolPath = require.resolve(SRC('db/pool'));
  const mods = ['services/payment.service', 'services/trackB.service'].map(p => require.resolve(SRC(p)));
  const calls = [];
  const stub = {
    query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params) || { rows: [], rowCount: 0 }; },
    connect: async () => ({ query: stub.query, release() {} }),
  };
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  mods.forEach(m => delete require.cache[m]);
  try { return await run(require(mods[0]), calls); }
  finally {
    mods.forEach(m => delete require.cache[m]);
    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
  }
}

const ACCT = { bankName: '국민은행', bankAccount: '123456789', accountHolder: '김리뷰' };
function handler(opts = {}) {
  return (sql) => {
    if (/FROM trackb_tab_finished/.test(sql)) {
      if (opts.finThrow) throw new Error('fin boom');
      return { rows: opts.finished || [] };
    }
    if (/FROM review_index ri/.test(sql)) return { rows: [
      { sheetId: 'S1', tabName: '끝난작업', rowIndex: 10, reviewerName: '김리뷰', phone8: '11112222', startDate: '', productName: '', amountCells: { '결제금액': '10,000' } },
      { sheetId: 'S2', tabName: '진행작업', rowIndex: 20, reviewerName: '김리뷰', phone8: '11112222', startDate: '', productName: '', amountCells: { '결제금액': '20,000' } },
    ] };
    if (/FROM tab_configs tc/.test(sql)) return { rows: [
      { sheetId: 'S1', tabName: '끝난작업', tabGid: '777', label: '끝난작업', transferBank: '케이뱅크', depositName: '망고', goodsCostType: '' },
      { sheetId: 'S2', tabName: '진행작업', tabGid: '888', label: '진행작업', transferBank: '케이뱅크', depositName: '망고', goodsCostType: '' },
    ] };
    if (/FROM reviewers WHERE phone8/.test(sql) && !/AS "subAccounts"/.test(sql))
      return { rows: [{ reviewerId: 'r1', phone8: '11112222', name: '김리뷰', ...ACCT }] };
    return { rows: [] };
  };
}

(async function main() {
  console.log('\n§1 실행');

  await ta('1a ★ 마감된 작업(이름 일치)은 빠지고 건수를 말한다', async () => {
    await withStubPool(handler({ finished: [{ sheetId: 'S1', tabName: '끝난작업', tabGid: '' }] }), async (svc) => {
      const r = await svc.listPaymentTargets();
      assert.deepStrictEqual(r.items.map(i => i.tabName), ['진행작업']);
      assert.deepStrictEqual(r.finishedExcluded, { rows: 1, works: 1, payable: 1 });
      assert.strictEqual(r.summary.total, 1, '집계도 보이는 건 기준');
      assert.strictEqual(r.finishedUnavailable, false);
    });
  });

  await ta('1b 탭 이름이 바뀌어도 gid 로 마감을 알아본다', async () => {
    await withStubPool(handler({ finished: [{ sheetId: 'S1', tabName: '옛이름', tabGid: '777' }] }), async (svc) => {
      const r = await svc.listPaymentTargets();
      assert.deepStrictEqual(r.items.map(i => i.tabName), ['진행작업']);
    });
  });

  await ta('1c ★ 마감 조회가 실패하면 빼지 않고(fail-open) 그 사실을 알린다', async () => {
    await withStubPool(handler({ finThrow: true }), async (svc) => {
      const r = await svc.listPaymentTargets();
      assert.strictEqual(r.items.length, 2);
      assert.strictEqual(r.finishedUnavailable, true);
      assert.strictEqual(r.finishedExcluded, null);
    });
  });

  await ta('1d includeFinished 면 마감 작업도 그대로(마감 조회조차 안 한다)', async () => {
    await withStubPool(handler({ finished: [{ sheetId: 'S1', tabName: '끝난작업', tabGid: '' }] }), async (svc, calls) => {
      const r = await svc.listPaymentTargets({ includeFinished: true });
      assert.strictEqual(r.items.length, 2);
      assert.strictEqual(calls.filter(c => /FROM trackb_tab_finished/.test(c.sql)).length, 0);
    });
  });

  await ta('1e 마감 작업이 없으면 finishedExcluded 는 null(화면이 아무 말도 안 한다)', async () => {
    await withStubPool(handler({ finished: [] }), async (svc) => {
      const r = await svc.listPaymentTargets();
      assert.strictEqual(r.items.length, 2);
      assert.strictEqual(r.finishedExcluded, null);
    });
  });

  console.log('\n§2 배선');
  const pay = fs.readFileSync(SRC('services/payment.service.js'), 'utf8');
  const tb = fs.readFileSync(SRC('services/trackB.service.js'), 'utf8');
  const rt = fs.readFileSync(SRC('routes/trackB.routes.js'), 'utf8');
  const wd = fs.readFileSync(FE('workdesk.html'), 'utf8');
  t('2a ★ 회차 만들기는 마감 작업도 포함해 다시 계산한다', () =>
    assert.ok(/listPaymentTargets\(\{ includeFinished: true \}\)/.test(pay)));
  t('2b 마감 판정은 trackB.service 한 곳(사본 금지)', () => {
    assert.ok(/isTabFinishedIn\(fin\.map/.test(pay));
    assert.ok(!/FROM trackb_tab_finished/.test(pay), 'payment.service 가 마감 표를 직접 읽지 않는다');
    assert.ok(/finishedTabsMap, isTabFinishedIn,/.test(tb));
  });
  t('2c 라우트: 쿼리 includeFinished=1 만 켜고, 공유 조회 키에 포함, 건수·실패 신호를 싣는다', () => {
    assert.ok(/includeFinished: String\(req\.query\.includeFinished \|\| ''\) === '1'/.test(rt));
    assert.ok(/!!opts\.includeFinished\]\)/.test(rt));
    assert.ok(/finishedExcluded: out\.finishedExcluded \|\| null, finishedUnavailable: !!out\.finishedUnavailable/.test(rt));
  });
  t('2d 화면: 조회 두 곳이 같은 주소 함수를 쓰고, 안내 줄이 표시된다', () => {
    assert.strictEqual((wd.match(/api\('\/api\/trackb\/payment\/targets'/g) || []).length, 0, '주소를 하드코딩하지 않는다');
    assert.strictEqual((wd.match(/api\(_pmTargetsUrl\(\)/g) || []).length, 2);
    // 시안 2(결정 217): 마감 안내는 왼쪽 작업 목록 아래로 옮겼다 — 렌더가 그 함수를 부르는 것은 그대로
    assert.ok(/bottom:\s*_pmFinishedNoteHtml\(\)/.test(wd), '마감 안내 줄이 화면에 실리지 않는다');
    assert.ok(/onclick="_pmToggleFinished\(\)"/.test(wd));
  });

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
