/**
 * 모집공고 제목 수정 → 리뷰 내역이 "변경전 제목 / 변경후 제목" 두 장으로 쪼개지던 회귀 가드.
 * (2026-08-19 사용자 신고 — 8/15모기위키 모기기피제)
 *
 * 원인 두 겹을 각각 고정한다:
 *   ① 짝짓기 키  — 참여형(무시트) 주문 원장 좌표는 `campaign:<공고ID>`라 작업표(review_index)
 *      좌표와 영원히 일치하지 않는다 → **주문 id**(campaign_participants.order_submission_id)로
 *      dedup 해야 한다. 이 키는 제목·탭명·행번호가 바뀌어도 변하지 않는다.
 *   ② 카드 제목  — 병합 카드가 rc.title(실시간)을, 색인행 카드가 tab_configs.display_name
 *      (접수 시점 고정)을 쓰면 제목 수정 순간 한 참여가 두 이름으로 갈린다.
 *
 * 실행: node tests/reviewerHistoryTitleSplit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ── pool 모킹 (search.service 로드 전에 require 캐시 주입) ──
const poolPath = require.resolve('../src/db/pool');
const captured = { queries: [] };
let seenRows = [];      // 위치키 dedup 재료(review_index, row_index IS NOT NULL)
let osidRows = [];      // 주문 id dedup 재료(campaign_participants ⨝ review_index)
let orderRows = [];     // 병합 대상(order_submissions)
let osidFails = false;  // 주문 id 조회 실패(fail-soft 확인용)

const fakePool = {
  query: async (sql, params) => {
    captured.queries.push({ sql, params });
    if (/FROM reviewers/.test(sql)) return { rows: [] };
    if (/set_limit/.test(sql)) return { rows: [] };
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: '0', built_at: null }] };
    if (/FROM review_submissions/.test(sql)) return { rows: [] };
    if (/FROM campaign_participants/.test(sql)) {
      if (osidFails) throw new Error('relation "campaign_participants" does not exist');
      return { rows: osidRows };
    }
    if (/FROM order_submissions/.test(sql)) return { rows: orderRows };
    if (/FROM review_index/.test(sql) && /row_index IS NOT NULL/.test(sql)) return { rows: seenRows };
    if (/FROM review_index/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
};
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool };

const { searchByName } = require('../src/services/search.service');

/** 참여형(무시트) 주문 — 원장 좌표는 campaign:*, sheetRow 는 작업표 seq(좌표계가 다르다) */
function campaignOrderRow(over = {}) {
  return {
    id: 'os-camp-1', sheetId: 'campaign:c1', tabName: 'campaign:c1', gid: null, sheetRow: 5,
    mirrorStatus: 'written', recipientName: '박진회', displayNameTC: '모기위키 모기기피제',
    campaignName: '모기위키 모기기피제', manager: null, reviewType: null, deliveryType: null,
    incomeType: null, isClosed: false, ...over,
  };
}

function orderQuerySql() {
  const q = captured.queries.find(x => /FROM order_submissions/.test(x.sql));
  return q ? q.sql : '';
}

