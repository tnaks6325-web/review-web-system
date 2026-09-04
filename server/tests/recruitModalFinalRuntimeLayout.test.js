/** Current shared recruitment editor layout regression guard. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');

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
assert(/class="section rf-public-settings"/.test(compact)
  && /class="section" data-sec="link"/.test(compact)
  && /class="section" data-sec="prod"/.test(compact),
  '공개 설정·기본 설정·진행상품의 현재 섹션 구조를 유지해야 합니다.');
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
  const w = assetTag(workdesk, file), a = assetTag(admin, file);
  assert(w, `workdesk should load ${file}.`);
  assert(a, `admin should load ${file}.`);
  assert.strictEqual(w, a, `${file}: 두 화면이 서로 다른 버전을 로드하면 안 됩니다.`);
});

console.log('recruitModalFinalRuntimeLayout: passed');
