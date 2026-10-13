/**
 * 결정 240 — 관리자 화면 숫자(공고 카드 회차 진행·홈 오늘 참여 확정·참여 관리 머리줄·상품별 현황표)에 바로 구매를 넣는다.
 * 셈은 정원 엔진 하나(quotaFloor.confirmedWithDirect / optionDirectOrderStats). 구버전 서버(새 칸 없음)에서는 화면이 종전 값으로 접힌다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const { confirmedWithDirect } = require('../src/services/quotaFloor.service');

// ① 순수 셈 — max(확정, 연결 주문) · 공유 작업표/조회 실패 = 공고 참여만
let c = confirmedWithDirect({ submittedAll: 6, todaySubmitted: 0, linked: { ok: true, orders: 16, ordersToday: 6 } });
assert.deepEqual([c.total, c.today, c.attributable], [16, 6, true]);
c = confirmedWithDirect({ submittedAll: 6, todaySubmitted: 1, linked: { ok: true, orders: 16, ordersToday: 6, sharedTab: true } });
assert.deepEqual([c.total, c.today, c.attributable, c.sharedTab], [6, 1, false, true], 'shared worktable: applications only');
c = confirmedWithDirect({ submittedAll: 10, todaySubmitted: 1, linked: { ok: true, orders: 13, ordersToday: 2 } }, { n: 5, today: 2 });
assert.deepEqual([c.total, c.today, c.direct, c.directToday], [15, 3, 5, 2], 'confirmations + direct (not max) — unlinked manual confirmations are not lost');
c = confirmedWithDirect({ submittedAll: 6, todaySubmitted: 1, linked: null });
assert.deepEqual([c.total, c.today, c.attributable], [6, 1, false], 'no ledger data: applications only');

// ② 서버 배선
const routes = read('server/src/routes/campaign.routes.js');
assert.ok(/todayConfirmedAll: c\.today, totalConfirmedAll: c\.total, directCountable: c\.attributable/.test(routes), '카드·홈 재료');
assert.ok(/loadDirectOrderCounts\(pool, _pIds, now\)/.test(routes), '바로 구매 수는 게이트 집계와 분리된 조회');
const stSrc = read('server/src/services/campaignState.service.js');
const ldo = stSrc.slice(stSrc.indexOf('async function _loadLinkedOrderCounts'), stSrc.indexOf('async function loadDirectOrderCounts'));
assert.ok(!/direct_orders|is_direct/.test(ldo), '참여 게이트 주문 집계(_loadLinkedOrderCounts)는 무접촉');
assert.ok(/totalConfirmed: cnt\.submittedAll,/.test(routes), '종전 칸(공고 참여만)은 호환용으로 유지');
assert.ok(/options, sheetInfo, directSummary \}\)/.test(routes) && /optionDirectOrderStats\(pool, id\)/.test(routes), '참여 관리 요약');
assert.ok(/let byOpt = null;\s*if \(stats\)/.test(routes), '상품별 조회 실패는 null(모름) — 0 으로 꾸미지 않음');
const plan = read('server/src/services/campaignPlan.service.js');
assert.ok(/\[today\]: Math\.max\(plannerByDateSubmitted\[today\] \|\| 0, c\.today\)/.test(plan), '시트 작업: 누적과 오늘 칸을 함께 올린다');

// ③ 화면 — 새 칸 우선, 없으면 종전 칸(배포 스큐 안전)
const cards = read('frontend/js/campaign-cards.js');
assert.equal((cards.match(/c\.ops\.totalConfirmedAll != null \? c\.ops\.totalConfirmedAll : c\.ops\.totalConfirmed/g) || []).length, 2, '카드 폴백 분자·회차 진행');
const wd = read('frontend/workdesk.html');
assert.ok(/c\.ops\.todayConfirmedAll!=null\?c\.ops\.todayConfirmedAll:c\.ops\.todaySubmitted/.test(wd), '홈 오늘 참여 확정');

// ④ 상품별 현황표 실행 — 바로 구매가 오늘 제출·누적 확정에 더해지고 괄호로 표시, 재료 없으면 종전
const ir = read('frontend/js/index-recruit.js');
const start = ir.indexOf('function _seqMDk(');
const end = ir.indexOf('function _campOwnerTable(');
const ctx = {}; vm.createContext(ctx); vm.runInContext(ir.slice(start, end), ctx);
const opts = [{ optKey: 'F', payAmount: 18000, recruitTotal: 500, status: 'open' }];
const rows = [{ option_key: 'F', status: 'submitted', submitted_at: '2026-10-10T01:00:00Z', applied_at: '2026-10-10T00:00:00Z' }];
const kstDay = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
const withD = ctx._campOptionTable(opts, rows, Date.parse('2026-10-13T05:00:00Z'), '2026-10-13', kstDay, { F: { n: 6, today: 4 } });
assert.ok(/>4 <span[^>]*>\(바로 4\)<\/span>/.test(withD) && />7 <span[^>]*>\(바로 6\)<\/span>/.test(withD), withD);
const noD = ctx._campOptionTable(opts, rows, Date.parse('2026-10-13T05:00:00Z'), '2026-10-13', kstDay, null);
assert.ok(!/바로/.test(noD) && />1<\/td>/.test(noD), 'no summary (old server/failure) = applications only');

console.log('directPurchaseAdminNumbers: passed');
