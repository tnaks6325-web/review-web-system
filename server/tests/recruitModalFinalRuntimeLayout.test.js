/**
 * Final runtime editor layout regression guard.
 *
 * The approved compact-row mockup must be the actual shared modal, not only a
 * standalone HTML artifact. This check protects the field IDs used by the
 * prefill/save path while asserting the approved information architecture.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');

function mustContain(fragment, message) {
  assert(modal.includes(fragment), message);
}

function mustNotContain(fragment, message) {
  assert(!modal.includes(fragment), message);
}

// A compact desktop editor: left step rail / editor / preview at a controlled width.
assert(/class="modal-box rf-box"[^>]*max-width:1124px/.test(modal),
  '최종 런타임 모달은 승인된 1124px 폭을 사용해야 합니다.');

// The rail is navigation, not a per-user drag-and-drop layout editor.
mustContain('class="rf-step-list"', '좌측 단계 목록이 있어야 합니다.');
mustContain('data-rf-step="link"', '연결·기본 단계가 있어야 합니다.');
mustContain('data-rf-step="prod"', '진행상품 단계가 있어야 합니다.');
mustContain('data-rf-step="cond"', '모집 조건 단계가 있어야 합니다.');
mustNotContain('data-rf-step="fee"', '리뷰비·입금은 연결·기본 단계 안에서 편집해야 합니다.');
mustNotContain('data-rf-step="work"', '작업내용은 진행상품·상품 정보 단계 안에서 편집해야 합니다.');
mustNotContain('onclick="RecruitModal.preset', '최종안의 단계 이동은 드래그 배치 프리셋을 노출하지 않아야 합니다.');
mustNotContain('class="rf-rhnd"', '최종안의 단계 목록은 드래그 핸들을 렌더하지 않아야 합니다.');

// Product settings are one continuous section, rather than a separate product-info card.
mustNotContain('data-sec="info"', '상품 정보는 진행상품 아래의 같은 섹션에 포함되어야 합니다.');
assert(modal.indexOf('data-sec="prod"') < modal.indexOf('id="rf_review_type"'),
  '리뷰 타입은 진행상품 뒤에 이어지는 상품 설정 흐름에 있어야 합니다.');

// Status is selected at the title row while the legacy select remains as the save contract.
mustContain('id="rf_status_buttons"', '제목 입력란 오른쪽에 상태 버튼 묶음이 있어야 합니다.');
mustContain('data-rf-status="draft"', '임시저장 상태 버튼이 있어야 합니다.');
mustContain('data-rf-status="active"', '모집중 상태 버튼이 있어야 합니다.');
mustContain('data-rf-status="closed"', '마감 상태 버튼이 있어야 합니다.');
mustContain('id="rf_status"', '저장 계약을 위한 상태 필드는 유지해야 합니다.');

// Automatic checks live at the bottom of the step rail, not as a separate editor step.
mustContain('id="rf_side_audit"', '좌측 하단 자동점검 영역이 있어야 합니다.');
assert(modal.indexOf('id="rf_side_audit"') < modal.indexOf('class="rf-main"'),
  '자동점검은 입력 영역보다 앞선 좌측 레일에 배치되어야 합니다.');

// Both shared-modal surfaces must request the released asset URL once anew.
['workdesk', 'admin'].forEach((surface) => {
  const html = surface === 'workdesk' ? workdesk : admin;
  assert(html.includes('js/recruit-modal.js?v=20260817-card-module-fix-c116'), `${surface} should request the released modal asset.`);
  assert(html.includes('js/campaign-cards.js?v=20260817-popular-priority-c118'), `${surface} should request the released card asset.`);
  assert(html.includes('js/index-recruit.js?v=20260817-popular-priority-c119'), `${surface} should request the released controller asset.`);
});

console.log('recruitModalFinalRuntimeLayout: passed');
