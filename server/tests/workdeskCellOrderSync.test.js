/**
 * 회귀가드 — 작업보드 그리드 셀 편집 → 주문 원장(order_submissions) through-write
 *
 * 왜 필요한가(실사고): 관리자가 작업보드 표에서 리뷰어 연락처 오타를 고쳐도, 그 수정은
 * `participant_edits`(표시 전용 오버레이)에만 저장되고 `order_submissions`·`review_index`
 * (리뷰어 "리뷰 내역" 검색이 실제로 보는 데이터)는 전혀 바뀌지 않았다 — 표에는 정정된 값이
 * 보이는데 리뷰어 화면은 여전히 옛 값을 봐서 참여가 "안 보이는" 상태가 됐다.
 *
 * 수정 = `syncCellToOrderIdentity`(orderLedger.service.js) — editWorkdeskRow 가 오버레이를
 * 커밋한 **뒤**, 라우트 레벨에서 별도로 호출해 신원 5필드와 결제금액을
 * 실제 주문 원장 + (무시트 탭이면) 작업표 row_json 까지 갱신한다.
 *
 * 이 가드가 지키는 것:
 *  §1 역할 화이트리스트 — 신원 5필드와 결제금액만 동기화, 은행·계좌 등은 대상 아님
 *  §2 킬스위치 · 사전조건 (env 는 호출마다 읽는다 — child process 불필요)
 *  §3 취소/존재하지 않는 주문 = 쓰기 0건
 *  §4 무시트 경로 — 편집된 그 헤더 한 칸만 갱신(전체 재기입 아님) · phone8 정규화 · TOCTOU
 *  §5 시트기반 경로 — 큐(order_update) 페이로드 정확성
 *  §6 DB 컬럼매핑 오버라이드 대조(userId/user_id 표기 불일치 버그 회귀)
 *  §7 정적 — 위험한 재사용(writeOrderToWorktable 전체 재기입·renumberTabInTx) 부재
 *  §8 라우트 배선 — POST /workdesk/edit 가 커밋 후에만·내부 역할에만·응답에 결과를 싣는다
 *  §9 editWorkdeskRow 반환값 — orderSubmissionId·priorValue
 *  §10 프론트 — 실패 시에만 경고 토스트(성공/미시도는 조용)
 *
 * 실행: node tests/workdeskCellOrderSync.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}

const SRC = p => path.join(__dirname, '..', 'src', p);
const read = p => fs.readFileSync(SRC(p), 'utf8');
const readRoot = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

/* 스텁 pool 로 orderLedger.service 를 실행한다.
 * ★ `getPool()`(orderLedger.service)와 `withJobLock`(jobLock.js) 는 둘 다 `require('../db/pool')` 로
 *   **같은 싱글턴 객체**를 받으므로, 그 객체에 query/connect 를 얹으면 양쪽 모두 스텁이 적용된다. */
async function withStubPool(handler, run) {
  const poolPath = require.resolve(SRC('db/pool'));
  const svcPath = require.resolve(SRC('services/orderLedger.service'));
  const calls = [];
  const stub = {
    query: async (sql, params) => { calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return handler(sql, params, calls) || { rows: [], rowCount: 0 }; },
    connect: async () => ({
      query: async (sql, params) => {
        const s = String(sql);
        if (/pg_try_advisory_lock/.test(s)) return { rows: [{ ok: true }] };
        if (/pg_advisory_unlock/.test(s)) return { rows: [{}] };
        return stub.query(sql, params);
      },
      release() {},
    }),
  };
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  delete require.cache[svcPath];
  try { return await run(require(svcPath), calls); }
  finally {
    delete require.cache[svcPath];
    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
  }
}

/** `isSheetless`(utils/sheetlessScope) 를 강제해 무시트/시트기반 경로를 확정적으로 고른다. */
async function withIsSheetless(value, run) {
  const sless = require(SRC('utils/sheetlessScope'));
  const orig = sless.isSheetless;
  sless.isSheetless = async () => value;
  try { return await run(); } finally { sless.isSheetless = orig; }
}

/** 무시트=true + 장부 재생성(rebuildLedgers)은 성공으로 스텁 — §4/§6 의 "그 뒤" 성공 경로 검증용.
 *  ★ rebuildLedgers 는 실제 구현(review_index 재파싱 등)이라 스텁 pool 만으로는 끝까지 못 돈다.
 *    이 헬퍼로 조용히 통과시키고, 재생성 실패 자체를 검증하는 테스트(4f)는 자기 자리에서 따로 덮어쓴다. */
async function withSheetlessOk(run) {
  const sless = require(SRC('utils/sheetlessScope'));
  const led = require(SRC('services/sheetlessLedger.service'));
  const origSless = sless.isSheetless;
  const origRebuild = led.rebuildLedgers;
  sless.isSheetless = async () => true;
  led.rebuildLedgers = async () => ({});
  try { return await run(); }
  finally { sless.isSheetless = origSless; led.rebuildLedgers = origRebuild; }
}

const HEADERS = ['번호', '구매일자', '주문자', '수취인', '쿠팡ID', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '주문번호', '리뷰', '입금', '비고'];

