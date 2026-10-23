/** Current shared recruitment editor layout regression guard. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');
// 옛 관리자 대시보드 폐기(결정 267) — admin.html 과의 버전 일치 검사는 빠지고 작업보드 로드만 고정한다.

const compactStart = modal.indexOf('<div class="rf-main rf-compact-main">');
const compactEnd = modal.indexOf('<!-- /rf-compact-main -->', compactStart);
assert(compactStart > 0 && compactEnd > compactStart, '실제 컴팩트 편집기 범위를 찾을 수 있어야 합니다.');
const compact = modal.slice(compactStart, compactEnd);

assert(/class="modal-box rf-box"[^>]*max-width:1124px/.test(modal),
  '최종 런타임 모달은 승인된 1124px 폭을 사용해야 합니다.');
assert(!/class="rf-rail\b/.test(compact) && !/data-rf-step=/.test(compact),
  '긴 설정 흐름에서 제거한 좌측 단계 레일이 실제 편집기에 되살아나면 안 됩니다.');
assert(/class="editor"/.test(compact) && /id="editorScroller" class="compact-editor-scroller"/.test(compact),
  '중앙 편집기와 독립 스크롤 영역을 유지해야 합니다.');
assert(/class="startup-setting-bar"/.test(compact) && /id="rf_startcheck"/.test(compact),
  '작업 시작 점검은 편집기 상단의 고정 요약으로 보여야 합니다.');
// 시안 3차(결정 274 · 사용자 확정 2026-10-22) — 진행상품은 「리뷰오더와 맞춰지는 항목」 안의 묶음이고, 참여형 전용 토글(data-part-only)을 그대로 단다
assert(/class="section rf-order-own" data-sec="order"/.test(compact)
  && /class="section rf-sync-box" data-sec="link"/.test(compact)
  && /class="rf-sync-sub" data-sec="prod" data-part-only/.test(compact)
  && /class="section rf-public-settings" data-sec="pub"/.test(compact),
  '고유 항목·맞춰지는 항목(진행상품)·리뷰웹 전용 값의 현재 섹션 구조를 유지해야 합니다.');
assert(/id="rf_status" hidden/.test(compact), '저장 계약용 상태 필드는 숨은 필드로 유지해야 합니다.');
assert(/<footer class="footer modal-footer">/.test(compact)
  && /id="recruitSaveBtnInline"/.test(compact),
  '편집기 하단의 인라인 저장 푸터를 유지해야 합니다.');

const sideStart = modal.indexOf('<aside class="rf-side">', compactEnd);
const sideEnd = modal.indexOf('</aside>', sideStart);
const side = modal.slice(sideStart, sideEnd);
assert(sideStart > compactEnd && /id="rf_preview_listcard"/.test(side) && /id="rf_preview_card"/.test(side),
  '우측에는 목록 카드와 참여 후 화면의 실시간 미리보기가 함께 있어야 합니다.');

const assetTag = (html, file) => {
  const m = new RegExp('<script src="js/' + file.replace('.', '\\.') + '(\\?[^\"]*)?"').exec(html);
  return m ? (m[1] || '') : null;
};
['recruit-modal.js', 'campaign-cards.js', 'index-recruit.js'].forEach(file => {
  const w = assetTag(workdesk, file);
  assert(w !== null, `workdesk should load ${file}.`);
});

console.log('recruitModalFinalRuntimeLayout: passed');
