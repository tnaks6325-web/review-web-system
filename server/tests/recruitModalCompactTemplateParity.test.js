/**
 * Approved compact-row recruitment editor contract.
 *
 * This is a source-level guard because the editor is assembled by a browser
 * JavaScript module.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const recruit = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-recruit.js'), 'utf8');

/* ★★ 데스크톱 폭 = **1124px (사용자 확정 2026-08-19)**.
   ⚠ 이 숫자를 바꾸려면 **이 줄도 함께** 고쳐야 한다 — 그것이 이 검사의 목적이다(실수로 바뀌는 것을 잡는다).
   ⚠ 그동안 이 자리가 1020 으로 굳어 있어(문서 1280 · 가드 1020 · 코드 1124 로 셋이 갈림) 가드가
     상시 빨간 상태였고, 그 더미에 진짜 회귀가 묻혔다. 값이 바뀔 땐 반드시 같이 갱신할 것. */
const RF_DESKTOP_WIDTH = 1124;
{
  const box = (/class="modal-box rf-box"[^>]*style="([^"]*)"/.exec(modal) || [, ''])[1];
  const w = Number((/max-width:(\d+)px/.exec(box) || [, ''])[1]);
  assert(w === RF_DESKTOP_WIDTH,
    `모집공고 편집 팝업의 데스크톱 폭은 확정값 ${RF_DESKTOP_WIDTH}px 이어야 합니다(현재 ${w || '없음'}px). ` +
    '의도한 변경이라면 이 테스트의 RF_DESKTOP_WIDTH 도 함께 고치세요.');
  assert(/width:\d+%/.test(box) && /max-height:\d+vh/.test(box),
    '좁은 화면·낮은 화면에서 접히도록 %·vh 상한이 함께 있어야 합니다.');
}

assert(!/class="rf-rail"/.test(modal) && !/data-rf-step=/.test(modal),
  '좌측 단계 사이드바는 렌더링하지 않아야 합니다.');
assert(!modal.includes('작업보드와 공고의 기준 정보 및 입금 기준을 먼저 확인합니다.'),
  '중앙 상단의 연결·기본 안내 문구는 없어야 합니다.');
const compact = modal.slice(modal.indexOf('class="rf-main rf-compact-main"'));
assert(compact.indexOf('startup-setting-bar') < compact.indexOf('id="editorScroller"'),
  '작업 시작 설정 바는 스크롤 영역 위에 고정되어야 합니다.');
assert(compact.indexOf('id="editorScroller"') < compact.indexOf('for="rf_title"'),
  '공고 제목 행은 스크롤 영역 안에 있어야 합니다.');
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
assert(['다음날에 더하기', '남은 날에 나눠담기', '종료일 뒤에 붙이기']
  .every((label) => modal.includes(label)),
  '모집이월 방식은 세 가지 선택지를 제공해야 합니다.');
assert(/rfCarrySet\("extend", \{ silent: true \}\)/.test(recruit),
  '신규 공고의 모집이월 기본값은 종료일 뒤에 붙이기여야 합니다.');
assert(!modal.includes('마감 · 보류 · 인원 제한 세부 설정'),
  '효용이 낮은 묶음형 세부설정은 노출하지 않아야 합니다.');

console.log('recruitModalCompactTemplateParity: passed');
