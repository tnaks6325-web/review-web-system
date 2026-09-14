const fs = require('fs');
const path = require('path');
const assert = require('assert');

const recruitJs = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-recruit.js'), 'utf8');
const modalJs = fs.readFileSync(path.join(__dirname, '../../frontend/js/recruit-modal.js'), 'utf8');

assert.match(recruitJs, /thumbUrl\.addEventListener\("paste", _pasteCampThumbImage\)/,
  '썸네일 URL 입력창에 이미지 붙여넣기 핸들러를 연결해야 합니다.');
assert.match(recruitJs, /entry\.kind === "file" && \/\^image\\\//,
  '클립보드의 이미지 파일만 업로드 대상으로 골라야 합니다.');
assert.match(recruitJs, /if \(!item\) return;[\s\S]*?e\.preventDefault\(\);/,
  '텍스트 붙여넣기는 유지하고 이미지가 있을 때만 기본 동작을 막아야 합니다.');
assert.match(recruitJs, /_uploadCampThumbFile\(file\)/,
  '붙여넣은 이미지는 파일 선택과 같은 업로드 경로를 사용해야 합니다.');
assert.match(recruitJs, /if \(input\) input\.value = url;/,
  '업로드된 이미지 URL을 썸네일 URL 입력창에 표시해야 합니다.');
assert.match(recruitJs, /5 \* 1024 \* 1024/,
  '붙여넣기 업로드에도 5MB 제한을 유지해야 합니다.');
assert.match(modalJs, /복사한 이미지를 입력창에 Ctrl\+V 하세요/,
  '모집공고 설정에 이미지 붙여넣기 안내를 표시해야 합니다.');

console.log('\n✅ recruitThumbnailPaste: 7개 통과');
