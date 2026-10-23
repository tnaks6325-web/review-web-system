/**
 * 공고 창 시안 3차(결정 275 · 사용자 확정 2026-10-22 「1.나 2.가 3.가」) — 리뷰웹 모집공고 설정 창.
 *   체험단 종류 → 리뷰오더 고유 항목 → 리뷰오더와 맞춰지는 항목(양방향 · 진행상품/구매배송/리뷰작업내용) → 리뷰웹에서만 정하는 값.
 *   ★ 칸의 화면 뒤 이름(id)은 그대로다 — 옮긴 것은 줄의 자리뿐(프리필·저장·잠금이 그 이름으로 묶여 있다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-recruit.js'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'utf8');
const a = modal.indexOf('<div class="rf-main rf-compact-main">');
const compact = modal.slice(a, modal.indexOf('<!-- /rf-compact-main -->', a));

// ① 스크롤 영역 안의 여는·닫는 div 짝이 맞는다 — 하나라도 남으면 그 뒤 구역(리뷰웹 전용 값·리뷰가이드)이
//    스크롤 영역 밖으로 밀려 창에서 잘린다(2026-10-22 구조 변경 중 실제로 밟음 — 옛 자리에서는 브라우저가 무시해 안 보였다).
{
  const s = compact.indexOf('<div id="editorScroller"'), e = compact.indexOf('<footer class="footer modal-footer">');
  assert.ok(s > 0 && e > s);
  const body = compact.slice(s, e);
  const open = (body.match(/<div\b/g) || []).length, close = (body.match(/<\/div>/g) || []).length;
  assert.strictEqual(open, close, `스크롤 영역 div 짝: 여는 ${open} · 닫는 ${close}`);
  assert.strictEqual((body.match(/<section\b/g) || []).length, (body.match(/<\/section>/g) || []).length);
  // 리뷰웹 전용 구역과 리뷰가이드는 스크롤 영역(닫는 div) 앞에 있다
  assert.ok(body.indexOf('class="section rf-public-settings" data-sec="pub"') > 0 && body.indexOf('id="rf_wd_review"') > 0);
}
// ② 칸 자리 — 구역마다 들어갈 칸
const sec = (startMarker, endMarker) => compact.slice(compact.indexOf(startMarker), endMarker ? compact.indexOf(endMarker) : undefined);
{
  const own = sec('data-sec="order"', 'data-sec="link"');
  assert.ok(own.includes('id="rf_start_date"') && own.includes('id="rf_order_manager"'), '고유 항목 = 모집 시작일 · 리뷰오더 담당자(보기 전용)');
  const sync = sec('data-sec="link"', 'data-sec="pub"');
  for (const id of ['rf_prod_mode', 'rf_inflow_type_value', 'rf_review_type', 'rf_order_distribution', 'rf_product_url', 'rf_opt_rows', 'rf_thumb_url',
    'rf_channel', 'rf_delivery_type', 'rf_recall_courier', 'rf_time_range', 'rf_skip_weekends', 'rf_review_fee', 'rf_wd_review', 'rf_wd_notes']) assert.ok(sync.includes(`id="${id}"`), `맞춰지는 항목: ${id}`);
  const pub = sec('data-sec="pub"');
  for (const id of ['rf_title', 'rf_manager', 'rf_cash_receipt_required', 'rf_transfer_memo', 'rf_transfer_bank', 'rf_fee_sched_on', 'rf_chat_enabled',
    'rf_multi_account', 'rf_repurchase_days', 'rf_carry_strategy', 'rf_badge_input', 'rf_deadline']) assert.ok(pub.includes(`id="${id}"`), `리뷰웹 전용: ${id}`);
  // 진행상품 순서 — 작업 종류 → 유입방식 → 리뷰타입 → 투입방식 → 상품 메인 URL → 상품표
  const order = ['id="rf_prod_mode"', 'id="rf_inflow_type_value"', 'id="rf_review_type"', 'id="rf_order_distribution_row"', 'id="rf_product_main_url"', 'id="rf_opt_rows"'].map(m => sync.indexOf(m));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), JSON.stringify(order));
  // 참여형 전용 토글은 그대로 — 진행상품 묶음 · 리뷰가이드 묶음 · 안내배지 줄
  assert.match(compact, /class="rf-sync-sub" data-sec="prod" data-part-only/);
  assert.match(compact, /class="row-form rf-sync-work" data-part-only/);
  assert.match(compact, /<div class="form-row tall" data-part-only><span class="form-label">안내배지/);
  // 리뷰웹 담당자(만두/망고)와 리뷰오더 담당자는 뜻이 다르다 — 이름표로 갈라 둔다
  assert.match(pub, /리뷰웹 담당자/);
}
// ③ 양방향 표시 — 연결 공고에서만 · 리뷰웹 전용 줄(유형별 리뷰비·작업보드 표시명)에는 달지 않는다
assert.match(modal, /\.rf-sync-box\[data-linked="1"\] \.form-row:not\(\.rf-local\):not\(\.thumb-guide-row\):not\(#rf_workboard_display_name_row\)::after\{content:'양방향'/);
assert.match(compact, /class="form-row rf-local" id="rf_delivery_fee_row"/);
// ④ 열 때 채우고 새 공고에서 지운다 · 결정 279(사용자 확정 2026-10-23 「나」): 연결 공고도 모집 시작일은 여기서 정한다(종전 D5 잠금 해제)
{
  assert.match(editor, /_rfApplyOrderLink\(null, false\);/, '새 공고·다른 공고를 열 때 지난 연결 표시를 지운다');
  assert.match(editor, /_rfApplyOrderLink\(json && json\.orderInfo \|\| null, !!window\._rfBidirBase\);/);
  const fn = editor.slice(editor.indexOf('function _rfApplyOrderLink('), editor.indexOf('\n}\n', editor.indexOf('function _rfApplyOrderLink(')));
  assert.doesNotMatch(fn, /sBtn\.disabled = !!linked/, '연결 공고의 시작일을 잠그면 아무도 못 고친다(리뷰오더 시작일은 접수 뒤 고칠 수 없다)');
  assert.match(fn, /_renderStartDateBasisNote\(\);/, '누가 정한 날인지 한 줄');
  assert.match(fn, /escHtml\(info\.title/, '오더 제목은 이스케이프해서 그린다');
}
// ⑤ 서버 — 상세 응답에 연결 리뷰오더 안내를 더한다(가산 · 읽기만 · 조회 실패 = 없음)
assert.match(route, /\.\.\.\(orderInfo \? \{ orderInfo \} : \{\}\),/);
assert.match(route, /'id', 'title', 'manager_name', 'work_manager', 'product_distribution_mode', 'source_review_order_id', 'bidir_state',/);
assert.match(route, /SELECT MAX\(created_at\) AS at FROM work_order_shared_snapshots WHERE work_order_id = \$1/);
console.log('recruitModalV3Sections: passed');
