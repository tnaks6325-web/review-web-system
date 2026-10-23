'use strict';
/**
 * 결정 281 — 홈 작업목록 · 업체관리(업체 요약) 숫자를 작업보드 [진행 현황]과 같은 규칙으로 센다.
 *
 * 사고(2026-10-23 운영 읽기 전용 실측): 남은 유일한 시트 기반 탭 「8/3(쿠팡)위프_블랙 탈취제 800건」에서
 *   작업보드 = 줄 800 · 참여 784 · 제출 783 · 입금 775
 *   홈 내부 집계(tabStatsMap) = 0 · 0 · 0 · 653  ← index_master 분기(운영 0건) + review_index 입금 칸 최빈값
 *   업체관리·업체 요약 = 784 · 659 · 653          ← review_index 에서 고른 제출·입금 칸(빈 포인터 140줄을 못 셈)
 *   그리고 그 탭은 홈 목록에 아예 없었다(index_master 없음 + 무시트 아님).
 *
 * 이 가드는 PGlite(실제 PostgreSQL)로 서비스를 **그대로 실행**해 고정한다:
 *   1) 상태 칸 판정 단일 출처(workboardStatusHeaders) 순수 함수
 *   2) 같은 가짜 데이터에서 홈 집계 ≡ 작업보드 ≡ 업체관리 (남은 시트 탭 모양 · 무시트 탭)
 *   3) 옛 ⬛ 마감 탭은 숫자상 후보여도 자동 마감·검수 대기에서 빠진다(258 완화 금지)
 *   4) 홈 목록엔 남은 시트 탭이 뜨고, 그림자 투영 대상 목록엔 **안** 들어간다(넣으면 import 줄이 전부 비활성화)
 *   5) fail 방향 — 칸 판정 조회 실패: 홈 = ok:false / 업체관리 = 행별 포인터로 계속
 *   6) 변이시험 — 판정을 망가뜨리면 이 가드가 실제로 잡는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const S = 'SHEET_T';
const T1 = '8/3(쿠팡)남은시트탭 20건';   // 남은 시트 기반 탭 모양(무시트 아님 · ⬛ 아님 · index_master 없음 · 앞 12줄만 포인터)
const T2 = '7/3(쿠팡)옛마감 10건';         // 옛 ⬛ 마감(is_closed) — 다 차 있다
const T3 = '9/1(네이버)무시트 10건';        // 정상 무시트

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'statusCountUnify.schema.sql'), 'utf8'));
  let failOn = null;   // 정규식 — 맞는 쿼리를 실패시킨다(fail 방향 검사)
  const q = async (sql, params) => {
    if (failOn && failOn.test(String(sql))) throw new Error('injected failure');
    return db.query(sql, params);
  };
  const pool = require('../src/db/pool');
  pool.query = q; pool.connect = async () => ({ query: q, release() {} });
  const wsh = require('../src/services/workboardStatusHeaders.service');
  const svc = require('../src/services/trackB.service');
  const parts = require('../src/services/participants.service');

  await db.exec(`
    INSERT INTO advertisers (id, name) VALUES ('adv1', '가짜업체');
    INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid) VALUES ('adv1', '${S}', NULL);
    INSERT INTO raw_sheet_tabs (sheet_id, spreadsheet_title, tab_gid, tab_name, row_count, is_system_tab, detected_headers, mirrored_at) VALUES
     ('${S}','가짜 시트','101','${T1}',20,FALSE,'["번호","수취인","연락처","은행","계좌번호","예금주","결제금액","리뷰제출","입금","주문번호",""]'::jsonb, NOW()),
     ('${S}','가짜 시트','102','${T2}',10,FALSE,'["번호","수취인","리뷰제출","입금"]'::jsonb, NOW()),
     ('${S}','가짜 시트','103','${T3}',10,FALSE,'["번호","수취인","리뷰제출","입금일자"]'::jsonb, NOW());
    INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheetless, is_closed, manager) VALUES
     ('${S}','${T1}','',FALSE,FALSE,'망고'), ('${S}','${T2}','102',FALSE,TRUE,'망고'), ('${S}','${T3}','103',TRUE,FALSE,'만두');
    INSERT INTO index_master (sheet_id, tab_name, tab_gid, status, row_count, submitted_count) VALUES ('${S}','${T3}','103','active',8,6);
  `);
  // T1: 20줄 · 채워진 18 · 제출 17 · 입금 16 — 행별 포인터는 앞 12줄만(운영의 빈 포인터 140줄 모양) · review_index 0줄
  await db.exec(`
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, is_submitted, is_paid, source, submit_col, submit_col2, row_json, active)
    SELECT '${S}','101','${T1}', g+1,
           CASE WHEN g<=18 THEN '가짜'||g END, CASE WHEN g<=18 THEN '수취'||g END, CASE WHEN g<=18 THEN lpad((10000000+g)::text,8,'0') END,
           g<=17, g<=16, CASE WHEN g<=5 THEN 'import' ELSE 'worktable' END,
           CASE WHEN g<=12 THEN '리뷰제출' END, CASE WHEN g<=12 THEN '입금' END,
           jsonb_build_object('번호', g::text, '리뷰제출', CASE WHEN g<=17 THEN 'O' ELSE '' END, '입금', CASE WHEN g<=16 THEN '10/1' ELSE '' END),
           TRUE FROM generate_series(1,20) g;
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, is_submitted, is_paid, source, submit_col, submit_col2, row_json, active)
    SELECT '${S}','102','${T2}', g+1, '마감'||g, '수취'||g, lpad((20000000+g)::text,8,'0'), TRUE, TRUE, 'import', '리뷰제출', '입금',
           jsonb_build_object('번호', g::text, '리뷰제출', 'O', '입금', '9/1'), TRUE FROM generate_series(1,10) g;
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, is_submitted, is_paid, source, submit_col, submit_col2, row_json, active)
    SELECT '${S}','103','${T3}', g+1,
           CASE WHEN g<=8 THEN '무시트'||g END, CASE WHEN g<=8 THEN '수취'||g END, CASE WHEN g<=8 THEN lpad((30000000+g)::text,8,'0') END,
           g<=6, g<=5, 'worktable', '리뷰제출', '입금일자',
           jsonb_build_object('번호', g::text, '리뷰제출', CASE WHEN g<=6 THEN 'O' ELSE '' END, '입금일자', CASE WHEN g<=5 THEN '10/2' ELSE '' END),
           TRUE FROM generate_series(1,10) g;
    INSERT INTO review_index (sheet_id, tab_name, tab_gid, row_index, reviewer_name, submit_col, submit_col2)
    SELECT '${S}','${T3}','103', g+1, '무시트'||g, '리뷰제출', '입금일자' FROM generate_series(1,8) g;
  `);

  /* ── 1) 판정 단일 출처 — 순수 함수 ───────────────────────────── */
  await t('입금 칸: 머리글이 줄 포인터를 이긴다(작업보드 화면 기준)', async () => {
    assert.strictEqual(wsh.pickPaidHeader(['번호', '입금명', '입금'], { '입금일자': 99 }), '입금');
  });
  await t('입금 칸: 머리글에 없으면 줄 포인터 최빈값(동률은 이름순) · 모르면 빈 값', async () => {
    assert.strictEqual(wsh.pickPaidHeader(['번호'], { 'B입금': 2, 'A입금': 2, 'C': 1 }), 'A입금');
    assert.strictEqual(wsh.pickPaidHeader([], {}), '');
  });
  await t('머리글: 감지 헤더(공백·중복 제거) → 없으면 첫 줄 키(id 제외) · 「현영」 원본 칸 제외', async () => {
    assert.deepStrictEqual(wsh.boardHeaders([' 번호 ', '번호', '', '현 영', '입금'], null), ['번호', '입금']);
    assert.deepStrictEqual(wsh.boardHeaders([], { id: 1, 번호: 1, 입금: 1 }), ['번호', '입금']);
  });

  /* ── 2) 같은 데이터 = 같은 숫자 (홈 ≡ 작업보드 ≡ 업체관리) ─────── */
  const board = {};
  for (const tab of [T1, T2, T3]) board[tab] = (await svc.workdeskTab({ sheetId: S, tabName: tab, role: 'master' })).counts;
  await t('작업보드(기준값) — 남은 시트 탭 20/18/17/16 · 무시트 10/8/6/5', async () => {
    assert.deepStrictEqual([board[T1].total, board[T1].filled, board[T1].submitted, board[T1].paid], [20, 18, 17, 16]);
    assert.deepStrictEqual([board[T3].total, board[T3].filled, board[T3].submitted, board[T3].paid], [10, 8, 6, 5]);
  });
  svc.__resetTabStatsCacheForTest();
  const st = await svc.tabStatsMap({ force: true });
  await t('★★ 홈 집계 ≡ 작업보드 (줄·참여·제출·입금) — 시트 기반 탭도 index_master 없이 작업표 원장으로', async () => {
    assert.strictEqual(st.ok, true);
    for (const tab of [T1, T2, T3]) {
      const s = st.map[S + '\t' + tab], b = board[tab];
      assert.deepStrictEqual([s.total, s.filled, s.submitted, s.paid], [b.total, b.filled, b.submitted, b.paid], tab);
    }
  });
  const own = await svc.ownedTabsForAdvertiser({ advertiserId: 'adv1', annotate: true });
  await t('★★ 업체관리(업체 요약) ≡ 작업보드 (참여·제출·입금) — 제출·입금 칸을 review_index 에서 고르지 않는다', async () => {
    for (const tab of [T1, T3]) {
      const o = own.rows.find(r => r.tabName === tab), b = board[tab];
      assert.deepStrictEqual([o.bTotal, o.bSub, o.bPaid], [b.filled, b.submitted, b.paid], tab);
    }
  });

  /* ── 3) 옛 ⬛ 마감은 🏁 로 옮기지 않는다(258) ──────────────────── */
  await t('⬛ 탭은 숫자상 후보(finishCandidate=true)여도 자동 마감 대상이 아니다', async () => {
    assert.strictEqual(svc.finishCandidate(st.map[S + '\t' + T2]), true, '판정 자체는 그대로(사본 0)');
    const af = await svc.autoFinishEligibleTabs({ dryRun: true });
    assert.strictEqual(af.ok, true);
    assert.deepStrictEqual(af.candidates.map(c => c.tabName), []);
    assert.strictEqual(af.skippedClosed, 1);
  });
  await t('⬛ 탭은 업체관리 검수 대기(finishCand)·개요 수에서도 빠진다', async () => {
    assert.strictEqual(own.rows.find(r => r.tabName === T2).finishCand, false);
    const ov = await svc.advertiserOverview();
    assert.strictEqual(ov.byAdvertiser.adv1.finishCand, 0);
  });

  /* ── 4) 홈 목록 / 투영 대상 목록 ─────────────────────────────── */
  await t('★ 홈·작업바 목록(includeParticipantTabs)에 남은 시트 탭이 뜬다 — ⬛ 탭은 안 뜨고, 무시트 탭은 한 번만', async () => {
    const list = await svc.scopedActiveTabs({ role: 'master', allWorkdesk: true, includeParticipantTabs: true });
    const names = list.map(x => x.tabName);
    assert.ok(names.includes(T1), '남은 시트 탭이 홈에 없다');
    assert.ok(!names.includes(T2), '⬛ 마감 탭이 진행 목록에 떴다');
    assert.strictEqual(names.filter(n => n === T3).length, 1);
    const row = list.find(x => x.tabName === T1);
    assert.strictEqual(row.tabGid, '101', '탭 설정의 gid 가 비면 시트 미러의 gid 로 채운다(마감·공고 gid 폴백 재료)');
    assert.strictEqual(row.sheetless, false);
    assert.strictEqual(row.participantOnly, true, '보는 목록 전용 표식');
    assert.strictEqual(list.find(x => x.tabName === T3).participantOnly, false);
  });
  await t('★★ 모집공고 발행 대상·매핑·스코프 판정(기본값)에는 남은 시트 탭이 없다 — 골라 발행하면 주문이 sheet_tab_retired 로 실패', async () => {
    const plain = await svc.scopedActiveTabs({ role: 'master', allWorkdesk: true });
    assert.ok(!plain.some(x => x.tabName === T1));
    assert.ok(plain.some(x => x.tabName === T3));
    // 라우트: 보는 목록(stats=1 · participantTabs=1)만 켠다 · forMapping 은 언제나 끈다
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
    assert.match(routes, /const includeParticipantTabs = req\.query\.forMapping !== '1' && \(req\.query\.stats === '1' \|\| req\.query\.participantTabs === '1'\);/);
    assert.match(routes, /allWorkdesk: true, includeParticipantTabs \}\);/);
    // 화면: 작업바만 participantTabs=1 · 모집공고 탭 목록은 매개변수 없이 + participantOnly 줄을 두 겹으로 거른다
    const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
    assert.match(wd, /async function loadTabs\(\)\{[\s\S]{0,300}api\('\/api\/trackb\/tabs\?limit=300&participantTabs=1'\)/);
    assert.strictEqual((wd.match(/\/api\/trackb\/tabs\?[^'"`]*participantTabs=1/g) || []).length, 1, '작업바 외에 켜는 곳이 생겼다');
    const rec = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-recruit.js'), 'utf8');
    assert.match(rec, /return \(typeof window !== "undefined" && window\.RECRUIT_TABS_API\) \|\| "\/api\/trackb\/tabs";/);
    assert.ok(!/participantTabs|stats=1/.test(rec), '모집공고 탭 목록이 보는 목록 매개변수를 쓴다');
    // 화면 실행 — 서버가 실수로 실어도 공고 대상 목록에는 안 들어간다
    const vm = require('vm');
    const src = rec.slice(rec.indexOf('async function loadRecruitTabOptions'), rec.indexOf('/* fallback: DOM에서 보완'));
    const ctx = { _recruitTabList: [] };
    vm.createContext(ctx);
    // 행 처리 루프(실제 코드)를 그대로 돌린다 — 서버가 실수로 표식 줄을 실은 경우
    const loop = src.slice(src.indexOf('const seen'));
    vm.runInContext(`(async () => { const json = { tabs: [{ sheetId: '${S}', tabName: '${T1}', participantOnly: true }, { sheetId: '${S}', tabName: '${T3}', participantOnly: false }] };
      const rows = json.tabs; ${loop} })()`, ctx);
    assert.strictEqual(JSON.stringify(ctx._recruitTabList.map(x => x.tabName)), JSON.stringify([T3]));
  });
  await t('★★★ 그림자 투영 대상(listActiveTabs 기본값)에는 남은 시트 탭을 넣지 않는다 — 넣으면 import 줄 전부 비활성화', async () => {
    const proj = await parts.listActiveTabs({ limit: 2000 });
    assert.ok(!proj.some(x => x.tabName === T1));
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
    const fn = (name) => src.slice(src.indexOf(`async function ${name}(`), src.indexOf('\n}\n', src.indexOf(`async function ${name}(`)));
    assert.match(fn('projectActive'), /participants\.listActiveTabs\(\{ limit \}\)/);
    assert.match(fn('projectionCoverage'), /participants\.listActiveTabs\(\{ limit: _COVERAGE_TAB_CAP \}\)/);
    assert.ok(!/includeParticipantTabs/.test(fn('projectActive') + fn('projectionCoverage')));
    assert.strictEqual((src.match(/listActiveTabs\(\{[^}]*includeParticipantTabs/g) || []).length, 1, '켜는 곳은 scopedActiveTabs 하나');
    assert.match(src, /async function scopedActiveTabs\([^)]*includeParticipantTabs = false/, 'scopedActiveTabs 기본값은 끈 상태');
    assert.ok(!/includeParticipantTabs: true/.test(src), '서비스 안에서 무조건 켜는 곳이 생겼다');
  });

  /* ── 5) fail 방향 ───────────────────────────────────────────── */
  await t('칸 판정 조회 실패 → 홈 집계 ok:false(숫자를 지어내지 않는다 · 자동 마감은 stats_unavailable 로 건너뜀)', async () => {
    failOn = /FROM keys k/; svc.__resetTabStatsCacheForTest();
    const r = await svc.tabStatsMap({ force: true });
    const af = await svc.autoFinishEligibleTabs({ dryRun: true });
    failOn = null;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(af.code, 'stats_unavailable');
  });
  await t('칸 판정 조회 실패 → 업체관리는 행별 포인터로 계속(표·업체 화면은 뜬다)', async () => {
    failOn = /FROM keys k/;
    const r = await svc.ownedTabsForAdvertiser({ advertiserId: 'adv1' });
    failOn = null;
    const o = r.rows.find(x => x.tabName === T1);
    assert.deepStrictEqual([o.bSub, o.bPaid], [12, 12], '포인터가 있는 12줄만 — 종전 동작으로 접힌다');
  });

  await t('★ 칸을 못 찾은 탭의 기록 칸 폴백이 실패해도 홈 집계는 ok:false(빈 칸으로 삼켜 ok:true 로 캐시하지 않는다)', async () => {
    // 머리글·포인터가 전혀 없는 줄 있는 탭 → ③ 폴백(review_index 조회)까지 간다
    await db.exec(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless) VALUES ('${S}','폴백탭',TRUE);
      INSERT INTO campaign_participants (sheet_id, tab_name, seq, reviewer_name, active, row_json) VALUES ('${S}','폴백탭',2,'가',TRUE,'{}'::jsonb);`);
    try {
      failOn = /FROM review_index/; svc.__resetTabStatsCacheForTest();
      const r = await svc.tabStatsMap({ force: true });
      assert.strictEqual(r.ok, false, '폴백 실패가 삼켜졌다');
      const cached = await svc.tabStatsMap();
      assert.strictEqual(cached.ok, false, '실패 결과 대신 캐시가 ok:true 를 돌려준다');
      const own = await svc.ownedTabsForAdvertiser({ advertiserId: 'adv1' });
      assert.ok(own.rows.length > 0, '업체관리는 경고 후 계속');
      // 작업보드 한 탭 화면은 종전대로 fail-soft(빈 칸 = 0건) — 화면이 죽지 않는다
      const w = await svc.workdeskTab({ sheetId: S, tabName: '폴백탭', role: 'master' });
      assert.strictEqual(w.counts.paid, 0);
    } finally {
      failOn = null;
      await db.exec(`DELETE FROM campaign_participants WHERE tab_name='폴백탭'; DELETE FROM tab_configs WHERE tab_name='폴백탭';`);
      svc.__resetTabStatsCacheForTest();
    }
  });

  /* ── 6) 정적 배선 + 변이시험 ──────────────────────────────────── */
  await t('세 곳이 같은 판정을 탄다 · review_index 칸 최빈값 사본 부재', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
    assert.match(src, /let tabPaidHeader = _wsh\.pickPaidHeader\(headers \|\| \[\], _wsh\.countHeaders\(roster\.map\(r => r\.submit_col2\)\)\);/);
    assert.match(src, /let tabSubmitHeader = _wsh\.pickSubmitHeader\(/);
    assert.match(src, /const statusHeaders = await _wsh\.loadTabStatusHeaders\(db, \{ submit: false \}\);/);
    assert.match(src, /_wsh\.loadTabStatusHeaders\(db, \{ tabs: keyRows \}\)/);
    assert.ok(!/FROM review_index ri\s+WHERE ri\.sheet_id = (tc|t)\.sheet_id AND ri\.tab_name = (tc|t)\.tab_name/.test(src));
    assert.ok(!/LEFT JOIN index_master im ON im\.sheet_id = tc\.sheet_id/.test(src));
  });
  await t('변이시험: 공용 칸 판정을 빼면(종전의 행별 포인터만) 홈·업체관리 ≢ 작업보드 로 잡힌다', async () => {
    const orig = wsh.loadTabStatusHeaders;
    wsh.loadTabStatusHeaders = async () => new Map();
    try {
      svc.__resetTabStatsCacheForTest();
      const m = await svc.tabStatsMap({ force: true });
      assert.notStrictEqual(m.map[S + '\t' + T1].paid, board[T1].paid, '홈 변이가 검출되지 않았다');
      const o = (await svc.ownedTabsForAdvertiser({ advertiserId: 'adv1' })).rows.find(x => x.tabName === T1);
      assert.notStrictEqual(o.bSub, board[T1].submitted, '업체관리 제출 변이가 검출되지 않았다');
    } finally { wsh.loadTabStatusHeaders = orig; }
  });

  console.log(`\n✅ statusCountUnify: ${passed} 통과`);
})().catch(e => { console.error(e); process.exitCode = 1; });
