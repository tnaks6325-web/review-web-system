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
ok('렌더러가 한 벌로 추출된다', /_finProgHtml/.test(src));
const sb = { esc: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
             _isNoSheet: t => !!(t && t.sheetless === true) };
vm.createContext(sb); vm.runInContext(src, sb);

const T = (stats, camps, sheetless) => ({ stats, campaigns: camps, sheetless });
const h1 = sb._finProgHtml(T({ total: 581, filled: 208, submitted: 159, paid: 106 },
  [{ id: 'c1', status: 'active', recruitTotal: 500, recruitTotalSource: 'campaign' }], true));
ok('분모 = 총건수(500), 분자 = 채워진 줄(208)', /208\/500/.test(h1) && !/159\/581/.test(h1));
ok('제출 수는 남긴다(정보 손실 0)', /제출 159/.test(h1));
// ★ 게이지 폭도 **채워진 줄** 기준이어야 한다 — 숫자만 검사하면 막대만 제출 기준으로 되돌린
//   변이를 통과시킨다(변이시험 M2 실측). 208/500 = 42%.
ok('게이지 폭 = 채워진 줄/총건수(42%)', /width:42%/.test(h1));
ok('준비된 줄·빈 슬롯을 툴팁으로 말한다', /준비된 줄 581줄 \(빈 슬롯 373줄\)/.test(h1));
ok('무시트에서 줄≠총건수면 경고를 붙인다', /⚠ 준비된 줄\(581\)이 총건수\(500\)/.test(h1));

const h2 = sb._finProgHtml(T({ total: 300, filled: 120, submitted: 90, paid: 10 },
  [{ id: 'c1', status: 'active', recruitTotal: 300, recruitTotalSource: 'campaign' }], true));
ok('줄 = 총건수면 경고가 없다', !/⚠/.test(h2) && /120\/300/.test(h2));

const h3 = sb._finProgHtml(T({ total: 140, filled: 140, submitted: 90 },
  [{ id: 'c1', status: 'active', recruitTotal: 500, recruitTotalSource: 'campaign' }], false));
ok('시트 기반 탭에는 경고를 붙이지 않는다(이름 있는 행 수라 적은 게 정상)', !/⚠/.test(h3) && /140\/500/.test(h3));

const h4 = sb._finProgHtml(T({ total: 581, filled: 208, submitted: 159 }, [], true));
ok('총건수를 모르면 분모를 줄 수로 접고 표시로 알린다(0 위장 금지)', /208\/581\*/.test(h4));
ok('총건수 미상 사유를 툴팁으로 말한다', /총건수 미상/.test(h4));

const h5 = sb._finProgHtml(T({ total: 581, submitted: 159 },
  [{ id: 'c1', status: 'active', recruitTotal: 500 }], true));
ok('구버전 백엔드(filled 미동봉) = 종전 표기로 접는다', /159\/581/.test(h5) && /제출 기준/.test(h5));

const h6 = sb._finProgHtml(T({}, [], true));
eq('통계 자체가 없으면 —', h6, '<span class="wbl-sub">—</span>');

const h7 = sb._finProgHtml(T({ total: 100, filled: 40, submitted: 10 },
  [{ id: 'c1', status: 'active', recruitTotal: 0, recruitTotalSource: 'none' },
   { id: 'c2', status: 'draft', recruitTotal: 999 }], true));
ok('기준 공고 = 게시중 우선(총건수 0이면 줄 수로 접는다)', /40\/100\*/.test(h7));

const h8 = sb._finProgHtml(T({ total: 500, filled: 500, submitted: 500 },
  [{ id: 'c1', status: 'active', recruitTotal: 500 }], true));
ok('100% 를 넘기지 않는다', /width:100%/.test(h8));

console.log(`\n✅ ${n} 케이스 통과`);
process.exit(0);
