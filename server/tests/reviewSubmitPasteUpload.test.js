'use strict';
// 결정 263: 리뷰 제출 화면 — 칸 클릭 = 선택 + [바로 붙여넣기/파일에서 고르기](PC) · Ctrl+V · 클릭/드래그와 같은 넣는 길 · 글자 붙여넣기 보존.
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
const grab = name => { const m = js.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')); assert.ok(m, name); return m[0]; };

t('붙여넣기는 클릭·드래그와 같은 함수로만 넣는다(형식·10MB·AI 사전확인 사본 0)', () => {
  const b = grab('_pasteInto');
  assert.match(b, /if \(z\.id === "dropZone"\) addFiles\(files\);/);
  assert.match(b, /_mrAddFiles\(Number\(m\[1\]\), files\)/);
  assert.match(b, /_csAddFiles\(m\[1\], files\)/);
  assert.ok(!/fileToBase64|S\.files\.push/.test(b), '붙여넣기 전용 저장 경로를 만들지 않는다');
  assert.match(grab('bindPasteUpload'), /_pasteInto\(z, imgs\);/, 'Ctrl+V 도 같은 길');
  assert.match(grab('_zcPasteFromClipboard'), /_pasteInto\(z, blobs\);/, '[바로 붙여넣기] 도 같은 길');
});
t('칸 클릭: PC = 선택 + 선택지(파일 탐색기 즉시 열지 않음) · 휴대폰 = 종전대로 바로 고르기', () => {
  const b = grab('_zoneTap');
  const i = b.indexOf('if (!_isPcPointer())'), j = b.indexOf('_zcOpen(z);');
  assert.ok(i > 0 && j > i && /_pasteZoneId = z\.id; _pastePaint\(\);\s*\n\s*_zcOpen\(z\);/.test(b));
  assert.match(b.slice(i, j), /inp\.click\(\)/);
  assert.match(b, /closest\("button, \.zone-chooser"\)\) return;/, '삭제(×)·선택지 버튼은 칸 클릭으로 처리하지 않는다');
  assert.match(html, /<div id="dropZone" class="drop-zone" onclick="_zoneTap\(event,this\)">/);
  assert.equal((js.match(/class="mr-slot-dropzone" id="(?:mrDz_\$\{idx\}|csDz_\$\{slot\.key\})" onclick="_zoneTap\(event,this\)"/g) || []).length, 2);
  assert.match(css, /@media \(hover:hover\) and \(pointer:fine\)\{[\s\S]*?\.mr-slot-dropzone input\[type=file\]\{pointer-events:none\}/);
  const o = grab('_zcOpen');
  assert.ok(/바로 붙여넣기/.test(o) && /파일에서 고르기/.test(o) && /inp\.click\(\)/.test(o));
});
t('[바로 붙여넣기] 실패는 조용히 넘기지 않는다 — 미지원·권한 거절·사진 없음 각각 안내', () => {
  const b = grab('_zcPasteFromClipboard');
  assert.ok(/버튼으로 붙여넣기를 못 해요/.test(b) && /클립보드 읽기를 막았어요/.test(b) && /클립보드에 사진이 없어요/.test(b));
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
  const zones = [{ id: 'mrDz_0', offsetParent: 1 }, { id: 'mrDz_1', offsetParent: 1 }, { id: 'csDz_receipt', offsetParent: 1 }];
  const ctx = { S: { files: [], filesByIdx: { 0: [1] }, filesBySlot: {} }, _pasteZoneId: '',
    document: { querySelector: () => ({ offsetParent: 1, querySelectorAll: () => zones }) } };
  vm.createContext(ctx);
  vm.runInContext(['_pasteZones', '_pasteZoneFiles', '_pasteTargetZone'].map(grab).join('\n') + '\nconst _PASTE_ZONE_SEL="x";', ctx);
  assert.equal(vm.runInContext('_pasteTargetZone().id', ctx), 'mrDz_1', '채워진 첫 칸은 건너뛴다');
  vm.runInContext('_pasteZoneId="csDz_receipt"', ctx);
  assert.equal(vm.runInContext('_pasteTargetZone().id', ctx), 'csDz_receipt', '마우스로 고른 칸이 먼저');
  vm.runInContext('_pasteZoneId=""; S.filesByIdx={0:[1],1:[1]}; S.filesBySlot={receipt:[1]}', ctx);
  assert.equal(vm.runInContext('_pasteTargetZone().id', ctx), 'mrDz_0', '모두 찼으면 첫 칸');
});
t('화면 표시: 안내 줄 + 대상 칸 알약 — PC(마우스)에서만', () => {
  assert.match(html, /class="dz-paste-tip">[^<]*<b>Ctrl\+V<\/b>/);
  assert.equal((js.match(/<em class="dz-paste-tip">또는 캡처 후 Ctrl\+V<\/em>/g) || []).length, 2, '다건·슬롯 칸 둘 다');
  assert.match(css, /\.dz-paste-tip\{display:none[\s\S]*@media \(hover:hover\) and \(pointer:fine\)\{\s*\.dz-paste-tip\{display:block\}/);
  assert.match(css, /\.paste-target \.dz-paste-tip::before\{content:"✓ 선택됨 · Ctrl\+V 하면 여기에 들어가요"/);
  assert.match(js, /클릭 또는 드래그 · JPG\/PNG\/WebP/, '현금영수증 안내서 가드 문구 유지');
});
t('시작 시 연결 · 단계 전환 때 표시 갱신', () => {
  assert.match(js, /bindDragDrop\(\);\n\s*bindPasteUpload\(\);/);
  assert.match(grab('goStep'), /_pastePaint\(\);/);
});
console.log(`\n✅ reviewSubmitPasteUpload: ${passed}/${passed}`);
