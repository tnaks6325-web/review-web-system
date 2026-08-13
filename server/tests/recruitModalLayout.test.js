/**
 * Shared recruitment editor runtime layout guard.
 *
 * This protects the approved compact-row editor from drifting back to the
 * earlier per-user drag-and-drop card layout. The test intentionally verifies
 * source structure because the editor is plain browser JavaScript.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const modal = read('frontend/js/recruit-modal.js');
const editor = read('frontend/js/index-recruit.js');

let count = 0;
function ok(label, condition) {
  assert(condition, label);
  count += 1;
  console.log(`  ✓ ${label}`);
}

function cssOf(name) {
  const start = modal.indexOf(`var ${name} = \``);
  assert(start >= 0, `${name} CSS를 찾지 못했습니다.`);
  const from = start + (`var ${name} = \``).length;
  const end = modal.indexOf('`;', from);
  assert(end > from, `${name} CSS가 닫히지 않았습니다.`);
  return modal.slice(from, end);
}

function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

ok('모달은 승인된 컴팩트 행 편집기 폭을 사용한다',
  /class="modal-box rf-box"[^>]*max-width:1020px/.test(modal));
ok('좌측은 드래그 레일이 아니라 3단계 고정 내비게이션이다',
  /class="rf-step-list"/.test(modal)
  && ['link', 'prod', 'cond'].every((key) => modal.includes(`data-rf-step="${key}"`))
  && ['fee', 'work'].every((key) => !modal.includes(`data-rf-step="${key}"`))
  && !modal.includes('onclick="RecruitModal.preset'));
ok('스크롤 중 현재 단계를 표시하고 클릭하면 중앙 편집 영역을 스크롤한다',
  /data-rf-step/.test(modal)
  && /scrollRailToCard/.test(modal)
  && /setActiveRail/.test(modal)
  && /if \(act === 'pub' \|\| act === 'fee'\) act = 'link'/.test(modal)
  && /if \(act === 'work'\) act = 'prod'/.test(modal)
  && /body\.rf-recruit-modal-open\{overflow:hidden\}/.test(modal)
  && /document\.body\.classList\.add\("rf-recruit-modal-open"\)/.test(editor)
  && /document\.body\.classList\.remove\("rf-recruit-modal-open"\)/.test(editor)
  && /body\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: 'smooth' \}\)/.test(modal));
ok('자동점검은 좌측 하단에 있으며 본문 단계가 아니다',
  /id="rf_side_audit"/.test(modal)
  && modal.indexOf('id="rf_side_audit"') < modal.indexOf('class="rf-main"')
  && /id="rf_part_check"/.test(modal));
ok('제목 오른쪽의 상태 버튼은 기존 저장 select와 동기화된다',
  /id="rf_status_buttons"/.test(modal)
  && /data-rf-status="draft"/.test(modal)
  && /data-rf-status="active"/.test(modal)
  && /data-rf-status="closed"/.test(modal)
  && /function syncStatusButtons/.test(modal)
  && /function setStatus/.test(modal)
  && /syncStatusButtons\(\)/.test(editor));
ok('중앙 편집부는 사후 DOM 이동 없이 시안 순서로 직접 렌더링된다',
  !modal.includes('data-sec="info"')
  && modal.indexOf('data-sec="pub"') < modal.indexOf('data-sec="link"')
  && modal.indexOf('data-sec="link"') < modal.indexOf('data-sec="fee"')
  && modal.indexOf('data-sec="fee"') < modal.indexOf('data-sec="prod"')
  && modal.indexOf('data-sec="prod"') < modal.indexOf('data-product-settings')
  && modal.indexOf('data-product-settings') < modal.indexOf('id="rf_work_section"')
  && modal.indexOf('id="rf_work_section"') < modal.indexOf('data-sec="cond"')
  && /data-product-settings/.test(modal)
  && /id="rf_delivery_toggle"/.test(modal)
  && /rf-parity-time-row/.test(modal)
  && /rf-parity-date-row/.test(modal)
  && !/function hydrateParityControls/.test(modal)
  && !/function placeFinalSections/.test(modal)
  && !/\.appendChild\(settings\)/.test(modal)
  && !/\.insertBefore\(publish, link\)/.test(modal)
  && !/\.rf-card\[data-sec="(?:link|fee|prod|work|cond)"\]\{order:/.test(modal)
  && !/\.rf-publish-card\{order:/.test(modal)
  && !/RecruitModal\.syncProductSettings\(on\)/.test(editor));
ok('브라우저가 템플릿의 모달 셸을 잘못 분리해도 미리보기·푸터를 원래 레이아웃으로 복구한다',
  /function normalizeShellLayout/.test(modal)
  && /split\.appendChild\(side\)/.test(modal)
  && /editor\.appendChild\(compactFooter\)/.test(modal)
  && /box\.appendChild\(legacyFooter\)/.test(modal));
ok('실제 런타임 중앙 편집부는 승인 시안의 editor/section/row-form 마크업을 직접 사용한다',
  /class="rf-main rf-compact-main"/.test(modal)
  && /class="editor-head"/.test(modal)
  && /class="title-control-bar"/.test(modal)
  && /class="section" data-sec="link"/.test(modal)
  && /class="row-form"/.test(modal)
  && /class="form-row"/.test(modal)
  && /class="form-label"/.test(modal)
  && /class="form-control"/.test(modal));
const compactEditorStart = modal.indexOf('<div class="rf-main rf-compact-main">');
const legacyRootClose = modal.indexOf('</div></template><!-- /legacy rf-main -->');
ok('이전 마크업 템플릿은 새 컴팩트 편집기 전에 정확히 닫혀 실제 입력 DOM을 만든다',
  legacyRootClose > modal.indexOf('<template id="rf_legacy_card_editor_markup">')
  && legacyRootClose < compactEditorStart);
ok('최종 행형 문법은 승인 시안의 25/75 열과 동일 높이의 입력·버튼을 쓴다',
  /\.rf-hrow\{grid-template-columns:minmax\(112px,25%\) minmax\(0,75%\)/.test(modal)
  && /\.rf-main \.rform-input\{min-height:26px;height:26px/.test(modal)
  && /\.rchan-btn,#recruitModal \.rf-pm-btn,#recruitModal \.rf-status-buttons button\{min-height:26px/.test(modal));
ok('옵션 URL·주말 제외·구매시간·현금영수증·기간별 리뷰비 필드는 보존한다',
  ['rf-opt-url', 'rf_skip_weekends', 'rf_free_time_toggle', 'rf_cash_receipt_required', 'rf_fee_sched_on']
    .every((token) => modal.includes(token)));
ok('작업내용 3종의 이미지 첨부 입력은 그대로 유지한다',
  ['rf_wd_inflow', 'rf_wd_review', 'rf_wd_notes', 'rf_ig_inflow', 'rf_ig_review', 'rf_ig_notes']
    .every((id) => modal.includes(id)));
ok('시안의 상품 URL·단일 선택·혼합 조합·토글 상태 DOM을 런타임이 직접 가진다',
  /class="form-row product-main-url"/.test(modal)
  && /id="rf_product_main_url"/.test(modal)
  && /id="rf_mixed_review_composer"/.test(modal)
  && /id="rf_review_mix_rows"/.test(modal)
  && /id="rf_cashrcpt_toggle"/.test(modal)
  && /id="feeScheduleState"/.test(modal)
  && /id="weekendNotice"/.test(modal)
  && /id="accountNote"/.test(modal)
  && /function rfSetWeekendPolicy/.test(editor)
  && /function rfSetMultiAccount/.test(editor));
ok('모달 CSS의 중괄호가 균형을 이뤄 브라우저 파싱이 끊기지 않는다',
  ['SHELL_CSS', 'CSS'].every((name) => {
    const css = withoutComments(cssOf(name));
    return (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length;
  }));

console.log(`\n✅ recruitModalLayout: ${count}개 통과`);
