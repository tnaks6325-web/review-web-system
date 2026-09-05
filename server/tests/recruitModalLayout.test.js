/** Shared compact recruitment editor runtime layout guard. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const modal = read('frontend/js/recruit-modal.js');
const editor = read('frontend/js/index-recruit.js');
let count = 0;
const ok = (label, condition) => { assert(condition, label); count++; console.log('  ✓ ' + label); };

function cssOf(name) {
  const start = modal.indexOf(`var ${name} = \``);
  assert(start >= 0, `${name} CSS를 찾지 못했습니다.`);
  const from = start + (`var ${name} = \``).length;
  const end = modal.indexOf('`;', from);
  assert(end > from, `${name} CSS가 닫히지 않았습니다.`);
  return modal.slice(from, end);
}
const withoutComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const compactStart = modal.indexOf('<div class="rf-main rf-compact-main">');
const compactEnd = modal.indexOf('<!-- /rf-compact-main -->', compactStart);
const compact = modal.slice(compactStart, compactEnd);

ok('실제 컴팩트 편집기 범위를 찾는다', compactStart > 0 && compactEnd > compactStart);
ok('모달은 중앙 편집기와 우측 미리보기의 2열 셸을 쓴다',
  /class="modal-box rf-box"[^>]*max-width:1124px/.test(modal)
  && /class="rf-split"/.test(modal)
  && /<aside class="rf-side">/.test(modal)
  && /#recruitModal \.rf-side\{width:309px/.test(modal));
ok('제거된 좌측 단계 레일은 실제 DOM에 없다',
  !/class="rf-rail\b/.test(compact) && !/data-rf-step=/.test(compact));
ok('편집기 자체 스크롤과 body 스크롤 잠금을 유지한다',
  /id="editorScroller" class="compact-editor-scroller"/.test(compact)
  && /body\.rf-recruit-modal-open\{overflow:hidden\}/.test(modal)
  && /document\.body\.classList\.add\("rf-recruit-modal-open"\)/.test(editor)
  && /document\.body\.classList\.remove\("rf-recruit-modal-open"\)/.test(editor));
ok('작업 시작 점검은 편집기 상단에 있다',
  /class="startup-setting-bar"/.test(compact) && /id="rf_startcheck"/.test(compact));
ok('상태 저장 계약은 숨은 select로 유지한다',
  /id="rf_status" hidden/.test(compact) && /function syncStatusButtons/.test(modal));
ok('시안 순서로 공개 설정·기본 설정·진행상품을 직접 렌더링한다',
  compact.indexOf('class="section rf-public-settings"') < compact.indexOf('data-sec="link"')
  && compact.indexOf('data-sec="link"') < compact.indexOf('data-sec="prod"')
  && !/data-sec="info"/.test(compact));
ok('중앙 편집부는 section/row-form/form-row 문법을 쓴다',
  /class="section" data-sec="link"/.test(compact)
  && /class="row-form"/.test(compact)
  && /class="form-row"/.test(compact)
  && /class="form-label"/.test(compact)
  && /class="form-control"/.test(compact));
ok('시트·탭은 숨은 호환 필드로만 유지한다',
  /<div class="sheetless-compat-fields" hidden><select id="rf_linked_campaign"/.test(compact)
  && /<select id="rf_linked_tab"/.test(compact));
ok('상품 메인 URL은 작업 종류 아래에서 직접 편집한다',
  compact.indexOf('product-work-type') < compact.indexOf('id="rf_product_main_url"')
  && compact.indexOf('id="rf_product_main_url"') < compact.indexOf('id="rf_opt_wrap"')
  && /<input id="rf_product_url" type="url"/.test(compact)
  && /landing\.value\s*=\s*String\(input\.value/.test(editor));
ok('혼합 리뷰 조합기는 리뷰 타입 행 안에 있다',
  /class="form-row rf-review-type-row"/.test(compact)
  && /id="rf_mixed_review_composer"/.test(compact)
  && /id="rf_review_mix_rows"/.test(compact));
ok('이월 배치 방식은 next/spread/extend 세 상태를 저장한다',
  /id="rf_carry_strategy"/.test(compact)
  && ['next', 'spread', 'extend'].every(v => compact.includes(`rfCarrySet('${v}')`))
  && /payload\.carry_strategy/.test(editor));
ok('옵션 URL·주말·구매시간·현금영수증·기간별 리뷰비 필드를 보존한다',
  ['rf-opt-url', 'rf_skip_weekends', 'rf_free_time_toggle', 'rf_cash_receipt_required', 'rf_fee_sched_on']
    .every(token => modal.includes(token)));
ok('작업내용 이미지 첨부 입력을 유지한다',
  ['rf_wd_review', 'rf_wd_notes', 'rf_ig_review', 'rf_ig_notes'].every(id => compact.includes(id)));
ok('미리보기는 목록 카드와 참여 후 화면을 함께 렌더링한다',
  /id="rf_preview_listcard"/.test(modal) && /id="rf_preview_card"/.test(modal)
  && /구매양식 제출까지/.test(modal));
ok('인라인 푸터에 저장 버튼이 있고 셸 복구도 같은 위치를 보장한다',
  /<footer class="footer modal-footer">/.test(compact)
  && /id="recruitSaveBtnInline"/.test(compact)
  && /function normalizeShellLayout/.test(modal)
  && /editor\.appendChild\(compactFooter\)/.test(modal));
ok('좁은 화면은 1열 폼으로 수렴한다',
  /@media \(max-width:780px\)[\s\S]*?#recruitModal \.rf-hrow\{grid-template-columns:1fr/.test(modal));
ok('모달 CSS 중괄호가 균형을 이룬다',
  ['SHELL_CSS', 'CSS'].every(name => {
    const css = withoutComments(cssOf(name));
    return (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length;
  }));

console.log(`\n✅ recruitModalLayout: ${count}개 통과`);
