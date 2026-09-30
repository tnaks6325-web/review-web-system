/* 관제 "확정으로 안 잡힌 작업표 줄" 대조식 — 진짜 PG16 실행 가드.
 *
 * ★★ 이 검사는 **라우트 파일에 실제로 박힌 SQL 문자열을 꺼내 그대로 돌린다**.
 *    사본을 만들어 검증하면 라우트 SQL 을 망가뜨려도 통과한다(레포에서 이미 밟은 함정).
 * ★★ 스텁 DB 로는 절대 못 잡는 것들을 여기서 잡는다 — window `FILTER … OVER ()`,
 *    `regexp_replace(…, '\D', …)`, CTE 참조, 정렬 순서.
 *
 * 배경(2026-08-19 위프 800건 실측): 대조가 명의 phone8 하나뿐이라
 *   ㉮ 타계정 건(작업표 연락처 = 소유자 번호) ㉯ 연락처 오타·수취인 번호 기입
 * 이 전부 "미확정"으로 뜨고, **같은 건이 반대편에서는 "확정인데 줄이 없음"** 으로 또 세어졌다.
 *
 * 실행: PGTEST_URL=postgres://... node tests/campaignUnmatchedKeysPg.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let n = 0;
const ok = (m, c) => { assert.ok(c, m); console.log('  ✓ ' + m); n++; };
const eq = (m, a, b) => { assert.strictEqual(a, b, `${m} (got ${a}, want ${b})`); console.log(`  ✓ ${m} → ${a}`); n++; };

/* ── 라우트 파일에서 실제 SQL 을 꺼낸다(사본 금지) ───────────────────────── */
function extractSql() {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
  const start = src.indexOf('`WITH sub AS (');
  assert.ok(start > 0, '대조 SQL(WITH sub AS) 을 찾지 못했다 — 배선이 바뀌면 이 가드를 함께 갱신할 것');
  const end = src.indexOf('LIMIT 30`', start);
  assert.ok(end > start, 'SQL 끝(LIMIT 30)을 찾지 못했다');
  // 템플릿 리터럴 안의 `\\D` 는 런타임에 `\D` 가 된다 — 실행 시점과 같게 되돌린다.
  return src.slice(start + 1, end + 'LIMIT 30'.length).replace(/\\\\/g, '\\');
}

(async () => {
  const SQL = extractSql();
  ok('★ 라우트에 박힌 SQL 을 그대로 꺼냈다(사본 아님)', /WITH sub AS/.test(SQL) && /LIMIT 30$/.test(SQL));
  ok('★ 세 키가 모두 들어 있다', /s\.phone8 = ri\.phone8/.test(SQL)
    && /s\.owner_phone8 = ri\.phone8/.test(SQL)
    && /s\.order_submission_id = cp\.order_submission_id/.test(SQL));

  const url = process.env.PGTEST_URL;
  if (!url) { console.log('\n⏭  PGTEST_URL 없음 — 정적 검사만 수행했다.'); console.log(`\n✅ campaignUnmatchedKeysPg: ${n}개 통과`); return; }

  const { Client } = require('pg');
  const db = new Client({ connectionString: url });
  await db.connect();
  const S = 'sheetX', T = '탭X', C = 'camp_x';
  await db.query(`
    DROP TABLE IF EXISTS review_index, campaign_applications, campaign_participants, order_submissions;
    CREATE TABLE review_index (sheet_id text, tab_name text, row_index int, reviewer_name text, phone8 text);
    CREATE TABLE campaign_applications (campaign_id text, status text, phone8 text, owner_phone8 text, order_submission_id uuid);
    CREATE TABLE campaign_participants (sheet_id text, tab_name text, seq int, order_submission_id uuid, deleted_at timestamptz);
    CREATE TABLE order_submissions (sheet_id text, tab_name text, phone text);
  `);
  const OS_C = '11111111-1111-1111-1111-111111111111';
  const OS_G = '22222222-2222-2222-2222-222222222222';
  await db.query(
    `INSERT INTO review_index (sheet_id, tab_name, row_index, reviewer_name, phone8) VALUES
       ($1,$2,10,'본인일치','10000001'),
       ($1,$2,20,'타계정(소유자번호)','10000002'),
       ($1,$2,30,'연락처오타','19999999'),
       ($1,$2,40,'홀드만료','10000004'),
       ($1,$2,50,'공고미경유','10000005'),
       ($1,$2,60,'수기입력','10000006'),
       ($1,$2,70,'삭제된줄링크','10000007'),
       ($1,$2,80,'타계정 명의의 만료 홀드','10000008')`, [S, T]);
  await db.query(
    `INSERT INTO campaign_applications (campaign_id, status, phone8, owner_phone8, order_submission_id) VALUES
       ($1,'submitted','10000001','10000001',NULL),
       ($1,'submitted','10000022','10000002',NULL),
       ($1,'submitted','10000003','10000003',$2),
       ($1,'expired'  ,'10000004','10000004',NULL),
       ($1,'submitted','10000077','10000077',$3),
       ($1,'expired'  ,'10000088','10000008',NULL)`, [C, OS_C, OS_G]);
  await db.query(
    `INSERT INTO campaign_participants (sheet_id, tab_name, seq, order_submission_id, deleted_at) VALUES
       ($1,$2,30,$3,NULL),
       ($1,$2,70,$4,NOW())`, [S, T, OS_C, OS_G]);
  await db.query(`INSERT INTO order_submissions (sheet_id, tab_name, phone) VALUES ($1,$2,'010-1000-0005')`, [S, T]);

  const { rows } = await db.query(SQL, [S, T, C]);
  const byRow = Object.fromEntries(rows.map(r => [r.row, r]));

  ok('㉮ 명의 phone8 일치 → 확정으로 본다', !byRow[10]);
  ok('★ ㉯ 소유자 번호로만 일치해도 확정으로 본다(타계정 정상 케이스)', !byRow[20]);
  ok('★★ ㉰ 연락처가 아예 달라도 주문 링크가 같으면 확정으로 본다', !byRow[30]);
  ok('★ 소프트삭제된 줄의 링크는 근거가 아니다', !!byRow[70]);
  eq('남는 줄 수', rows.length, 5);

  /* ★ 홀드 판정도 소유자 번호를 본다 — 타계정 명의로 잡았다 만료된 건은
       작업표 연락처(=소유자 번호)로만 이어지므로, 여기서 owner 를 빠뜨리면
       "참여 기록 없음(조치 불필요)"으로 잘못 분류돼 담당자가 놓친다. */
  eq('★ 타계정 명의로 잡은 만료 홀드도 hasHold', byRow[80].has_hold, true);

  eq('만료 홀드 줄은 hasHold', byRow[40].has_hold, true);
  eq('공고 미경유 줄은 hasHold=false', byRow[50].has_hold, false);
  eq('공고 미경유 줄은 주문이 있다(연락처 숫자만 대조)', byRow[50].has_order, true);
  eq('수기 입력 줄은 주문도 없다', byRow[60].has_order, false);

  eq('총 건수(window)', rows[0].total_cnt, 5);
  eq('홀드 이력 있는 건수', rows[0].hold_cnt, 2);
  eq('공고 미경유(주문만) 건수', rows[0].order_only_cnt, 1);
  ok('★ 조치 대상(홀드 이력)이 목록 맨 앞에 온다', rows[0].has_hold === true && rows[rows.length - 1].has_order === true);

  await db.end();
  console.log(`\n✅ campaignUnmatchedKeysPg: ${n}개 통과`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
