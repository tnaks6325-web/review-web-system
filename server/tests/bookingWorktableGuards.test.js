/**
 * bookingWorktableGuards.test.js — 네이버예약리뷰 2단계 회귀가드: 자리표 저장(실제 SQL) + 작업표 자동 정리 격리(결정 407)
 * 실행: node tests/bookingWorktableGuards.test.js
 *
 * 위험:
 *  ① 자리표가 작업표 줄과 다른 날짜·줄 번호로 저장되거나, 재접수에서 두 번 깔린다.
 *  ② 작업표를 스스로 손보는 기능(빈 줄 날짜 옮기기·총 건수 맞추기·번호 겹친 빈 줄 정리·아무 빈 줄에나 주문 끼우기·
 *     줄 정리·날짜 고치기·차수)이 **업체가 정한 날짜**를 옮기거나 자리를 지운다.
 *  ③ 판정 조회가 실패했을 때 예약 탭을 리뷰 탭처럼 정리한다(fail-open).
 *  ④ 1단계 안전핀이 풀린다 — 2단계는 저장 입구를 열지 않는다.
 * ★ 저장·판정·날짜 옮기기·총 건수 맞추기·날짜 고치기·줄 삭제 보충은 PGlite(저장소 migrations 그대로)에서 실제로 돌린다.
 *   운영 DB 에 닿지 않는다(가짜 이름·가짜 매장).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const SERVER = path.join(__dirname, '..');
const SHEET = 'wt_booking_fixture';
const TAB = '12월 가짜식당 예약리뷰';
const REVIEW_TAB = '12월 가짜상품 리뷰';
const WO = 'wo_booking_fixture';
const DATES = [{ date: '2026-12-04', count: 2 }, { date: '2026-12-05', count: 1 }, { date: '2026-12-07', count: 3 }];
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };

async function openDb() {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에 없는 확장을 쓰는 몇 파일 — 이 시험의 표와 무관 */ }
  }
  return db;
}
function poolOf(db) {
  const query = async (sql, params) => {
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
}

(async () => {
  console.log('\n▶ 네이버예약리뷰 2단계 — 자리표 저장 · 작업표 자동 정리 격리\n');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);

  const bs = require('../src/services/bookingSlots.service');
  const { selectionKey } = require('../src/services/productOptions.service');

  /* ── 0) 표 · 판정 ─────────────────────────────────────────────── */
  console.log('0) 자리표 표 · 예약 탭 판정');
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'booking_slots'`)).rows.map(r => r.column_name);
  t('★ migration 227 — booking_slots 표(작업오더·탭·줄 번호·이용일·그날 순번·리뷰마감일·상태)',
    ['work_order_id', 'sheet_id', 'tab_name', 'seq', 'slot_date', 'date_seq', 'review_deadline', 'status'].every(c => cols.includes(c)));
  t('migration 파일 번호 227 은 하나뿐', fs.readdirSync(path.join(SERVER, 'migrations')).filter(f => /^227_/.test(f)).length === 1);
  t('★ 기동 필수 표 목록에 booking_slots', /REQUIRED_TABLES\s*=\s*\[[\s\S]{0,400}'booking_slots'/.test(S('index.js')));

  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);
  const place = { name: '가짜식당 강남점', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
    base: { pay: 25000, count: 6, daily: 0, review_type_mix: [] }, options: [], booking: { pay_mode: 'refund', dates: DATES, review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1' } };
  const wo = { id: WO, title: TAB, work_kind: 'booking', workboard_schema_version: 2, recruit_count: 6, review_fee: 5000, pay_amount: 150000, start_date: null,
    product_options_json: JSON.stringify([place]) };

  /* ── ① 접수 저장 — 작업표 줄과 같은 흐름 ───────────────────────── */
  console.log('\n① 접수 저장(작업표 줄 + 자리표)');
  const acc = require('../src/services/sheetlessAccept.service');
  const made = await acc.createSheetlessWorktable({ workOrder: wo, tabName: TAB, by: 'test' });
  t('작업표 계획 성공 · 6줄', made.ok === true && made.rows.length === 6);
  t('★ 자리표 6칸이 줄 번호(2..7)를 갖는다', Array.isArray(made.bookingSlots) && made.bookingSlots.map(s => s.rowSeq).join() === '2,3,4,5,6,7');
  const sheetId = made.sheetId;
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'booking', TRUE, 2)`, [sheetId, TAB, made.gid]);
  await made.persist();
  const cps = (await q(`SELECT seq, start_date, option_text, row_json FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 ORDER BY seq`, [sheetId, TAB])).rows;
  const slots = await bs.calendarForTab(pool, sheetId, TAB);
  t('★★ 작업표 6줄 · 이용일자 칸 = 업체가 정한 날짜(토요일 포함)', cps.length === 6
    && cps.map(r => r.row_json['이용일자']).join('|') === '12 / 4 (금)|12 / 4 (금)|12 / 5 (토)|12 / 7 (월)|12 / 7 (월)|12 / 7 (월)');
  t('★ 리뷰마감일 칸 = 이용일 + 3일', cps[0].row_json['리뷰마감일'] === '12 / 7 (월)' && cps[5].row_json['리뷰마감일'] === '12 / 10 (목)');
  t('★★ 자리표 6칸 = 줄 번호·날짜·그날 순번·리뷰마감일', slots.length === 6
    && slots.map(s => `${s.seq}:${s.slot_date}:${s.date_seq}:${s.review_deadline}`).join(',') ===
      '2:2026-12-04:1:2026-12-07,3:2026-12-04:2:2026-12-07,4:2026-12-05:1:2026-12-08,5:2026-12-07:1:2026-12-10,6:2026-12-07:2:2026-12-10,7:2026-12-07:3:2026-12-10'
    && slots.every(s => s.work_order_id === WO && s.status === 'open'));
  await made.persist();
  t('★ 다시 깔아도 두 번 깔리지 않는다(재시도 멱등)', (await bs.calendarForTab(pool, sheetId, TAB)).length === 6);
  t('날짜별 자리 수(3단계 신청 재료)', JSON.stringify(await bs.seatsByDate(pool, sheetId, TAB)) ===
    JSON.stringify([{ date: '2026-12-04', total: 2, open: 2 }, { date: '2026-12-05', total: 1, open: 1 }, { date: '2026-12-07', total: 3, open: 3 }]));
  let dupErr = null;
  try { await q(`INSERT INTO booking_slots (work_order_id, sheet_id, tab_name, seq, slot_date, date_seq) VALUES ($1, $2, $3, 99, '2026-12-04', 1)`, [WO, sheetId, TAB]); } catch (e) { dupErr = e; }
  t('★ 같은 날 같은 순번 자리는 두 번 못 만든다(유일 색인)', !!dupErr);
  {
    // 이미 깔린 줄이 계획과 다르면(손으로 고친 이용일자) 자리표를 붙이지 않는다
    await q(`DELETE FROM booking_slots WHERE sheet_id = $1 AND tab_name = $2`, [sheetId, TAB]);
    await q(`UPDATE campaign_participants SET start_date = '12 / 9 (수)' WHERE sheet_id = $1 AND tab_name = $2 AND seq = 4`, [sheetId, TAB]);
    let err = null;
    try { await (await acc.createSheetlessWorktable({ workOrder: wo, tabName: TAB, by: 'test' })).persist(); } catch (e) { err = e; }
    t('★★ 깔린 줄이 계획과 다르면 자리표를 붙이지 않고 던진다(어긋난 자리표 금지)', err && /4/.test(err.message)
      && (await bs.calendarForTab(pool, sheetId, TAB)).length === 0);
    await q(`UPDATE campaign_participants SET start_date = '12 / 5 (토)' WHERE sheet_id = $1 AND tab_name = $2 AND seq = 4`, [sheetId, TAB]);
    const rep = await bs.repairCalendarIfMissing({ workOrder: wo, sheetId, tabName: TAB, by: 'test' });
    t('★ 재접수 복구: 줄이 계획과 같으면 같은 자리표를 되살린다', rep.ok && rep.repaired && rep.inserted === 6 && (await bs.calendarForTab(pool, sheetId, TAB)).length === 6);
    t('이미 있으면 복구하지 않는다', (await bs.repairCalendarIfMissing({ workOrder: wo, sheetId, tabName: TAB })).reason === 'present');
  }

  /* 판정 */
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind, sheetless) VALUES ($1, $2, '', TRUE)`, [sheetId, REVIEW_TAB]);
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind, sheetless) VALUES ($1, '자리표 없는 예약 탭', 'booking', TRUE)`, [sheetId]);
  t('★ 자리표가 있으면 예약 탭', await bs.isBookingTab(pool, sheetId, TAB) === true);
  t('리뷰 탭은 아님', await bs.isBookingTab(pool, sheetId, REVIEW_TAB) === false);
  t('★ 자리표가 없어도 탭 종류가 booking 이면 예약 탭(저장 실패한 예약 탭도 리뷰 탭처럼 정리되지 않게)', await bs.isBookingTab(pool, sheetId, '자리표 없는 예약 탭') === true);
  t('★ 조회 실패 = 예약 탭으로 본다(fail-closed)', await bs.isBookingTab({ query: async () => { throw new Error('x'); } }, 's', 't') === true);
  t('★ 표가 없는 환경(42P01)도 예약 탭으로 본다', await bs.isBookingTab({ query: async () => { throw Object.assign(new Error('x'), { code: '42P01' }); } }, 's', 't') === true);
  {
    const log = [];
    const txc = { release() {}, query: async (sql) => { log.push(String(sql)); if (/FROM booking_slots/.test(sql)) throw new Error('boom'); return { rows: [] }; } };
    t('★ 트랜잭션 안: 실패하면 SAVEPOINT 로 되돌리고 예약 탭으로 본다', await bs.isBookingTab(txc, 's', 't') === true
      && log[0] === 'SAVEPOINT booking_tab_probe' && log.includes('ROLLBACK TO SAVEPOINT booking_tab_probe'));
    const log2 = [];
    const txo = { release() {}, query: async (sql) => { log2.push(String(sql)); return { rows: /FROM booking_slots/.test(sql) ? [{ b: false }] : [] }; } };
    t('트랜잭션 안: 성공하면 SAVEPOINT 를 풀고 결과 그대로', await bs.isBookingTab(txo, 's', 't') === false && log2.includes('RELEASE SAVEPOINT booking_tab_probe'));
    t('★ 빈 응답 = 아님(조회는 됐는데 행 없음)', await bs.isBookingTab({ query: async () => ({ rows: [] }) }, 's', 't') === false);
  }
  t('탭 이름이 없으면 아님', await bs.isBookingTab(pool, '', TAB) === false);
  t('★ 자리 줄 판정(실제 SQL)', await bs.isBoundRow(pool, sheetId, TAB, 3) === true && await bs.isBoundRow(pool, sheetId, TAB, 50) === false);
  t('자리 줄 판정 실패 = 묶인 것으로 본다', await bs.isBoundRow({ query: async () => { throw new Error('x'); } }, 's', 't', 1) === true);
  t('묶인 줄 번호 고르기(실제 SQL)', JSON.stringify(await bs.boundSeqs(pool, sheetId, TAB, [3, 9, 7])) === '[3,7]');
  t('묶임 판정 SQL = 같은 탭·같은 줄 번호', bs.boundRowSql('p') === 'EXISTS (SELECT 1 FROM booking_slots bks WHERE bks.sheet_id = p.sheet_id AND bks.tab_name = p.tab_name AND bks.seq = p.seq)');

  /* ── ② 빈 줄 날짜 옮기기 ─────────────────────────────────────── */
  console.log('\n② 빈 줄 날짜 옮기기(relay)');
  const daily = require('../src/services/sheetlessDailyPlan.service');
  const snap = async () => (await q(`SELECT seq, start_date, row_json->>'이용일자' AS d FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 ORDER BY seq`, [sheetId, TAB])).rows.map(r => `${r.seq}:${r.start_date}:${r.d}`).join(',');
  const before = await snap();
  const rel = await daily.relayWorktableToProjection({ client: pool, sheetId, tabName: TAB, days: [{ date: '2026-12-20', quota: 6 }], today: '2026-12-01' });
  t('★★ 예약 탭: 건너뛰고 아무 줄도 옮기지 않는다(실제 SQL)', rel.skipped === true && rel.reason === 'booking_slot_calendar' && (await snap()) === before);

  /* ── ③ 총 건수 맞추기 ─────────────────────────────────────────── */
  console.log('\n③ 총 건수 맞추기(quota sync)');
  const lrq = require('../src/services/linkedRecruitQuota.service');
  const camp = { id: 'camp_booking', linked_sheet_id: sheetId, linked_tab_name: TAB };
  const tryQ = async (fn) => { try { return { out: await fn() }; } catch (e) { return { err: e }; } };
  const down = await tryQ(() => lrq.syncWorktableSlotsInTx(pool, camp, 4, 'test'));
  t('★★ 줄이기 = 거절(recruit_quota_booking_locked) · 줄을 지우지 않는다', down.err && down.err.code === 'recruit_quota_booking_locked'
    && (await q(`SELECT COUNT(*)::int AS n FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active`, [sheetId, TAB])).rows[0].n === 6);
  const up = await tryQ(() => lrq.syncWorktableSlotsInTx(pool, camp, 9, 'test'));
  t('★★ 늘리기 = 거절 · 줄을 덧붙이지 않는다', up.err && up.err.code === 'recruit_quota_booking_locked' && (await snap()) === before);
  const same = await tryQ(() => lrq.syncWorktableSlotsInTx(pool, camp, 6, 'test'));
  t('건수가 같으면 통과(발행 때 같은 수)', !same.err);
  {
    const lsrc = S('src/services/linkedRecruitQuota.service.js');
    const fn = lsrc.slice(lsrc.indexOf('async function _assertQnaCalendarUnchanged'), lsrc.indexOf('async function assertWorktableSlotsInTx'));
    t('★ 저장 전 확인(assert)도 같은 규칙 — 확인·맞추기 두 곳이 같은 함수(예약 거절 포함)를 탄다',
      (lsrc.match(/await _assertQnaCalendarUnchanged\(client, campaign, delta\);/g) || []).length === 2
      && /isBookingTab\(client, campaign\.linked_sheet_id, campaign\.linked_tab_name\)[\s\S]{0,200}'recruit_quota_booking_locked'/.test(fn));
  }
  t('정원 동기화의 예약 거절은 409 로(500 위장 금지)', /recruit_quota_booking_locked: 409/.test(S('src/routes/trackB.routes.js')));
  t('작업표 만들 때 모집인원만큼 빈 줄 맞추기도 예약리뷰는 건너뛴다(자리표가 줄을 정한다)',
    /!require\('\.\.\/utils\/workKind'\)\.isQnaKind\(c\.work_kind\) && !require\('\.\.\/utils\/workKind'\)\.isBookingKind\(c\.work_kind\)/.test(S('src/services/campaignWorktable.service.js')));

  /* ── ④ 날짜 고치기 · 칸 편집 ──────────────────────────────────── */
  console.log('\n④ 날짜 고치기 · 칸 편집');
  const tb = require('../src/services/trackB.service');
  tb.__setPoolForTest(pool);
  const rowOf = async (seq) => (await q(`SELECT id FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [sheetId, TAB, seq])).rows[0].id;
  const dt = await tb.setWorkdeskPurchaseDate({ sheetId, tabName: TAB, rowId: await rowOf(3), date: '2026-12-20', by: 'test' });
  t('★★ 자리 줄의 이용일자는 달력으로 못 바꾼다(실제 SQL)', dt.ok === false && dt.error === 'booking_slot_date_locked' && (await snap()) === before);
  const tbs = S('src/services/trackB.service.js');
  t('★ 일반 칸 편집: 자리 줄의 이용일자·리뷰마감일·상품 칸은 막는다(booking_slot_cell_locked)',
    /const _bookingCell = \[_wp\.BOOKING_DATE_HEADER, _wp\.BOOKING_DEADLINE_HEADER\]\.includes\(_hdr\)\s*\|\| \(_hi >= 0 && \(_pwc\(_heads\)\.includes\(_hi\) \|\| _owc\(_heads\)\.includes\(_hi\)\)\);/.test(tbs)
    && /error: 'booking_slot_cell_locked'/.test(tbs));
  t('예약번호 칸은 막지 않는다(3단계에 리뷰어가 내고, 담당자가 고칠 수 있다)', !/BOOKING_NUMBER_HEADER[^\n]*_bookingCell|_bookingCell[^\n]*BOOKING_NUMBER_HEADER/.test(tbs));

  /* ── ⑤ 줄 삭제 보충 ───────────────────────────────────────────── */
  console.log('\n⑤ 줄 삭제 보충');
  t('★ 예약 탭: 지운 줄과 같은 날로 보충', /const finalDateLabel = _slotTab \? removedRaw : \(planLabel \|\| lastSheetLabel \|\| removedRaw\);/.test(tbs));
  t('★ 자리 줄만 늘 보충 · 자리 없는 줄은 보충 안 함', /const shouldReplenish = _slotTab \? _slotBound : (?:_receiptTab \? _receiptBound : )?!\(boardTarget > 0 && boardAfterDelete >= boardTarget\);/.test(tbs));
  t('★ 보충 줄이 리뷰마감일 칸을 잇는다(같은 날 = 같은 마감)', /if \(_bookingBound\) \{[\s\S]{0,400}BOOKING_DEADLINE_HEADER/.test(tbs));
  t('★★ 자리표가 보충 줄을 가리키게 같은 트랜잭션에서 옮긴다', /if \(_bookingBound && replacement\) \{\s*await client\.query\(\s*'UPDATE booking_slots SET seq = \$4, updated_at = NOW\(\) WHERE sheet_id = \$1 AND tab_name = \$2 AND seq = \$3'/.test(tbs));
  {
    const victim = await rowOf(4);   // 12/5(토) 하나뿐인 자리
    const r = await tb.hideWorkdeskRow({ sheetId, tabName: TAB, rowId: victim, by: 'test', actorRole: 'admin' });
    const after = (await q(`SELECT seq, start_date, row_json FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active ORDER BY seq`, [sheetId, TAB])).rows;
    const moved = (await bs.calendarForTab(pool, sheetId, TAB)).find(s => s.slot_date === '2026-12-05');
    const repl = after.find(x => Number(x.seq) === Number(moved && moved.seq));
    t('★★ 줄 삭제(실제 SQL): 같은 날(12/5 토)로 보충 · 자리표가 새 줄을 가리킨다 · 줄 수 그대로',
      r && r.ok !== false && after.length === 6 && !after.some(x => Number(x.seq) === 4) && moved && Number(moved.seq) !== 4
      && repl && repl.start_date === '12 / 5 (토)' && repl.row_json['이용일자'] === '12 / 5 (토)' && repl.row_json['리뷰마감일'] === '12 / 8 (화)'
      && repl.row_json['상품'] === '가짜식당 강남점');
  }

  {
    const { findDateColumnIndex } = require('../src/services/campaignSchedule.service');
    t('★ 날짜 칸 찾기: 예약 작업표는 「이용일자」가 날짜 칸(보충·재번호·날짜 기록이 같은 칸을 본다)', findDateColumnIndex(['번호', '이용일자', '상품', '리뷰마감일']) === 1);
    t('★★ 다른 날짜 칸이 있으면 그것이 이긴다(앞에 있어도) — 기존 탭 판정 불변', findDateColumnIndex(['이용일자', '번호', '구매일자']) === 2
      && findDateColumnIndex(['이용일자', '진행일자']) === 1);
    t('이름이 정확히 같을 때만(이용일·이용일자 메모 등은 아님)', findDateColumnIndex(['이용일', '이용일자 메모']) === -1);
  }

  /* ── ⑥ 나머지 경로 ────────────────────────────────────────────── */
  console.log('\n⑥ 나머지 경로');
  t('★ 번호 겹친 빈 줄 정리: 자리표에 묶인 줄은 대상에서 뺀다', /AND NOT \$\{require\('\.\/bookingSlots\.service'\)\.boundRowSql\('p'\)\}/.test(S('src/services/rowNumbering.service.js')));
  {
    const so = S('src/services/sheetlessOrder.service.js');
    const iB = so.indexOf("require('./bookingSlots.service').isBookingTab(client, sheetId, tabName)");
    const iAppend = so.indexOf("require('./participants.service').appendSlot(client");
    t('★★ 아무 빈 줄에나 주문 끼우기: 예약 탭은 자리 번호 없는 주문을 덧붙이기 전에 멈춘다(booking_slot_required)',
      iB > 0 && iB < iAppend && /reason: 'booking_slot_required'/.test(so));
  }
  t('번호 없는 주문 옮기기: 예약 탭은 거절', /isBookingTab\(client, sheetId, tabName\)\) \{ return \{ ok: false, error: 'booking_slot_required' \}; \}/.test(tbs));
  t('옛 신청 줄 덧붙이기: 예약 탭은 던진다', /예약리뷰 작업표에는 신청자 줄을 덧붙이지 않습니다/.test(S('src/services/sheetlessApplicant.service.js')));
  {
    const ledger = require('../src/services/sheetlessLedger.service');
    let err = null;
    try { await ledger.retireRows({ sheetId, tabName: TAB, seqs: [3, 99], dryRun: true }); } catch (e) { err = e; }
    t('★★ 줄 정리(중복 정리·짝 빈 줄 포함): 자리 줄이 섞이면 미리보기부터 거절(실제 SQL)', err && err.code === 'booking_slot_rows');
  }
  t('주문 행 삭제: 자리 줄은 「줄 삭제」로 안내(409)', /code: 'booking_slot_row'/.test(S('src/services/workdeskOrderDelete.service.js'))
    && /out\.code === 'booking_slot_row'(?: \|\| out\.code === 'receipt_pool_row')? \? 409/.test(S('src/routes/trackB.routes.js')));
  t('★ 차수 추가·삭제: 예약 공고는 409(두 경로 모두)', (S('src/routes/trackB.routes.js').match(/isBookingCampaign\(campaignId\)\) \{\s*return res\.status\(409\)\.json\(\{ ok: false, code: 'rounds_booking_locked'/g) || []).length === 2);
  t('작업 삭제 때 자리표도 함께 지운다', require('../src/services/workTabDelete.service').DELETE_TABLES.includes('booking_slots'));
  t('★ 작업 이름 바꾸기: 자리표도 같은 트랜잭션에서 따라간다', /UPDATE booking_slots SET tab_name = \$1, updated_at = NOW\(\) WHERE sheet_id = \$2 AND tab_name = \$3/.test(S('src/services/tabRename.service.js')));
  t('옵션 다시 나누기: 예약 탭은 해당 없음', /isBookingTab\(client, camp\.linked_sheet_id, camp\.linked_tab_name\)\) return 'booking'/.test(S('src/services/worktableOptionSlots.service.js')));
  {
    const orr = S('src/routes/order.routes.js');
    t('★★ 접수: 자리표 저장 실패 = 접수를 끝내지 않는다(booking_calendar_failed · 상태 전이 전)',
      /normalizeWorkKind\(o\.work_kind\) === 'booking'\) \{[\s\S]{0,300}code: 'booking_calendar_failed'/.test(orr));
    t('★ 재접수: 자리표가 비어 있으면 줄과 같을 때만 되살린다', /require\('\.\.\/services\/bookingSlots\.service'\)\s*\.repairCalendarIfMissing\(/.test(orr));
  }

  /* ── ⑦ 1단계 안전핀 유지 ─────────────────────────────────────── */
  console.log('\n⑦ 1단계 안전핀 유지');
  const wk = require('../src/utils/workKind');
  t('★★ booking 개방(결정 414 — 준비 중 목록 비어 있음 · 저장 입구 장치는 다음 종류용으로 남음)', !wk.NOT_READY_WORK_KINDS.includes('booking') && wk.isWorkKindReady('booking') === true && typeof wk.workKindNotReadyBody === 'function');   // 결정 418 — 목록에 영수증리뷰가 있어도 booking 은 개방(의미 불변)

  console.log(`\n✅ ${pass}개 통과\n`);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
