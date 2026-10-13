/**
 * 결정 242 — 바로 구매 규칙 위반 표시(막지 않음). 순수 판정 · 훅 배선 · 같은 셈(참여 버튼 규칙) · 화면 배지.
 * 실제 DB 시나리오 8개(옛/새 비교)는 PR 본문에 기록.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const svc = require('../src/services/directPurchaseRules.service');

// ① 순수 판정
const f = (o) => svc.collectFlags({ registered: true, repurchaseBlocked: false, onePerPersonBlocked: false, popular: false, popularCredits: null, todayBefore: 0, dailyCap: 10, ...o }).map(x => x.code);
assert.deepEqual(f({}), [], 'clean purchase = []');
assert.deepEqual(f({ popular: true, popularCredits: 0 }), ['popular_no_credit']);
assert.deepEqual(f({ popular: true, popularCredits: 1 }), [], 'credit available');
assert.deepEqual(f({ registered: false }), ['unregistered']);
assert.deepEqual(f({ repurchaseBlocked: true, onePerPersonBlocked: true }), ['repurchase_window', 'one_per_person']);
assert.deepEqual(f({ todayBefore: 9 }), [], '10th purchase is allowed');
assert.deepEqual(f({ todayBefore: 10 }), ['daily_cap'], '11th purchase flagged');
for (const code of ['popular_no_credit', 'unregistered', 'repurchase_window', 'one_per_person', 'daily_cap']) assert.ok(svc.RULE_LABELS[code], code);

// ② 서비스 계약
const s = read('server/src/services/directPurchaseRules.service.js');
assert.ok(/if \(o\.campaign_application_id \|\| o\.deleted_at\) return \{ judged: false, reason: 'not_direct' \}/.test(s), 'participation orders are never flagged');
assert.ok(/ORDER BY \(rc\.created_at <= \$3\) DESC/.test(s), 'campaign existing at purchase time (same rule as credit events)');
assert.ok(/loadPopularCreditState\(db, p8, \{ evaluatedAt: new Date\(at\.getTime\(\) - 1\) \}\)/.test(s), 'credit evaluated just before this purchase');
assert.ok(/checkRepurchaseConflictAt/.test(s) && (s.match(/excludeOrderSubmissionId: o\.id, onlyBefore: true/g) || []).length === 2,
  'repurchase guard single source, excludes itself, earlier records only (later purchase carries the flag)');
const rg = read('server/src/utils/repurchaseGuard.js');
assert.equal((rg.match(/AND \(NOT \$9::boolean OR (os|ca)\.submitted_at < \$5::timestamptz\)/g) || []).length, 2, 'onlyBefore applies to orders and applications');
assert.ok(/rc2\.participation_mode IS TRUE[\s\S]{0,120}rc2\.linked_tab_name = os\.tab_name/.test(s), 'daily cap counts participation worktables only (same as apply gate)');
assert.ok(/WHERE id = \$1::uuid AND campaign_application_id IS NULL/.test(s), 'write guarded to direct purchases');
assert.ok(/JSON\.stringify\(\{ campaignId: camp\.id, flags \}\)/.test(s), 'stores which campaign produced the result');
assert.ok(/DIRECT_PURCHASE_RULE_FLAGS === '0'/.test(s) && /setImmediate/.test(s), 'after response · kill switch');

// ③ 훅 — 바로 구매 두 길(구매양식 링크·담당자 수동제출)
assert.ok(/\n    require\('\.\.\/services\/directPurchaseRules\.service'\)\.judgeLater\(ledger\.orderSubmissionId, 'submit'\)/.test(read('server/src/routes/submit.routes.js')),
  'every saved purchase is judged (failed hold confirmation leaves a direct purchase)');
assert.ok(/if \(!application\) require\('\.\/directPurchaseRules\.service'\)\.judgeLater\(ledger\.orderSubmissionId, 'manual'\)/.test(read('server/src/services/manualOrder.service.js')));
assert.ok(/"campaignId"/.test(read('server/migrations/187_order_rule_flags.sql')) && /ADD COLUMN IF NOT EXISTS rule_flags JSONB/.test(read('server/migrations/187_order_rule_flags.sql')));
assert.ok(/\['order_submissions', 'rule_flags'\]/.test(read('server/index.js')), 'schema preflight');

// ④ 화면 — 작업보드(보기·편집)·카드·참여 관리
const wd = read('frontend/workdesk.html');
assert.ok(/⚠ 규칙 위반: '\+esc\(r\.ruleFlags\.join/.test(wd), 'view table badge');
assert.ok(/\$\{ruleMark\}\$\{esc\(r\.name\|\|'—'\)\}/.test(wd), 'grid: red mark before the name (badge after would be clipped)');
const cc = read('frontend/js/campaign-cards.js');
assert.ok(/ruleBad > 0/.test(cc) && /c\.ops\.ruleViolations === null/.test(cc), 'card orange badge; unknown = grey ?');
const st = read('server/src/services/campaignState.service.js');
assert.ok(/x\.rf->>'campaignId' = x\.id/.test(st) && /SELECT DISTINCT ON \(rc\.id, \$\{ORDER_PURCHASE_KEY_SQL\}\) rc\.id, os\.rule_flags AS rf/.test(st),
  'card count = same representative row as the list, this campaign\'s judgment only');
assert.ok(/r\.rule_flags\.campaignId === campaignId/.test(st), 'list shows this campaign\'s judgment only');
assert.ok(/\(dmr \? \(Number\(dmr\.flagged\) \|\| 0\) : null\)/.test(read('server/src/routes/campaign.routes.js')), 'lookup failure = null, not 0');
assert.ok(/r\.ruleFlags\.join\(" · "\)/.test(read('frontend/js/index-recruit.js')), 'control direct list badge');
const tb = read('server/src/services/trackB.service.js');
assert.ok(/\.\.\.\(showEdits && r\.ruleFlags && Array\.isArray\(r\.ruleFlags\.flags\)/.test(tb), 'internal workboard only (not advertiser lens)');

console.log('directPurchaseRuleFlags: passed');
