/**
 * reviewPhotoRelink.test.js — 리뷰 사진 줄 재연결 도구 회귀가드 (2026-10-02 · migration 172)
 *
 * 깨지면 아픈 것:
 *  ① 확정 기준이 느슨해짐 — 타계정(주문자=사진 이름)·동명이인·직원 교체 사진·교체요청 사진·시트 작업·
 *     무시트 시대 사진이 대상에 섞이면 **맞는 사진을 남의 줄로 옮긴다**(레드팀 R1~R3·R6).
 *  ② 화면이 본 (파일·출발·도착)과 다른 계획을 실행(R14) · 실패를 삼키고 "완료"(R4).
 *  ③ 대표 이미지를 옮긴 사진과 무관한 줄까지 다시 고름(R8) · review_index 행 없는 줄에서 오류(R5).
 *  ④ 되돌리기가 그 뒤 바뀐 사진까지 덮음(R7).
 * 실행: node tests/reviewPhotoRelink.test.js   (PGTEST_URL 이 있으면 진짜 PG 단계까지)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const SVC = require('../src/services/reviewPhotoRelink.service');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'reviewPhotoRelink.service.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '172_review_photo_relinks.sql'), 'utf8');

(async () => {
  console.log('\n[A] 배선·게이트');
  for (const [m, p] of [['get', 'summary'], ['get', 'preview'], ['post', 'apply'], ['post', 'revert']]) {
    ok(`${m.toUpperCase()} /review-photo-relink/${p} = adminOrMaster`,
      new RegExp(`router\\.${m}\\('/review-photo-relink/${p}', authMiddleware, adminOrMasterMiddleware`).test(routes));
  }
  ok('실행은 confirm === true 만', /confirm: b\.confirm === true/.test(routes));
  ok('migration 172 는 새 표 하나(가산적)', /CREATE TABLE IF NOT EXISTS review_photo_relinks/.test(mig) && !/ALTER TABLE|DROP TABLE (?!IF EXISTS review_photo_relinks)/.test(mig.replace(/--[^\n]*/g, '')));
  ok('이력에 이름·파일명을 담지 않는다(개인정보 최소)', !/reviewer_name|file_name/.test(mig.replace(/--[^\n]*/g, '')));

  console.log('\n[B] 확정 기준(계획 SQL) — 완화 금지');
  const sql = SVC.__planSqlForTest();
  ok('시트 없이 도는 작업만', /tc\.sheetless = TRUE/.test(sql));
  ok('시트 시절 상한(무시트 시대 정상 사진 제외)', /< \$3::timestamptz/.test(sql) && SVC.SHEET_ERA_END === '2026-09-01');
  ok('리뷰 슬롯만', /COALESCE\(s\.slot_key, 'review'\) = 'review'/.test(sql));
  ok('교체요청에 걸린 파일 제외', /er\.old_file_id = s\.file_id OR er\.new_file_id = s\.file_id/.test(sql));
  ok('직원 교체 파일 제외', /staff_file_replacement/.test(sql));
  ok('지금 줄 주문의 주문자·수취인도 사진 이름과 달라야(타계정 보호)',
    /REPLACE\(COALESCE\(os\.orderer,''\),' ',''\) <> rs\.nm/.test(sql) && /REPLACE\(COALESCE\(os\.recipient,''\),' ',''\) <> rs\.nm/.test(sql));
  ok('같은 이름 활성 줄이 딱 하나', /u\.name_rows = 1/.test(sql));
  ok('대상 줄 주문의 주문자 또는 수취인이 사진 이름', /os2\.orderer[\s\S]{0,80}= u\.nm OR[\s\S]{0,80}os2\.recipient[\s\S]{0,40}= u\.nm/.test(sql));
  ok('대상 줄에 같은 이름 사진이 이미 있으면 제외', /x\.row_index = e\.seq[\s\S]{0,200}= u\.nm\)/.test(sql));

  console.log('\n[C] 실행 규율');
  ok('잠금 뒤 다시 계산하고 (파일·출발·도착) 세 값으로 대조', /const _key = \(x\) => `\$\{x\.fileId\}\|\$\{Number\(x\.fromRow\)\}\|\$\{Number\(x\.toRow\)\}`/.test(src) && /plan_changed/.test(src));
  ok('사진 행 갱신이 1건이 아니면 전체 롤백', /upd\.rowCount !== 1\) throw new RelinkError\('row_moved'/.test(src));
  ok('장부 재생성·직원 교체와 같은 잠금 이름', /sheetless_ledger:\$\{sheetId\}:\$\{tabName\}/.test(src) && /review_file:\$\{sheetId\}\|\$\{tabName\}\|\$\{row\}/.test(src));
  ok('lock_timeout 으로 오래 붙잡지 않는다', /SET LOCAL lock_timeout = '5s'/.test(src));
  ok('is_submitted·입금·주문은 건드리지 않는다', !/is_submitted|is_paid|payment_|order_submissions\s+SET|UPDATE order_submissions|UPDATE campaign_participants/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
  ok('fileRoute.recomputePrimary 를 쓰지 않는다(옮긴 사진과 무관한 줄 대표까지 바꾸고 오류를 삼킨다)', !/recomputePrimary/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));

  console.log('\n[B2] 2단계 기준 — 근거 하나 이상 + 반대 증거 제외(완화 금지)');
  const sql2 = SVC.__planSqlTier2ForTest();
  ok('2단계도 시트 시절·리뷰 슬롯·교체요청·직원 교체 제외', /< \$3::timestamptz/.test(sql2) && /'review'/.test(sql2)
    && /er\.old_file_id = s\.file_id/.test(sql2) && /staff_file_replacement/.test(sql2));
  ok('2단계는 시트 작업(sheetless=FALSE)을 제외', /tc\.sheetless IS FALSE/.test(sql2));
  ok('2단계도 같은 이름 활성 줄 딱 하나', /c\.name_rows = 1/.test(sql2));
  ok('2단계도 타계정(지금 줄 주문자 = 사진 이름) 제외', /o\.id = c\.hos AND REPLACE\(COALESCE\(o\.orderer/.test(sql2));
  ok('★★ OCR 작성자가 지금 줄 사람과 맞으면 제외', /WHERE NOT contra/.test(sql2));
  ok('근거 3종 중 하나 이상', /ev_order OR ev_ocr OR \(shift = mshift AND mcount >= 10/.test(sql2));
  ok('라우트는 tier=2 를 명시할 때만 2단계', /tier: req\.query\.tier === '2' \? 2 : 1/.test(routes) && /tier: b\.tier === 2 \? 2 : 1/.test(routes));

  if (!process.env.PGTEST_URL) {
    console.log(`\n✅ reviewPhotoRelink: ${passed}개 통과 (PGTEST_URL 없음 — 진짜 PG 단계 생략)`);
    process.exit(0);
  }

  console.log('\n[D] 진짜 PG');
  const { Pool } = require('pg');
  const SCHEMA = 'rpr_test';
  { const boot = new Pool({ connectionString: process.env.PGTEST_URL });
    await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`); await boot.end(); }
  const db = new Pool({ connectionString: process.env.PGTEST_URL, options: `-c search_path=${SCHEMA}` });
  await db.query(`
    CREATE TABLE tab_configs (sheet_id TEXT, tab_name TEXT, sheetless BOOLEAN);
    CREATE TABLE order_submissions (id UUID PRIMARY KEY, orderer TEXT, recipient TEXT);
    CREATE TABLE campaign_participants (sheet_id TEXT, tab_name TEXT, seq INT, reviewer_name TEXT, recipient_name TEXT,
      order_submission_id UUID, active BOOLEAN DEFAULT TRUE, deleted_at TIMESTAMPTZ);
    CREATE TABLE review_index (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT, row_index INT,
      review_file_id TEXT, review_file_url TEXT, review_file_name TEXT, review_file_count INT DEFAULT 0, review_file_at TIMESTAMPTZ);
    CREATE TABLE review_submissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT, row_index INT,
      reviewer_name TEXT, review_index_id UUID, file_id TEXT UNIQUE, file_url TEXT, file_name TEXT, slot_key TEXT DEFAULT 'review',
      uploaded_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE review_inspections (file_id TEXT UNIQUE, sheet_id TEXT, tab_name TEXT, row_index INT, checks JSONB, updated_at TIMESTAMPTZ);
    CREATE TABLE review_edit_requests (old_file_id TEXT, new_file_id TEXT);`);
  await db.query(mig);
  const S = 'S1', T = 'T1';
  await db.query(`INSERT INTO tab_configs VALUES ($1,$2,TRUE), ('S1','SHEET',FALSE)`, [S, T]);
  const O = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  await db.query(`INSERT INTO order_submissions VALUES
    ($1,'가나','가나'), ($2,'다라','다라'), ($3,'마바','사아'), ($4,'자차','자차'), ($5,'카타','카타'), ($6,'파하','파하')`,
    [O(1), O(2), O(3), O(4), O(5), O(6)]);
  // 줄 1=가나 · 2=다라 · 3=사아(주문자 마바 — 타계정) · 4=자차 · 5=카타 · 6=카타(동명)
  await db.query(`INSERT INTO campaign_participants (sheet_id,tab_name,seq,reviewer_name,recipient_name,order_submission_id) VALUES
    ($1,$2,1,'가나','가나',$3),($1,$2,2,'다라','다라',$4),($1,$2,3,'사아','사아',$5),($1,$2,4,'자차','자차',$6),
    ($1,$2,5,'카타','카타',$7),($1,$2,6,'카타','카타',$8),($1,$2,7,'마바','마바',NULL)`, [S, T, O(1), O(2), O(3), O(4), O(5), O(6)]);
  for (const r of [1, 2, 3, 4, 5, 6, 7]) await db.query(`INSERT INTO review_index (sheet_id,tab_name,row_index) VALUES ($1,$2,$3)`, [S, T, r]);
  const ADD = (f, row, nm, at = '2026-07-01') => db.query(
    `INSERT INTO review_submissions (sheet_id,tab_name,row_index,reviewer_name,file_id,file_url,file_name,uploaded_at) VALUES ($1,$2,$3,$4,$5,$5,$5,$6)`,
    [S, T, row, nm, f, at]);
  await ADD('F_DARA', 1, '다라');          // 다라 사진이 1번(가나 줄)에 → 2번으로 가야 함
  await ADD('F_GANA', 2, '가나');          // 가나 사진이 2번(다라 줄)에 → 1번으로 (교차)
  await ADD('F_MABA', 3, '마바');          // 타계정: 줄 3 주문자=마바 → 정상(옮기지 않음)
  await ADD('F_KATA', 4, '카타');          // 동명 2줄 → 옮기지 않음
  await ADD('F_LATE', 4, '가나', '2026-09-10'); // 무시트 시대 → 제외
  await ADD('F_STAFF', 4, '다라');         // 직원 교체 사진 → 제외
  await db.query(`INSERT INTO review_inspections VALUES ('F_STAFF',$1,$2,4,'{"replacement":{"reason":"staff_file_replacement"}}',NOW())`, [S, T]);
  await db.query(`INSERT INTO review_inspections VALUES ('F_DARA',$1,$2,1,'{}',NOW())`, [S, T]);
  await db.query(`UPDATE review_index SET review_file_id='F_DARA' WHERE row_index=1`);
  await db.query(`UPDATE review_index SET review_file_id='F_GANA' WHERE row_index=2`);
  await db.query(`UPDATE review_index SET review_file_id='F_KATA' WHERE row_index=4`);
  SVC.__setPoolForTest(db);

  const pv = await SVC.preview({ sheetId: S, tabName: T });
  const got = pv.items.map(i => `${i.fileId}:${i.fromRow}->${i.toRow}`).sort().join(',');
  ok('미리보기는 확정 2장만(교차 이동) — 타계정·동명·무시트 시대·직원 교체 제외', got === 'F_DARA:1->2,F_GANA:2->1', got);
  ok('미리보기는 쓰기 0', (await db.query(`SELECT COUNT(*)::int n FROM review_photo_relinks`)).rows[0].n === 0);
  const sum = await SVC.summary();
  ok('요약은 작업별 장수', sum.total === 2 && sum.tabs[0].count === 2);

  await assert.rejects(SVC.apply({ sheetId: S, tabName: T, items: pv.items }), e => e.code === 'confirm_required');
  await assert.rejects(SVC.apply({ sheetId: S, tabName: T, confirm: true, items: [{ fileId: 'F_DARA', fromRow: 1, toRow: 3 }] }),
    e => e.code === 'plan_changed');
  ok('confirm 없거나 화면 계획과 다르면 거부(쓰기 0)', (await db.query(`SELECT COUNT(*)::int n FROM review_photo_relinks`)).rows[0].n === 0
    && (await db.query(`SELECT row_index FROM review_submissions WHERE file_id='F_DARA'`)).rows[0].row_index === 1);

  const ap = await SVC.apply({ sheetId: S, tabName: T, confirm: true, items: pv.items, by: '테스트' });
  const rowOf = async f => (await db.query(`SELECT row_index FROM review_submissions WHERE file_id=$1`, [f])).rows[0].row_index;
  const repOf = async r => (await db.query(`SELECT review_file_id FROM review_index WHERE row_index=$1`, [r])).rows[0].review_file_id;
  ok('교차 이동 적용', ap.moved === 2 && await rowOf('F_DARA') === 2 && await rowOf('F_GANA') === 1);
  ok('검수 기록 줄도 같이 옮김', (await db.query(`SELECT row_index FROM review_inspections WHERE file_id='F_DARA'`)).rows[0].row_index === 2);
  ok('대표 이미지가 각자 본인 사진으로', await repOf(1) === 'F_GANA' && await repOf(2) === 'F_DARA');
  ok('옮기지 않은 줄 대표는 그대로(R8)', await repOf(4) === 'F_KATA');
  ok('review_index_id 가 도착 줄로', (await db.query(
    `SELECT s.review_index_id = ri.id AS same FROM review_submissions s JOIN review_index ri ON ri.row_index=2 WHERE s.file_id='F_DARA'`)).rows[0].same === true);
  ok('이력 2건', (await db.query(`SELECT COUNT(*)::int n FROM review_photo_relinks WHERE run_id=$1`, [ap.runId])).rows[0].n === 2);
  ok('다시 미리보기하면 0장(멱등)', (await SVC.preview({ sheetId: S, tabName: T })).total === 0);

  // 되돌리기 — 그 사이 F_GANA 가 다른 줄로 바뀌었다면 그것만 건너뛴다(R7)
  await db.query(`UPDATE review_submissions SET row_index=7 WHERE file_id='F_GANA'`);
  const rv = await SVC.revert({ runId: ap.runId, confirm: true, by: '테스트' });
  ok('되돌리기: 그대로인 사진만 돌리고 바뀐 사진은 건너뜀', rv.reverted === 1 && rv.skipped === 1 && await rowOf('F_DARA') === 1 && await rowOf('F_GANA') === 7);
  ok('되돌린 줄 대표 복원', await repOf(1) === 'F_DARA');
  await assert.rejects(SVC.revert({ runId: ap.runId }), e => e.code === 'confirm_required');

  // ── 2단계 — 설정 행이 없는 작업(T2) ──
  await db.query(`ALTER TABLE review_inspections ADD COLUMN IF NOT EXISTS ocr_author TEXT`);
  const T2 = 'T2', O2 = (n) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  // 줄 1..14: 사람01..사람14 (주문 연결은 1~4번만), 사진은 대부분 +1 밀림(줄 k 의 사진 = 줄 k+1 사람)
  for (let k = 1; k <= 14; k++) {
    const nm = '사람' + String(k).padStart(2, '0');
    if (k <= 4) await db.query(`INSERT INTO order_submissions VALUES ($1,$2,$2)`, [O2(k), nm]);
    await db.query(`INSERT INTO campaign_participants (sheet_id,tab_name,seq,reviewer_name,recipient_name,order_submission_id) VALUES ($1,$2,$3,$4,$4,$5)`,
      [S, T2, k, nm, k <= 4 ? O2(k) : null]);
    await db.query(`INSERT INTO review_index (sheet_id,tab_name,row_index) VALUES ($1,$2,$3)`, [S, T2, k]);
  }
  for (let k = 1; k <= 12; k++) {   // 줄 k 에 사람(k+1) 사진 — 12장이 +1 밀림 패턴
    const nm = '사람' + String(k + 1).padStart(2, '0');
    await db.query(`INSERT INTO review_submissions (sheet_id,tab_name,row_index,reviewer_name,file_id,file_url,file_name,uploaded_at) VALUES ($1,$2,$3,$4,$5,$5,$5,'2026-07-01')`,
      [S, T2, k, nm, 'G' + k]);
  }
  // G5 는 OCR 이 지금 줄 사람(사람05)을 가리킨다 → 반대 증거로 제외
  await db.query(`INSERT INTO review_inspections (file_id,sheet_id,tab_name,row_index,checks,ocr_author) VALUES ('G5',$1,$2,5,'{}','사*5')`, [S, T2]);
  const p2 = await SVC.preview({ sheetId: S, tabName: T2, tier: 2 });
  const ids2 = p2.items.map(i => i.fileId).sort();
  ok('1단계는 설정 행 없는 작업을 대상에 넣지 않는다', (await SVC.preview({ sheetId: S, tabName: T2 })).total === 0);
  ok('2단계: +1 밀림 패턴(다수)으로 대상 — 반대 증거(G5)는 제외', p2.total === 11 && !ids2.includes('G5') && p2.items.every(i => i.toRow === i.fromRow + 1), ids2.join(','));
  ok('2단계 근거가 응답에 실린다', p2.items.every(i => i.evidence && (i.evidence.shift || i.evidence.order || i.evidence.reviewName)));
  await assert.rejects(SVC.apply({ sheetId: S, tabName: T2, confirm: true, items: p2.items }), e => e.code === 'plan_changed');
  ok('2단계 계획을 1단계로 실행하면 거부(tier 명시 필요)', true);
  const ap2 = await SVC.apply({ sheetId: S, tabName: T2, confirm: true, items: p2.items, tier: 2, by: '테스트' });
  ok('2단계 적용', ap2.moved === 11 && await rowOf('G1') === 2 && await rowOf('G5') === 5);

  await db.end();
  { const boot = new Pool({ connectionString: process.env.PGTEST_URL }); await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await boot.end(); }
  console.log(`\n✅ reviewPhotoRelink: ${passed}개 통과 (진짜 PG 포함)`);
  process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
