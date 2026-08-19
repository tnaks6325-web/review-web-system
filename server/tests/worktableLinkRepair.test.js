/* 작업표 줄 ↔ 주문 링크 교정 — 회귀가드.
 *
 * 배경(2026-08-19 위프 800건): 링크가 phone8 하나로 정해지던 시절, 한 연락처를 여러 명의가
 * 공유하면 한 주문이 여러 줄에 붙었다. 그 오염이 ㉮ 중복 정리로 **멀쩡한 주문을 취소**시키고
 * ㉯ 관제 대조를 오표시했다. 이 도구는 그 잔존분을 사람이 지목해 고치는 창구다.
 *
 * ★ 진짜 PG16 실행 가드 — 트랜잭션·FOR UPDATE·정규식·되돌리기(ROLLBACK)는 스텁으로 못 본다.
 *   PGTEST_URL=postgres://... node tests/worktableLinkRepair.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (m, c) => { assert.ok(c, m); console.log('  ✓ ' + m); n++; };
const eq = (m, a, b) => { assert.strictEqual(a, b, `${m} (got ${a}, want ${b})`); console.log(`  ✓ ${m} → ${a}`); n++; };

/* ═══ 라우터 스택 실검사 ═══ */
{
  const rt = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
  const i = rt.indexOf("router.post('/worktable/repair-link'");
  ok('라우트가 등록돼 있다', i > 0);
  const head = rt.slice(i, i + 200);
  ok('★ adminOrMaster 게이트 — 되돌리기 어려운 쓰기라 AE 에게 열지 않는다',
    /authMiddleware, adminOrMasterMiddleware/.test(head));
  ok('★ dryRun 기본 true(미리보기 없이 쓰지 않는다)', /dryRun: b\.dryRun !== false/.test(rt.slice(i, i + 900)));
  ok('★ confirm 은 명시 true 일 때만', /confirm: b\.confirm === true/.test(rt.slice(i, i + 900)));
}

/* ═══ 쓰기 표면 ═══ */
{
  const sv = fs.readFileSync(path.join(__dirname, '../src/services/worktableLinkRepair.service.js'), 'utf8');
  const writes = (sv.match(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(\w+)/g) || []).map(s => s.split(/\s+/).pop());
  const uniq = [...new Set(writes)].sort();
  eq('★ 쓰기 대상 테이블은 둘뿐', uniq.join(','), 'campaign_participants,order_submissions');
  ok('★ 시트·장부·정원·홀드 무접촉',
    !/sync_queue|review_index|campaign_applications|recruit_campaigns|raw_sheet/.test(sv));
  ok('★ 하드삭제 없음', !/DELETE FROM/.test(sv));
}

if (!process.env.PGTEST_URL) {
  console.log('\n⏭  PGTEST_URL 없음 — 정적 검사만 수행했다.');
  console.log(`\n✅ worktableLinkRepair: ${n}개 통과`);
  process.exit(0);
}

process.env.DATABASE_URL = process.env.PGTEST_URL;   // pool 은 require 시점에 읽는다
const pool = require('../src/db/pool');
const { repairWorktableLinks } = require('../src/services/worktableLinkRepair.service');

const S = 'sheetR', T = '탭R';
const OS_A = '11111111-0000-0000-0000-000000000001';   // 김윤경 주문(정상)
const OS_B = '22222222-0000-0000-0000-000000000002';   // 유재휘 주문(중복정리로 취소됨)

async function seed() {
  await pool.query(`
    DROP TABLE IF EXISTS campaign_participants, order_submissions;
    CREATE TABLE campaign_participants (id uuid primary key default gen_random_uuid(), sheet_id text, tab_name text,
      seq int, reviewer_name text, phone8 text, order_submission_id uuid, deleted_at timestamptz,
      updated_at timestamptz, updated_by text);
    CREATE TABLE order_submissions (id uuid primary key, sheet_id text, tab_name text, sheet_row int,
      order_num text, mirror_status text, deleted_at timestamptz, canceled_by text, updated_at timestamptz);
  `);
  await pool.query(`INSERT INTO campaign_participants (sheet_id,tab_name,seq,reviewer_name,phone8,order_submission_id) VALUES
      ($1,$2,192,'김윤경','32427251',$3),
      ($1,$2,375,'유재휘','32427251',$3),
      ($1,$2,166,'김현숙','32250135',$3)`, [S, T, OS_A]);
  await pool.query(`INSERT INTO order_submissions (id,sheet_id,tab_name,sheet_row,order_num,mirror_status,deleted_at,canceled_by) VALUES
      ($3,$1,$2,192,'4102169038684','written',NULL,NULL),
      ($4,$1,$2,375,'5102334927882','canceled',NOW(),'dedupe:김수만')`, [S, T, OS_A, OS_B]);
}
const linkOf = async (seq) => (await pool.query(
  `SELECT order_submission_id FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND seq=$3`, [S, T, seq])).rows[0].order_submission_id;
const ordOf = async (id) => (await pool.query(`SELECT mirror_status, deleted_at, canceled_by FROM order_submissions WHERE id=$1`, [id])).rows[0];