/** raw_sheet_tabs 조회 응답을 만드는 헬퍼 */
function rawTabsRow(tabGid) {
  return { detected_headers: HEADERS, tab_gid: tabGid || 'g1' };
}

(async function main() {

/* ══════════════ §1 역할 화이트리스트 ══════════════ */
console.log('\n§1 역할 화이트리스트 — 신원 5필드와 결제금액만 동기화 대상');

t('1a 신원 5개 역할과 결제금액 → order_submissions 컬럼명이 정확하다', () => {
  const svc = require(SRC('services/orderLedger.service'));
  // 함수 자체는 export 안 됐지만(_OS_COL_BY_ROLE), classifyHeaders 를 통해 간접 검증한다.
  const { classifyHeaders } = require(SRC('utils/worktableTemplate'));
  const roles = classifyHeaders(HEADERS).map(c => c.role);
  assert.strictEqual(roles[2], 'orderer');
  assert.strictEqual(roles[3], 'recipient');
  assert.strictEqual(roles[4], 'userId');
  assert.strictEqual(roles[5], 'phone');
  assert.strictEqual(roles[6], 'address');
  // 대상 아닌 역할들
  assert.strictEqual(roles[7], 'bank');
  assert.strictEqual(roles[8], 'account');
  assert.strictEqual(roles[9], 'depositor');
  assert.strictEqual(roles[10], 'price');
  assert.strictEqual(roles[11], 'orderNum');
  assert.strictEqual(roles[14], 'memo');
});

await ta('1b ★ 은행·계좌·주문번호·비고 열 편집은 role_not_syncable — 쓰기 0건', async () => {
  process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';
  await withStubPool(
    (sql) => { if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] }; return { rows: [], rowCount: 0 }; },
    async (svc, calls) => {
      for (const header of ['은행', '계좌번호', '예금주', '주문번호', '비고']) {
        calls.length = 0;
        const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header, value: 'x', orderSubmissionId: 'o1' });
        assert.strictEqual(out.attempted, true, header);
        assert.strictEqual(out.ok, false, header);
        assert.strictEqual(out.reason, 'role_not_syncable', header);
        assert.ok(!calls.some(c => /UPDATE order_submissions|UPDATE campaign_participants/.test(c.sql)), header + ' — 쓰기 쿼리가 나가면 안 된다');
      }
    });
  delete process.env.ORDER_LEDGER_WRITE_ENABLED;
});

await ta('1c ★ 결제금액은 쉼표/원 표기를 원화 정수로 정규화해 원장과 무시트 작업표에 함께 쓴다', async () => {
  process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';
  await withSheetlessOk(() => withStubPool(
    (sql) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
      if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (svc, calls) => {
      const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '결제금액', value: '13,090원', orderSubmissionId: 'o1' });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      assert.strictEqual(out.role, 'price');
      const os = calls.find(c => /UPDATE order_submissions/.test(c.sql));
      const cp = calls.find(c => /UPDATE campaign_participants/.test(c.sql));
      assert.strictEqual(os.params[1], '13090');
      assert.strictEqual(cp.params[1], '13090');
      assert.ok(/price\s+= CASE WHEN \$3 = 'price' THEN \$2 ELSE price END/.test(cp.sql));
    }));
  delete process.env.ORDER_LEDGER_WRITE_ENABLED;
});

await ta('1d ★ 결제금액이 원화 정수가 아니면 원장/작업표에 쓰지 않는다', async () => {
  process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';
  await withStubPool(
    (sql) => { if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] }; return { rows: [], rowCount: 0 }; },
    async (svc, calls) => {
      const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '결제금액', value: '-13090', orderSubmissionId: 'o1' });
      assert.strictEqual(out.reason, 'invalid_price');
      assert.ok(!calls.some(c => /UPDATE order_submissions|UPDATE campaign_participants/.test(c.sql)));
    });
  delete process.env.ORDER_LEDGER_WRITE_ENABLED;
});

/* ══════════════ §2 킬스위치 · 사전조건 ══════════════ */
console.log('\n§2 킬스위치 · 사전조건');

await ta('2a ORDER_LEDGER_WRITE_ENABLED 미설정이면 시도조차 안 한다', async () => {
  delete process.env.ORDER_LEDGER_WRITE_ENABLED;
  delete process.env.WORKDESK_CELL_ORDER_SYNC;
  const svc = require(SRC('services/orderLedger.service'));
  delete require.cache[require.resolve(SRC('services/orderLedger.service'))];
  const svc2 = require(SRC('services/orderLedger.service'));
  const out = await svc2.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: 'x', orderSubmissionId: 'o1' });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.reason, 'ledger_write_disabled');
});

await ta('2b ★ WORKDESK_CELL_ORDER_SYNC=0 이면 전체 게이트(ORDER_LEDGER_WRITE_ENABLED)가 켜져 있어도 끈다', async () => {
  process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';
  process.env.WORKDESK_CELL_ORDER_SYNC = '0';
  const svc = require(SRC('services/orderLedger.service'));
  const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: 'x', orderSubmissionId: 'o1' });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.reason, 'disabled');
  delete process.env.WORKDESK_CELL_ORDER_SYNC;
});

