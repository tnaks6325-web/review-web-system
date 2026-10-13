/**
 * 결정 241 — 참여 관리 화면의 "바로 구매" 목록 + 관리자 인기 참여권 집계·라벨에 바로 구매.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

const st = read('server/src/services/campaignState.service.js');
// ① 목록과 개수는 같은 범위(단일 출처 SQL)
assert.equal((st.match(/\$\{DIRECT_ORDER_SCOPE_SQL/g) || []).length, 2, 'count + list share DIRECT_ORDER_SCOPE_SQL');
assert.ok(/SELECT DISTINCT ON \(\$\{ORDER_PURCHASE_KEY_SQL\}\)[\s\S]{0,200}AS name/.test(st), 'one purchase = one row');
assert.ok(/RIGHT\(regexp_replace\(COALESCE\(os\.phone, ''\), '\[\^0-9\]', '', 'g'\), 4\) AS phone4/.test(st), 'only last 4 digits leave the server');
assert.ok(/NULLIF\(cp\.row_json->>'상품', ''\)/.test(st), 'product falls back to the worktable row');

// ② 서버 배선
const routes = read('server/src/routes/campaign.routes.js');
assert.ok(/listDirectOrders\(pool, id\) : null/.test(routes) && /rows: rowsDirect,/.test(routes), 'directSummary.rows');
assert.ok(/loadPopularCreditMatches\(pool, null, \{ evaluatedAt, includeDirectPurchases: true \}\)/.test(routes), 'audit counts direct purchases');
assert.ok(/\{ evaluatedAt, includeDirectPurchases: true \}\);\n/.test(routes), 'control purpose label counts direct purchases');
const tb = read('server/src/services/trackB.service.js');
assert.ok(/loadPopularCreditMatches\(db, phones, \{ includeDirectPurchases: true \}\)/.test(tb), 'workboard purpose label counts direct purchases');

// ③ 화면 표 실행 — 공유·실패·빈 목록·목록
const ir = read('frontend/js/index-recruit.js');
const s0 = ir.indexOf('function _campDirectTable(');
const ctx = {}; vm.createContext(ctx); vm.runInContext(ir.slice(s0, ir.indexOf('function _campOwnerTable(')), ctx);
assert.equal(ctx._campDirectTable(null), '', 'old server: nothing');
assert.ok(/나눌 수 없습니다/.test(ctx._campDirectTable({ countable: false, shared: true })));
assert.ok(/불러오지 못했습니다/.test(ctx._campDirectTable({ countable: true, rows: null })), 'failure is not shown as empty');
assert.ok(/바로 구매가 없습니다/.test(ctx._campDirectTable({ countable: true, rows: [] })));
const html = ctx._campDirectTable({ countable: true, totalDirect: 3, rows: [
  { submittedAt: '2026-10-13T12:00:00Z', name: '<b>x</b>', phone4: '0007', product: 'F', rowSeq: 7, source: 'manual' }] });
assert.ok(/&lt;b&gt;x&lt;\/b&gt;/.test(html) && /\*\*\*0007/.test(html) && /7행/.test(html) && /담당자 수동제출/.test(html), html);
assert.ok(/최근 1건만 보입니다\(전체 3건\)/.test(html), 'truncation is stated');

// ④ Codex PR #1627 — 연락처 없는 주문은 참여권 매칭 제외 · 진단 수동추가는 수동 · 작업표 줄은 이 공고 표만 · 바로 구매 줄 인기 목적 표시
const dp = read('server/src/services/directPurchaseParticipation.service.js');
assert.ok(/AND \$\{OS_PHONE8\} ~ '\^\[0-9\]\{8\}\$'/.test(dp), 'phone-less orders never share credits');
assert.ok(/\(r\.source === 'admin_external' \|\| r\.source === 'manual'\) \? 'manual' : 'link'/.test(st), 'diag manual orders are manual');
assert.ok(/SELECT cpo\.reviewer_name[\s\S]{0,400}AND cpo\.sheet_id = rc\.linked_sheet_id/.test(st), 'fallback row restricted to campaign worktable');
assert.ok(/r\.popularPurpose = dm\.matchedNormalIds\.has\('os:' \+ r\.orderId\)/.test(routes) && /delete r\.phone8/.test(routes), 'direct rows get the shared purpose marker; full phone stripped');
const html2 = ctx._campDirectTable({ countable: true, totalDirect: 1, rows: [{ submittedAt: null, name: 'a', phone4: '1', product: '', rowSeq: null, source: 'link', popularPurpose: true }] });
assert.ok(/🔥 인기상품목적 참여건/.test(html2), 'badge rendered');

console.log('directPurchaseParticipantRows: passed');