(async () => {
  await seed();

  /* ① 미리보기는 쓰지 않는다 */
  const dry = await repairWorktableLinks({ sheetId: S, tabName: T, by: 't',
    fixes: [{ seq: 375, action: 'relink', expectOrderSubmissionId: OS_A, orderNum: '5102334927882' }] });
  ok('① 미리보기 성공 판정', dry.ok === true && dry.applied === false);
  eq('★ 미리보기는 링크를 바꾸지 않는다', await linkOf(375), OS_A);
  eq('★ 미리보기는 취소도 되돌리지 않는다', (await ordOf(OS_B)).mirror_status, 'canceled');

  /* ② confirm 없이 실행 불가 */
  let e = null;
  try {
    await repairWorktableLinks({ sheetId: S, tabName: T, dryRun: false, by: 't',
      fixes: [{ seq: 375, action: 'relink', expectOrderSubmissionId: OS_A, orderNum: '5102334927882' }] });
  } catch (err) { e = err; }
  eq('② confirm 없으면 거부', e && e.code, 'confirm_required');

  /* ③ 실제 적용 — 재링크 + 중복정리 취소 되돌리기 */
  const run = await repairWorktableLinks({ sheetId: S, tabName: T, dryRun: false, confirm: true, by: 't',
    fixes: [{ seq: 375, action: 'relink', expectOrderSubmissionId: OS_A, orderNum: '5102334927882' }] });
  ok('③ 적용됨', run.ok === true && run.applied === true);
  eq('★ 자기 주문으로 재링크', await linkOf(375), OS_B);
  const restored = await ordOf(OS_B);
  eq('★ 중복정리가 취소한 주문은 되살린다', restored.mirror_status, 'written');
  ok('★ deleted_at·canceled_by 도 지운다', restored.deleted_at === null && restored.canceled_by === null);
  eq('★ 남의 줄(192)은 손대지 않는다', await linkOf(192), OS_A);

  /* ④ 낙관적 동시성 — 그 사이 값이 바뀌었으면 거부 */
  const stale = await repairWorktableLinks({ sheetId: S, tabName: T, dryRun: false, confirm: true, by: 't',
    fixes: [{ seq: 375, action: 'relink', expectOrderSubmissionId: OS_A, orderNum: '5102334927882' }] });
  eq('④ 기대값이 다르면 거부', stale.code, 'changed');
  eq('★ 거부 시 값 불변', await linkOf(375), OS_B);

  /* ⑤ 원장에 없는 주문번호는 채우지 않는다 */
  const nf = await repairWorktableLinks({ sheetId: S, tabName: T, dryRun: false, confirm: true, by: 't',
    fixes: [{ seq: 166, action: 'relink', expectOrderSubmissionId: OS_A, orderNum: '11102128152660' }] });
  eq('⑤ 원장에 없으면 거부(추측 금지)', nf.code, 'order_not_found');
  eq('★ 거부 시 링크 불변', await linkOf(166), OS_A);

  /* ⑥ 줄 번호가 다르면 거부 */
  const rm = await repairWorktableLinks({ sheetId: S, tabName: T, dryRun: false, confirm: true, by: 't',
    fixes: [{ seq: 166, action: 'relink', expectOrderSubmissionId: OS_A, orderNum: '4102169038684' }] });
  eq('⑥ 주문의 줄 번호와 다르면 거부', rm.code, 'row_mismatch');

  /* ⑦ 링크 비우기 */
  const un = await repairWorktableLinks({ sheetId: S, tabName: T, dryRun: false, confirm: true, by: 't',
    fixes: [{ seq: 166, action: 'unlink', expectOrderSubmissionId: OS_A }] });
  ok('⑦ 링크 비우기 적용', un.applied === true);
  eq('★ 비워졌다', await linkOf(166), null);

  /* ⑧ 전부 아니면 전무 */
  await seed();
  const mix = await repairWorktableLinks({ sheetId: S, tabName: T, dryRun: false, confirm: true, by: 't',
    fixes: [
      { seq: 166, action: 'unlink', expectOrderSubmissionId: OS_A },
      { seq: 375, action: 'relink', expectOrderSubmissionId: 'wrong-id', orderNum: '5102334927882' },
    ] });
  ok('⑧ 한 건이라도 실패하면 전체 롤백', mix.ok === false && mix.applied === false);
  eq('★ 앞 건도 적용되지 않았다', await linkOf(166), OS_A);

  /* ⑨ 사람이 취소한 주문은 되살리지 않는다 */
  await pool.query(`UPDATE order_submissions SET canceled_by='admin:김수만' WHERE id=$1`, [OS_B]);
  const human = await repairWorktableLinks({ sheetId: S, tabName: T, dryRun: false, confirm: true, by: 't',
    fixes: [{ seq: 375, action: 'relink', expectOrderSubmissionId: OS_A, orderNum: '5102334927882' }] });
  ok('⑨ 재링크는 되지만', human.applied === true);
  eq('★ 사람이 취소한 주문은 취소 상태 유지', (await ordOf(OS_B)).mirror_status, 'canceled');
  ok('★ 그 사실을 응답이 말한다', !!(human.results[0] && human.results[0].orderStillCanceled));

  await pool.end();
  console.log(`\n✅ worktableLinkRepair: ${n}개 통과`);
})().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