await ta('2c 필수 인자 누락은 bad_request', async () => {
  process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';
  const svc = require(SRC('services/orderLedger.service'));
  const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: 'x' /* orderSubmissionId 없음 */ });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.reason, 'bad_request');
});

await ta('2d 감지 헤더가 비어 있으면(raw_sheet_tabs 미스캔) no_headers', async () => {
  await withStubPool(
    () => ({ rows: [] }),
    async (svc) => {
      const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: 'x', orderSubmissionId: 'o1' });
      assert.strictEqual(out.attempted, true);
      assert.strictEqual(out.reason, 'no_headers');
    });
});

await ta('2e 그 탭에 그 헤더가 실재하지 않으면 header_not_found', async () => {
  await withStubPool(
    (sql) => { if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] }; return { rows: [] }; },
    async (svc) => {
      const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '없는헤더', value: 'x', orderSubmissionId: 'o1' });
      assert.strictEqual(out.reason, 'header_not_found');
    });
});

/* ══════════════ §3 취소·존재하지 않는 주문 ══════════════ */
console.log('\n§3 취소된(또는 없는) 주문 — 쓰기 0건');

await ta('3a ★ deleted_at IS NOT NULL(취소된 주문) — UPDATE 가 0행 → 그 이상 아무 것도 쓰지 않는다', async () => {
  await withStubPool(
    (sql) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [] };   // deleted_at IS NULL 조건에 안 걸림
      return { rows: [], rowCount: 0 };
    },
    async (svc, calls) => {
      const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: '01012345678', orderSubmissionId: 'o1' });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.reason, 'order_cancelled_or_missing');
      assert.ok(!calls.some(c => /UPDATE campaign_participants/.test(c.sql)), '무시트 갱신이 나가면 안 된다');
      assert.ok(!calls.some(c => /jsonb_set/.test(c.sql)));
    });
});

t('3b ★★ UPDATE order_submissions 문장 자체가 deleted_at IS NULL 조건을 건다(문자열 그대로 고정)', () => {
  const body = read('services/orderLedger.service.js').slice(
    read('services/orderLedger.service.js').indexOf('async function syncCellToOrderIdentity'));
  const upd = body.slice(0, body.indexOf('RETURNING id, sheet_id, tab_name'));
  assert.ok(/WHERE id = \$1 AND sheet_id = \$4 AND tab_name = \$5 AND deleted_at IS NULL/.test(upd),
    'UPDATE 절에 현재 작업의 sheet/tab + deleted_at IS NULL 조건이 없다');
});

await ta('3c 편집 시점에 알던 탭과 지금 주문이 속한 탭이 다르면(재연결됨) tab_mismatch — 쓰기 중단', async () => {
  await withStubPool(
    (sql) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'OTHER_TAB' }] };
      return { rows: [], rowCount: 0 };
    },
    async (svc, calls) => {
      const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: '01012345678', orderSubmissionId: 'o1' });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.reason, 'tab_mismatch');
      assert.ok(!calls.some(c => /UPDATE campaign_participants/.test(c.sql)));
    });
});

/* ══════════════ §4 무시트 경로 ══════════════ */
console.log('\n§4 무시트 탭 — 편집된 그 헤더 한 칸만 갱신 · phone8 정규화 · TOCTOU');

await ta('4a ★★ row_json 에 그 헤더 키 하나만 jsonb_set 으로 갈아끼운다(전체 재기입 아님)', async () => withSheetlessOk(() =>
  withStubPool(
    (sql, params) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
      if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (svc, calls) => {
      const out = await svc.syncCellToOrderIdentity({
        sheetId: 'S1', tabName: 'T1', header: '연락처', value: '010-7728-0891', orderSubmissionId: 'o1',
      });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      assert.strictEqual(out.mode, 'sheetless');
      const cp = calls.find(c => /UPDATE campaign_participants/.test(c.sql));
      assert.ok(cp, 'campaign_participants UPDATE 가 나가지 않았다');
      assert.ok(/jsonb_set\(COALESCE\(row_json/.test(cp.sql), 'row_json 전체 교체가 아니라 jsonb_set 이어야 한다');
      assert.strictEqual(cp.params[0], '연락처', '갱신 대상 키가 편집된 헤더 하나여야 한다');
      assert.strictEqual(cp.params[1], '010-7728-0891');
      assert.ok(/order_submission_id = \$7::uuid/.test(cp.sql), '★ TOCTOU — 앵커(주문id)로 대상 행을 확정해야 한다');
    })));

await ta('4b ★★ phone8 정규화 — 연락처 편집이면 phone8 컬럼도 뒤 8자리로 함께 갱신된다', async () => {
  await withSheetlessOk(() => withStubPool(
    (sql) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
      if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (svc, calls) => {
      await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: '010-7728-0891', orderSubmissionId: 'o1' });
      const cp = calls.find(c => /UPDATE campaign_participants/.test(c.sql));
      assert.strictEqual(cp.params[3], '77280891', 'toPhone8("010-7728-0891") = "77280891" 이어야 한다');
    }));
});

