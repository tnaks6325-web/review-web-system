'use strict';
/**
 * 결정 283 — 「제출」 숫자도 **채워진 줄(사람이 들어온 줄)만** 센다. 작업보드 [진행 현황] · 홈 작업목록 · 업체관리 세 곳 모두.
 *
 * 사고(2026-10-23 운영 읽기 전용 실측):
 *   ① 「0528)남이섬 설리조트 예약자 리뷰」 — 61줄 중 사람 있는 줄 35. 미리 깔아 둔 빈 슬롯 26줄의 「완료여부」 칸에 「미진행」이 박혀 있고,
 *      그 글자가 제출 판정(reviewObligation.classifyCell — 빈 값·false·미제출만 미제출)에서 「제출」로 세졌다 → 작업보드·업체관리 제출 60(실제 34).
 *   ② 「6/11퓨비아표백제_네이버15건」 — 탭 이름을 바꾸기 전(6/10…) 빈 줄 15줄이 같은 gid 로 남아, 업체관리(gid OR 이름 매칭)가 제출 28(실제 15).
 *   참여·입금은 이미 채워진 줄만 셌다(rowNumbering.filledSql / isFilledRow 단일 출처) — 제출만 빠져 있었다.
 *
 * 지키는 것(PGlite 실DB로 서비스를 그대로 실행):
 *   1) 빈 슬롯의 「미진행」은 제출이 아니다 — 작업보드 ≡ 홈 ≡ 업체관리 = 6
 *   2) 옛 이름 빈 줄(같은 gid)은 업체관리 제출에 안 들어간다
 *   3) 사람 있는 줄의 제출 판정(classifyCell)은 그대로다 — 리뷰어 화면에 영향이 있어 건드리지 않는다
 *   4) 세 곳이 같은 판정(filled)을 탄다 — 배선 검사
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const S = 'SHEET_F';
const T4 = '0528)빈슬롯 미진행 10건';     // 남이섬 모양 — 무시트 · 빈 슬롯 4줄에 「미진행」
const T5 = '6/11(네이버)새이름 5건';      // 퓨비아 모양 — 같은 gid 의 옛 이름 빈 줄 3
const T5_OLD = '6/10(네이버)옛이름 5건';

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'statusCountUnify.schema.sql'), 'utf8'));
  const q = async (sql, params) => db.query(sql, params);
  const pool = require('../src/db/pool');
  pool.query = q; pool.connect = async () => ({ query: q, release() {} });
  const svc = require('../src/services/trackB.service');

  await db.exec(`
    INSERT INTO advertisers (id, name) VALUES ('adv2', '가짜업체2');
    INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid) VALUES ('adv2', '${S}', NULL);
    INSERT INTO raw_sheet_tabs (sheet_id, spreadsheet_title, tab_gid, tab_name, row_count, is_system_tab, detected_headers, mirrored_at) VALUES
     ('${S}','가짜 시트','104','${T4}',10,FALSE,'["번호","수취인","담당자","완료여부","입금"]'::jsonb, NOW()),
     ('${S}','가짜 시트','105','${T5}',5,FALSE,'["번호","수취인","리뷰제출","입금"]'::jsonb, NOW());
    INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheetless, is_closed, manager) VALUES
     ('${S}','${T4}','104',TRUE,FALSE,'망고'), ('${S}','${T5}','105',TRUE,FALSE,'망고');
  `);
  await db.exec(`
    -- T4: 채워진 6줄(완료 6 · 입금 5) + 빈 슬롯 4줄(이름·연락처·주문 없음 · 완료여부 「미진행」 · 행 포인터 없음 — 운영 모양 그대로)
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, is_submitted, is_paid, source, submit_col, submit_col2, row_json, active)
    SELECT '${S}','104','${T4}', g+1, '사람'||g, '수취'||g, lpad((40000000+g)::text,8,'0'), TRUE, g<=5, 'worktable', '완료여부', '입금',
           jsonb_build_object('번호', g::text, '담당자', '망고', '완료여부', '완료', '입금', CASE WHEN g<=5 THEN '10/3' ELSE '' END),
           TRUE FROM generate_series(1,6) g;
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, is_submitted, is_paid, source, row_json, active)
    SELECT '${S}','104','${T4}', g+1, FALSE, FALSE, 'worktable',
           jsonb_build_object('번호', g::text, '담당자', '망고', '완료여부', '미진행'), TRUE FROM generate_series(7,10) g;
    -- T5: 새 이름 채워진 5줄(제출 5 · 입금 5) + 같은 gid 의 옛 이름 빈 줄 3(리뷰제출 칸에 글자)
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, is_submitted, is_paid, source, submit_col, submit_col2, row_json, active)
    SELECT '${S}','105','${T5}', g+1, '사람'||g, '수취'||g, lpad((50000000+g)::text,8,'0'), TRUE, TRUE, 'worktable', '리뷰제출', '입금',
           jsonb_build_object('번호', g::text, '리뷰제출', '6/12 13:57', '입금', '6/20'), TRUE FROM generate_series(1,5) g;
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, is_submitted, is_paid, source, row_json, active)
    SELECT '${S}','105','${T5_OLD}', g+1, FALSE, FALSE, 'import',
           jsonb_build_object('번호', g::text, '리뷰제출', '미진행'), TRUE FROM generate_series(1,3) g;
  `);

  const board = (await svc.workdeskTab({ sheetId: S, tabName: T4, role: 'master' }));
  await t('★★ 작업보드 [진행 현황] — 빈 슬롯의 「미진행」은 제출이 아니다(참여 6 · 제출 6 · 입금 5)', async () => {
    const c = board.counts;
    assert.deepStrictEqual([c.total, c.filled, c.submitted, c.paid], [10, 6, 6, 5]);
  });
  await t('제출이 참여를 넘지 않는다(빈 슬롯이 제출로 새면 바로 깨진다)', async () => {
    assert.ok(board.counts.submitted <= board.counts.filled);
  });
  await t('사람 있는 줄의 줄별 제출 상태는 그대로(classifyCell 무변경) — 6줄 모두 fulfilled', async () => {
    const people = board.roster.filter(r => r.filled);
    assert.strictEqual(people.length, 6);
    assert.ok(people.every(r => r.reviewObligationStatus === 'fulfilled'));
  });

  svc.__resetTabStatsCacheForTest();
  const st = await svc.tabStatsMap({ force: true });
  await t('★★ 홈 집계 ≡ 작업보드 (참여·제출·입금)', async () => {
    assert.strictEqual(st.ok, true);
    const s = st.map[S + '\t' + T4], c = board.counts;
    assert.deepStrictEqual([s.filled, s.submitted, s.paid], [c.filled, c.submitted, c.paid]);
  });

  const own = await svc.ownedTabsForAdvertiser({ advertiserId: 'adv2' });
  await t('★★ 업체관리 ≡ 작업보드 (참여·제출·입금) — 빈 슬롯 「미진행」 제외', async () => {
    const o = own.rows.find(r => r.tabName === T4), c = board.counts;
    assert.deepStrictEqual([o.bTotal, o.bSub, o.bPaid], [c.filled, c.submitted, c.paid]);
  });
  await t('★★ 업체관리 — 같은 gid 의 옛 이름 빈 줄은 제출로 세지 않는다(5 · 5 · 5)', async () => {
    const o = own.rows.find(r => r.tabName === T5);
    assert.deepStrictEqual([o.bTotal, o.bSub, o.bPaid], [5, 5, 5]);
  });

  await t('배선 — 세 곳 모두 제출 수에 채워진 줄 판정을 건다', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
    assert.match(src, /const reviewSubmitted = syn\.filled && !syn\.reviewResolution && syn\.reviewObligationStatus==='fulfilled';/);
    // 업체관리: submitted FILTER 안에 filledSql
    const own = src.slice(src.indexOf('async function ownedTabsForAdvertiser'), src.indexOf('AS submitted,', src.indexOf('async function ownedTabsForAdvertiser')));
    assert.ok(/AND \$\{_filledSql\('cp'\)\}\s+AND NOT EXISTS \(SELECT 1 FROM review_closed_targets closed/.test(own), '업체관리 제출에 채워진 줄 판정이 없다');
    // 홈: submitted_count FILTER 안에 filledSql
    const home = src.slice(src.indexOf('async function tabStatsMap'), src.indexOf('AS submitted_count', src.indexOf('async function tabStatsMap')));
    assert.ok(/submittedSql\('cp\.is_submitted','cp','seq'\)\}\s+AND \$\{_filledSql\('cp'\)\}/.test(home), '홈 제출에 채워진 줄 판정이 없다');
  });

  console.log(`\n✅ submitCountFilledRows: ${passed} 통과`);
})().catch(e => { console.error(e); process.exitCode = 1; });
