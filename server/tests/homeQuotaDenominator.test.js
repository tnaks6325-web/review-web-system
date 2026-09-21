/**
 * homeQuotaDenominator.test.js — 홈 「인원/제출」 분모 = 총건수 + savePlans 총량 게이트 구멍 (2026-08-24 신고)
 *
 * 신고: 작업오더·모집공고·작업표가 모두 500건인데 홈 목록에는 581건/577건.
 * 원인 2겹 —
 *   ㉮ 홈 분모가 **총건수가 아니라 작업표 활성 줄 수**였다(`tabStatsMap` 의 sheetless 분기).
 *   ㉯ `savePlans` 의 총량 게이트가 `recruit_total` 만 봐서, **공고 총인원 0 + 발주 500** 인
 *      작업에서는 `totalCap=0` 이 되어 게이트가 통째로 꺼져 있었다.
 *
 * ★★ 완화 금지 불변식
 *   ① 채움 수 판정 사본 0 — `tabStatsMap` 은 `rowNumbering.filledSql` 을 쓴다(작업보드 게이지와 같은 판정).
 *   ② 총건수 판정 사본 0 — 홈 주석·총량 게이트 모두 `displayRecruitTotal`(공고>0 이면 공고, 아니면 발주).
 *   ③ 모르는 것을 지어내지 않는다 — 채움 수/총건수를 못 받으면 종전 표기로 접고 그 사실을 말한다.
 *   ④ 작업표 줄 수 대조는 **거부하지 않는다**(읽기 전용 · 저장을 되돌리지 않는다).
 *
 * 실행: node tests/homeQuotaDenominator.test.js
 */
process.env.PGTEST_SKIP_BOOT = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const rf = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', ...p), 'utf8').replace(/\r\n/g, '\n');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };
const eq = (name, got, want) => ok(`${name} → ${JSON.stringify(got)}`, got === want);

const trackB = rd('src', 'services', 'trackB.service.js');
const plan = rd('src', 'services', 'campaignPlan.service.js');
const wd = rf('workdesk.html');

console.log('\n1. tabStatsMap — 채워진 줄은 filledSql 단일 출처');
ok('filledSql 을 SQL 에 태운다(사본 금지)', /filledSql\('cp'\)/.test(trackB));
ok('filled_count 를 무시트 분기에서 쓴다', /THEN COALESCE\(cp\.filled_count, 0\)[\s\S]{0,40}AS "filledCount"/.test(trackB));
ok('맵에 filled 를 싣는다', /filled: Number\.isFinite\(\+r\.filledCount\)/.test(trackB));
ok('total(준비된 줄)은 그대로 남긴다(정보 손실 0)', /total: Number\.isFinite\(\+r\.rowCount\)/.test(trackB));
ok('입금완료도 review_index 상태값이 아니라 작업보드 submit_col2 실제 셀을 센다',
  /cp\.row_json ->> COALESCE\(paid_header\.paid_header, NULLIF\(BTRIM\(cp\.submit_col2\), ''\)\)/.test(trackB)
  && /GROUP BY NULLIF\(BTRIM\(ri\.submit_col2\), ''\)[\s\S]{0,100}ORDER BY COUNT\(\*\) DESC/.test(trackB)
  && /COALESCE\(cp\.paid_count, 0\)::int AS "paidCount"/.test(trackB)
  && !/FROM review_index WHERE is_submitted2 = 'PAID' GROUP BY sheet_id, tab_name/.test(trackB));

