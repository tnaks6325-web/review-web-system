/*
 * 기존(참여형 이전) 모집공고도 새 컴팩트 편집기에서 값이 사라지지 않아야 한다.
 * 이 테스트는 서버 상세 응답과 프런트 복원·저장 계약을 함께 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FRONT = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'index-recruit.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'src', 'routes', 'campaign.routes.js'), 'utf8');

const saveStart = FRONT.lastIndexOf('const partEl = document.getElementById("rf_participation")');
assert.ok(saveStart >= 0, '참여형 저장 경로를 찾을 수 없습니다.');
const save = FRONT.slice(saveStart, saveStart + 12000);

assert.match(
  FRONT,
  /Object\.prototype\.hasOwnProperty\.call\(c, "work_detail"\)/,
  'public detail payload must not be treated as an editable campaign'
);
assert.match(
  FRONT,
  /if \(_recruitEditId && window\._recruitEditLoadFailed\) \{[\s\S]{0,360}?return;/,
  'saving an existing campaign must stop after detail loading fails'
);

assert.ok(
  !/if \(c\.participation_mode\) \{[\s\S]{0,9000}renderOptRowsWithProduct/.test(FRONT),
  '기존 공고도 상품·옵션 복원이 participation_mode 조건에 막히면 안 됩니다.'
);
assert.match(
  FRONT,
  /renderOptRowsWithProduct\(json\.options \|\| \[\], wd\.productLines, c\)/,
  '기존 공고의 총모집·일건수 보정값까지 상품 행 복원에 전달해야 합니다.'
);
assert.match(
  FRONT,
  /setV\("rf_product_url", c\.landing_url \|\| ""\)/,
  '기존 상품 메인 URL을 새 상품 URL 입력값에 복원해야 합니다.'
);
assert.match(
  FRONT,
  /setV\("rf_thumb_url", c\.thumbnail_url \|\| ""\)/,
  '기존 공고 썸네일 URL을 새 입력란에 복원해야 합니다.'
);
assert.ok(
  !/document\.getElementById\("rf_notes"\)\.value\s*=\s*c\.notes/.test(FRONT),
  'the retired public-note field must be optional so it cannot stop compact legacy-value restoration'
);
assert.match(
  FRONT,
  /const notesEl = document\.getElementById\("rf_notes"\); if \(notesEl\) notesEl\.value = c\.notes \|\| "";/,
  'legacy public notes must be restored only when the active layout renders that field'
);
/* ★ 2026-08-19: 종전엔 칸이 없어도 ''를 보내 서버 COALESCE 가 '지움'으로 받았다(저장할 때마다
   유의사항 삭제) → 입력칸이 있는 화면에서만 전송한다(미전송 = 서버가 기존 값 유지). */
assert.match(
  FRONT,
  /const _notesEl = document\.getElementById\("rf_notes"\);\s*\n\s*if \(_notesEl\) payload\.notes = String\(_notesEl\.value \|\| ""\)\.trim\(\);/,
  'saving the compact layout must omit the retired public-note field instead of blanking it'
);
assert.ok(
  !/notes:\s+String\(document\.getElementById\("rf_notes"\)/.test(FRONT),
  'the payload literal must not send an empty note when the field is absent'
);
assert.match(
  FRONT,
  /onWorkdesk[\s\S]{0,160}\? '\/api\/trackb\/campaigns' : '\/api\/campaign\/admin'/,
  '작업보드에서 상세 조회 설정이 누락돼도 공개 상세 API로 내려가면 안 됩니다.'
);
assert.match(
  save,
  /const preserveLegacyCampaign = Boolean\(_recruitEditId && window\._recruitEditLoaded\?\.participation_mode === false\)/,
  '기존 공고 저장 시 participation_mode를 유지하는 보호 장치가 필요합니다.'
);
assert.match(
  save,
  /if \(isPart \|\| preserveLegacyCampaign\) \{/,
  '기존 공고도 새 편집기에서 보이는 값은 저장할 수 있어야 합니다.'
);
assert.match(
  save,
  /if \(!preserveLegacyCampaign\) payload\.participation_mode = isPart;/,
  '기존 공고 저장 시 participation_mode를 무조건 덮어쓰면 안 됩니다.'
);
assert.match(
  SERVER,
  /const options = await _loadOptionsRaw\(pool, id\);/,
  '기존 공고도 관리자 상세 응답에서 저장된 옵션 행을 받아야 합니다.'
);

console.log('✅ recruitLegacyRestoreContract: legacy restore contract is present');
