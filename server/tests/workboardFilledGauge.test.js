/**
 * workboardFilledGauge.test.js — 회귀가드: [진행 현황] 게이지 기준 = **채워진 줄**
 * 실행: node tests/workboardFilledGauge.test.js
 *
 * 배경(사용자 신고 2026-08-20 「0729)위드프렌즈_면마스크 200건」): 상단 게이지가
 *   `counts.total`(= 작업표 활성 **줄 수**)을 세어, 작업표 생성 때 미리 깔아 둔 **빈 슬롯**까지
 *   사람으로 계산했다 → 실제로 채워진 줄이 그보다 적은데 `참여자 200/200 · 100%` 로 보였다.
 *   같은 화면 툴바의 「오늘 참여현황」은 `review_index`(이름 있는 행)만 세어 두 숫자가 갈렸다.
 *
 * 고정하는 것:
 *  A. "채워진 줄" 판정은 **단일 출처**(`utils/rowNumbering`) — SQL·JS 가 같은 목록을 본다
 *  B. 서버가 `counts.filled` 를 준다 — 빈 슬롯은 안 세고, 마스킹 전에 센다
 *  C. 화면 게이지는 그 값을 분자·분모로 쓰고, 못 받으면 종전(`total`)으로 접는다
 *  D. 줄 수(준비된 슬롯)는 사라지지 않는다 — 참여자 게이지 툴팁이 말한다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readRoot = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const U = require('../src/utils/rowNumbering');

console.log('\n[A] "채워진 줄" 판정 단일 출처 — SQL·JS 가 같은 목록을 본다');
{
  // ★ 이 리터럴은 종전 `rowNumbering.service.FILLED_SQL` 원문이다. 생성기가 이것과
  //   **바이트 동일**해야 번호 재부여·짝 빈 줄 정리의 동작이 한 글자도 안 바뀐다.
  const LEGACY = `(p.order_submission_id IS NOT NULL
   OR NULLIF(btrim(COALESCE(p.reviewer_name, '')), '') IS NOT NULL
   OR NULLIF(btrim(COALESCE(p.recipient_name, '')), '') IS NOT NULL
   OR NULLIF(btrim(COALESCE(p.phone8, '')), '') IS NOT NULL)`;
  ok('★ filledSql("p") 가 종전 리터럴과 바이트 동일(무회귀)', U.filledSql('p') === LEGACY, U.filledSql('p'));
  ok('별칭이 반영된다', U.filledSql('cp').indexOf('cp.phone8') > 0);
  let threw = false; try { U.filledSql('p; DROP TABLE x'); } catch (e) { threw = true; }
  ok('★ 별칭 형식 검증(문자열 보간 주입 차단)', threw);

  const svc = read('src/services/rowNumbering.service.js');
  ok('★ 서비스에 SQL 사본이 없다(생성기를 쓴다)',
    /const FILLED_SQL = filledSql\('p'\);/.test(svc) && !/COALESCE\(p\.reviewer_name/.test(svc));

  // JS 판정 — DB 행/합성 행 두 모양 모두
  ok('빈 슬롯 = 채워지지 않음', U.isFilledRow({ seq: 170, name: '', recipient: '', phone8: '', hasOrder: false }) === false);
  ok('공백만 있는 칸도 빈 칸', U.isFilledRow({ name: '   ', phone8: '  ' }) === false);
  ok('이름만 있어도 채워짐', U.isFilledRow({ name: '조연숙' }) === true);
  ok('수취인만 있어도 채워짐', U.isFilledRow({ recipient: '이혜선' }) === true);
  ok('연락처만 있어도 채워짐', U.isFilledRow({ phone8: '96689776' }) === true);
  ok('주문 링크만 있어도 채워짐(합성 행 hasOrder)', U.isFilledRow({ hasOrder: true }) === true);
  ok('주문 링크만 있어도 채워짐(DB 행)', U.isFilledRow({ order_submission_id: 'uuid' }) === true);
  ok('DB 컬럼명으로도 판정된다', U.isFilledRow({ reviewer_name: '홍길동' }) === true);
  ok('빈 입력은 false', U.isFilledRow(null) === false && U.isFilledRow(undefined) === false);
}

console.log('\n[B] 서버 counts.filled — 스텁 pool 로 workdeskTab 실제 실행');
{
  const poolPath = require.resolve('../src/db/pool');
  const orig = require.cache[poolPath];
  const rosterRows = [
    // 무시트 수동 생성 행: submit_col은 비어 있지만 탭 상태 헤더의 실제 셀 값은 있다.
    { id: 'r1', seq: 164, name: '조연숙', recipient: '조연숙', phone8: '96689776', order_submission_id: null, row_json: { 리뷰제출: '8/10 22:49' }, source: 'worktable' },
    // 플래그는 false지만 표 셀에 값이 있다. 카드 기준은 반드시 이 값을 센다.
    { id: 'r2', seq: 165, name: '이혜선', recipient: '이혜선', phone8: '90739194', order_submission_id: null, row_json: { 리뷰제출: '8/4 13:53' }, source: 'worktable', submitted: false },
    { id: 'r3', seq: 170, name: '', recipient: '', phone8: '', order_submission_id: null, row_json: {}, source: 'worktable' },   // 빈 슬롯
    { id: 'r4', seq: 171, name: null, recipient: null, phone8: null, order_submission_id: null, row_json: {}, source: 'worktable' }, // 빈 슬롯
  ];
  const stub = {
    query: async (sql) => {
      const q = String(sql);
      if (/FROM tab_configs tc/.test(q)) return { rows: [{ displayName: 't', sheetless: true }] };
      // ★ 더 좁은 조건(명단 조회)을 **먼저** — 스텁은 SQL 을 해석하지 않으므로 순서가 곧 판정이다
      //   (넓은 분기를 앞에 두면 명단이 빈 배열로 가로채여 "0 명" 을 정상으로 읽는다).
      if (/FROM campaign_participants cp/.test(q) && /ORDER BY cp\.seq/.test(q)) return { rows: rosterRows };
      if (/SELECT submit_col AS h FROM review_index/.test(q)) return { rows: [{ h: '리뷰제출' }] };
      return { rows: [] };
    },
  };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => stub, query: stub.query } };
  delete require.cache[require.resolve('../src/services/trackB.service')];
  const trackB = require('../src/services/trackB.service');

  (async () => {
    const res = await trackB.workdeskTab({ sheetId: 's1', tabName: 't1', role: 'master', allowAllWorkdesk: true });
    ok('★ counts.filled = 채워진 줄만(빈 슬롯 2줄 제외)', res.counts.filled === 2, JSON.stringify(res.counts));
    ok('counts.total 은 종전대로 줄 수(정보 보존)', res.counts.total === 4, String(res.counts.total));
    ok('★ counts.submitted = is_submitted 플래그가 아닌 실제 리뷰제출 셀 값 수', res.counts.submitted === 2, JSON.stringify(res.counts));
    ok('★ 수동 생성 무시트 행(submit_col 없음)도 탭 상태 헤더로 실제 셀을 센다', res.counts.submitted === 2, JSON.stringify(res.counts));

    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
    console.log(`\n✅ ${passed} passed\n`);
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}

console.log('\n[B2] 계산 위치 — 마스킹 전');
{
  const src = read('src/services/trackB.service.js');
  const iFilled = src.indexOf('_isFilledRow(syn)');
  const iMask = src.indexOf('if (maskPII) { syn.phone8 = _mask(');
  /* ★★ 행 숨김 기능 폐기(사용자 확정 2026-08-23) — 화면에서만 줄을 빼는 경로가 없어졌다.
     되살리면 게이지 분자와 표의 줄 수가 다시 갈린다(참여자 85명 → 82/100 실사고). */
  ok('★ 숨김 오버레이 해석이 남아 있지 않다(표의 줄 수 ≡ 게이지 분모)',
    src.indexOf('if (ov._hidden === true)') === -1);
  ok('★ 카운트는 마스킹 **앞**(광고주 렌즈를 거친 뒤 세면 전 줄이 채워짐으로 뒤집힌다)', iMask > 0 && iFilled < iMask);
  // ⚠ 제출물 미리보기(2026-08-21)가 같은 import 에서 `numberColumnKey` 도 가져오며 형태가 바뀌었다.
  //   검사 의미는 불변 — 판정을 베끼지 않고 utils 에서 가져다 쓴다.
  ok('판정 사본 없음 — utils 를 import 해 쓴다',
    /isFilledRow: _isFilledRow[\s\S]{0,80}\} = require\('\.\.\/utils\/rowNumbering'\)/.test(src));
  ok('모집일 부족분은 무시트 내부 작업보드에서만 저장된 계획 합계로 계산한다',
    /showEdits && meta\[0\] && meta\[0\]\.sheetless && _cond && _cond\.campaignId && _recruitCap/.test(src)
    && /SUM\(planned_count\)/.test(src)
    && /scheduleUnassigned: scheduleUnassigned > 0 \? scheduleUnassigned : undefined/.test(src));
}