await ta('4c 연락처가 아닌 헤더(예 수취인)를 고치면 phone8 파라미터는 null(건드리지 않는다)', async () => {
  await withSheetlessOk(() => withStubPool(
    (sql) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
      if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (svc, calls) => {
      await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '수취인', value: '김민혜', orderSubmissionId: 'o1' });
      const cp = calls.find(c => /UPDATE campaign_participants/.test(c.sql));
      assert.strictEqual(cp.params[3], null);
    }));
});

await ta('4d ★ TOCTOU — 그 사이 다른 줄로 재배정됐으면(rowCount=0) row_reassigned, 값을 되돌리지 않는다', async () => {
  await withSheetlessOk(() => withStubPool(
    (sql) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
      if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    async (svc) => {
      const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: '01011112222', orderSubmissionId: 'o1' });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.reason, 'row_reassigned');
    }));
});

await ta('4e ★ 중복(rowCount>1) 이면 ambiguous_row — 여러 줄에 동시 반영하지 않는다', async () => {
  await withSheetlessOk(() => withStubPool(
    (sql) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
      if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 2 };
      return { rows: [], rowCount: 0 };
    },
    async (svc) => {
      const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: '01011112222', orderSubmissionId: 'o1' });
      assert.strictEqual(out.reason, 'ambiguous_row');
    }));
});

await ta('4f 장부 재생성(rebuildLedgers) 실패는 ledger_rebuild_failed 로 사유를 말한다(조용히 넘기지 않는다)', async () => {
  await withIsSheetless(true, () => withStubPool(
    (sql) => {
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
      if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
      if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async (svc) => {
      const led = require(SRC('services/sheetlessLedger.service'));
      const orig = led.rebuildLedgers;
      led.rebuildLedgers = async () => { throw new Error('boom'); };
      try {
        const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: '01011112222', orderSubmissionId: 'o1' });
        assert.strictEqual(out.reason, 'ledger_rebuild_failed');
      } finally { led.rebuildLedgers = orig; }
    }));
});

/* ══════════════ §5 시트기반 경로 ══════════════ */
console.log('\n§5 시트기반 탭 — 큐(order_update) 페이로드');

await ta('5a ★ 무시트가 아니면 즉시 쓰지 않고 order_update 큐로 위임한다(page 안전 회차)', async () => {
  const sless = require(SRC('utils/sheetlessScope'));
  const origIsSless = sless.isSheetless;
  sless.isSheetless = async () => false;
  const queue = require(SRC('services/syncQueue.service'));
  const origEnqueue = queue.enqueue;
  let captured = null;
  queue.enqueue = async (type, payload) => { captured = { type, payload }; };
  const pump = require(SRC('jobs/queuePump'));
  const origKick = pump.kickQueuePump;
  let kicked = 0;
  pump.kickQueuePump = () => { kicked++; };
  try {
    await withStubPool(
      (sql) => {
        if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
        if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
        return { rows: [], rowCount: 0 };
      },
      async (svc, calls) => {
        const out = await svc.syncCellToOrderIdentity({
          sheetId: 'S1', tabName: 'T1', header: '연락처', value: '01077280891', oldValue: '01070891728', orderSubmissionId: 'o1',
        });
        assert.strictEqual(out.ok, true, JSON.stringify(out));
        assert.strictEqual(out.mode, 'queued');
        assert.ok(!calls.some(c => /UPDATE campaign_participants/.test(c.sql)), '시트기반 탭에서 campaign_participants 를 직접 쓰면 안 된다');
      });
    assert.ok(captured, 'enqueue 가 호출되지 않았다');
    assert.strictEqual(captured.type, 'order_update');
    assert.strictEqual(captured.payload.orderSubmissionId, 'o1');
    assert.ok(Array.isArray(captured.payload.edits) && captured.payload.edits.length === 1);
    assert.strictEqual(captured.payload.edits[0].field, 'phone');
    assert.strictEqual(captured.payload.edits[0].oldValue, '01070891728');
    assert.strictEqual(captured.payload.edits[0].newValue, '01077280891');
    assert.ok(kicked >= 1, '★ 큐에 넣은 뒤 즉시 펌프해야 시트 반영이 지연되지 않는다');
  } finally {
    sless.isSheetless = origIsSless; queue.enqueue = origEnqueue; pump.kickQueuePump = origKick;
  }
});

await ta('5b oldValue 미지정이면 빈 문자열로 채운다(큐 대조 안전값)', async () => {
  const sless = require(SRC('utils/sheetlessScope'));
  const origIsSless = sless.isSheetless;
  sless.isSheetless = async () => false;
  const queue = require(SRC('services/syncQueue.service'));
  const origEnqueue = queue.enqueue;
  let captured = null;
  queue.enqueue = async (type, payload) => { captured = payload; };
  const pump = require(SRC('jobs/queuePump'));
  const origKick = pump.kickQueuePump; pump.kickQueuePump = () => {};
  try {
    await withStubPool(
      (sql) => {
        if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow()] };
        if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
        return { rows: [], rowCount: 0 };
      },
      async (svc) => {
        await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '주소', value: '새 주소', orderSubmissionId: 'o1' });
      });
    assert.strictEqual(captured.edits[0].oldValue, '');
  } finally { sless.isSheetless = origIsSless; queue.enqueue = origEnqueue; pump.kickQueuePump = origKick; }
});

