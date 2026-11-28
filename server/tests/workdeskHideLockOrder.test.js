/* ★★ 결정 439 — 작업표 [줄 삭제]·리뷰어 [참여 취소](같은 실행부 trackB.hideWorkdeskRow)의 잠금 순서 고정.
 *
 * 사고(2026-11-28 실 PG 실측): 같은 탭에서 줄 삭제 5건이 동시에 오면 40P01(교착).
 *   A = 자기 줄 잠금(campaign_participants … FOR UPDATE) → 공고 행(recruit_campaigns … FOR UPDATE) 대기
 *   B = 공고 행 쥠 → 탭의 모든 줄(… ORDER BY seq FOR UPDATE) 대기(그중 A 의 줄)  → 순환.
 * 고친 뒤: 트랜잭션의 첫 잠금 = 탭 잠금(`sheetless_worktable:<sheet>:<tab>` — 주문 기록·정원 보충·직원 셀 수정과
 *   같은 키 · 결정 182 「탭 잠금은 첫 잠금」). 같은 탭의 줄 삭제끼리는 탭 잠금에서 줄을 서므로 순환이 생길 수 없다.
 *
 * 이 시험은 스텁 연결로 **실제** hideWorkdeskRow(주문 있는 줄은 실제 orderCancellation 까지)를 돌리며
 * 트랜잭션마다 잠금을 건 순서를 기록하고, 「동시진행 범위 잠금(lifecycle)을 뺀 첫 잠금 = 탭 잠금」 ·
 * 「탭 잠금이 주문 행·내 줄·공고 행·탭 줄 잠금보다 먼저」 · 「공고 행이 탭 줄보다 먼저」(결정 016)를 모든 갈래에서 단언한다.
 * PGlite 는 연결 하나라 교착을 재현하지 못한다 — 진짜 교착 0 은 실 PG 하네스로 따로 쟀다(결정 439 문서). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ORDER_ID = '11111111-2222-3333-4444-555555555555';
const ROW_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SHEET = 's-lock';
const TAB = 't-lock';

const svc = require('../src/services/trackB.service');
const cpSvc = require('../src/services/campaignPlan.service');
cpSvc.relayCampaignWorktable = async () => ({ ok: true, moved: 0 });   // 커밋 뒤 날짜 맞추기 — 실제 DB 를 열지 않게
svc.__setLedgerRebuildForTest(async () => {});

// 잠금 문장 분류 — 기다리는(blocking) 잠금만. try 잠금은 기다리지 않아 순환에 끼지 못한다.
function classify(sql, params) {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  if (/pg_try_advisory/.test(q)) return null;
  if (/pg_advisory_xact_lock/.test(q)) {
    if (/dual_channel_lifecycle/.test(q)) return 'lifecycle';
    const p = String((params || [])[0] || '');
    if (p.startsWith('sheetless_worktable:')) return 'tab';
    return 'advisory:' + p;
  }
  if (/FOR UPDATE/.test(q)) {
    if (/FROM order_submissions/.test(q)) return 'order_row';
    if (/FROM recruit_campaigns/.test(q)) return 'campaign';
    if (/FROM campaign_participants/.test(q)) return /ORDER BY seq/.test(q) ? 'tab_rows' : 'participant';
    return 'other_row';
  }
  if (/^UPDATE order_submissions/.test(q)) return 'order_row';
  if (/^(DELETE FROM|UPDATE|INSERT INTO) campaign_participants/.test(q)) return 'participant_write';
  if (/^UPDATE campaign_applications/.test(q)) return 'application_write';
  return null;
}

function makeStub({ liveOrder = true, cancelUpdates = true } = {}) {
  const txs = [];   // 트랜잭션별 잠금 순서
  let connects = 0;
  const answer = (sql, params, tx) => {
    const q = String(sql);
    if (tx) {
      if (/^\s*BEGIN/.test(q)) tx.began = true;
      const k = classify(q, params);
      if (k) tx.locks.push(k);
    }
    if (q.includes('FROM campaign_participants cp') && q.includes('JOIN order_submissions')) return { rows: liveOrder ? [{ oid: ORDER_ID }] : [] };
    if (q.includes('SELECT order_submission_id, tab_gid FROM campaign_participants')) return { rows: [{ order_submission_id: liveOrder ? ORDER_ID : null, tab_gid: '9' }] };
    if (q.includes('SELECT id FROM order_submissions WHERE id=$1::uuid') && !q.includes('FOR UPDATE')) return { rows: [{ id: ORDER_ID }] };
    if (q.includes('to_jsonb(o) AS submission')) return { rows: [{ submission: { id: ORDER_ID, sheet_id: SHEET, tab_name: TAB, gid: '9' } }] };
    if (q.includes('pg_try_advisory')) return { rows: [{ ok: true }] };
    if (q.includes('SELECT order_submission_id FROM campaign_participants') && q.includes('FOR UPDATE')) return { rows: [{ order_submission_id: ORDER_ID }] };
    if (/UPDATE order_submissions SET deleted_at=NOW\(\)/.test(q)) {
      return cancelUpdates ? { rowCount: 1, rows: [{ sheet_row: 7, mirror_status: 'written', sheet_id: SHEET, tab_name: TAB, tab_gid: '9', gid: '9' }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('SELECT deleted_at FROM order_submissions')) return { rows: [{ deleted_at: new Date() }] };
    if (q.includes('SELECT id, seq, phone8, row_json, order_submission_id')) {
      return { rows: [{ id: ROW_ID, seq: 7, phone8: '12345678', row_json: { '구매일자': '8/19 (수)' }, order_submission_id: liveOrder ? ORDER_ID : null, revision: 'r1' }] };
    }
    if (q.includes(') AS done')) return { rows: [{ done: false }] };
    if (q.includes('COALESCE(sheetless,FALSE) AS sheetless')) return { rows: [{ sheetless: true }] };
    if (q.includes('SELECT rc.id AS campaign_id')) return { rows: [{ campaign_id: 'camp-1', is_open: true, is_linked: true, recruitTotal: 10, workOrderRecruitTotal: null }] };
    if (q.includes('SELECT seq, tab_gid, row_json')) return { rows: [{ seq: 7, tab_gid: '9', row_json: { '구매일자': '8/19 (수)' } }, { seq: 8, tab_gid: '9', row_json: { '구매일자': '8/25 (월)' } }] };
    if (q.includes('DELETE FROM campaign_participants')) return { rowCount: 1, rows: [] };
    if (q.includes('INSERT INTO campaign_participants')) return { rowCount: 1, rows: [{ id: 'row-new', seq: 9 }] };
    return { rowCount: 0, rows: [] };
  };
  const pool = {
    query: async (sql, params) => answer(sql, params, null),
    connect: async () => {
      connects++;
      const tx = { locks: [], began: false };
      txs.push(tx);
      return { query: async (sql, params) => answer(sql, params, tx), release() {} };
    },
  };
  return { pool, txs, connects: () => connects };
}

// 한 트랜잭션의 잠금 순서 계약
function assertTabFirst(locks, label) {
  const blocking = locks.filter(k => k !== 'lifecycle');
  assert.ok(blocking.length, `${label}: 잠금 기록이 비었습니다`);
  assert.strictEqual(blocking[0], 'tab',
    `${label}: 트랜잭션의 첫 잠금(동시진행 범위 잠금 제외)은 탭 잠금이어야 합니다 — 실제 순서 ${JSON.stringify(locks)}`);
  const lastLifecycle = locks.lastIndexOf('lifecycle');
  assert.ok(lastLifecycle < locks.indexOf('tab'), `${label}: 동시진행 범위 잠금은 탭 잠금보다 먼저입니다(주문 기록과 같은 순서)`);
  const c = locks.indexOf('campaign'), r = locks.indexOf('tab_rows');
  if (c >= 0 && r >= 0) assert.ok(c < r, `${label}: 공고 행 → 탭 줄 순서(결정 016)여야 합니다 — ${JSON.stringify(locks)}`);
}

test('주문 없는 줄 — [줄 삭제] 트랜잭션의 첫 잠금은 탭 잠금', async () => {
  const s = makeStub({ liveOrder: false });
  svc.__setPoolForTest(s.pool);
  const out = await svc.hideWorkdeskRow({ sheetId: SHEET, tabName: TAB, rowId: ROW_ID, by: '망고', actorRole: 'staff' });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(s.txs.length, 1);
  assertTabFirst(s.txs[0].locks, '주문 없는 줄');
  assert.ok(s.txs[0].locks.includes('participant') && s.txs[0].locks.includes('campaign') && s.txs[0].locks.includes('tab_rows'),
    '내 줄·공고 행·탭 줄 잠금은 그대로 잡는다(동작 불변)');
});

test('주문 있는 줄 — 실제 주문 취소 경로에서도 탭 잠금이 주문 행·줄·공고 잠금보다 먼저', async () => {
  const s = makeStub({ liveOrder: true });
  svc.__setPoolForTest(s.pool);
  const out = await svc.hideWorkdeskRow({ sheetId: SHEET, tabName: TAB, rowId: ROW_ID, by: '망고', actorRole: 'staff' });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.orderCanceled, true, '주문 취소와 줄 삭제가 한 트랜잭션에서 끝나야 합니다');
  assert.strictEqual(s.txs.length, 1, '한 트랜잭션');
  const locks = s.txs[0].locks;
  assertTabFirst(locks, '주문 있는 줄');
  assert.ok(locks.indexOf('tab') < locks.indexOf('order_row'), `탭 잠금 → 주문 행(셀 수정·날짜 수정과 같은 방향) — ${JSON.stringify(locks)}`);
});

test('리뷰어 [참여 취소](requireNoReview) — 같은 실행부라 같은 순서', async () => {
  const s = makeStub({ liveOrder: true });
  svc.__setPoolForTest(s.pool);
  const out = await svc.hideWorkdeskRow({ sheetId: SHEET, tabName: TAB, rowId: ROW_ID, by: 'reviewer:5678', requireNoReview: true });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assertTabFirst(s.txs[0].locks, '리뷰어 참여 취소');
});

test('주문이 그새 취소됨(본문 미실행) → 이어서 도는 자기 트랜잭션도 탭 잠금이 첫 잠금', async () => {
  const s = makeStub({ liveOrder: true, cancelUpdates: false });
  svc.__setPoolForTest(s.pool);
  const out = await svc.hideWorkdeskRow({ sheetId: SHEET, tabName: TAB, rowId: ROW_ID, by: '망고', actorRole: 'staff' });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(s.txs.length, 2, '취소 트랜잭션 + 줄 삭제만 하는 트랜잭션');
  s.txs.forEach((t, i) => assertTabFirst(t.locks, `트랜잭션 ${i + 1}`));
});

test('정적 — 파괴 실행부 진입점은 hideWorkdeskRow 하나 · _hideParticipantInTx 는 그 안 두 곳에서만', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/trackB.service.js'), 'utf8');
  const calls = src.match(/(?<!function )_hideParticipantInTx\(client/g) || [];
  assert.strictEqual(calls.length, 2, `_hideParticipantInTx 호출 = 2곳(자기 트랜잭션 · 주문 취소 트랜잭션) — 실제 ${calls.length}`);
  const start = src.indexOf('async function _hideWorkdeskRowOnce(');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start, '_hideWorkdeskRowOnce 본문');
  const body = src.slice(start, end);
  assert.strictEqual((body.match(/_hideParticipantInTx\(client/g) || []).length, 2, '두 호출 모두 실행부 안');
  assert.strictEqual((body.match(/_lockHideTabFirstInTx\(client/g) || []).length, 2, '두 트랜잭션 모두 탭 잠금을 먼저');
  // 바깥 진입점(라우트·리뷰어 취소·Q&A 캡처 기한 정리)은 모두 hideWorkdeskRow 를 부른다 — 사본 없음
  const root = path.resolve(__dirname, '../src');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const users = walk(root).filter(f => !f.endsWith('trackB.service.js') && /_hideParticipantInTx\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(users, [], '_hideParticipantInTx 를 trackB 밖에서 부르지 않는다');
});

test('교착(40P01)만 트랜잭션 통째로 다시 — 최대 3번 · 다른 실패는 다시 하지 않는다', async () => {
  // 첫 번째 시도의 공고 잠금에서 교착 → 다음 시도는 성공
  for (const [failTimes, wantOk, wantAttempts] of [[1, true, 2], [2, true, 3], [5, false, 3]]) {
    const s = makeStub({ liveOrder: false });
    let fails = 0;
    const orig = s.pool.connect;
    s.pool.connect = async () => {
      const c = await orig();
      const q = c.query;
      c.query = async (sql, params) => {
        if (String(sql).includes('SELECT rc.id AS campaign_id') && fails < failTimes) {
          fails++;
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        }
        return q(sql, params);
      };
      return c;
    };
    svc.__setPoolForTest(s.pool);
    const out = await svc.hideWorkdeskRow({ sheetId: SHEET, tabName: TAB, rowId: ROW_ID, by: '망고', actorRole: 'staff' });
    assert.strictEqual(out.ok, wantOk, `교착 ${failTimes}번: ${JSON.stringify(out)}`);
    assert.strictEqual(s.txs.length, wantAttempts, `교착 ${failTimes}번 → 시도 ${wantAttempts}번`);
    if (!wantOk) { assert.strictEqual(out.error, 'unexpected'); assert.strictEqual(out.pgCode, '40P01', '3번 다 교착이면 종전처럼 원인 코드를 그대로 알린다'); }
  }
  // 다른 오류(예: 시간 초과 57014)·업무 거절은 다시 하지 않는다
  {
    const s = makeStub({ liveOrder: false });
    const orig = s.pool.connect;
    s.pool.connect = async () => {
      const c = await orig(); const q = c.query;
      c.query = async (sql, params) => {
        if (String(sql).includes('SELECT rc.id AS campaign_id')) throw Object.assign(new Error('canceling statement'), { code: '57014' });
        return q(sql, params);
      };
      return c;
    };
    svc.__setPoolForTest(s.pool);
    const out = await svc.hideWorkdeskRow({ sheetId: SHEET, tabName: TAB, rowId: ROW_ID, by: '망고', actorRole: 'staff' });
    assert.strictEqual(out.ok, false); assert.strictEqual(out.pgCode, '57014');
    assert.strictEqual(s.txs.length, 1, '교착이 아닌 오류는 한 번만');
  }
});
