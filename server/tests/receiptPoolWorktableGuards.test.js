/**
 * receiptPoolWorktableGuards.test.js — 영수증리뷰 2단계 회귀가드: 영수증 묶음 저장(실제 SQL) + 작업표 자동 정리 격리(결정 420)
 * 실행: node tests/receiptPoolWorktableGuards.test.js
 *
 * 위험:
 *  ① 영수증 묶음이 작업표 줄과 다른 줄 번호로 저장되거나, 재접수에서 두 번 깔린다 · 같은 영수증이 두 자리에 들어간다.
 *  ② 비공개 경로로 올라오지 않은 파일 번호(공개 안내 사진·이체결과 파일)가 영수증 자리에 들어간다.
 *  ③ 작업표를 스스로 손보는 기능(빈 줄 날짜 옮기기·총 건수 맞추기·번호 겹친 빈 줄 정리·아무 빈 줄에나 주문 끼우기·
 *     줄 정리·날짜 고치기·차수)이 **날짜를 지어 붙이거나** 영수증 자리를 지운다.
 *  ④ 판정 조회가 실패했을 때 영수증 탭을 리뷰 탭처럼 정리한다(fail-open).
 *  ⑤ 예약리뷰·Q&A 판정이 영수증 탭을 자기 탭으로 읽거나, 그 반대.
 *  ⑥ 1단계 안전핀이 풀린다 — 2단계는 저장 입구를 열지 않는다.
 * ★ 저장·판정·날짜 옮기기·총 건수 맞추기·날짜 고치기·칸 편집·줄 삭제 보충·줄 정리는 PGlite(저장소 migrations 그대로)에서 실제로 돌린다.
 *   운영 DB 에 닿지 않는다(가짜 이름·가짜 매장·가짜 파일 번호).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const SERVER = path.join(__dirname, '..');
const TAB = '12월 가짜카페 영수증리뷰';
const REVIEW_TAB = '12월 가짜상품 리뷰';
const WO = 'wo_receipt_fixture';
const FID = n => `fake_receipt_${String(n).padStart(4, '0')}_abcdefghijk`;
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
  console.log('\n▶ 영수증리뷰 2단계 — 영수증 묶음 저장 · 작업표 자동 정리 격리\n');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);

  const rp = require('../src/services/receiptPool.service');

  /* ── 0) 표 · 판정 ─────────────────────────────────────────────── */
  console.log('0) 영수증 묶음 표 · 영수증 탭 판정');
  const colsOf = async tbl => (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [tbl])).rows.map(r => r.column_name);
  {
    const c1 = await colsOf('receipt_pool');
    const c2 = await colsOf('receipt_review_files');
    t('★ receipt_pool 칸', ['work_order_id', 'sheet_id', 'tab_name', 'seq', 'pool_seq', 'file_id', 'status'].every(c => c1.includes(c)));
    t('★ receipt_review_files 칸(비공개 영수증 사진 목록)', ['file_id', 'source', 'mime_type', 'created_at'].every(c => c2.includes(c)));
  }
  t('migration 파일 번호 230 은 하나뿐', fs.readdirSync(path.join(SERVER, 'migrations')).filter(f => /^230_/.test(f)).length === 1);
  t('★ 기동 필수 표 목록에 receipt_pool · receipt_review_files', /REQUIRED_TABLES\s*=\s*\[[\s\S]{0,6000}'receipt_pool'/.test(S('index.js'))
    && /REQUIRED_TABLES\s*=\s*\[[\s\S]{0,6000}'receipt_review_files'/.test(S('index.js')));

  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);
  const receipts = [1, 2, 3, 4].map(n => ({ file_id: FID(n) }));
  const place = { name: '가짜카페 역삼점', url: 'https://map.naver.com/p/entry/place/0000000', option_schema_version: 2, product_mode: 'none',
    base: { pay: 0, count: 4, daily: 0, review_type_mix: [] }, options: [], receipt: { review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1', receipts } };
  const wo = { id: WO, title: TAB, work_kind: 'receipt', workboard_schema_version: 2, recruit_count: 4, review_fee: 5000, pay_amount: 0, start_date: null,
    product_options_json: JSON.stringify([place]) };

  /* ── ① 접수 저장 — 작업표 줄과 같은 흐름 ───────────────────────── */
  console.log('\n① 접수 저장(작업표 줄 + 영수증 묶음)');
  const acc = require('../src/services/sheetlessAccept.service');
  const made = await acc.createSheetlessWorktable({ workOrder: wo, tabName: TAB, by: 'test' });
  t('작업표 계획 성공 · 4줄', made.ok === true && made.rows.length === 4);
  t('★ 영수증 자리 4칸이 줄 번호(2..5)를 갖는다', Array.isArray(made.receiptPoolSlots) && made.receiptPoolSlots.map(s => s.rowSeq).join() === '2,3,4,5');
  t('예약·Q&A 자리표는 싣지 않는다', made.bookingSlots === null && made.qnaSlots === null);
  const sheetId = made.sheetId;
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'receipt', TRUE, 2)`, [sheetId, TAB, made.gid]);
  {
    let err = null;
    try { await made.persist(); } catch (e) { err = e; }
    t('★★ 비공개 경로로 올라온 적 없는 파일 번호면 묶음을 깔지 않고 던진다(공개 사진·이체결과 파일 끼워 넣기 차단)',
      err && err.code === 'receipt_file_unregistered' && /4/.test(err.message) && (await rp.poolForTab(pool, sheetId, TAB)).length === 0);
  }
  for (const r of receipts) await rp.registerReceiptUpload(r.file_id, { source: 'upload:intranet', mimeType: 'image/jpeg' });
  await made.persist();
  const cps = (await q(`SELECT seq, start_date, option_text, row_json FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 ORDER BY seq`, [sheetId, TAB])).rows;
  const pr = await rp.poolForTab(pool, sheetId, TAB);
  t('★★ 작업표 4줄 · 참여일자 비어 있음(날짜를 지어내지 않는다) · 영수증 칸 1번..4번', cps.length === 4
    && cps.every(r => !r.start_date && r.row_json['참여일자'] === '' && r.row_json['리뷰마감일'] === '')
    && cps.map(r => r.row_json['영수증']).join('|') === '1번|2번|3번|4번');
  t('★★ 영수증 묶음 4칸 = 줄 번호·영수증 순번·파일 번호(받은 순서 그대로)', pr.length === 4
    && pr.map(s => `${s.seq}:${s.pool_seq}:${s.file_id}`).join(',') === [2, 3, 4, 5].map((seq, i) => `${seq}:${i + 1}:${FID(i + 1)}`).join(',')
    && pr.every(s => s.work_order_id === WO && s.status === 'open'));
  t('★ 작업표 줄·장부에 영수증 파일 번호가 없다(업체 화면에도 나가는 표)', !JSON.stringify(cps).includes('fake_receipt_')
    && !JSON.stringify((await q(`SELECT * FROM raw_sheet_rows WHERE sheet_id = $1`, [sheetId]).catch(() => ({ rows: [] }))).rows).includes('fake_receipt_'));
  await made.persist();
  t('★ 다시 깔아도 두 번 깔리지 않는다(재시도 멱등)', (await rp.poolForTab(pool, sheetId, TAB)).length === 4);
  t('남은 영수증 수(3단계 신청 재료)', JSON.stringify(await rp.poolCounts(pool, sheetId, TAB)) === JSON.stringify({ total: 4, open: 4 }));
  {
    let e1 = null, e2 = null;
    try { await q(`INSERT INTO receipt_pool (work_order_id, sheet_id, tab_name, seq, pool_seq, file_id) VALUES ($1, $2, $3, 99, 1, 'other_file_aaaaaaaaaaaaaa')`, [WO, sheetId, TAB]); } catch (e) { e1 = e; }
    try { await q(`INSERT INTO receipt_pool (work_order_id, sheet_id, tab_name, seq, pool_seq, file_id) VALUES ($1, $2, $3, 98, 9, $4)`, [WO, sheetId, TAB, FID(1)]); } catch (e) { e2 = e; }
    t('★ 같은 탭에 같은 영수증 순번은 두 번 못 만든다(유일 색인)', !!e1);
    t('★★ 같은 탭에 같은 영수증 사진은 두 자리에 못 들어간다(한 장 = 한 사람 · 유일 색인)', !!e2);
  }
  {
    // 이미 깔린 줄이 계획과 다르면(손으로 고친 영수증 칸) 묶음을 붙이지 않는다
    await q(`DELETE FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2`, [sheetId, TAB]);
    await q(`UPDATE campaign_participants SET row_json = jsonb_set(row_json, '{영수증}', '"9번"') WHERE sheet_id = $1 AND tab_name = $2 AND seq = 4`, [sheetId, TAB]);
    let err = null;
    try { await (await acc.createSheetlessWorktable({ workOrder: wo, tabName: TAB, by: 'test' })).persist(); } catch (e) { err = e; }
    t('★★ 깔린 줄이 계획과 다르면 묶음을 붙이지 않고 던진다(어긋난 묶음 금지)', err && /4/.test(err.message) && (await rp.poolForTab(pool, sheetId, TAB)).length === 0);
    const rep0 = await rp.repairPoolIfMissing({ workOrder: wo, sheetId, tabName: TAB, by: 'test' });
    t('★ 재접수 복구도 줄이 다르면 되살리지 않는다(fail-closed)', rep0.ok === false && rep0.reason === 'rows_mismatch');
    await q(`UPDATE campaign_participants SET row_json = jsonb_set(row_json, '{영수증}', '"3번"') WHERE sheet_id = $1 AND tab_name = $2 AND seq = 4`, [sheetId, TAB]);
    const rep = await rp.repairPoolIfMissing({ workOrder: wo, sheetId, tabName: TAB, by: 'test' });
    t('★ 재접수 복구: 줄이 계획과 같으면 같은 묶음을 되살린다', rep.ok && rep.repaired && rep.inserted === 4 && (await rp.poolForTab(pool, sheetId, TAB)).length === 4);
    t('이미 있으면 복구하지 않는다', (await rp.repairPoolIfMissing({ workOrder: wo, sheetId, tabName: TAB })).reason === 'present');
  }

  /* 판정 */
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind, sheetless) VALUES ($1, $2, '', TRUE)`, [sheetId, REVIEW_TAB]);
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind, sheetless) VALUES ($1, '묶음 없는 영수증 탭', 'receipt', TRUE)`, [sheetId]);
  t('★ 묶음이 있으면 영수증 탭', await rp.isReceiptPoolTab(pool, sheetId, TAB) === true);
  t('리뷰 탭은 아님', await rp.isReceiptPoolTab(pool, sheetId, REVIEW_TAB) === false);
  t('★ 묶음이 없어도 탭 종류가 receipt 면 영수증 탭(저장 실패한 영수증 탭도 리뷰 탭처럼 정리되지 않게)', await rp.isReceiptPoolTab(pool, sheetId, '묶음 없는 영수증 탭') === true);
  t('★ 조회 실패 = 영수증 탭으로 본다(fail-closed)', await rp.isReceiptPoolTab({ query: async () => { throw new Error('x'); } }, 's', 't') === true);
  t('★ 표가 없는 환경(42P01)도 영수증 탭으로 본다', await rp.isReceiptPoolTab({ query: async () => { throw Object.assign(new Error('x'), { code: '42P01' }); } }, 's', 't') === true);
  {
    const log = [];
    const txc = { release() {}, query: async (sql) => { log.push(String(sql)); if (/FROM receipt_pool/.test(sql)) throw new Error('boom'); return { rows: [] }; } };
    t('★ 트랜잭션 안: 실패하면 SAVEPOINT 로 되돌리고 영수증 탭으로 본다', await rp.isReceiptPoolTab(txc, 's', 't') === true
      && log[0] === 'SAVEPOINT receipt_pool_tab_probe' && log.includes('ROLLBACK TO SAVEPOINT receipt_pool_tab_probe'));
    const log2 = [];
    const txo = { release() {}, query: async (sql) => { log2.push(String(sql)); return { rows: /FROM receipt_pool/.test(sql) ? [{ b: false }] : [] }; } };
    t('트랜잭션 안: 성공하면 SAVEPOINT 를 풀고 결과 그대로', await rp.isReceiptPoolTab(txo, 's', 't') === false && log2.includes('RELEASE SAVEPOINT receipt_pool_tab_probe'));
    t('★ 빈 응답 = 아님(조회는 됐는데 행 없음)', await rp.isReceiptPoolTab({ query: async () => ({ rows: [] }) }, 's', 't') === false);
  }
  t('탭 이름이 없으면 아님', await rp.isReceiptPoolTab(pool, '', TAB) === false);
  t('★ 자리 줄 판정(실제 SQL)', await rp.isPoolBoundRow(pool, sheetId, TAB, 3) === true && await rp.isPoolBoundRow(pool, sheetId, TAB, 50) === false);
  t('자리 줄 판정 실패 = 묶인 것으로 본다', await rp.isPoolBoundRow({ query: async () => { throw new Error('x'); } }, 's', 't', 1) === true);
  t('묶인 줄 번호 고르기(실제 SQL)', JSON.stringify(await rp.poolBoundSeqs(pool, sheetId, TAB, [3, 9, 5])) === '[3,5]');
  t('묶임 판정 SQL = 같은 탭·같은 줄 번호', rp.poolBoundRowSql('p') === 'EXISTS (SELECT 1 FROM receipt_pool rcp WHERE rcp.sheet_id = p.sheet_id AND rcp.tab_name = p.tab_name AND rcp.seq = p.seq)');
  t('★ 줄 → 영수증 파일(직원 보기 통로가 쓴다 · 실제 SQL)', await rp.fileForRow(pool, sheetId, TAB, 3) === FID(2) && await rp.fileForRow(pool, sheetId, TAB, 50) === null);
  {
    const bs = require('../src/services/bookingSlots.service');
    const qs = require('../src/services/qnaSlots.service');
    t('★★ 예약리뷰·Q&A 판정은 영수증 탭을 자기 탭으로 읽지 않는다', await bs.isBookingTab(pool, sheetId, TAB) === false && await qs.isQnaTab(pool, sheetId, TAB) === false);
    await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind, sheetless) VALUES ($1, '가짜 예약 탭', 'booking', TRUE)`, [sheetId]);
    t('★ 영수증 판정도 예약 탭을 영수증 탭으로 읽지 않는다', await rp.isReceiptPoolTab(pool, sheetId, '가짜 예약 탭') === false);
  }

  /* ── ② 빈 줄 날짜 옮기기 ─────────────────────────────────────── */
  console.log('\n② 빈 줄 날짜 옮기기(relay)');
  const daily = require('../src/services/sheetlessDailyPlan.service');
  const snap = async () => (await q(`SELECT seq, start_date, row_json->>'참여일자' AS d, row_json->>'영수증' AS r FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active ORDER BY seq`, [sheetId, TAB])).rows.map(x => `${x.seq}:${x.start_date}:${x.d}:${x.r}`).join(',');
  const before = await snap();
  const rel = await daily.relayWorktableToProjection({ client: pool, sheetId, tabName: TAB, days: [{ date: '2026-12-20', quota: 4 }], today: '2026-12-01' });
  t('★★ 영수증 탭: 건너뛰고 아무 줄에도 날짜를 붙이지 않는다(실제 SQL)', rel.skipped === true && rel.reason === 'receipt_pool' && (await snap()) === before);

  /* ── ③ 총 건수 맞추기 ─────────────────────────────────────────── */
  console.log('\n③ 총 건수 맞추기(quota sync)');
  const lrq = require('../src/services/linkedRecruitQuota.service');
  const camp = { id: 'camp_receipt', linked_sheet_id: sheetId, linked_tab_name: TAB };
  const tryQ = async (fn) => { try { return { out: await fn() }; } catch (e) { return { err: e }; } };
  const down = await tryQ(() => lrq.syncWorktableSlotsInTx(pool, camp, 2, 'test'));
  t('★★ 줄이기 = 거절(recruit_quota_receipt_locked) · 줄을 지우지 않는다', down.err && down.err.code === 'recruit_quota_receipt_locked' && (await snap()) === before);
  const up = await tryQ(() => lrq.syncWorktableSlotsInTx(pool, camp, 9, 'test'));
  t('★★ 늘리기 = 거절 · 영수증 없는 줄을 덧붙이지 않는다', up.err && up.err.code === 'recruit_quota_receipt_locked' && (await snap()) === before);
  const same = await tryQ(() => lrq.syncWorktableSlotsInTx(pool, camp, 4, 'test'));
  t('건수가 같으면 통과(발행 때 같은 수)', !same.err);
  {
    const lsrc = S('src/services/linkedRecruitQuota.service.js');
    const fn = lsrc.slice(lsrc.indexOf('async function _assertQnaCalendarUnchanged'), lsrc.indexOf('async function assertWorktableSlotsInTx'));
    t('★ 저장 전 확인(assert)도 같은 규칙 — 확인·맞추기 두 곳이 같은 함수(영수증 거절 포함)를 탄다',
      (lsrc.match(/await _assertQnaCalendarUnchanged\(client, campaign, delta\);/g) || []).length === 2
      && /isReceiptPoolTab\(client, campaign\.linked_sheet_id, campaign\.linked_tab_name\)[\s\S]{0,200}'recruit_quota_receipt_locked'/.test(fn));
  }
  t('정원 동기화의 영수증 거절은 409 로(500 위장 금지)', /recruit_quota_receipt_locked: 409/.test(S('src/routes/trackB.routes.js')));
  t('작업표 만들 때 모집인원만큼 빈 줄 맞추기도 영수증리뷰는 건너뛴다(영수증 장수가 줄을 정한다)',
    /!require\('\.\.\/utils\/workKind'\)\.isBookingKind\(c\.work_kind\) && !require\('\.\.\/utils\/workKind'\)\.isReceiptKind\(c\.work_kind\)/.test(S('src/services/campaignWorktable.service.js')));

  /* ── ④ 날짜 고치기 · 칸 편집 ──────────────────────────────────── */
  console.log('\n④ 날짜 고치기 · 칸 편집');
  const tb = require('../src/services/trackB.service');
  tb.__setPoolForTest(pool);
  const rowOf = async (seq) => (await q(`SELECT id FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [sheetId, TAB, seq])).rows[0].id;
  const dt = await tb.setWorkdeskPurchaseDate({ sheetId, tabName: TAB, rowId: await rowOf(3), date: '2026-12-20', by: 'test' });
  t('★★ 자리 줄의 참여일자는 달력으로 못 넣는다(참여할 때 시스템이 적는다 · 실제 SQL)', dt.ok === false && dt.error === 'receipt_pool_date_locked' && (await snap()) === before);
  for (const h of ['영수증', '상품', '참여일자']) {
    const r = await tb.editWorkdeskRow({ sheetId, tabName: TAB, rowId: await rowOf(3), field: `col:${h}`, value: '바꿈', by: 'test' });
    t(`★★ 칸 편집: 자리 줄의 「${h}」 칸은 막는다(receipt_pool_cell_locked · 실제 SQL)`, r && r.ok === false && r.error === 'receipt_pool_cell_locked' && (await snap()) === before);
  }
  {
    const tbs = S('src/services/trackB.service.js');
    t('리뷰마감일 칸은 막지 않는다(담당자가 기한을 늘려 줄 수 있다 — 3단계에 시스템이 채운다)',
      /const _receiptCell = \[_wp\.RECEIPT_DATE_HEADER, _wp\.RECEIPT_POOL_HEADER\]\.includes\(_hdr\)/.test(tbs) && !/_receiptCell = [^\n]*RECEIPT_DEADLINE_HEADER/.test(tbs));
  }

  /* ── ⑤ 줄 삭제 보충 ───────────────────────────────────────────── */
  console.log('\n⑤ 줄 삭제 보충');
  {
    // 3단계에 참여일자가 찬 줄을 흉내 낸다 — 보충 줄은 그 날짜·마감을 잇지 않고 같은 영수증만 잇는다
    await q(`UPDATE campaign_participants SET start_date = '12 / 3 (목)', row_json = row_json || '{"참여일자":"12 / 3 (목)","리뷰마감일":"12 / 6 (일)","수취인":"가짜리뷰어"}'::jsonb WHERE sheet_id = $1 AND tab_name = $2 AND seq = 4`, [sheetId, TAB]);
    const victim = await rowOf(4);   // 3번 영수증 자리
    const r = await tb.hideWorkdeskRow({ sheetId, tabName: TAB, rowId: victim, by: 'test', actorRole: 'admin' });
    const after = (await q(`SELECT seq, start_date, row_json FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active ORDER BY seq`, [sheetId, TAB])).rows;
    const moved = (await rp.poolForTab(pool, sheetId, TAB)).find(s => s.pool_seq === 3);
    const repl = after.find(x => Number(x.seq) === Number(moved && moved.seq));
    t('★★ 줄 삭제(실제 SQL): 같은 영수증(3번)으로 보충 · 묶음이 새 줄을 가리킨다 · 줄 수 그대로',
      r && r.ok !== false && after.length === 4 && !after.some(x => Number(x.seq) === 4) && moved && Number(moved.seq) !== 4 && moved.file_id === FID(3)
      && repl && repl.row_json['영수증'] === '3번' && repl.row_json['상품'] === '가짜카페 역삼점');
    t('★★ 보충 줄은 날짜·마감·사람을 잇지 않는다(새 자리 = 아직 아무도 참여 안 함)', repl && !repl.start_date && !repl.row_json['참여일자']
      && !repl.row_json['리뷰마감일'] && !repl.row_json['수취인']);
    const tbs = S('src/services/trackB.service.js');
    t('★ 영수증 탭 판정은 Q&A·예약 판정 뒤에만(그 둘이면 돌지도 않는다) · 날짜를 잇는 갈래(_slotTab)에 넣지 않는다',
      /const _receiptTab = !_qnaTab && !_bookingTab && await require\('\.\/receiptPool\.service'\)\.isReceiptPoolTab\(client, sheetId, tabName\);/.test(tbs)
      && /const _slotTab = _qnaTab \|\| _bookingTab;/.test(tbs));
    t('★★ 묶음이 보충 줄을 가리키게 같은 트랜잭션에서 옮긴다', /if \(_receiptBound && replacement\) \{\s*await client\.query\(\s*'UPDATE receipt_pool SET seq = \$4, updated_at = NOW\(\) WHERE sheet_id = \$1 AND tab_name = \$2 AND seq = \$3'/.test(tbs));
  }
  {
    const { findDateColumnIndex } = require('../src/services/campaignSchedule.service');
    t('★ 날짜 칸 찾기는 「참여일자」를 보지 않는다(기존 탭 판정 불변 · 영수증 보충 줄에 날짜를 붙이지 않음)',
      findDateColumnIndex(['번호', '참여일자', '상품', '영수증']) === -1 && findDateColumnIndex(['참여일자', '구매일자']) === 1);
  }

  /* ── ⑥ 나머지 경로 ────────────────────────────────────────────── */
  console.log('\n⑥ 나머지 경로');
  t('★ 번호 겹친 빈 줄 정리: 영수증 자리 줄은 대상에서 뺀다', /AND NOT \$\{require\('\.\/receiptPool\.service'\)\.poolBoundRowSql\('p'\)\}/.test(S('src/services/rowNumbering.service.js')));
  {
    const so = S('src/services/sheetlessOrder.service.js');
    const iR = so.indexOf("require('./receiptPool.service').isReceiptPoolTab(client, sheetId, tabName)");
    const iAppend = so.indexOf("require('./participants.service').appendSlot(client");
    t('★★ 아무 빈 줄에나 주문 끼우기: 영수증 탭은 자리 번호 없는 주문을 덧붙이기 전에 멈춘다(receipt_pool_required)',
      iR > 0 && iR < iAppend && /reason: 'receipt_pool_required'/.test(so));
  }
  const tbs = S('src/services/trackB.service.js');
  t('번호 없는 주문 옮기기: 영수증 탭은 거절', /isReceiptPoolTab\(client, sheetId, tabName\)\) \{ return \{ ok: false, error: 'receipt_pool_required' \}; \}/.test(tbs));
  {
    const sa = require('../src/services/sheetlessApplicant.service');
    let err = null;
    try { await sa.addApplicantRow({ sheetId, tabName: TAB, applicant: { name: '가짜', phone: '01000000000' }, by: 'test', db: pool }); } catch (e) { err = e; }
    t('★ 옛 신청 줄 덧붙이기: 영수증 탭은 던진다(실제 실행)', err && /영수증리뷰 작업표에는 신청자 줄을 덧붙이지 않습니다/.test(err.message));
  }
  {
    const ledger = require('../src/services/sheetlessLedger.service');
    let err = null;
    try { await ledger.retireRows({ sheetId, tabName: TAB, seqs: [3, 99], dryRun: true }); } catch (e) { err = e; }
    t('★★ 줄 정리(중복 정리·짝 빈 줄 포함): 영수증 자리 줄이 섞이면 미리보기부터 거절(실제 SQL)', err && err.code === 'receipt_pool_rows');
    let err2 = null;
    try { await ledger.retireRows({ sheetId, tabName: TAB, rounds: ['1차'], dryRun: true }); } catch (e) { err2 = e; }
    t('★ 차수 단위 정리도 영수증 탭은 거절', err2 && err2.code === 'receipt_pool_rows');
  }
  {
    const od = require('../src/services/workdeskOrderDelete.service');
    await q(`UPDATE campaign_participants SET order_submission_id = '00000000-0000-4000-8000-000000000001' WHERE sheet_id = $1 AND tab_name = $2 AND seq = 3`, [sheetId, TAB]);
    const r = await od.deleteWorkdeskOrderRow({ sheetId, tabName: TAB, rowId: await rowOf(3), by: 'test', pool });
    await q(`UPDATE campaign_participants SET order_submission_id = NULL WHERE sheet_id = $1 AND tab_name = $2 AND seq = 3`, [sheetId, TAB]);
    t('★ 주문 행 삭제: 영수증 자리 줄은 「줄 삭제」로 안내(실제 실행 · 지우지 않음)', r && r.ok === false && r.code === 'receipt_pool_row');
    t('주문 행 삭제 409 매핑', /out\.code === 'receipt_pool_row' \? 409/.test(S('src/routes/trackB.routes.js')));
  }
  t('★ 차수 추가·삭제: 영수증 공고는 409(두 경로 모두)', (S('src/routes/trackB.routes.js').match(/isReceiptPoolCampaign\(campaignId\)\) \{\s*return res\.status\(409\)\.json\(\{ ok: false, code: 'rounds_receipt_locked'/g) || []).length === 2);
  {
    await q(`INSERT INTO recruit_campaigns (id, title, linked_sheet_id, linked_tab_name) VALUES ('camp_receipt', '가짜 영수증 공고', $1, $2)`, [sheetId, TAB]).catch(() => {});
    const linked = (await q(`SELECT 1 FROM recruit_campaigns WHERE id = 'camp_receipt'`)).rows.length === 1;
    t('★ 공고 판정(실제 SQL): 영수증 탭에 연결된 공고 = 참 · 없는 공고 = 거짓', !linked || (await rp.isReceiptPoolCampaign('camp_receipt') === true && await rp.isReceiptPoolCampaign('camp_none') === false));
  }
  t('작업 삭제 때 영수증 묶음도 함께 지운다(비공개 사진 목록은 남긴다 — 다른 통로 거절을 지키려고)', require('../src/services/workTabDelete.service').DELETE_TABLES.includes('receipt_pool')
    && !require('../src/services/workTabDelete.service').DELETE_TABLES.includes('receipt_review_files'));
  t('★ 작업 이름 바꾸기: 영수증 묶음도 같은 트랜잭션에서 따라간다', /UPDATE receipt_pool SET tab_name = \$1, updated_at = NOW\(\) WHERE sheet_id = \$2 AND tab_name = \$3/.test(S('src/services/tabRename.service.js')));
  t('옵션 다시 나누기: 영수증 탭은 해당 없음', /isReceiptPoolTab\(client, camp\.linked_sheet_id, camp\.linked_tab_name\)\) return 'receipt'/.test(S('src/services/worktableOptionSlots.service.js'))
    && /receipt_pool: '영수증리뷰 작업은 다시 나누기 해당 없음/.test(S('src/services/worktableOptionSlots.service.js')));
  t('★ 공유 저장: 영수증리뷰 오더는 접수 뒤 상품 구조(더하기·빼기) 영구 금지', require('../src/services/sharedPatch.service').structurePermanentlyLocked({ work_kind: 'receipt', product_options_json: '[]' }) === true
    && require('../src/services/sharedPatch.service').structurePermanentlyLocked({ work_kind: 'booking', product_options_json: '[]', delivery_type: '실배송' }) === false);
  {
    const orr = S('src/routes/order.routes.js');
    t('★★ 접수: 묶음 저장 실패 = 접수를 끝내지 않는다(receipt_pool_failed · 상태 전이 전)',
      /isReceiptKind\(o\.work_kind\)\) \{[\s\S]{0,300}code: 'receipt_pool_failed'/.test(orr)
      && orr.indexOf("code: 'receipt_pool_failed'") < orr.indexOf('indexBuilt = false;\n        sheetlessResult = { error: slErr.message };'));
    t('★ 재접수: 묶음이 비어 있으면 줄과 같을 때만 되살린다', /require\('\.\.\/services\/receiptPool\.service'\)\s*\.repairPoolIfMissing\(/.test(orr));
  }

  /* ── ⑦ 1단계 안전핀 유지 ─────────────────────────────────────── */
  console.log('\n⑦ 1단계 안전핀 유지');
  const wk = require('../src/utils/workKind');
  t('★★ 영수증리뷰는 여전히 「준비 중」(배포 그대로의 목록 — 시험이 비우지 않는다)', wk.NOT_READY_WORK_KINDS.includes('receipt') && wk.isWorkKindReady('receipt') === false);

  console.log(`\n✅ ${pass}개 통과\n`);
  await db.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
