'use strict';
/**
 * 결정 283 — 제출완료 수는 **채워진 줄만** 센다(작업보드 진행 현황 · 업체관리/업체 요약).
 *
 * 사고(2026-10-23 운영 읽기 전용 실측): 「0528)남이섬 설리조트」 작업보드 = 참여 35 · **제출 60**.
 *   작업표 생성 때 깔아 둔 빈 슬롯 26줄의 리뷰 칸에 「미진행」이 적혀 있었고, 칸 분류(`classifyCell`)는
 *   빈 값·false·미제출 말고는 모두 제출로 읽는다. 입금완료·참여는 이미 채워진 줄만 센다 → 제출만 분모가 달랐다.
 *   업체관리 SQL 도 같은 구멍(35·60·35) + 옛 이름 줄을 gid 로 끌어와 15·28·15 가 된 탭(6/11 퓨비아)이 있었다.
 *
 * 고정하는 것(PGlite 로 서비스 실제 실행):
 *   1) 빈 슬롯의 「미진행」은 작업보드 제출 수·업체관리 제출 수에 안 들어간다(참여·입금과 같은 분모)
 *   2) 줄 단위 판정(reviewObligationStatus)·칸 분류 어휘(classifyCell)·누적집행은 **바꾸지 않는다**(리뷰어 화면 영향 0)
 *   3) 홈 집계는 원래 34 방식(의무 투영/플래그) — 셋이 같은 숫자
 *   4) 변이시험 — 채워진 줄 조건을 빼면 이 가드가 잡는다(작업보드 · 업체관리 각각)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const S = 'SHEET_F';
const T = '0528)빈슬롯미진행 10건';
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'statusCountUnify.schema.sql'), 'utf8'));
  const q = (sql, params) => db.query(sql, params);
  const pool = require('../src/db/pool');
  pool.query = q; pool.connect = async () => ({ query: q, release() {} });
  const svcPath = require.resolve('../src/services/trackB.service');
  const svc = require(svcPath);
  const obligation = require('../src/services/reviewObligation.service');

  // 무시트 탭 10줄: 채워진 6줄(제출 5 · 미제출 1) + 빈 슬롯 4줄(리뷰 칸 「미진행」)
  await db.exec(`
    INSERT INTO advertisers (id, name) VALUES ('adv1', '가짜업체');
    INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid) VALUES ('adv1', '${S}', NULL);
    INSERT INTO raw_sheet_tabs (sheet_id, spreadsheet_title, tab_gid, tab_name, row_count, is_system_tab, detected_headers, mirrored_at)
      VALUES ('${S}','가짜 시트','201','${T}',10,FALSE,'["번호","수취인","완료여부","입금","결제금액"]'::jsonb, NOW());
    INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheetless) VALUES ('${S}','${T}','201',TRUE);
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, is_submitted, source, submit_col, submit_col2, row_json, active)
    SELECT '${S}','201','${T}', g+1,
           CASE WHEN g<=6 THEN '참여'||g END, CASE WHEN g<=6 THEN '수취'||g END, CASE WHEN g<=6 THEN lpad((40000000+g)::text,8,'0') END,
           g<=5, 'worktable', '완료여부', '입금',
           jsonb_build_object('번호', g::text,
             '완료여부', CASE WHEN g<=5 THEN '완료' WHEN g=6 THEN '' ELSE '미진행' END,
             '입금', CASE WHEN g<=4 THEN '10/1' ELSE '' END,
             '결제금액', CASE WHEN g<=6 THEN '10,000' ELSE '' END),
           TRUE FROM generate_series(1,10) g;
  `);

  const board = (await svc.workdeskTab({ sheetId: S, tabName: T, role: 'master' }));
  await t('★★ 작업보드 제출완료 = 채워진 줄만 — 빈 슬롯의 「미진행」 4줄은 안 센다 (참여 6 · 제출 5 · 입금 4)', async () => {
    assert.deepStrictEqual([board.counts.total, board.counts.filled, board.counts.submitted, board.counts.paid], [10, 6, 5, 4]);
  });
  await t('★ 줄 단위 판정·칸 분류 어휘·누적집행은 그대로(리뷰어 화면·입금 판정 영향 0)', async () => {
    const empty = board.roster.filter(r => !r.filled);
    assert.strictEqual(empty.length, 4);
    assert.ok(empty.every(r => r.reviewObligationStatus === 'fulfilled'), '빈 슬롯의 줄 판정까지 바꿨다(범위 밖)');
    assert.strictEqual(obligation.classifyCell('미진행', true), 'fulfilled', '칸 분류 어휘를 바꿨다(범위 밖 — 투영 SQL 과 함께 움직여야 한다)');
    assert.strictEqual(obligation.classifyCell('', true), 'pending');
    assert.strictEqual(board.counts.executionAmount, 50000, '누적집행이 바뀌었다(빈 슬롯은 금액이 없어 원래 5줄 × 10,000)');
  });
  const own = (await svc.ownedTabsForAdvertiser({ advertiserId: 'adv1' })).rows.find(r => r.tabName === T);
  await t('★★ 업체관리(업체 요약) 제출 = 채워진 줄만 — 작업보드와 같은 숫자', async () => {
    assert.deepStrictEqual([own.bTotal, own.bSub, own.bPaid], [board.counts.filled, board.counts.submitted, board.counts.paid]);
  });
  await t('홈 집계도 같은 숫자(원래 규칙 — 의무 투영/플래그)', async () => {
    svc.__resetTabStatsCacheForTest();
    const s = (await svc.tabStatsMap({ force: true })).map[S + '\t' + T];
    assert.deepStrictEqual([s.filled, s.submitted, s.paid], [6, 5, 4]);
  });

  /* ── 변이시험: 채워진 줄 조건을 빼면 잡히는가 ───────────────────── */
  const src = fs.readFileSync(svcPath, 'utf8');
  function loadMutant(from, to) {
    assert.strictEqual(src.split(from).length - 1, 1, '변이 지점을 못 찾았다: ' + from);
    const m = new Module(svcPath, module);
    m.filename = svcPath; m.paths = Module._nodeModulePaths(path.dirname(svcPath));
    m._compile(src.replace(from, to), svcPath);
    return m.exports;
  }
  await t('변이시험: 작업보드에서 채워진 줄 조건을 빼면 제출 9 로 잡힌다', async () => {
    const mut = loadMutant('if (syn.filled) reviewSubmitCellCount++;', 'reviewSubmitCellCount++;');
    const r = await mut.workdeskTab({ sheetId: S, tabName: T, role: 'master' });
    assert.strictEqual(r.counts.submitted, 9);
  });
  await t('변이시험: 업체관리 SQL 에서 채워진 줄 조건을 빼면 제출 9 로 잡힌다', async () => {
    const mut = loadMutant("-- ★ 제출도 채워진 줄만(결정 283 — 참여·입금과 같은 분모 · 작업보드 진행 현황과 같은 규칙)\n                  AND ${_filledSql('cp')}\n", '');
    const r = (await mut.ownedTabsForAdvertiser({ advertiserId: 'adv1' })).rows.find(x => x.tabName === T);
    assert.strictEqual(r.bSub, 9);
  });

  console.log(`\n✅ submittedFilledOnly: ${passed} 통과`);
})().catch(e => { console.error(e); process.exitCode = 1; });
