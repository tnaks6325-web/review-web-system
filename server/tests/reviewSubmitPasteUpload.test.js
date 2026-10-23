'use strict';
// 결정 263: 리뷰 제출 화면 사진 칸 3분할(PC: 좌 Ctrl+V · 중앙 끌어다 놓기 · 우 파일 추가) · Ctrl+V · 클릭/드래그와 같은 넣는 길 · 글자 붙여넣기 보존.
// 실행: node tests/reviewSubmitPasteUpload.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FE = path.join(__dirname, '..', '..', 'frontend');
const js = fs.readFileSync(path.join(FE, 'js', 'search-app.js'), 'utf8');
const css = fs.readFileSync(path.join(FE, 'css', 'search.css'), 'utf8');
const html = fs.readFileSync(path.join(FE, 'search.html'), 'utf8');
let passed = 0; const t = (n, f) => { f(); passed++; console.log('PASS ' + n); };
const grab = name => { const m = js.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')); assert.ok(m, name); return m[0]; };

t('붙여넣기는 클릭·드래그와 같은 함수로만 넣는다(형식·10MB·AI 사전확인 사본 0)', () => {
  const b = grab('_pasteInto');
  assert.match(b, /if \(z\.id === "dropZone"\) await addFiles\(files\);/);
  assert.match(b, /await _mrAddFiles\(Number\(m\[1\]\), files\)/);
  assert.match(b, /await _csAddFiles\(m\[1\], files\)/);
  assert.match(b, /const took = _pasteZoneFiles\(z\)\.length - before;\s*\n\s*if \(took > 0\) showToast\(`붙여넣은 사진 \$\{took\}장/, '성공 안내는 실제로 받아들여진 장수만');
  assert.ok(!/_pasteZoneId = /.test(b), '자동으로 고른 칸을 기억하지 않는다(한 칸에 계속 쌓이지 않게)');
  assert.ok(!/fileToBase64|S\.files\.push/.test(b), '붙여넣기 전용 저장 경로를 만들지 않는다');
  assert.match(grab('bindPasteUpload'), /_pasteInto\(z, imgs\);/, 'Ctrl+V 도 같은 길');
  assert.match(grab('_zonePasteFromClipboard'), /_pasteInto\(z, blobs\);/, '왼쪽 [Ctrl+V] 누르기도 같은 길');
});
t('3분할: 왼쪽 Ctrl+V = 선택+붙여넣기 · 오른쪽 파일 추가만 파일 탐색기 · 그 밖은 선택만 · 휴대폰 = 종전대로 바로 고르기', () => {
  const b = grab('_zoneTap');
  const i = b.indexOf('if (!_isPcPointer())'), j = b.indexOf('_pasteZoneId = z.id; _pastePaint();');
  assert.ok(i > 0 && j > i);
  assert.match(b.slice(i, j), /inp\.click\(\)/, '휴대폰 = 바로 고르기');
  const pc = b.slice(j);
  assert.match(pc, /if \(act === "file"\) \{ const inp = _zonePickerInput\(z\); if \(inp\) inp\.click\(\); \}/);
  assert.match(pc, /else if \(act === "paste"\) _zonePasteFromClipboard\(z\);/);
  assert.equal((pc.match(/inp\.click\(\)/g) || []).length, 1, 'PC 에서 파일 탐색기는 [파일 추가]만');
  assert.match(b, /if \(!cell && [^\n]*closest\("button"\)\) return;/, '사진 삭제(×)는 칸 클릭으로 처리하지 않는다');
  const split = grab('_dzSplitHtml');
  const order = ['data-act="paste"', 'ds-drop', 'data-act="file"'].map(x => split.indexOf(x));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], '좌 Ctrl+V · 중앙 끌어다 놓기 · 우 파일 추가');
  assert.ok(/<b>Ctrl\+V<\/b>/.test(split) && /<b>끌어다 놓기<\/b>/.test(split) && /<b>파일 추가<\/b>/.test(split));
  const htmlSplit = (html.match(/<div class="dz-split">[\s\S]*?<\/div><\/div>|<div class="dz-split">.*<\/button><\/div>/) || [''])[0];
  assert.ok(htmlSplit && htmlSplit.replace(/\s+/g, '') === split.match(/'([^']*)'/g).map(x => x.slice(1, -1)).join('').replace(/\s+/g, ''), '단건 칸(html)과 슬롯 칸(js)의 3분할 모양이 같다');
  assert.match(html, /<div id="dropZone" class="drop-zone" onclick="_zoneTap\(event,this\)">/);
  assert.equal((js.match(/class="mr-slot-dropzone" id="(?:mrDz_\$\{idx\}|csDz_\$\{slot\.key\})" onclick="_zoneTap\(event,this\)"/g) || []).length, 2);
  assert.equal((js.match(/\$\{_dzSplitHtml\(\)\}/g) || []).length, 2, '다건·슬롯 칸 둘 다 3분할');
  assert.match(css, /\.dz-split\{display:none\}[\s\S]*@media \(hover:hover\) and \(pointer:fine\)\{[\s\S]*?\.mr-slot-dropzone input\[type=file\]\{pointer-events:none\}[\s\S]*?\.dz-split\{display:grid;grid-template-columns:1fr 1fr 1fr/);
});
t('[Ctrl+V] 누르기 실패는 조용히 넘기지 않는다 — 미지원·권한 거절·사진 없음 각각 안내', () => {
  const b = grab('_zonePasteFromClipboard');
  assert.ok(/눌러서 붙여넣기를 못 해요/.test(b) && /클립보드 읽기를 막았어요/.test(b) && /클립보드에 사진이 없어요/.test(b));
});
t('사진이 없으면 가로채지 않는다 — preventDefault 는 사진 확인 뒤(비고란 글자 붙여넣기 보존)', () => {
  const b = grab('bindPasteUpload');
  const i = b.indexOf('if (!imgs.length) return;'), j = b.indexOf('e.preventDefault();');
  assert.ok(i > 0 && j > i);
});
t('보이는 단계 화면의 보이는 칸에서만 받는다', () => {
  assert.match(grab('_pasteZones'), /\.step-pane\.active[\s\S]*offsetParent[\s\S]*z\.offsetParent/);
  assert.match(grab('bindPasteUpload'), /if \(!_pasteZones\(\)\.length\) return;/);
});
t('구매양식 일괄 캡처 붙여넣기는 그 칸이 보일 때만 — 숨은 카드로 새지 않는다', () => {
  const b = js.slice(js.indexOf('function _batchMountDropzone'), js.indexOf('async function _batchTakeFiles'));
  assert.match(b, /if \(!_BATCH\) return;\s*\n\s*if \(!box\.isConnected \|\| !box\.offsetParent\) return;/);
});
t('대상 칸 = 고른 칸 → 없으면 비어 있는 첫 칸 → 없으면 첫 칸', () => {
  const sl = sub => ({ dataset: { submitted: sub ? '1' : '' } });
  const zones = [{ id: 'mrDz_0', offsetParent: 1, closest: () => sl(false) }, { id: 'mrDz_1', offsetParent: 1, closest: () => sl(false) },
    { id: 'csDz_receipt', offsetParent: 1, closest: () => sl(false) }];
  const ctx = { S: { files: [], filesByIdx: { 0: [1] }, filesBySlot: {} }, _pasteZoneId: '',
    document: { querySelector: () => ({ offsetParent: 1, querySelectorAll: () => zones }) } };
  vm.createContext(ctx);
  vm.runInContext(['_pasteZones', '_pasteZoneFiles', '_pasteTargetZone'].map(grab).join('\n') + '\nconst _PASTE_ZONE_SEL="x";', ctx);
  assert.equal(vm.runInContext('_pasteTargetZone().id', ctx), 'mrDz_1', '채워진 첫 칸은 건너뛴다');
  vm.runInContext('_pasteZoneId="csDz_receipt"', ctx);
  assert.equal(vm.runInContext('_pasteTargetZone().id', ctx), 'csDz_receipt', '마우스로 고른 칸이 먼저');
  vm.runInContext('_pasteZoneId=""; S.filesByIdx={0:[1],1:[1]}; S.filesBySlot={receipt:[1]}', ctx);
  assert.equal(vm.runInContext('_pasteTargetZone().id', ctx), 'mrDz_0', '모두 찼으면 첫 칸');
  vm.runInContext('S.filesByIdx={}; S.filesBySlot={}', ctx);
  zones[0].closest = () => sl(true);
  assert.equal(vm.runInContext('_pasteTargetZone().id', ctx), 'mrDz_1', '이미 제출한 칸은 비어 보여도 건너뛴다(덮어쓰기 방지)');
  vm.runInContext('_pasteZoneId="mrDz_0"', ctx);
  assert.equal(vm.runInContext('_pasteTargetZone().id', ctx), 'mrDz_0', '제출한 칸도 직접 누르면 대상(교체)');
  assert.match(js, /if \(isDone\) slotEl\.dataset\.submitted = "1";/);
});
t('선택 표시: 선택된 칸 테두리 + 왼쪽 칸 "✓ 선택됨" — PC 에서만 · 휴대폰은 종전 안내 그대로', () => {
  assert.match(css, /\.paste-target \.ds-paste \.ds-sub::before\{content:"✓ 선택됨 · 여기로 들어가요"/);
  assert.match(css, /#dropZone \.dz-placeholder,\.mr-slot-dropzone \.mr-slot-dz-hint,#dropZone \.prev-add\{display:none!important\}/);
  assert.match(js, /클릭 또는 드래그 · JPG\/PNG\/WebP/, '현금영수증 안내서 가드 문구 유지(휴대폰 안내)');
  assert.match(html, /클릭하거나 이미지를 드래그하세요/);
});
t('시작 시 연결 · 단계 전환 때 표시 갱신', () => {
  assert.match(js, /bindDragDrop\(\);\n\s*bindPasteUpload\(\);/);
  assert.match(grab('goStep'), /_pastePaint\(\);/);
});
console.log(`\n✅ reviewSubmitPasteUpload: ${passed}/${passed}`);