async function run() {
  // ── 1) 주문 id 로 작업표 행이 확인되면 병합하지 않는다(제목·탭명 무관) ──
  captured.queries = []; osidFails = false;
  seenRows = [];                                  // 위치키로는 절대 못 맞는 상황(참여형)
  osidRows = [{ osid: 'os-camp-1' }];             // 작업표에 이미 그 주문이 붙어 있다
  orderRows = [campaignOrderRow()];
  const r1 = await searchByName('박진회', '12345678', { includeSubmitted: true });
  assert.equal(r1.results.length, 0,
    '1: 작업표에 이미 있는 참여형 주문은 병합 카드로 다시 나오면 안 된다(제목 수정과 무관)');
  console.log('  1. 주문 id dedup — 참여형 중복 차단 ✓');

  // ── 2) 주문 id 는 문자열/UUID 어느 표기든 같은 건으로 본다 ──
  captured.queries = [];
  osidRows = [{ osid: 'OS-CAMP-1' }];             // 대소문자만 다른 값은 **다른 주문**이다
  orderRows = [campaignOrderRow()];
  const r2 = await searchByName('박진회', '12345678', { includeSubmitted: true });
  assert.equal(r2.results.length, 1, '2: 다른 주문 id 는 dedup 대상이 아니다(과잉 제거 금지)');
  console.log('  2. 다른 주문은 그대로 노출 ✓');

  // ── 3) 주문 id 조회 실패 = fail-soft(병합 자체는 계속) ──
  captured.queries = []; osidFails = true;
  osidRows = []; orderRows = [campaignOrderRow()];
  const r3 = await searchByName('박진회', '12345678', { includeSubmitted: true });
  assert.equal(r3.results.length, 1,
    '3: dedup 조회 실패는 병합을 죽이지 않는다(중복 노출 > 참여 실종)');
  osidFails = false;
  console.log('  3. dedup 조회 실패 fail-soft ✓');

  // ── 4) 위치키 dedup(시트 기반 주문)은 종전 그대로 ──
  captured.queries = [];
  osidRows = [];
  seenRows = [{ sheetId: 'S', tabName: '탭', rowIndex: 7 }];
  orderRows = [campaignOrderRow({ id: 'os-sheet-1', sheetId: 'S', tabName: '탭', sheetRow: 7 })];
  const r4 = await searchByName('박진회', '12345678', { includeSubmitted: true });
  assert.equal(r4.results.length, 0, '4: 시트 기반 주문의 위치키 dedup 무회귀');
  console.log('  4. 위치키 dedup 무회귀 ✓');

  // ── 5) 주문 id dedup 은 "이 리뷰어에게 실제로 보이는 행"만 인정한다 ──
  const sqlOsid = captured.queries.length
    ? (captured.queries.find(x => /FROM campaign_participants/.test(x.sql)) || {}).sql : '';
  // (4번 케이스에서도 조회는 발행된다)
  assert.ok(/JOIN review_index ri/.test(sqlOsid || ''),
    '5: review_index 와 조인해야 화면에서 사라지는 참여가 생기지 않는다');
  assert.ok(/ri\.phone8 = ANY\(\$1\)/.test(sqlOsid || ''),
    '5: 리뷰어 phone8 스코프 — 남의 작업표 행으로 내 카드를 지우지 않는다');
  assert.ok(/cp\.deleted_at IS NULL/.test(sqlOsid || ''),
    '5: 삭제된 작업표 줄은 dedup 근거가 될 수 없다');
  assert.ok(/ri\.row_index = cp\.seq/.test(sqlOsid || ''),
    '5: 작업표 seq = 색인 row_index 좌표 계약');
  console.log('  5. dedup 조회 스코프 계약 ✓');

  // ── 6) 카드 제목 = **지금 적용된 공고 제목** 우선(색인행 카드와 같은 문자열) ──
  const sqlOrder = orderQuerySql();
  assert.ok(/COALESCE\(NULLIF\(rc\.title, ''\), NULLIF\(wt\.display_name, ''\)/.test(sqlOrder),
    '6: 병합 카드 제목은 지금 적용된 공고 제목이 먼저다(사용자 확정 2026-08-19)');
  assert.ok(/LEFT JOIN tab_configs wt[\s\S]{0,200}wt\.sheet_id = rc\.linked_sheet_id[\s\S]{0,80}wt\.tab_name = rc\.linked_tab_name/.test(sqlOrder),
    '6: 연결 작업표 탭 조인이 있어야 한다');
  console.log('  6. 카드 제목 단일 출처 ✓');

  // ── 7) 제목 기반 dedup(migration 120 짝)은 좌표 매칭으로도 성립해야 한다 ──
  assert.ok(/ri\.tab_name = rc\.title[\s\S]{0,400}ri\.sheet_id = rc\.linked_sheet_id[\s\S]{0,120}ri\.tab_name = rc\.linked_tab_name/.test(sqlOrder),
    '7: 제목 문자열이 바뀌어도 연결 작업표 좌표로 짝지어져야 한다(제목만 보면 수정 즉시 풀린다)');
  console.log('  7. 제목 변경 내성(좌표 매칭 병기) ✓');

  // ── 8) 색인행 카드도 **같은 출처**로 지금 적용된 공고 제목을 쓴다(사본 금지) ──
  //   접수 업서트의 display_name 은 blank-only 라 제목을 절대 안 따라간다 → 그 값만 쓰면
  //   같은 참여가 화면에서 옛 이름으로 남는다(사용자 확정으로 뒤집힌 지점).
  const orderRoutes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'order.routes.js'), 'utf8');
  assert.ok(/display_name\s*=\s*COALESCE\(NULLIF\(tab_configs\.display_name,''\),\s*EXCLUDED\.display_name\)/.test(orderRoutes),
    '8: 접수 업서트의 display_name 은 blank-only(제목을 따라가지 않는다) — 이 전제 위에서 아래를 요구한다');
  const searchSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'search.service.js'), 'utf8');
  const ctUses = (searchSrc.match(/campaignTitlesForTabs\(/g) || []).length;
  assert.ok(ctUses >= 2,
    '8: 본검색·폴백 **두 경로 모두** 공고 제목을 조회해야 한다(한쪽만 고치면 화면이 갈린다)');
  const ctApply = (searchSrc.match(/displayNameTC:\s*_ctMap\.get\(/g) || []).length;
  assert.ok(ctApply >= 2, '8: 조회만 하고 라벨에 안 쓰면 아무 일도 일어나지 않는다');
  assert.ok(/_ctMap\.get\(`\$\{row\.sheetId\} \$\{row\.tabName\}`\) \|\| row\.displayName/.test(searchSrc),
    '8: 미연결·조회 실패는 종전 탭 표시명으로 접는다(이름이 비면 안 된다)');
  console.log('  8. 색인행 카드도 같은 제목(단일 출처) ✓');

  console.log('✅ reviewerHistoryTitleSplit 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
