/**
 * Approved compact-row recruitment editor contract.
 *
 * The live modal deliberately shares its desktop geometry and navigation
 * grouping with the approved compact-rows reference.  This is a source-level
 * guard because the editor is assembled by a browser JavaScript module.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const recruit = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-recruit.js'), 'utf8');

assert(/class="modal-box rf-box"[^>]*max-width:1020px/.test(modal),
  '모집공고 편집 팝업은 승인 시안의 1020px 데스크톱 폭을 사용해야 합니다.');

['link', 'prod', 'cond'].forEach((step) => {
  assert(modal.includes(`data-rf-step="${step}"`), `${step} 단계가 좌측 레일에 있어야 합니다.`);
});
['fee', 'work'].forEach((step) => {
  assert(!modal.includes(`data-rf-step="${step}"`), `${step}은 별도 좌측 단계가 아니어야 합니다.`);
});

assert(modal.includes('진행상품 · 상품 정보'),
  '진행상품과 상품 정보는 하나의 좌측 단계로 표기해야 합니다.');
assert(/if \(act === 'pub' \|\| act === 'fee'\) act = 'link'/.test(modal),
  '입금 영역을 지날 때 좌측 단계는 연결·기본으로 유지해야 합니다.');
assert(/if \(act === 'work'\) act = 'prod'/.test(modal),
  '작업내용을 지날 때 좌측 단계는 진행상품·상품 정보로 유지해야 합니다.');
assert(/#recruitModal \.rf-hrow\{grid-template-columns:minmax\(112px,25%\) minmax\(0,75%\)/.test(modal),
  '승인 시안의 25/75 라벨·입력 열 비율을 사용해야 합니다.');
assert(/#recruitModal \.rf-compact-main \.form-control>input:not\(\[type=checkbox\]\),#recruitModal \.rf-compact-main \.form-control>textarea\{[^}]*height:26px/.test(modal),
  '입력란은 승인 시안의 30px 높이를 사용해야 합니다.');
assert(/#recruitModal \.rf-compact-main \.choice,#recruitModal \.rf-compact-main \.square-toggle button\{min-height:26px/.test(modal),
  '선택 버튼은 승인 시안의 29px 높이를 사용해야 합니다.');
assert(/rf-parity-time-row/.test(modal) && /rf-parity-date-row/.test(modal),
  '구매시간대와 모집 시작일은 승인 시안의 행 위치로 렌더링되어야 합니다.');
assert(['상품 메인 URL', '공고 썸네일 URL', '모집이월 방식', '입금명', '자율리뷰']
  .every((label) => modal.includes(label)),
  '승인된 라벨은 런타임 모달에 모두 남아 있어야 합니다.');
assert((recruit.match(/refreshLinkedReferences/g) || []).length >= 3,
  '작업오더 프리필 후 읽기 전용 연결값을 다시 그려야 합니다.');

console.log('recruitModalCompactTemplateParity: passed');