/* ══════════════ §6 DB 컬럼매핑 오버라이드 대조 ══════════════ */
console.log('\n§6 컬럼매핑 오버라이드 — userId/user_id 표기 불일치 버그 회귀');

await ta('6a 오버라이드가 지금 편집한 칸과 다른 위치를 가리키면 동기화하지 않는다(column_mapping_mismatch)', async () => {
  const cm = require(SRC('services/columnMapping.service'));
  const origGet = cm.getTabColumnIndexMap;
  cm.getTabColumnIndexMap = async () => new Map([['phone', { colIndex: 99, header: '엉뚱한칸' }]]);
  try {
    await withStubPool(
      (sql) => { if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow('g1')] }; return { rows: [], rowCount: 0 }; },
      async (svc, calls) => {
        const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: 'x', orderSubmissionId: 'o1' });
        assert.strictEqual(out.reason, 'column_mapping_mismatch');
        assert.ok(!calls.some(c => /UPDATE order_submissions/.test(c.sql)));
      });
  } finally { cm.getTabColumnIndexMap = origGet; }
});

await ta('6b 오버라이드가 같은 위치를 가리키면 정상 진행한다', async () => {
  const cm = require(SRC('services/columnMapping.service'));
  const origGet = cm.getTabColumnIndexMap;
  cm.getTabColumnIndexMap = async () => new Map([['phone', { colIndex: 5, header: '연락처' }]]);   // idx5 = '연락처'
  try {
    await withSheetlessOk(() => withStubPool(
      (sql) => {
        if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow('g1')] };
        if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
        if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
        if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async (svc) => {
        const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: 'x', orderSubmissionId: 'o1' });
        assert.strictEqual(out.ok, true, JSON.stringify(out));
      }));
  } finally { cm.getTabColumnIndexMap = origGet; }
});

await ta('6c ★★★ 회귀 — 채널 ID(userId) 열의 오버라이드는 role("userId")이 아니라 컬럼명("user_id")로 조회해야 한다', () => {
  // 이 테스트는 정적이다: 소스에서 조회 키가 osCol(=_OS_COL_BY_ROLE 파생, snake_case)인지 확인한다.
  //   과거 버그: dbColMap.get(role) 로 조회하면 role='userId'(camelCase)라 항상 undefined 를 돌려받아
  //   불일치 검사 자체가 조용히 무력화된다(6d 가 그 결과를 실행으로 증명).
  const body = read('services/orderLedger.service.js');
  const i = body.indexOf('async function syncCellToOrderIdentity');
  const fn = body.slice(i, body.indexOf('async function claimRow', i));
  assert.ok(/dbColMap\.get\(osCol\)/.test(fn), 'dbColMap.get(osCol) 이어야 한다(발견된 버그: get(role) 은 항상 undefined)');
  assert.ok(!/dbColMap\.get\(role\)/.test(fn), 'role(camelCase) 로 조회하면 컬럼매핑 표(snake_case)와 어긋난다');
});

await ta('6d ★★★ 회귀 실행 — userId 열 편집 시 "user_id" 오버라이드가 실제로 대조된다(다르면 막힌다)', async () => {
  const cm = require(SRC('services/columnMapping.service'));
  const origGet = cm.getTabColumnIndexMap;
  // '쿠팡ID' 는 idx4 인데, 오버라이드는 idx9(다른 곳)를 user_id 라 말한다 → 불일치로 막혀야 한다.
  cm.getTabColumnIndexMap = async () => new Map([['user_id', { colIndex: 9, header: '엉뚱' }]]);
  try {
    await withStubPool(
      (sql) => { if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [rawTabsRow('g1')] }; return { rows: [], rowCount: 0 }; },
      async (svc, calls) => {
        const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '쿠팡ID', value: 'x', orderSubmissionId: 'o1' });
        assert.strictEqual(out.reason, 'column_mapping_mismatch',
          '고쳐지지 않았다면 get("userId")===undefined 라 이 대조가 조용히 통과해버린다');
        assert.ok(!calls.some(c => /UPDATE order_submissions/.test(c.sql)));
      });
  } finally { cm.getTabColumnIndexMap = origGet; }
});

