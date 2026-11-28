/**
 * bookingHomeElapsedWarning.test.js — 네이버예약리뷰는 리뷰어 홈 「리뷰 미제출 · N일 경과」 경고를 띄우지 않는다
 * (결정 425 · 사용자 확정 2026-11-25 「①」).
 * 실행: node tests/bookingHomeElapsedWarning.test.js
 *
 * 왜: 그 경고는 「구매양식(= 예약리뷰는 예약내역) 제출 뒤 10일」로 센다. 예약내역은 예약 직후 내고 방문은 몇 주 뒤일 수 있어
 *     방문도 하기 전에 빨간 「리뷰 미제출 · N일 경과」가 뜬다. 예약 줄은 결정 422 의 「내일/오늘 마감」(이용일 기준) 안내만 남긴다.
 *
 * 판정 자리: 경고에 띄울 한 건은 **서버**(`GET /api/reviewer/overdue-review-warning`)가 고른다(가장 오래된 1건).
 *   화면에서 지우면 「가장 오래된 게 예약 줄」일 때 다른 종류의 진짜 경고까지 같이 사라진다 → 서버 후보에서 예약 줄만 뺀다.
 *   예약 줄 판정 = `utils/bookingTabSql`(자리표가 있거나 탭 종류 booking — 결정 407·423 단일 출처). 모르는 종류 = 종전대로 띄운다.
 *
 * 구성(PGlite · 저장소 migrations 그대로 · 실제 처리기):
 *   예약 2줄(탭 종류 booking + 자리표 · 자리표만 있는 탭) + 리뷰·블로그·Q&A·영수증·종류 모름 각 1줄 → 경고는 예약을 건너뛰고
 *   다른 종류를 오래된 순으로 고른다. 매 호출마다 「예약 조건만 뺀 SQL(= 종전 SQL)」도 같이 돌려, 종전 답이 예약 줄이 아니면
 *   새 답과 **같은 줄·같은 경과일**인지 대조한다(다른 종류 불변 증명). 예약 줄만 남으면 경고 없음.
 * ★ 가짜 이름·가짜 번호 · 외부 호출 0.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : '')); pass++; console.log('  ✓ ' + name); };

const SERVER = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booking-home-warning-secret';
delete process.env.REVIEW_OVERDUE_WARNING_ENABLED;

let poolImpl = null;
{
  const poolPath = require.resolve('../src/db/pool');
  const proxy = { query: (...a) => poolImpl.query(...a), connect: (...a) => poolImpl.connect(...a), on() {}, end: async () => {} };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: proxy };
}

async function openDb() {
  const mod = process.env.PGLITE_MODULE || '@electric-sql/pglite';
  const { PGlite } = require(mod);
  const base = path.dirname(require.resolve(mod));
  const ext = n => require(require.resolve('@electric-sql/pglite/contrib/' + n, { paths: [base] }))[n];
  const extensions = {};
  try { extensions.pgcrypto = ext('pgcrypto'); extensions.pg_trgm = ext('pg_trgm'); } catch (_) { /* 아래 확인이 알려 준다 */ }
  const db = new PGlite({ extensions });
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에서 안 도는 몇 파일 */ }
  }
  const need = (await db.query(`SELECT table_name, column_name FROM information_schema.columns
     WHERE (table_name = 'booking_slots' AND column_name = 'slot_date') OR (table_name = 'tab_configs' AND column_name = 'work_kind')`)).rows;
  assert(need.length === 2, 'migrations(booking_slots · tab_configs.work_kind) 적용 실패');
  return db;
}

