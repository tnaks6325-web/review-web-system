/**
 * 회귀가드 — 업체 직접 입금 작업 (결정 247 · 사용자 확정 2026-10-14 "모두 권장" · migration 189)
 *
 * 배경: 스마트윈처럼 **업체가 페이백을 직접 보내는** 작업이 생겼다. 종전에는 우리가 입금을 하므로 업체 화면에서
 * 은행·계좌·예금주를 아예 빼고 보냈고(_isAdvertiserRestrictedHeader), 입금 칸도 업체가 고칠 수 없었다.
 *
 * 고정하는 것:
 *   §1 입금관리 — 스위치를 켠 작업은 이체 대상이 아니다(맨 앞 사유 advertiser_pays · 목록에서 빼고 건수만 싣는다)
 *      · 조회 실패 = 전 건 보류(fail-closed — 업체도 보내고 우리도 보내면 되돌릴 수 없다)
 *      · 업체 화면 계좌 = 우리가 보낼 바로 그 계좌(판정 사본 0)
 *   §2 스위치 저장 — 시트 기반·업체 없는 작업은 켜지지 않는다(막다른 길 방지) · 끄기는 언제든
 *   §3 업체 입금 기록 — 트랜잭션 안에서 스위치·우리 이체 회차·업체가 넣은 값만 지우기를 다시 본다
 *   §4 배선 — 소유 업체 대표 링크만(브랜드 링크·남의 업체 제외) · 원본 계좌 열은 계속 차단 · 화면 사유 문구
 *
 * 실행: node tests/advertiserPayout.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}
const ROOT = path.join(__dirname, '..');
const SRC = p => path.join(ROOT, 'src', p);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function withStubPool(handler, modRel, run) {
  const poolPath = require.resolve(SRC('db/pool'));
  const modPath = require.resolve(SRC(modRel));
  const calls = [];
  const stub = {
    query: async (sql, params) => { calls.push({ sql: String(sql), params }); return (await handler(String(sql), params)) || { rows: [], rowCount: 0 }; },
    connect: async () => ({ query: stub.query, release() {} }),
  };
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  delete require.cache[modPath];
  return Promise.resolve()
    .then(() => run(require(modPath), calls))
    .finally(() => {
      delete require.cache[modPath];
      if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
    });
}

const ACCT = '1002345678901';
function payHandler(o = {}) {
  return (sql) => {
    if (/FROM review_index ri/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', rowIndex: 7, reviewerName: '김혜진', phone8: '83540507',
      startDate: '10 / 14 (수)', productName: '미소 누룽지', amountCells: { '결제금액': '11,850' },
    }] };
    if (/SELECT advertiser_payout FROM tab_configs/.test(sql)) return { rows: [{ advertiser_payout: !!o.lockFlag }] };
    if (/AS "paidCell"/.test(sql)) return { rows: [{ id: 'cp1', paidCell: o.paidCell || '' }] };
    if (/INSERT INTO payment_batches/.test(sql)) return { rows: [{ id: 'b1' }] };
    if (/advertiser_payout = TRUE/.test(sql)) {
      if (o.throwFlag) throw new Error('flag boom');
      return { rows: o.flagOn ? [{ sheetId: 'S1', tabName: 'T1' }] : [] };
    }
    if (/FROM tab_configs tc/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', label: '스마트윈', transferBank: '케이뱅크', depositName: '스마트윈', goodsCostType: '' }] };
    if (/FROM order_submissions/.test(sql) && !/FROM unnest/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', sheetRow: 7, price: '11850', feeSnapshot: null, orderedAt: '2026-10-14T09:00:00+09:00',
      bank: '우리은행', account: ACCT, depositor: '김혜진' }] };
    return { rows: [] };
  };
}

(async function main() {
  console.log('\n§1 입금관리 — 업체 직접 입금 작업은 우리가 보내지 않는다');

  await ta('1a 스위치 꺼짐 = 종전 그대로(입금 가능)', () =>
    withStubPool(payHandler({ flagOn: false }), 'services/payment.service', async svc => {
      const r = await svc.listPaymentTargets();
      assert.strictEqual(r.items.length, 1);
      assert.ok(!r.items[0].issues.includes('advertiser_pays'));
      assert.strictEqual(r.advertiserPaidExcluded, null);
    }));

  await ta('1b ★★ 스위치 켜짐 = 목록에서 빼고 건수만 싣는다(조용히 숨기지 않는다)', () =>
    withStubPool(payHandler({ flagOn: true }), 'services/payment.service', async svc => {
      const r = await svc.listPaymentTargets();
      assert.strictEqual(r.items.length, 0, '우리 입금관리 목록에 나오면 안 된다');
      assert.deepStrictEqual(r.advertiserPaidExcluded, { rows: 1, works: 1 });
    }));

  await ta('1c ★★ 포함 조회에서는 맨 앞 사유가 advertiser_pays 이고 이체 불가(createBatch 가 issues[0] 을 사유로 말한다)', () =>
    withStubPool(payHandler({ flagOn: true }), 'services/payment.service', async svc => {
      const r = await svc.listPaymentTargets({ includeAdvertiserPaid: true });
      assert.strictEqual(r.items.length, 1);
      assert.strictEqual(r.items[0].issues[0], 'advertiser_pays');
      assert.strictEqual(r.items[0].payable, false);
    }));

  await ta('1d ★★ 스위치 조회 실패 = 전 건 보류(fail-closed) — 목록에는 남겨 사유를 말한다', () =>
    withStubPool(payHandler({ throwFlag: true }), 'services/payment.service', async svc => {
      const r = await svc.listPaymentTargets();
      assert.strictEqual(r.items.length, 1);
      assert.strictEqual(r.items[0].issues[0], 'advertiser_payout_unknown');
      assert.strictEqual(r.items[0].payable, false);
    }));

  await ta('1e ★ 업체 화면 계좌 = 입금 판정이 고른 바로 그 계좌(rowIndex 별)', () =>
    withStubPool(payHandler({ flagOn: true }), 'services/payment.service', async svc => {
      const m = await svc.advertiserPayoutAccounts({ sheetId: 'S1', tabName: 'T1' });
      assert.ok(m instanceof Map);
      const a = m.get(7);
      assert.ok(a, '리뷰 제출·미입금 줄은 계좌가 있어야 한다');
      assert.strictEqual(a.account, ACCT);
      assert.strictEqual(a.holder, '김혜진');
      assert.ok(/우리/.test(a.bank));
      assert.strictEqual(m.get(8), undefined, '대상이 아닌 줄은 계좌가 없다');
      assert.strictEqual(a.phone8, '83540507', '화면 줄과 명의를 맞춰 보기 위해 phone8 을 싣는다');
      assert.strictEqual(a.failed, false);
    }));

  await ta('1f ★★ 회차 만들기 — 화면이 보낸 줄이어도 advertiser_pays 사유로 건너뛴다', () =>
    withStubPool(payHandler({ flagOn: true }), 'services/payment.service', async svc => {
      const r = await svc.createBatch({ bank: 'kbank', rows: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 7 }], by: 't' });
      assert.notStrictEqual(r.ok, true, '담기면 안 된다');
      const sk = (r.skipped || []);
      assert.strictEqual(sk[0] && sk[0].reason, 'advertiser_pays', '건너뛴 사유 = 업체 직접 입금: ' + JSON.stringify(r));
    }));

  await ta('1g ★★ 회차 만들기 — 목록 계산 뒤 스위치가 켜졌으면 잠근 줄에서 다시 보고 건너뛴다', () =>
    withStubPool(payHandler({ flagOn: false, lockFlag: true }), 'services/payment.service', async svc => {
      const r = await svc.createBatch({ bank: 'kbank', rows: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 7 }], by: 't' });
      assert.notStrictEqual(r.ok, true);
      assert.strictEqual(r.skipped[0].reason, 'advertiser_pays');
    }));
  await ta('1h ★★ 회차 만들기 — 작업표 입금 칸에 이미 날짜가 있으면(장부가 늦은 경우) 담지 않는다', () =>
    withStubPool(payHandler({ flagOn: false, paidCell: '10/15' }), 'services/payment.service', async svc => {
      const r = await svc.createBatch({ bank: 'kbank', rows: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 7 }], by: 't' });
      assert.notStrictEqual(r.ok, true);
      assert.strictEqual(r.skipped[0].reason, 'already_paid');
    }));

  console.log('\n§2 스위치 저장 — 막다른 길을 만들지 않는다');
  const tabRow = (o) => (sql) => {
    if (/FROM tab_configs tc WHERE tc\.sheet_id/.test(sql)) return { rows: o.noTab ? [] : [{ sheetless: o.sheetless !== false, tabGid: '1',
      advertiserNames: o.adv === undefined ? ['스마트윈', '스마트윈2'] : (o.adv ? [o.adv] : null) }] };
    if (/UPDATE tab_configs SET advertiser_payout/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  };
  await ta('2a 시트 기반 작업은 켜지 않는다(업체 입금일 기록 창구가 무시트 전용)', () =>
    withStubPool(tabRow({ sheetless: false }), 'services/advertiserPayout.service', async (svc, calls) => {
      const r = await svc.setAdvertiserPayout({ sheetId: 'S', tabName: 'T', enabled: true, by: 'a' });
      assert.strictEqual(r.error, 'not_sheetless');
      assert.ok(!calls.some(c => /UPDATE/.test(c.sql)), '쓰기 0건');
    }));
  await ta('2b 소유 업체가 없는 작업은 켜지 않는다(계좌를 볼 업체가 없다)', () =>
    withStubPool(tabRow({ adv: null }), 'services/advertiserPayout.service', async svc => {
      const r = await svc.setAdvertiserPayout({ sheetId: 'S', tabName: 'T', enabled: true, by: 'a' });
      assert.strictEqual(r.error, 'no_advertiser');
    }));
  await ta('2c 켜기 — 누가 켰는지 남긴다', () =>
    withStubPool(tabRow({}), 'services/advertiserPayout.service', async (svc, calls) => {
      const r = await svc.setAdvertiserPayout({ sheetId: 'S', tabName: 'T', enabled: true, by: '관리자' });
      assert.strictEqual(r.ok, true); assert.strictEqual(r.enabled, true); assert.strictEqual(r.advertiserName, '스마트윈');
      assert.deepStrictEqual(r.advertiserNames, ['스마트윈', '스마트윈2'], '연결된 업체 전부를 돌려준다(전부 계좌를 보게 된다)');
      const up = calls.find(c => /UPDATE tab_configs SET advertiser_payout/.test(c.sql));
      assert.deepStrictEqual(up.params, ['S', 'T', true, '관리자']);
    }));
  await ta('2d 끄기는 업체·시트 조건과 무관하게 된다', () =>
    withStubPool(tabRow({ adv: null, sheetless: false }), 'services/advertiserPayout.service', async svc => {
      const r = await svc.setAdvertiserPayout({ sheetId: 'S', tabName: 'T', enabled: false, by: 'a' });
      assert.strictEqual(r.ok, true); assert.strictEqual(r.enabled, false);
    }));

  console.log('\n§3 업체 입금 기록 — 같은 트랜잭션 안에서 다시 본다');
  const svc = require('../src/services/trackB.service');
  const ledger = require('../src/services/sheetlessLedger.service');
  const realRebuild = ledger.rebuildLedgers;
  ledger.rebuildLedgers = async () => ({ ok: true });
  function makePool(sc) {
    const q = [];
    const client = {
      async query(sql, params) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        q.push({ s, params });
        if (/^BEGIN|^ROLLBACK|^COMMIT/.test(s)) return { rows: [] };
        if (/FROM campaign_participants WHERE id=\$1 .* FOR UPDATE/.test(s)) return { rows: [{
          id: 'row-1', seq: 7, source: 'import', order_submission_id: 'os-1', identity_key: 'phone8:83540507',
          phone8: '83540507', recipient_name: '김혜진', option_text: '', submit_col: '리뷰', submit_col2: '입금일',
          row_json: { 번호: '1', 입금일: sc.prev == null ? '' : sc.prev } }] };
        if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: 1 }] };
        if (/SELECT submit_col2 AS h FROM review_index/.test(s)) return { rows: [{ h: '입금일' }] };
        if (/SELECT advertiser_payout FROM tab_configs/.test(s)) return { rows: sc.flag === false ? [{ advertiser_payout: false }] : [{ advertiser_payout: true }] };
        if (/SELECT 1 FROM payment_batch_items/.test(s)) return { rows: sc.ourBatch ? [{ '?column?': 1 }] : [] };
        if (/left\(created_by, length\(\$6\)\) = \$6/.test(s)) { sc.ownPrefix = params[5]; return { rows: sc.ownValue == null ? [] : [{ value_text: sc.ownValue }] }; }
        if (/FROM review_closed_targets/.test(s)) return { rows: sc.closed ? [{ '?column?': 1 }] : [] };
        if (/FROM reviewer_participations/.test(s)) return { rows: [{ review_obligation_status: sc.notSubmitted ? 'pending' : 'fulfilled' }] };
        if (/UPDATE campaign_participants SET row_json/.test(s)) return { rowCount: 1, rows: [] };
        if (/UPDATE participant_edits SET reverted_at/.test(s)) return { rowCount: 1, rows: [] };
        if (/INSERT INTO participant_edits/.test(s)) return { rows: [{ id: 7 }] };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    return {
      q, client, async connect() { return client; },
      async query(sql, params) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        q.push({ s, params });
        if (/COALESCE\(sheetless, FALSE\) AS s FROM tab_configs/.test(s)) return { rows: [{ s: true }] };
        return { rows: [], rowCount: 0 };
      },
    };
  }
  const writes = p => p.q.filter(x => /^(UPDATE|INSERT|DELETE)/.test(x.s));
  const dep = (sc, date, adv = true) => { const p = makePool(sc); svc.__setPoolForTest(p);
    return svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date, by: adv ? '업체#adv_1:스마트윈' : '망고', advertiser: adv, advertiserId: adv ? 'adv_1' : '' }).then(r => ({ r, p, sc })); };
  try {
    await ta('3a 빈 칸에 기록 — 업체 이름으로 편집기록이 남는다', async () => {
      const { r, p } = await dep({ prev: '' }, '2026-10-15');
      assert.strictEqual(r.ok, true); assert.strictEqual(r.value, '10/15');
      const ins = p.q.find(x => /INSERT INTO participant_edits/.test(x.s) && x.params[4] === 'col:입금일');
      assert.strictEqual(ins.params[6], '업체#adv_1:스마트윈', '업체 id 까지 남긴다(같은 이름·여러 업체 구분)');
    });
    await ta('3b ★ 스위치를 끈 뒤의 요청은 거부(쓰기 0건)', async () => {
      const { r, p } = await dep({ prev: '', flag: false }, '2026-10-15');
      assert.strictEqual(r.error, 'advertiser_payout_off'); assert.strictEqual(writes(p).length, 0);
    });
    await ta('3c ★★ 우리 이체 회차에 살아 있는 줄은 거부(이중 입금 차단)', async () => {
      const { r, p } = await dep({ prev: '', ourBatch: true }, '2026-10-15');
      assert.strictEqual(r.error, 'our_payout'); assert.strictEqual(writes(p).length, 0);
    });
    await ta('3d ★★ 우리가 넣은 입금일은 업체가 고치거나 지우지 못한다', async () => {
      const a = await dep({ prev: '10/12', ownValue: null }, '');
      assert.strictEqual(a.r.error, 'not_own_entry'); assert.strictEqual(writes(a.p).length, 0);
      const b = await dep({ prev: '10/12', ownValue: '10/11' }, '2026-10-15');
      assert.strictEqual(b.r.error, 'not_own_entry', '업체 기록이 있어도 지금 칸 값과 다르면(그 뒤 다른 기록) 거부');
    });
    await ta('3e 업체가 넣은 값은 업체가 지울 수 있다 — 소유 판정은 **그 업체 id** 기준', async () => {
      const { r, sc } = await dep({ prev: '10/15', ownValue: '10/15' }, '');
      assert.strictEqual(r.ok, true); assert.strictEqual(r.cleared, true);
      assert.strictEqual(sc.ownPrefix, '업체#adv_1:', '다른 업체의 기록과 섞이지 않게 접두어에 업체 id');
    });
    await ta('3g ★ 리뷰 제출 전 줄에는 새 입금일을 기록하지 못한다(비우기는 된다)', async () => {
      const a = await dep({ prev: '', notSubmitted: true }, '2026-10-15');
      assert.strictEqual(a.r.error, 'review_not_submitted'); assert.strictEqual(writes(a.p).length, 0);
      const c = await dep({ prev: '', closed: true }, '2026-10-15');
      assert.strictEqual(c.r.error, 'review_not_submitted', '미작성 종결 줄도 막는다');
      const b = await dep({ prev: '10/15', ownValue: '10/15', notSubmitted: true }, '');
      assert.strictEqual(b.r.ok, true, '업체가 잘못 넣은 값은 거둬들일 수 있어야 한다');
    });
    await ta('3f 내부 담당자 경로는 종전 그대로(업체 검사를 타지 않는다)', async () => {
      const { r, p } = await dep({ prev: '10/12' }, '', false);
      assert.strictEqual(r.ok, true);
      assert.ok(!p.q.some(x => /SELECT advertiser_payout FROM tab_configs/.test(x.s)));
    });
  } finally { ledger.rebuildLedgers = realRebuild; }

  console.log('\n§4 배선 — 누구에게 무엇이 보이나');
  const tb = read('src/services/trackB.service.js');
  const routes = read('src/routes/trackB.routes.js');
  const html = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'workdesk.html'), 'utf8');
  await ta('4a ★★ 계좌 칸은 소유 업체 대표 링크만 — 브랜드 세션·남의 업체(작업보드는 모든 업체가 열람) 제외', () => {
    assert.match(tb, /role === 'advertiser' && !archived && advHeaders && !brandId && advertiserId && meta\[0\] && meta\[0\]\.advertiserPayout === true\s*\n\s*&& meta\[0\]\.sheetless === true && await advOwnsTab\(\)/);
    // 명의(phone8)까지 맞아야 싣는다 — 줄 재배정 시 남의 계좌 노출 방지
    assert.match(tb, /String\(a0\.phone8\) === String\(r\.phone8 == null \? '' : r\.phone8\)/);
    // 업체 응답 meta 에서 내부 정산 값 제거
    assert.match(tb, /if \(role === 'advertiser'\) \{ delete _resMeta\.depositName; delete _resMeta\.tabReviewFee; delete _resMeta\.tabTransferBank; delete _resMeta\.advertiserPayout; \}/);
  });
  await ta('4b ★★ 원본 은행·계좌·예금주 열은 계속 차단 — 세 칸은 입금 판정 결과로만 채운다', () => {
    assert.match(tb, /\|\| \/은행\|bank\/\.test\(key\)/);
    assert.match(tb, /if \(advPayout && Object\.prototype\.hasOwnProperty\.call\(ADV_PAYOUT_FIELD, h\)\) \{[\s\S]{0,400}?const a0 = advPayout\.accounts\.get\(Number\(r\.seq\)\);/);
    assert.match(tb, /advertiserPayoutAccounts\(\{ sheetId, tabName \}\)/);
  });
  await ta('4c 잠금 재료 조회 실패 = 기록 창구 전부 잠금(fail-closed)', () => {
    assert.match(tb, /advPayout\.lockAll = 'unknown';/);
    assert.match(tb, /if \(!tabPaidHeader \|\| writeHeader !== tabPaidHeader\) advPayout\.lockAll = 'column_mismatch';/);
    assert.match(tb, /: advPayout\.lockAll \? advPayout\.lockAll/);
    assert.match(tb, /: \(!paidVal && !reviewSubmitted\) \? 'not_submitted'/);
  });
  await ta('4d 라우트 — 브랜드 세션 403 · 소유 스코프 · 스위치는 관리자 전용', () => {
    const dd = routes.slice(routes.indexOf("router.post('/workdesk/deposit-date'"), routes.indexOf("router.get('/workdesk/cell-edits'"));
    assert.match(dd, /req\.admin\.brand_id\) return res\.status\(403\)/);
    assert.match(dd, /await _ensureThreadScope\(req, sheetId, tabName\)/);
    assert.match(dd, /advertiser \? \('업체#' \+ advertiserId \+ ':'/);
    assert.match(routes, /router\.post\('\/payment\/advertiser-payout', authMiddleware, adminOrMasterMiddleware/);
  });
  await ta('4e 업체 렌즈는 화이트리스트라 입금 주체(advertiserPayout)가 업체 작업 조건에 나가지 않는다', () => {
    const lens = tb.slice(tb.indexOf('function _condAdvertiserLens('), tb.indexOf('function _condAdvertiserLens(') + 4000);
    assert.ok(!/advertiserPayout/.test(lens));
  });
  await ta('4f 부팅 프리플라이트 등록(없으면 입금대상 추출이 전 건 보류)', () => {
    assert.match(read('index.js'), /\['tab_configs', 'advertiser_payout'\]/);
    assert.ok(fs.existsSync(path.join(ROOT, 'migrations', '189_tab_advertiser_payout.sql')));
  });
  await ta('4g 화면 — 업체 메뉴 사유 문구가 서버 잠금 코드와 1:1, 내부 경로는 종전', () => {
    const sb = { STATE: { role: 'advertiser', wd: { advertiserPayout: { on: true } } }, _isInternalRole: () => false };
    vm.createContext(sb);
    vm.runInContext(html.match(/const _ADV_DEPOSIT_LOCK=\{[\s\S]*?\n\};/)[0].replace('const _ADV_DEPOSIT_LOCK', 'var _ADV_DEPOSIT_LOCK'), sb);
    vm.runInContext(html.match(/function _isAdvPayout\(\)\{[^\n]*\}/)[0], sb);
    vm.runInContext(html.match(/function _depositMenuBlockReason\(td, row\)\{[\s\S]*?\n\}/)[0], sb);
    const f = vm.runInContext('_depositMenuBlockReason', sb);
    assert.strictEqual(f({}, { depositEditable: true }), '');
    for (const k of ['our_payout', 'not_own', 'ambiguous', 'no_anchor', 'no_column', 'unknown', 'not_submitted', 'column_mismatch']) {
      assert.ok(f({}, { depositEditable: false, depositLock: k }).length > 5, '사유 문구 없음: ' + k);
    }
    sb.STATE = { role: 'advertiser', wd: {} };
    assert.match(f({}, { depositEditable: true }), /내부 담당자만/, '스위치가 꺼진 작업은 업체에게 열리지 않는다');
  });

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