await ta('6e tabGid 가 없으면 오버라이드 조회 자체를 건너뛰고 진행한다(그 탭은 아직 DB 매핑 대상 아님)', async () => {
  const cm = require(SRC('services/columnMapping.service'));
  const origGet = cm.getTabColumnIndexMap;
  let called = false;
  cm.getTabColumnIndexMap = async () => { called = true; return null; };
  try {
    await withSheetlessOk(() => withStubPool(
      (sql) => {
        if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [{ detected_headers: HEADERS, tab_gid: '' }] };
        if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
        if (/UPDATE order_submissions/.test(sql)) return { rows: [{ id: 'o1', sheet_id: 'S1', tab_name: 'T1' }] };
        if (/UPDATE campaign_participants/.test(sql)) return { rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async (svc) => {
        const out = await svc.syncCellToOrderIdentity({ sheetId: 'S1', tabName: 'T1', header: '연락처', value: 'x', orderSubmissionId: 'o1' });
        assert.strictEqual(out.ok, true, JSON.stringify(out));
      }));
    assert.strictEqual(called, false, 'tabGid 없으면 getTabColumnIndexMap 을 호출하지 않아야 한다');
  } finally { cm.getTabColumnIndexMap = origGet; }
});

/* ══════════════ §7 정적 — 위험한 재사용 부재 ══════════════ */
console.log('\n§7 정적 — writeOrderToWorktable(전체 재기입)·renumberTabInTx 재사용 금지');

t('7a syncCellToOrderIdentity 는 writeOrderToWorktable 을 부르지 않는다(전체 행 재기입 위험 회피)', () => {
  const body = read('services/orderLedger.service.js');
  const i = body.indexOf('async function syncCellToOrderIdentity');
  const fn = body.slice(i, body.indexOf('async function claimRow', i));
  assert.ok(!/writeOrderToWorktable/.test(fn));
});

t('7b renumberTabInTx 를 부르지 않는다(번호 재부여는 이 함수의 일이 아니다)', () => {
  const body = read('services/orderLedger.service.js');
  const i = body.indexOf('async function syncCellToOrderIdentity');
  const fn = body.slice(i, body.indexOf('async function claimRow', i));
  assert.ok(!/renumberTabInTx/.test(fn));
});

t('7c order_ledger:<id> 락 이름 관용구를 그대로 쓴다(다른 이름을 쓰면 기존 6개 락과 해시충돌 재검토가 필요하다)', () => {
  const body = read('services/orderLedger.service.js');
  assert.ok(/withJobLock\('order_ledger:' \+ orderSubmissionId/.test(body));
});

/* ══════════════ §8 라우트 배선 ══════════════ */
console.log('\n§8 라우트 — POST /workdesk/edit 는 커밋 후에만·내부 역할에만 through-write 한다');

t('8a ★ through-write 는 col: 필드 + 성공(out.ok) + orderSubmissionId 존재 조건에서만 시도한다', () => {
  const body = read('routes/trackB.routes.js');
  const i = body.indexOf("router.post('/workdesk/edit'");
  const fn = body.slice(i, body.indexOf("router.post('/workdesk/revert'"));
  assert.ok(/out\.ok && out\.orderSubmissionId/.test(fn));
  assert.ok(/field\.indexOf\('col:'\) === 0/.test(fn));
});

t('8b ★★ 광고주(advertiser)는 through-write 조건에서 명시적으로 제외된다(내부 역할만)', () => {
  const body = read('routes/trackB.routes.js');
  const i = body.indexOf("router.post('/workdesk/edit'");
  const fn = body.slice(i, body.indexOf("router.post('/workdesk/revert'"));
  assert.ok(/role === 'master' \|\| role === 'admin' \|\| role === 'staff'/.test(fn));
  assert.ok(!/role === 'advertiser'/.test(fn), 'advertiser 를 허용 목록에 넣으면 안 된다');
});

t('8c 편집 자체가 실패(out.ok=false)면 through-write 를 시도하지 않는다(가드 순서)', () => {
  const body = read('routes/trackB.routes.js');
  const i = body.indexOf("router.post('/workdesk/edit'");
  const fn = body.slice(i, body.indexOf("router.post('/workdesk/revert'"));
  const guardIdx = fn.indexOf('if (out.ok && out.orderSubmissionId');
  const editIdx = fn.indexOf('svc.editWorkdeskRow');
  assert.ok(editIdx > 0 && guardIdx > editIdx, 'through-write 게이트는 editWorkdeskRow 호출 뒤에 있어야 한다');
});

t('8c-1 ★ 결제금액은 오버레이 저장 전에 같은 정규화·검증을 거친다(실패 시 금액 분리 방지)', () => {
  const body = read('routes/trackB.routes.js');
  const i = body.indexOf("router.post('/workdesk/edit'");
  const fn = body.slice(i, body.indexOf("router.post('/workdesk/revert'"));
  assert.ok(/normalizeWorkdeskColumnValue\(\{ sheetId, tabName, header: field\.slice\(4\), value \}\)/.test(fn));
  assert.ok(/normalized\.isPrice && !normalized\.ok/.test(fn));
  assert.ok(/value: normalizedValue/.test(fn));
  assert.ok(/결제금액은 0 이상의 원화 정수/.test(fn));
});

t('8c-2 ★ 상품가격·금액·price 별칭도 표준 분류기 기준으로 금액 검증한다', () => {
  const body = read('services/orderLedger.service.js');
  const i = body.indexOf('async function normalizeWorkdeskColumnValue');
  const fn = body.slice(i, body.indexOf('async function syncCellToOrderIdentity', i));
  assert.ok(/classifyHeaders\(headers\)/.test(fn));
  assert.ok(/role !== 'price'/.test(fn));
  assert.ok(/normalizeWorkdeskPrice\(value\)/.test(fn));
});

t('3d ★ 다른 작업으로 재연결된 주문은 UPDATE 조건에서 차단한다(금액 오염 방지)', () => {
  const body = read('services/orderLedger.service.js');
  const i = body.indexOf('async function syncCellToOrderIdentity');
  const fn = body.slice(i, body.indexOf('async function claimRow', i));
  assert.ok(/WHERE id = \$1 AND sheet_id = \$4 AND tab_name = \$5 AND deleted_at IS NULL/.test(fn));
});

t('8d 예외를 삼키지 않고 응답에 실패 사유를 싣는다(조용한 실패 금지)', () => {
  const body = read('routes/trackB.routes.js');
  const i = body.indexOf("router.post('/workdesk/edit'");
  const fn = body.slice(i, body.indexOf("router.post('/workdesk/revert'"));
  assert.ok(/catch \(e\) {\s*throughWrite = { attempted: true, ok: false, reason: 'exception'/.test(fn));
});

t('8e 응답에 throughWrite 를 함께 실어 보낸다(프론트가 실패를 알 수 있게)', () => {
  const body = read('routes/trackB.routes.js');
  const i = body.indexOf("router.post('/workdesk/edit'");
  const fn = body.slice(i, body.indexOf("router.post('/workdesk/revert'"));
  assert.ok(/json\({ \.\.\.out, throughWrite }\)/.test(fn));
});

await ta('8f ★★ 라우터 스택 실검사 — /workdesk/edit 핸들러가 실제로 through-write 를 호출한다', async () => {
  const express = require('express');
  const origRouter = express.Router;
  let captured = null;
  express.Router = function (...a) { const r = origRouter.apply(this, a); captured = captured || r; return r; };
  delete require.cache[require.resolve(SRC('routes/trackB.routes'))];
  const routes = require(SRC('routes/trackB.routes'));   // eslint-disable-line no-unused-vars
  express.Router = origRouter;
  const layer = captured.stack.find(l => l.route && l.route.path === '/workdesk/edit' && l.route.methods && l.route.methods.post);
  assert.ok(layer, '/workdesk/edit 라우트를 찾지 못했다');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  const svc = require(SRC('services/trackB.service'));
  const origEdit = svc.editWorkdeskRow;
  svc.editWorkdeskRow = async () => ({ ok: true, editId: 1, anchorType: 'order', field: 'col:연락처', linkedField: null, value: 'x', orderSubmissionId: 'o1', priorValue: 'old' });
  const led = require(SRC('services/orderLedger.service'));
  const origSync = led.syncCellToOrderIdentity;
  const origNormalize = led.normalizeWorkdeskColumnValue;
  let syncArgs = null;
  led.syncCellToOrderIdentity = async (a) => { syncArgs = a; return { attempted: true, ok: true, mode: 'sheetless' }; };
  led.normalizeWorkdeskColumnValue = async ({ value }) => ({ isPrice: false, ok: true, value });
  try {
    const resp = await new Promise((resolve) => {
      handler(
        { body: { sheetId: 'S1', tabName: 'T1', rowId: 'r1', field: 'col:연락처', value: '01012345678' }, admin: { role: 'staff', name: '망고' } },
        { status: () => ({ json: (b) => resolve(b) }), json: (b) => resolve(b) },
        (e) => resolve({ err: String(e) }));
    });
    assert.ok(syncArgs, 'syncCellToOrderIdentity 가 호출되지 않았다');
    assert.strictEqual(syncArgs.orderSubmissionId, 'o1');
    assert.strictEqual(syncArgs.header, '연락처');
    assert.strictEqual(syncArgs.oldValue, 'old');
    assert.ok(resp.throughWrite && resp.throughWrite.ok === true);

    // advertiser 가 (허용된 택배송장 필드로) 스코프 검사를 통과해 도달해도, through-write 는 스킵돼야 한다.
    //   ★ isTrackingField('col:택배송장번호')===true 라 _ensureWorkdeskCellEditScope 가 _ensureThreadScope
    //   (canAccessTab DB 조회)로 넘어간다 — 그 조회만 스텁하고 나머지는 그대로 실행한다(방어 2중 확인).
    const origCanAccess = svc.canAccessTab;
    svc.canAccessTab = async () => true;
    syncArgs = null;
    let resp2;
    try {
      resp2 = await new Promise((resolve) => {
        handler(
          { body: { sheetId: 'S1', tabName: 'T1', rowId: 'r1', field: 'col:택배송장번호', value: 'x' }, admin: { role: 'advertiser', name: 'adv' } },
          { status: () => ({ json: (b) => resolve(b) }), json: (b) => resolve(b) },
          (e) => resolve({ err: String(e) }));
      });
    } finally { svc.canAccessTab = origCanAccess; }
    assert.strictEqual(syncArgs, null, 'advertiser 요청에서는 syncCellToOrderIdentity 를 부르면 안 된다');
    assert.strictEqual(resp2.throughWrite, null, JSON.stringify(resp2));
  } finally {
    svc.editWorkdeskRow = origEdit;
    led.syncCellToOrderIdentity = origSync;
    led.normalizeWorkdeskColumnValue = origNormalize;
  }
});

/* ══════════════ §9 editWorkdeskRow 반환값 ══════════════ */
console.log('\n§9 editWorkdeskRow — orderSubmissionId · priorValue');

t('9a order 앵커일 때만 orderSubmissionId 를 싣는다(manual/identity 앵커는 null)', () => {
  const body = read('services/trackB.service.js');
  const i = body.indexOf('async function editWorkdeskRow');
  const fn = body.slice(i, body.indexOf('} catch (e) {', i));
  assert.ok(/orderSubmissionId: anchorType === 'order' \? anchorValue : null/.test(fn));
});

t('9b priorValue 는 row_json(편집 전 값)에서만 읽는다(편집 자체가 row_json 을 바꾸지 않으므로 안전)', () => {
  const body = read('services/trackB.service.js');
  const i = body.indexOf('async function editWorkdeskRow');
  const fn = body.slice(i, body.indexOf('} catch (e) {', i));
  assert.ok(/row\.row_json\[field\.slice\(4\)\]/.test(fn));
  assert.ok(/isCol && anchorType === 'order'/.test(fn));
});

t('9c priorValue 계산은 COMMIT 뒤(트랜잭션과 무관 — 추가 쿼리 없음)', () => {
  const body = read('services/trackB.service.js');
  const i = body.indexOf('async function editWorkdeskRow');
  const fn = body.slice(i, body.indexOf('} catch (e) {', i));
  const commitIdx = fn.indexOf("await client.query('COMMIT')");
  const priorIdx = fn.indexOf('const priorValue');
  assert.ok(commitIdx > 0 && priorIdx > commitIdx);
});

/* ══════════════ §10 프론트 — 토스트 ══════════════ */
console.log('\n§10 프론트 — through-write 실패일 때만 경고 토스트');

const WD = readRoot('frontend/workdesk.html');

function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' 함수를 찾지 못했습니다');
  let d = 0, started = false, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

t('10a 정적 — cellsaved 표시 뒤·undoGroup.pending 감소 전에 조건부 토스트가 있다', () => {
  const fn = grabFn(WD, 'commitCellEdit');
  const savedIdx = fn.indexOf("classList.add('cellsaved')");
  const toastIdx = fn.indexOf("resp.throughWrite&&resp.throughWrite.attempted===true&&resp.throughWrite.ok===false");
  const pendingIdx = fn.indexOf('undoGroup.pending=Math.max(0,undoGroup.pending-1)');
  assert.ok(savedIdx > 0 && toastIdx > savedIdx, '토스트 조건이 cellsaved 표시보다 앞서면 안 된다');
  assert.ok(pendingIdx > toastIdx, '토스트 조건은 pending 감소보다 앞서 있어야 한다(같은 성공 분기 안)');
});

function makeCtx(apiImpl) {
  const toasts = [];
  const ctx = {
    STATE: { cur: { sheetId: 'S1', tabName: 'T1' } },
    api: apiImpl,
    toast: (msg) => { toasts.push(msg); },
    setTimeout: () => {},
    _gridRowById: () => ({ id: 'r1', cellEdits: {} }),
    _paintGridCell: () => {},
    _beginCellUndoGroup: () => ({ pending: 0 }),
    _recordCellUndo: () => {},
    _finishCellUndoGroup: () => {},
    reloadWorkdesk: () => {},
    _toasts: toasts,
  };
  vm.createContext(ctx);
  vm.runInContext(grabFn(WD, 'commitCellEdit'), ctx);
  return ctx;
}

await ta('10b throughWrite 실패면 경고 토스트를 띄운다(사유 문구 포함)', async () => {
  const ctx = makeCtx(async () => ({ ok: true, throughWrite: { attempted: true, ok: false, reason: 'tab_mismatch' } }));
  await ctx.commitCellEdit('r1', 'col:연락처', '010-7728-0891', null, {});
  assert.ok(ctx._toasts.some(m => /주문 원장 반영은 실패했습니다\(tab_mismatch\)/.test(m)), JSON.stringify(ctx._toasts));
});

await ta('10c throughWrite 성공(ok=true)이면 조용하다(토스트 없음)', async () => {
  const ctx = makeCtx(async () => ({ ok: true, throughWrite: { attempted: true, ok: true, mode: 'sheetless' } }));
  await ctx.commitCellEdit('r1', 'col:연락처', '010-7728-0891', null, {});
  assert.strictEqual(ctx._toasts.length, 0);
});

await ta('10d throughWrite 가 null(대상 아닌 필드·미시도)이면 조용하다', async () => {
  const ctx = makeCtx(async () => ({ ok: true, throughWrite: null }));
  await ctx.commitCellEdit('r1', 'col:연락처', '010-7728-0891', null, {});
  assert.strictEqual(ctx._toasts.length, 0);
});

await ta('10e ★ 편집 자체 실패(resp.ok=false)는 종전 오류 토스트만 뜬다(through-write 문구와 안 섞인다)', async () => {
  const ctx = makeCtx(async () => ({ ok: false, error: 'field_not_editable' }));
  await ctx.commitCellEdit('r1', 'col:연락처', '010-7728-0891', null, {});
  assert.ok(ctx._toasts.some(m => /편집 거부/.test(m)));
  assert.ok(!ctx._toasts.some(m => /주문 원장 반영/.test(m)));
});

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail > 0 ? 1 : 0);
})();
