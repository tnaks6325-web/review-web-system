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

// ★★ 캐시버스팅 문자열(`?v=…`)을 **정확히** 고정하지 않는다 — 그건 배포할 때마다 반드시 깨지도록
//   설계된 검사라, 이 파일의 진짜 검사(레일 배치 등)까지 상시 빨간 상태에 함께 묻힌다.
//   대신 더 강한 것을 고정한다: **두 화면이 같은 버전의 같은 에셋을 로드한다**(한쪽만 갱신되면 잡힌다).
// ★ 반드시 <script src> 태그에서만 읽는다 — 주석·설명문에 적힌 파일명이 대신 잡히면 거짓 불일치가 난다.
const assetTag = (html, file) => {
  const m = new RegExp('<script src="js/' + file.replace('.', '\\.') + '(\\?[^"]*)?"').exec(html);
  return m ? (m[1] || '') : null;
};
['recruit-modal.js', 'campaign-cards.js', 'index-recruit.js'].forEach((file) => {
  const w = assetTag(workdesk, file), a = assetTag(admin, file);
  assert(w, `workdesk should load ${file}.`);
  assert(a, `admin should load ${file}.`);
  assert.strictEqual(w, a, `${file}: 두 화면이 서로 다른 버전을 로드하면 한쪽만 옛 모달로 뜬다 (${w} ≠ ${a})`);
});

console.log('recruitModalFinalRuntimeLayout: passed');