console.log('\n2. tabCampaignsMap — 총건수는 displayRecruitTotal 단일 출처');
ok('displayRecruitTotal 을 태운다', /displayRecruitTotal\(r\.recruit_total, _wo && _wo\.recruit_count\)/.test(trackB));
ok('연결 발주는 배치 1회(N+1 금지)', /linkedWorkOrdersForCampaigns\(db, rows\.map\(r => r\.id\)/.test(trackB));
ok('recruitTotal·출처를 주석에 싣는다', /recruitTotal: _rt\.total \|\| null, recruitTotalSource: _rt\.source/.test(trackB));
ok('발주 조회 실패는 fail-soft(공고 값으로 계속)', /발주 정원 조회 실패\(공고 값만 사용\)/.test(trackB));

console.log('\n3. savePlans 총량 게이트 — 발주 폴백(㉯ 구멍)');
ok('_totalCapFor 가 orderTotal 을 받는다', /function _totalCapFor\(camp, schedule, orderTotal = 0\)/.test(plan));
ok('_totalCapFor 가 displayRecruitTotal 을 쓴다(사본 금지)',
  /displayRecruitTotal\(camp && camp\.recruit_total, orderTotal\)\.total/.test(plan));
ok('recruit_total 직접 반환이 되살아나지 않았다',
  !/return Number\(camp && camp\.recruit_total\) \|\| 0;/.test(plan));
ok('savePlans 가 연결 발주 총건수를 구한다', /linkedWorkOrderForCampaign\(camp, \['recruit_count'\]\)/.test(plan));
ok('발주 조회 실패는 fail-soft(게이트가 저장을 막지 않는다)',
  /연결 발주 정원 조회 실패\(공고 값만 사용\)/.test(plan));
ok('게이트 호출에 orderTotal 이 실린다', /_totalCapFor\(camp, schedule, orderTotal\)/.test(plan));

console.log('\n4. 작업표 줄 수 대조 — 읽기 전용 · 거부 금지');
const audit = plan.slice(plan.indexOf("SAVEPOINT cp_row_audit"), plan.indexOf('cp_row_audit') + 2000);
ok('활성 줄만 센다', /deleted_at IS NULL AND active = TRUE/.test(audit));
ok('SELECT 뿐이다(쓰기 0)', !/\b(INSERT|UPDATE|DELETE)\b/i.test(audit.split('} catch')[0]));
ok('SAVEPOINT 로 격리한다', /ROLLBACK TO SAVEPOINT cp_row_audit/.test(plan));
ok('초과해도 throw 하지 않는다(저장 유지)',
  !/rowAudit[\s\S]{0,400}throw/.test(plan.slice(plan.indexOf('rowAudit'), plan.indexOf('rowAudit') + 600)));
ok('start_date 를 date 로 캐스팅하지 않는다(TEXT 표시 문자열)',
  !/cp\.start_date::date/.test(plan));
ok('사유를 응답에 싣는다', /worktableSync\.rowAudit = \{/.test(plan));

console.log('\n5. [📅 인원] 저장 안내 — 조용한 누락 금지');
const dp = rf('js', 'campaign-daily-plan.js');
ok('rowAudit 를 토스트로 말한다(조건 형태까지 고정 — 문자열 존재만 보면 `false &&` 를 통과시킨다)',
  /else if \(j\.worktableSync && j\.worktableSync\.rowAudit\) \{/.test(dp));
ok('"저장 완료" 로 뭉뚱그리지 않는다(warning)', /rowAudit[\s\S]{0,400}'warning'/.test(dp));

console.log('\n6. 홈 「인원/제출」 렌더 — 실제 실행');
const src = wd.slice(wd.indexOf('function _finRecruitTotal('), wd.indexOf('function _finBodyHtml('));
ok('렌더러가 한 벌로 추출된다', /_finNumCells/.test(src));
/* ★ `_finUnpaid`(미입금 = 제출 − 입금)는 이 범위 밖에 있지만 **스텁을 두지 않고 구현을 꺼내 넣는다** —
   스텁이면 "입금 잔여가 필터·정렬과 같은 기준인가"를 여기서 못 본다(레포 규율). */
const unpaidFn = wd.match(/function _finUnpaid\(t\)\{[\s\S]*?\n\}/) || wd.match(/function _finUnpaid\(t\)\{.*?\}/);
ok('_finUnpaid 구현을 함께 태운다(스텁 금지)', !!unpaidFn);
const sb = { esc: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
             _isNoSheet: t => !!(t && t.sheetless === true) };
vm.createContext(sb); vm.runInContext(unpaidFn[0] + '\n' + src, sb);

const T = (stats, camps, sheetless) => ({ stats, campaigns: camps, sheetless });
const R = (t, filt) => sb._finNumCells(t, 0, filt || '');
const h1 = R(T({ total: 581, filled: 208, submitted: 159, paid: 106 },
  [{ id: 'c1', status: 'active', recruitTotal: 500, recruitTotalSource: 'campaign' }], true));
/* ★★ 시안 확정(2026-09-22) — 한 칸의 분수(`208/500`)를 **네 칸**으로 나눴다: 총건수·참여·제출·입금.
   검사 의미는 그대로다 — "총건수는 공고값(500), 참여는 채워진 줄(208), 제출은 제출 수(159)". */
ok('총건수 칸 = 공고 총건수(500)', /class="box tot">500</.test(h1));
ok('참여 칸 = 채워진 줄(208) — 줄 수(581)가 아니다', /class="box">208</.test(h1) && !/>581</.test(h1));
ok('제출·입금도 각자 칸(159 · 106)', />159</.test(h1) && />106</.test(h1));
ok('준비된 줄·빈 슬롯을 툴팁으로 말한다', /준비된 줄 581줄 \(빈 슬롯 373줄\)/.test(h1));
ok('무시트에서 줄≠총건수면 경고를 붙인다', /⚠ 준비된 줄\(581\)이 총건수\(500\)/.test(h1));

const h2 = R(T({ total: 300, filled: 120, submitted: 90, paid: 10 },
  [{ id: 'c1', status: 'active', recruitTotal: 300, recruitTotalSource: 'campaign' }], true));
ok('줄 = 총건수면 경고가 없다', !/⚠/.test(h2) && /class="box tot">300</.test(h2) && /class="box">120</.test(h2));

const h3 = R(T({ total: 140, filled: 140, submitted: 90 },
  [{ id: 'c1', status: 'active', recruitTotal: 500, recruitTotalSource: 'campaign' }], false));
ok('시트 기반 탭에는 경고를 붙이지 않는다(이름 있는 행 수라 적은 게 정상)', !/⚠/.test(h3) && /class="box tot">500</.test(h3));

const h4 = R(T({ total: 581, filled: 208, submitted: 159 }, [], true));
ok('총건수를 모르면 줄 수로 접고 표시로 알린다(0 위장 금지)', /class="box tot">581\*</.test(h4));
ok('총건수 미상 사유를 툴팁으로 말한다', /총건수 미상/.test(h4));

const h5 = R(T({ total: 581, submitted: 159 }, [{ id: 'c1', status: 'active', recruitTotal: 500 }], true));
ok('구버전 백엔드(filled 미동봉) = 참여 칸을 — 로 두고 사유를 말한다(0 위장 금지)',
  /class="box">—</.test(h5) && /이 서버는 채워진 줄 수를 아직 내려주지 않습니다/.test(h5));

const h6 = R(T({}, [], true));
ok('통계 자체가 없으면 네 칸 모두 —', (h6.match(/>—</g) || []).length === 4);

const h7 = R(T({ total: 100, filled: 40, submitted: 10 },
  [{ id: 'c1', status: 'active', recruitTotal: 0, recruitTotalSource: 'none' },
   { id: 'c2', status: 'draft', recruitTotal: 999 }], true));
ok('기준 공고 = 게시중 우선(총건수 0이면 줄 수로 접는다)', /class="box tot">100\*</.test(h7));

const h8 = R(T({ total: 500, filled: 500, submitted: 500, paid: 500 },
  [{ id: 'c1', status: 'active', recruitTotal: 500 }], true));
ok('총건수에 도달한 칸은 파랑으로 찬다', (h8.match(/class="box full"/g) || []).length === 3);

/* ★★ 시안 확정(2026-09-22) — 거의 끝난 작업에서만 숫자를 눌러 "아직 안 낸 사람"을 본다.
   잔여는 **참여자 기준**(제출) · **제출자 기준**(입금) — 서버 목록과 같은 기준이라야 건수가 갈리지 않는다. */
const h9 = R(T({ total: 100, filled: 100, submitted: 95, paid: 90 },
  [{ id: 'c1', status: 'active', recruitTotal: 100 }], true));
ok('잔여가 총건수의 10% 이하면 제출·입금 칸을 누를 수 있다',
  /class="box clickable"[^>]*data-k="submit"/.test(h9) && /data-k="paid"/.test(h9));
ok('남은 수를 말풍선으로 말한다(제출 5명 · 입금 5명)', (h9.match(/class="rest">5명 남음</g) || []).length === 2);
ok('onclick 에는 인덱스만 넘긴다(작업명은 시트에서 온 문자열)',
  /openPendingFromHome\(0,'submit',this\)/.test(h9) && !/openPendingFromHome\([^)]*tabName/.test(h9));

const h10 = R(T({ total: 100, filled: 100, submitted: 40, paid: 10 },
  [{ id: 'c1', status: 'active', recruitTotal: 100 }], true));
ok('아직 한참 남은 작업은 누를 수 없다(큰 숫자를 목록으로 열지 않는다)', !/clickable/.test(h10));

const h11 = R(T({ total: 100, filled: 100, submitted: 95, paid: 90 },
  [{ id: 'c1', status: 'active', recruitTotal: 100 }], true), 'pay');
ok('미입금 필터 중에는 입금 칸을 주황으로 + 남은 수를 상시 표시',
  /class="box short clickable"/.test(h11) && /class="rest on">5명 남음</.test(h11));

console.log(`\n✅ ${n} 케이스 통과`);
process.exit(0);