console.log('\n[C][D] 화면 게이지 — summaryStrip 을 vm 으로 실제 실행');
{
  const html = readRoot('frontend/workdesk.html');
  const start = html.indexOf('function summaryStrip(wd,d,m,c){');
  assert(start > 0, 'summaryStrip 을 찾지 못했다');
  const end = html.indexOf('\n}', html.indexOf('return `<div class="tp3grid c3', start)) + 2;
  /* ★ 분모(`_rvFilledOf`)는 제출물 미리보기와 **같은 함수**를 쓴다(사본 0, 2026-08-21).
     스텁으로 대신하면 그 단일 출처가 깨져도 이 가드가 통과하므로 **구현을 그대로 꺼내** 넣는다. */
  const iF = html.indexOf('function _rvFilledOf(c){');
  assert(iF > 0, '_rvFilledOf 을 찾지 못했다 — 게이지 분모가 다른 곳에서 만들어지고 있다');
  const code = html.slice(iF, html.indexOf('\n', iF)) + '\n' + html.slice(start, end);
  const sandbox = {
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    parseTabMeta: () => ({}),
    _condCardHtml: () => '<div class="tp3col">cond</div>',
    setlSummaryHtml: () => '<div class="setlsummary"></div>',
    _wonFmt: n => String(n),
    STATE: { role: 'master', cur: { tabName: 't' }, settleOpen: false },
    _topFolded: () => false,   // 접힘 상태 복원(시안 v2) — 게이지 검사와 무관
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const run = c => sandbox.summaryStrip({}, { recruitCount: 200 }, {}, c);

  const now = run({ total: 200, filled: 134, submitted: 134, paid: 119 });
  ok('★ 참여자 분자 = 채워진 줄(134)', /참여자<\/span><span class="nm">134<small>\/200<\/small>/.test(now), now.slice(0, 400));
  ok('★ 참여자 % = 채워진 줄 / 총건수(67%)', />67%<\/span>/.test(now));
  ok('★ 제출완료 분모도 채워진 줄(134/134)', /제출완료<\/span><span class="nm">134<small>\/134<\/small>/.test(now));
  ok('★ 입금완료 분모도 채워진 줄(119/134)', /입금완료<\/span><span class="nm">119<small>\/134<\/small>/.test(now));
  ok('★ 준비된 줄은 사라지지 않는다 — 툴팁이 말한다',
    /title="채워진 줄 134명 · 준비된 줄 200줄 \(빈 슬롯 66줄\)"/.test(now), now.slice(0, 600));

  const legacy = run({ total: 200, submitted: 134, paid: 119 });   // 구버전 백엔드(filled 없음)
  ok('★ filled 미동봉이면 종전 동작(줄 수 기준)으로 접는다',
    /참여자<\/span><span class="nm">200<small>\/200<\/small>/.test(legacy) && !/title="채워진 줄/.test(legacy));

  const zero = run({ total: 200, filled: 0, submitted: 0, paid: 0 });
  ok('채워진 줄 0 이어도 0 나누기로 죽지 않는다', /참여자<\/span><span class="nm">0<small>\/200<\/small>/.test(zero));

  const noEmpty = run({ total: 134, filled: 134, submitted: 100, paid: 90 });
  ok('빈 슬롯이 없으면 툴팁에 "(빈 슬롯 …)" 을 붙이지 않는다',
    /title="채워진 줄 134명 · 준비된 줄 134줄"/.test(noEmpty));

  const shortfall = run({ total: 200, filled: 168, submitted: 135, paid: 86, scheduleUnassigned: 32 });
  ok('★ 모집일 계획이 부족할 때만 정확한 부족 건수를 표시한다',
    /! 모집일 미설정 32건/.test(shortfall), shortfall.slice(0, 1000));
  const planned = run({ total: 200, filled: 168, submitted: 135, paid: 86, scheduleUnassigned: 0 });
  ok('모집일 계획이 모두 설정되면 경고를 표시하지 않는다', !/모집일 미설정/.test(planned));
  sandbox.STATE.role = 'advertiser';
  const advertiser = run({ total: 200, filled: 168, submitted: 135, paid: 86, scheduleUnassigned: 32 });
  ok('모집일 계획 부족분은 광고주 화면에 표시하지 않는다', !/모집일 미설정/.test(advertiser));
}