// 경고 SQL 은 한 번 들어올 때 「예약 조건만 뺀 종전 SQL」도 같이 돌려 둔다(대조용).
const { bookingTabSql } = require('../src/utils/bookingTabSql');
const BOOKING_CLAUSE = bookingTabSql('ri.sheet_id', 'ri.tab_name');
// 결정 434 사용자 확정(2026-11-28) — 영수증리뷰 줄도 같은 자리에서 뺀다(425 를 영수증에도). 종전 SQL = 두 조건을 다 뺀 것.
const RECEIPT_CLAUSE = require('../src/utils/receiptTabSql').receiptTabSql('ri.sheet_id', 'ri.tab_name');
let lastBaseline = null;
let warningSqlSeen = 0;
function poolOf(db) {
  let chain = Promise.resolve();
  const raw = async (sql, params) => {
    if (!params || !params.length) {
      if (/;\s*\S/.test(sql)) { await db.exec(sql); return { rows: [], rowCount: 0 }; }
    }
    if (sql.includes('WITH warning_candidate_ids AS MATERIALIZED')) {
      warningSqlSeen++;
      const old = sql.split(`AND NOT ${BOOKING_CLAUSE}`).join('').split(`AND NOT ${RECEIPT_CLAUSE}`).join('');
      lastBaseline = old === sql ? null : (await db.query(old, params || [])).rows;
    }
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  const connect = async () => {
    let release;
    const wait = chain;
    chain = new Promise(r => { release = r; });
    await wait;
    return { query: raw, release() { release(); } };
  };
  return { query: raw, connect, on() {}, end: async () => {} };
}

function handlerOf(router, method, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  assert(layer, '실제 처리기 경로: ' + method + ' ' + p);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function callWarning(handler, ownerReviewerId) {
  return await new Promise(resolve => {
    const res = { statusCode: 200, headers: {} };
    res.status = c => { res.statusCode = c; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.json = b => { resolve({ statusCode: res.statusCode, body: b }); return res; };
    Promise.resolve(handler({ reviewer: { ownerReviewerId, loginKind: 'self' }, headers: {} }, res, err => resolve({ err })))
      .catch(err => resolve({ err }));
  });
}

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHONE = '01011112222';
const P8 = '11112222';
// ★ 리뷰 칸(submit_col)을 두어야 참여 장부가 「리뷰 아직(pending)」으로 잡힌다(칸 모름 = unknown = 경고 대상 아님).
// 줄 = { key, days(제출 뒤 날수), kind(tab_configs.work_kind · null = 탭 설정 없음), slot(자리표 이용일 날수 오프셋 · undefined = 자리표 없음) }
const ROWS = [
  { key: 'bk1', days: 20, kind: 'booking', slot: +1, name: '가짜식당 예약(방문 내일)' },
  { key: 'bk2', days: 18, kind: null, slot: -5, name: '가짜카페 예약(자리표만 · 방문 지남)' },
  { key: 'rv', days: 15, kind: 'review', name: '가짜상품 리뷰' },
  { key: 'bl', days: 14, kind: 'blog', name: '가짜블로그' },
  { key: 'qn', days: 13, kind: 'qna', name: '가짜 Q&A' },
  { key: 'rc', days: 12, kind: 'receipt', name: '가짜영수증' },
  { key: 'un', days: 11, kind: null, name: '종류 모름 작업' },
  { key: 'bk3', days: 9, kind: 'booking', slot: -2, name: '9일 예약(10일 전 · 종전에도 없음)' },
  { key: 'rc2', days: 11.5, kind: null, pool: true, name: '가짜영수증(묶음만 · 탭 종류 칸 없음)' },   // 결정 434(2026-11-28) — 맨 뒤(앞 줄 번호 불변)
];
const idOf = i => `${String(i + 1).repeat(8)}-1111-4111-8111-${String(i + 1).repeat(12)}`;

(async () => {
  console.log('\n네이버예약리뷰 — 리뷰어 홈 「리뷰 미제출 · N일 경과」 경고에서 예약 줄 빼기 (결정 425)');
  const db = await openDb();
  poolImpl = poolOf(db);

  await db.query(`INSERT INTO reviewers(id, name, phone, sub_accounts) VALUES ($1, '가짜리뷰어', $2, '[]'::jsonb)`, [OWNER, PHONE]);
  for (let i = 0; i < ROWS.length; i++) {
    const r = ROWS[i]; const sid = 'sheet-' + r.key; const tab = 'tab-' + r.key; const oid = idOf(i);
    r.oid = oid; r.sid = sid; r.tab = tab;
    await db.query(`INSERT INTO order_submissions(id, submitted_at, sheet_id, tab_name, sheet_row, owner_reviewer_id, phone, mirror_status)
                    VALUES ($1, NOW() - ($2 || ' days')::interval - INTERVAL '1 hour', $3, $4, 1, $5, $6, 'written')`, [oid, String(r.days), sid, tab, OWNER, PHONE]);
    await db.query(`INSERT INTO review_index(sheet_id, tab_name, row_index, is_submitted, campaign_name, phone8, reviewer_name, submit_col, row_json)
                    VALUES ($1, $2, 1, FALSE, $3, $4, '가짜리뷰어', '리뷰', '{}'::jsonb)`, [sid, tab, r.name, P8]);
    await db.query(`INSERT INTO campaign_participants(order_submission_id, sheet_id, tab_name, seq, reviewer_name, phone8, owner_reviewer_id, is_submitted, submit_col, row_json)
                    VALUES ($1, $2, $3, 1, '가짜리뷰어', $4, $5, FALSE, '리뷰', '{}'::jsonb)`, [oid, sid, tab, P8, OWNER]);
    if (r.kind) await db.query(`INSERT INTO tab_configs(sheet_id, tab_name, display_name, work_kind, sheetless) VALUES ($1, $2, $3, $4, TRUE)`, [sid, tab, r.name, r.kind]);
    if (r.pool) {
      await db.query(`INSERT INTO receipt_pool(work_order_id, sheet_id, tab_name, seq, pool_seq, file_id, status) VALUES ('wo-' || $1, $2, $3, 1, 1, 'fake_rc_' || $1, 'open')`, [r.key, sid, tab]);
    }
    if (r.slot !== undefined) {
      await db.query(`INSERT INTO booking_slots(work_order_id, sheet_id, tab_name, seq, slot_date, date_seq, review_deadline, status)
                      VALUES ('wo-' || $1, $2, $3, 1, (NOW() AT TIME ZONE 'Asia/Seoul')::date + $4::int, 1,
                              (NOW() AT TIME ZONE 'Asia/Seoul')::date + $4::int + 3, 'booked')`, [r.key, sid, tab, r.slot]);
    }
  }
  const byOid = Object.fromEntries(ROWS.map(r => [r.oid, r]));
  const handler = handlerOf(require('../src/routes/reviewer.routes'), 'get', '/overdue-review-warning');

  const ask = async (label) => {
    lastBaseline = undefined;
    const out = await callWarning(handler, OWNER);
    assert.ifError(out.err);
    t(`${label}: 200 응답`, out.statusCode === 200 && out.body && out.body.ok === true, out);
    return out.body.item;
  };
  const markDone = (key) => { const r = ROWS.find(x => x.key === key); return db.query(`UPDATE review_index SET is_submitted = TRUE WHERE sheet_id = $1 AND tab_name = $2`, [r.sid, r.tab]); };

  // 1) 가장 오래된 건 예약(20일·18일)이지만 경고는 리뷰(15일)를 고른다.
  const first = await ask('처음');
  t('★★ 가장 오래된 예약 줄(예약내역 낸 지 20일 · 방문 내일)은 경고로 고르지 않는다', first && byOid[first.orderSubmissionId].kind !== 'booking'
    && byOid[first.orderSubmissionId].slot === undefined, first);
  t('★★ 자리표만 있는 예약 탭(탭 종류 칸이 비어도)도 빼고, 다음으로 오래된 리뷰체험단(15일)을 고른다', first && first.orderSubmissionId === ROWS[2].oid && first.elapsedDays === 15, first);
  t('  종전 SQL(예약 조건만 뺀 것)은 이 순간 예약 줄을 골랐다 — RED 의 근거', Array.isArray(lastBaseline) && lastBaseline[0]
    && lastBaseline[0].orderSubmissionId === ROWS[0].oid, lastBaseline);

  // 2) 다른 종류는 종전과 같은 줄·같은 경과일(리뷰 → 블로그 → Q&A → 종류 모름).
  //    ★ 결정 434 사용자 확정(2026-11-28) — 영수증리뷰(rc · 탭 종류 receipt / rc2 · 영수증 묶음만)는 예약처럼 빠진다
  //      (리뷰 기한이 10일보다 길면 마감 전에 「N일 경과」가 뜬다 — 「내일/오늘 마감」 안내만 남긴다). 종전(이 결정 전)에는 rc 가 12일로 떴다.
  const isRcRow = r => r && (r.kind === 'receipt' || r.pool === true);
  const order = ['rv', 'bl', 'qn', 'un'];
  for (let i = 0; i < order.length; i++) {
    const want = ROWS.find(r => r.key === order[i]);
    if (i > 0) {
      await markDone(order[i - 1]);
      const item = await ask(`${order[i - 1]} 낸 뒤`);
      t(`★ ${want.name}(${want.kind || '종류 모름'} · ${want.days}일) — 종전 그대로 「리뷰 미제출 · ${want.days}일 경과」`, item && item.orderSubmissionId === want.oid && item.elapsedDays === want.days
        && item.displayName === want.name, item);
    }
    // 종전 SQL 과 대조: 종전 답에서 예약 줄을 건너뛴 첫 줄 = 새 답.
    const oldPick = (lastBaseline || []).map(r => byOid[r.orderSubmissionId]);
    t(`  종전 SQL 대조(${want.key}): 종전도 예약을 빼면 같은 줄`, lastBaseline !== null && oldPick.length > 0
      && (oldPick[0].kind === 'booking' || oldPick[0].slot !== undefined || isRcRow(oldPick[0]) || oldPick[0].oid === want.oid), oldPick.map(r => r.key));
  }

  // 3) 예약 줄만 남으면 경고 없음(종전엔 예약 줄을 띄웠다).
  await markDone('un');
  const none = await ask('예약만 남음');
  t('★★ 예약·영수증리뷰 줄(rc 12일 · 묶음만 있는 rc2 11.5일)만 남으면 홈 경고 없음(빨간 「N일 경과」 안 뜸)', none === null, none);
  t('  종전 SQL 은 이때도 예약 줄(20일)을 띄웠다', Array.isArray(lastBaseline) && lastBaseline[0] && lastBaseline[0].orderSubmissionId === ROWS[0].oid, lastBaseline);

  // 4) 종류 모름(fail 방향): 자리표도 탭 종류도 없는 줄은 종전대로 띄운다 — 위 2) 의 'un' 이 그 증명. 탭 종류를 booking 으로 바꾸면 빠진다.
  await db.query(`UPDATE review_index SET is_submitted = FALSE WHERE sheet_id = $1`, [ROWS[6].sid]);
  const unknownAgain = await ask('종류 모름 다시');
  t('★ 종류를 모르는 줄은 숨기지 않는다(확실히 예약일 때만 뺀다)', unknownAgain && unknownAgain.orderSubmissionId === ROWS[6].oid, unknownAgain);
  await db.query(`INSERT INTO tab_configs(sheet_id, tab_name, display_name, work_kind, sheetless) VALUES ($1, $2, $3, 'booking', TRUE)`, [ROWS[6].sid, ROWS[6].tab, ROWS[6].name]);
  const nowBooking = await ask('탭 종류 booking 으로');
  t('  같은 줄도 탭 종류가 네이버예약리뷰면 뺀다', nowBooking === null, nowBooking);
  // 결정 434(2026-11-28) — 영수증 줄은 「종류 때문에」 빠진다: 같은 rc 줄의 탭 종류를 리뷰로 바꾸면 다시 뜬다(12일).
  await db.query(`UPDATE tab_configs SET work_kind = 'review' WHERE sheet_id = $1 AND tab_name = $2`, [ROWS[5].sid, ROWS[5].tab]);
  const rcAsReview = await ask('rc 탭 종류 review 로');
  t('  ★ 같은 영수증 줄도 탭 종류가 영수증이 아니면 종전대로 띄운다(확실히 영수증일 때만 뺀다)', rcAsReview && rcAsReview.orderSubmissionId === ROWS[5].oid && rcAsReview.elapsedDays === 12, rcAsReview);

  t('경고 SQL 을 실제로 돌렸다(처리기 경로)', warningSqlSeen >= 8, warningSqlSeen);
  console.log(`\n✅ bookingHomeElapsedWarning — ${pass}개 통과`);
})().catch(err => { console.error('❌ ' + (err && err.stack || err)); process.exitCode = 1; });
