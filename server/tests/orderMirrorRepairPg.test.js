/**
 * orderMirrorRepairPg.test.js — 진짜 PG16 로 SQL 을 실행해 확인한다
 * 실행: PGTEST_URL=postgres://... node tests/orderMirrorRepairPg.test.js
 *
 * ★ 스텁 pool 은 SQL 을 해석하지 않는다 — 상태 화이트리스트·소프트삭제 제외·`sinceHours` 창
 *   같은 **WHERE 절의 의미**는 여기서만 검증된다(jsonb `cells->>$n::int` 사고와 같은 교훈).
 */
process.env.DATABASE_URL = process.env.PGTEST_URL || process.env.DATABASE_URL || '';
const assert = require('assert');
if (!process.env.PGTEST_URL) { console.log('⏭  PGTEST_URL 없음 — 건너뜀'); process.exit(0); }

const pool = require('../src/db/pool');
const slOrder = require('../src/services/sheetlessOrder.service');

let passed = 0;
const ok = (n, c) => { assert(c, n); passed++; console.log('  ✓ ' + n); };

const SHEET = 'campaign:camp_pgtest01';
const WT = 'wt_pgtest0000000000000';
const TAB = '테스트 작업표';

async function seed() {
  await pool.query(`DELETE FROM campaign_participants WHERE sheet_id IN ($1,$2)`, [SHEET, WT]);
  await pool.query(`DELETE FROM order_submissions WHERE sheet_id IN ($1,$2)`, [SHEET, WT]);
  await pool.query(`DELETE FROM campaign_applications WHERE campaign_id = 'camp_pgtest01'`);
  await pool.query(`DELETE FROM recruit_campaigns WHERE id = 'camp_pgtest01'`);
  await pool.query(`DELETE FROM tab_configs WHERE sheet_id = $1`, [WT]);

  await pool.query(
    `INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, linked_tab_gid)
     VALUES ('camp_pgtest01','PG 테스트 공고','active',TRUE,$1,$2,'12345')`, [WT, TAB]);
  await pool.query(
    `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheetless)
     VALUES ($1,$2,'12345','PG 테스트',TRUE)`, [WT, TAB]);

  const mk = async (n, status, ago, cp, opts = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO order_submissions (sheet_id, tab_name, mirror_status, submitted_at, recipient, phone, order_num)
       VALUES ($1,$2,$3, NOW() - ($4 || ' hours')::interval, $5, $6, $7) RETURNING id`,
      [opts.sheetId || SHEET, opts.tabName || SHEET, status, String(ago), '수취인' + n, '0101111' + n, '90000000' + n]);
    const id = rows[0].id;
    if (cp) {
      await pool.query(
        `INSERT INTO campaign_participants (sheet_id, tab_name, seq, order_submission_id, source, deleted_at)
         VALUES ($1,$2,$3,$4,'worktable',$5)`,
        [WT, TAB, cp.seq, id, cp.deleted ? new Date() : null]);
    }
    return id;
  };

  return {
    failedWithRow:    await mk(1, 'failed', 2, { seq: 11 }),                 // ← 정정 대상
    pendingWithRow:   await mk(2, 'pending', 3, { seq: 12 }),                // ← 정정 대상
    canceledWithRow:  await mk(3, 'canceled', 4, { seq: 13 }),               // 취소 — 되살리면 안 됨
    stuckWithRow:     await mk(4, 'stuck_manual', 5, { seq: 14 }),           // 수동입력 표시 — 유지
    failedDeletedRow: await mk(5, 'failed', 6, { seq: 15, deleted: true }),  // 줄 정리됨 = 반영 아님
    failedNoRow:      await mk(6, 'failed', 7, null),                        // 줄 없음 = 복구 잡 담당
    writtenWithRow:   await mk(7, 'written', 8, { seq: 17 }),                // 이미 완결 — 무접촉
  };
}

const st = async (id) => (await pool.query('SELECT mirror_status, sheet_row FROM order_submissions WHERE id=$1', [id])).rows[0];

(async () => {
  const ids = await seed();

  console.log('\n[1] 완결 표시 정정 — dryRun');
  {
    const out = await slOrder.repairWrittenMarkForBoardRows({ dryRun: true });
    ok('대상은 2건뿐(failed·pending × 살아있는 줄)', out.scanned === 2);
    ok('상태별 집계', out.byStatus.failed === 1 && out.byStatus.pending === 1);
    ok('★ dryRun 은 아무것도 바꾸지 않는다', (await st(ids.failedWithRow)).mirror_status === 'failed');
    ok('줄 번호를 찾아 보고한다', out.items.some(i => i.seq === 11) && out.items.some(i => i.seq === 12));
  }

  console.log('\n[2] 완결 표시 정정 — 실행');
  {
    const out = await slOrder.repairWrittenMarkForBoardRows({ dryRun: false, by: 'pgtest' });
    ok('2건 정정', out.repaired === 2);
    const a = await st(ids.failedWithRow), b = await st(ids.pendingWithRow);
    ok('failed → written + 줄 번호 기록', a.mirror_status === 'written' && a.sheet_row === 11);
    ok('pending → written + 줄 번호 기록', b.mirror_status === 'written' && b.sheet_row === 12);
    ok('★ 취소된 주문은 되살아나지 않는다', (await st(ids.canceledWithRow)).mirror_status === 'canceled');
    ok('★ stuck_manual(수동입력 대상) 은 유지', (await st(ids.stuckWithRow)).mirror_status === 'stuck_manual');
    ok('★ 소프트삭제된 줄은 근거가 아니다 — 미완결 유지', (await st(ids.failedDeletedRow)).mirror_status === 'failed');
    ok('★ 줄이 없는 주문은 손대지 않는다(복구 잡 담당)', (await st(ids.failedNoRow)).mirror_status === 'failed');
    ok('멱등 — 다시 돌리면 0건', (await slOrder.repairWrittenMarkForBoardRows({ dryRun: false })).repaired === 0);
  }

  console.log('\n[3] 시트 기반 좌표는 대상이 아니다');
  {
    const SB = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const { rows } = await pool.query(
      `INSERT INTO order_submissions (sheet_id, tab_name, mirror_status, submitted_at, recipient)
       VALUES ($1,'시트탭','failed',NOW(),'시트수취인') RETURNING id`, [SB]);
    await pool.query(
      `INSERT INTO campaign_participants (sheet_id, tab_name, seq, order_submission_id, source)
       VALUES ($1,'시트탭',3,$2,'import')`, [SB, rows[0].id]);
    const out = await slOrder.repairWrittenMarkForBoardRows({ dryRun: true });
    ok('★ campaign:* 아닌 좌표는 스캔되지 않는다(그쪽은 큐 리컨실이 담당)', out.scanned === 0);
    await pool.query('DELETE FROM campaign_participants WHERE order_submission_id=$1', [rows[0].id]);
    await pool.query('DELETE FROM order_submissions WHERE id=$1', [rows[0].id]);
  }

  console.log('\n[4] 자동 인계 창(sinceHours) — SQL 실행 + 창이 옛 건을 뺀다');
  {
    const mkOrder = async (ago) => (await pool.query(
      `INSERT INTO order_submissions (sheet_id, tab_name, mirror_status, submitted_at, recipient, phone)
       VALUES ($1,$1,'failed', NOW() - ($2 || ' hours')::interval, '인계수취인','01099990000') RETURNING id`,
      [SHEET, String(ago)])).rows[0].id;
    // 준비된 빈 슬롯 1줄 — 열 이름(row_json 키)이 있어야 작업표에 실제로 기록된다
    await pool.query(
      `INSERT INTO campaign_participants (sheet_id, tab_name, seq, source, active, row_json)
       VALUES ($1,$2,20,'worktable',TRUE,$3::jsonb)`,
      [WT, TAB, JSON.stringify({ '번호': '20', '구매일자': '8 / 19 (수)', '수취인': '', '연락처': '', '주소': '' })]);
    const recent = await mkOrder(3), old = await mkOrder(24 * 10);
    for (const [i, oid] of [recent, old].entries()) {
      await pool.query(
        `INSERT INTO campaign_applications (campaign_id, applicant_name, status, phone8, order_submission_id, submitted_at)
         VALUES ('camp_pgtest01', $1, 'submitted', $2, $3, NOW())`, ['신청자' + i, '9999000' + i, oid]);
    }
    const win = await slOrder.recoverUnwrittenSheetlessOrders({ limit: 50, sinceHours: 48 });
    ok('★ SQL 실행 성공(창 절 타입 오류 없음)', typeof win.scanned === 'number');
    ok('★ 창 밖(10일 전) 주문은 스캔되지 않는다', win.scanned === 1);
    ok('창 값이 결과에 실린다', win.sinceHours === 48);
    ok('최근 건은 작업보드에 인계된다 — 준비된 빈 슬롯을 먹는다',
      win.written === 1 && win.items[0].ok === true && win.items[0].seq === 20);
    const filled = (await pool.query(
      `SELECT recipient_name, row_json->>'수취인' AS r FROM campaign_participants
        WHERE sheet_id=$1 AND tab_name=$2 AND seq=20`, [WT, TAB])).rows[0];
    ok('★ 그 줄에 주문 값이 실제로 들어간다', filled.recipient_name === '인계수취인' && filled.r === '인계수취인');
    const all = await slOrder.recoverUnwrittenSheetlessOrders({ limit: 50 });
    ok('★ 창 미지정 = 전체(옛 건도 대상)', all.scanned === 1 && all.sinceHours === null);
  }

  console.log(`\n총 ${passed}개 통과\n`);
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
