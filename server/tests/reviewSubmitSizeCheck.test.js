'use strict';
/* 결정 408 — 리뷰 사진 크기·형식은 **실제로 보낼(줄인 뒤) 사진**으로 판정하고, 받는 규칙은 한 곳(_reviewPhotoAdd)에서 정한다.
 *
 * 사고(점검 2026-11-24 M1 · L5):
 *   M1 화면은 사진을 넣는 즉시 긴 변 1600px JPEG 로 줄여 두는데, 「너무 크다」 판정은 **줄이기 전 원본 크기**(f.size)로 했다.
 *      → 휴대폰 스크린숏 몇 장(원본 합 15MB↑ · 보낼 양 1MB 남짓)이 [제출하기]에서 「이미지 총 용량이 15MB를 초과합니다」,
 *        원본 11MB 캡처(줄이면 0.5MB)는 넣는 순간 「10MB 초과」로 막혔다.
 *   L5 받는 규칙이 세 벌(단건 addFiles · 여러 건 _mrAddFiles · 캡처 칸 _csAddFiles)이라 형식 검사는 단건에만,
 *      10MB 는 설정값 1벌 + 숫자 박음 2벌, 15MB 합계 2벌, 「JPEG 로 바뀌었나」 판정 3벌. 끌어다 놓기는 형식이 다른 파일을 말없이 버렸다.
 *
 * search-app.js 의 **실제 함수 본문**(옛 입구 addFiles·_mrAddFiles·_csAddFiles·submitReview·_submitReviewSlots)을 vm 에서 돌린다.
 * 새 함수(_reviewPhoto*)는 있으면 함께 싣는다 — 옛 코드에서도 같은 입구로 돌아 **행동으로** 실패한다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SA = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
const APP_JS = fs.readFileSync(path.resolve(__dirname, '../src/app.js'), 'utf8');
const CFG = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-config.js'), 'utf8');
const MB = 1024 * 1024;

/** 맨 위 함수 하나(시작 ~ 첫 줄머리 `}`) — 없으면 '' */
function fn(src, name) {
  let at = src.indexOf('\nasync function ' + name + '(');
  if (at < 0) at = src.indexOf('\nfunction ' + name + '(');
  if (at < 0) return '';
  return src.slice(at + 1, src.indexOf('\n}', at) + 2);
}
const photoHelpers = (src) => [...src.matchAll(/^(?:async )?function (_reviewPhoto\w*)\(/gm)].map((m) => m[1]);
// 결정 410: 제출 두 길·넣는 길이 부르는 실패 안내 도우미(_rv…) + 문구 바탕(_ofFriendlyErr) — 있는 것만
const rvHelpers = (src) => [...src.matchAll(/^(?:async )?function (_rv[A-Z]\w*|_ofFriendlyErr)\(/gm)].map((m) => m[1]);
const captureConsts = (src) => (src.match(/^const REVIEW_CAPTURE_(?:MAX_PX|QUALITY)\s*=[^\n]*$/gm) || []).join('\n');
// 운영 설정(search-config.js DEFAULT_CONFIG)의 값을 그대로 읽어 쓴다 — 시험이 따로 값을 박지 않는다
const DEFAULT_CONFIG = vm.runInNewContext(CFG.slice(CFG.indexOf('const DEFAULT_CONFIG'), CFG.indexOf('const APP_CONFIG')) + '\nDEFAULT_CONFIG', { BOOTSTRAP_GAS_URL: '' });

/** 가짜 사진 파일 — size = 원본 크기(이름표), shrink = 화면이 줄인 뒤 보낼 base64(null = 휴대폰이 못 읽어 원본 그대로) */
const jpegB64 = (bytes) => '/9j/' + 'A'.repeat(Math.max(0, Math.ceil(bytes * 4 / 3) - 4));
function photo(name, { size, type = 'image/png', sendBytes = 400 * 1024, raw = 'iVBORw0KGgoAAAANSUhEUg', decodable = true } = {}) {
  return { name, size, type, __raw: raw, __shrink: decodable ? jpegB64(sendBytes) : null };
}

function harness() {
  const calls = { upload: [], post: [], toast: [], pre: 0 };
  const nodes = {};
  const el = (id) => nodes[id] || (nodes[id] = { id, value: '', innerHTML: '<i class="fas fa-paper-plane"></i> 제출하기', textContent: '',
    disabled: false, style: {}, className: '', classList: { add() {}, remove() {}, toggle() {} } });
  class FileReader {
    readAsDataURL(f) { setTimeout(() => { this.result = 'data:' + (f.type || 'application/octet-stream') + ';base64,' + f.__raw; this.onload && this.onload(); }, 0); }
  }
  const g = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Promise, Object, Array, String, Number, Set, Map, Error, setTimeout, clearTimeout, FileReader,
    window: { ImageShrink: { fromFile: async (f) => (f.__shrink ? { base64: f.__shrink, mime: 'image/jpeg' } : { base64: f.__raw, mime: f.type || 'image/jpeg' }) } },
    APP_CONFIG: Object.assign({}, DEFAULT_CONFIG, { GAS_WEB_APP_URL: 'https://fake.invalid/gas' }),
    gasPostUpload: async (p) => { calls.upload.push({ slotKey: p.slotKey, n: p.files.length, chars: p.files.map((f) => f.data.length), mime: p.files.map((f) => f.mimeType) });
      return { ok: true, uploadBatchId: 'b' + calls.upload.length, files: p.files.map((f, i) => ({ fileId: 'f' + i })) }; },
    gasPost: async (p) => { calls.post.push(p); return { ok: true, complete: true, missingSlots: [] }; },
    showToast: (m) => calls.toast.push(String(m)), showLoading() {}, hideLoading() {}, show() {}, goStep() {},
    _updateReceiptStepActions() {}, _clearSearchCache() {}, escHtml: String, extractProductOption: () => ({ options: [] }),
    _isBlogItem: () => false, _isPostUrl: () => false, _BLOG_POST_URL_HINT: '',
    _csIsReceiptSlot: (s) => !!(s && s.role === 'receipt'), _dualReviewItem: () => false, _dualReviewSlotsReady: () => true,
    _csShowVerdict() {}, _csClearVerdict() {}, _csShowRouteNotice() {}, _csClearRouteNotice() {}, _showDuplicateBlockModal() {},
    _preAwaitChecks: async () => true, _preHasBlock: () => false, _preBlockedMessage: () => '', _preCheckFiles: () => { calls.pre++; }, _preCtx: () => ({}),
    renderPreviews() {}, _mrRenderPreview() {}, _csRenderPreview() {},
    S: { selectedRows: [], selectedRow: { sheetId: 'sh', tabName: 'tab', gid: '1', rowIndex: 5, recipientName: '김예시', displayName: '김예시', row: {} },
      files: [], filesByIdx: {}, filesBySlot: {}, captureSlots: null, receiptStepMode: false, step: 2 },
    document: { getElementById: el },
  };
  nodes.memoTxt = { value: '' };
  vm.createContext(g);
  const names = ['addFiles', '_mrAddFiles', '_csAddFiles', '_mrOnDrop', '_csOnDrop', 'compressImage', 'fileToBase64', 'fileToBase64Raw',
    ...photoHelpers(SA), ...rvHelpers(SA), 'submitReview', '_submitReviewSlots'];
  vm.runInContext(captureConsts(SA) + '\n' + names.map((n) => fn(SA, n)).join('\n'), g);
  return { g, calls, nodes };
}
const shots = (n, prefix = 'shot') => Array.from({ length: n }, (_, i) => photo(`${prefix}${i + 1}.png`, { size: 4.2 * MB, sendBytes: 380 * 1024 }));
const sizeToast = (t) => t.filter((m) => /MB|용량|크기/.test(m));

/* ═══ M1. 보낼(줄인 뒤) 크기로 판정한다 ═══ */
test('M1-1 휴대폰 스크린숏 4장(원본 합 16.8MB · 보낼 양 1.5MB)은 단건 화면에서 그대로 제출된다 — 「총 용량 15MB 초과」 없음', async () => {
  const h = harness();
  await h.g.addFiles(shots(4));
  assert.equal(h.g.S.files.length, 4, '4장 모두 들어간다');
  await h.g.submitReview();
  assert.deepEqual(sizeToast(h.calls.toast), [], `★ 원본 크기로 막지 않는다 — 실제 안내: ${JSON.stringify(h.calls.toast)}`);
  assert.equal(h.calls.upload.length, 1, '업로드 1번');
  assert.equal(h.calls.upload[0].n, 4, '사진 4장을 한 번에');
  assert.equal(h.calls.post.length, 1, '제출 기록 1번');
});

test('M1-2 원본 11MB 캡처(줄이면 0.5MB)는 넣을 때 막히지 않고 제출된다', async () => {
  const h = harness();
  await h.g.addFiles([photo('big11.png', { size: 11 * MB, sendBytes: 510 * 1024 })]);
  assert.equal(h.g.S.files.length, 1, `★ 「10MB 초과」로 버리지 않는다 — 실제 안내: ${JSON.stringify(h.calls.toast)}`);
  assert.equal(h.calls.pre, 1, '들어간 사진은 종전처럼 1차 필터로 넘어간다');
  await h.g.submitReview();
  assert.equal(h.calls.upload.length, 1);
  assert.ok(h.calls.upload[0].chars[0] < 1 * MB, '보내는 것은 줄인 사진');
});

test('M1-3 여러 건 칸(_mrAddFiles)·캡처 칸(_csAddFiles)도 원본 11MB 를 받는다', async () => {
  const h = harness();
  await h.g._mrAddFiles(0, [photo('m11.png', { size: 11 * MB })]);
  await h.g._csAddFiles('review', [photo('c11.png', { size: 11 * MB })]);
  assert.equal((h.g.S.filesByIdx[0] || []).length, 1, '여러 건 칸');
  assert.equal((h.g.S.filesBySlot.review || []).length, 1, '캡처 칸');
});

test('M1-4 줄여도 10MB 가 넘는 사진은 넣지 않고, 어떤 사진인지 쉬운 말로 알린다', async () => {
  const h = harness();
  await h.g.addFiles([photo('huge.png', { size: 30 * MB, sendBytes: 11 * MB })]);
  assert.equal(h.g.S.files.length, 0, '넣지 않는다(서버 관문 앞에서 알린다)');
  const t = h.calls.toast.join(' | ');
  assert.match(t, /huge\.png/, '어느 사진인지 이름을 댄다');
  assert.match(t, /줄여도 10MB/, `★ 「줄여도 10MB 가 넘는다」를 쉬운 말로 — 실제: ${t}`);
  assert.match(t, /나눠 캡처/, '무엇을 하면 되는지 알려 준다');
});

test('M1-5 한 칸의 사진을 모두 합쳐 한 번에 보낼 수 없으면, 넘치게 만드는 사진을 넣을 때 바로 알린다', async () => {
  const h = harness();
  await h.g.addFiles([6, 6, 1].map((m, i) => photo(`p${i + 1}.png`, { size: 8 * MB, sendBytes: m * MB })));
  assert.deepEqual(h.g.S.files.map((f) => f.name), ['p1.png', 'p3.png'], '★ 6MB+6MB(보낼 base64 16MB)는 한 번에 못 보낸다 — 두 번째만 뺀다');
  assert.match(h.calls.toast.join(' | '), /p2\.png: 이 칸 사진을 모두 합치면 한 번에 보낼 수 있는 크기를 넘어/);
});

test('M1-6 제출할 때 크기 판정은 업로드를 시작하기 전에 전부 한다 — 여러 건 중 2번만 커도 아무것도 올리지 않고 2번을 가리킨다', async () => {
  const h = harness();
  h.g.S.selectedRows = [h.g.S.selectedRow, { ...h.g.S.selectedRow, rowIndex: 6 }];
  h.g.S.filesByIdx = {
    0: [{ b64: jpegB64(300 * 1024), size: 300 * 1024, type: 'image/jpeg', name: 'a.jpg' }],
    1: [{ b64: jpegB64(6 * MB), size: 9 * MB, type: 'image/jpeg', name: 'b.jpg' }, { b64: jpegB64(6 * MB), size: 9 * MB, type: 'image/jpeg', name: 'c.jpg' }],
  };
  await h.g.submitReview();
  assert.equal(h.calls.upload.length, 0, '★ 1번만 올라가고 2번에서 멈추는 일(일부 제출)이 없다');
  const t = h.calls.toast.join(' | ');
  assert.match(t, /2번 리뷰의 사진을 모두 합치면/, `어느 건인지 — 실제: ${t}`);
  assert.match(t, /가장 큰 1번째 사진을 빼고/, '무엇을 빼면 되는지');
  assert.ok(!/15MB|모든 제출에 실패/.test(t), '종전 문구(원본 기준 15MB · 「모든 제출에 실패」)가 아니다');
});

test('M1-7 캡처 칸 화면(_submitReviewSlots)은 칸마다(= 업로드 한 번마다) 보낼 크기를 본다 — 스크린숏 6장(원본 25MB)도 제출된다', async () => {
  const h = harness();
  h.g.S.captureSlots = [{ key: 'review', label: '리뷰', role: 'review' }, { key: 'receipt', label: '현금영수증', role: 'receipt', required: false }];
  await h.g._csAddFiles('review', shots(4));
  await h.g._csAddFiles('receipt', shots(2, 'rc'));
  await h.g.submitReview();
  assert.deepEqual(sizeToast(h.calls.toast), [], `★ 원본 크기 합(25MB)으로 막지 않는다 — 실제: ${JSON.stringify(h.calls.toast)}`);
  assert.deepEqual(h.calls.upload.map((u) => [u.slotKey, u.n]), [['review', 4], ['receipt', 2]], '칸마다 업로드 1번');
});

test('M1-8 캡처 칸 하나가 한 번에 못 보낼 만큼 크면 올리기 전에 그 칸 이름으로 알린다', async () => {
  const h = harness();
  h.g.S.captureSlots = [{ key: 'review', label: '리뷰', role: 'review' }];
  h.g.S.filesBySlot = { review: [6, 6].map((m, i) => ({ b64: jpegB64(m * MB), size: 9 * MB, type: 'image/jpeg', name: `s${i}.jpg` })) };
  await h.g.submitReview();
  assert.equal(h.calls.upload.length, 0);
  assert.match(h.calls.toast.join(' | '), /「리뷰」 칸의 사진을 모두 합치면 한 번에 보낼 수 있는 크기를 넘어요/);
});

/* ═══ L5. 받는 규칙은 한 곳 — 세 넣는 길이 같은 답을 낸다 ═══ */
const mixed = () => [
  photo('heic-ok.heic', { type: 'image/heic', size: 2 * MB, sendBytes: 300 * 1024 }),               // 휴대폰이 JPG 로 바꿔 줌
  photo('heic-raw.heic', { type: 'image/heic', size: 2 * MB, decodable: false, raw: 'AAAAHGZ0eXBoZWlj' }), // 못 바꿈(원본 그대로)
  { name: 'doc.pdf', size: 200 * 1024, type: 'application/pdf', __raw: 'JVBERi0xLjQK', __shrink: null },
  photo('small.png', { type: 'image/png', size: 300 * 1024, sendBytes: 120 * 1024 }),                  // 작은 PNG 도 JPG 로 다시 만들어진다
];
async function addVia(h, way, files) {
  if (way === 'single') { await h.g.addFiles(files); return h.g.S.files; }
  if (way === 'multi') { await h.g._mrAddFiles(0, files); return h.g.S.filesByIdx[0]; }
  await h.g._csAddFiles('review', files); return h.g.S.filesBySlot.review;
}
for (const way of ['single', 'multi', 'slot']) {
  test(`L5-1 [${way}] 형식은 보낼 내용으로 · 세 넣는 길이 같은 규칙 — JPG 로 바뀐 HEIC 는 받고, 못 바꾼 HEIC·PDF 는 쉬운 말로 돌려보낸다`, async () => {
    const h = harness();
    const got = await addVia(h, way, mixed());
    assert.deepEqual(got.map((f) => f.name), ['heic-ok.heic', 'small.png'], `★ 받는 사진이 길마다 같다 — 실제 ${JSON.stringify(got.map((f) => f.name))}`);
    assert.deepEqual(got.map((f) => f.type), ['image/jpeg', 'image/jpeg'], '형식 이름표 = 보낼 내용의 실제 형식(JPG)');
    const t = h.calls.toast.join(' | ');
    for (const n of ['heic-raw.heic', 'doc.pdf']) assert.match(t, new RegExp(n.replace('.', '\\.') + ': JPG·PNG·GIF·WebP 사진만 올릴 수 있어요'), `${n} 안내 — 실제: ${t}`);
  });
}

test('L5-2 끌어다 놓기는 형식이 다른 파일을 말없이 버리지 않는다(넣는 함수가 이유를 알린다)', async () => {
  const h = harness();
  const pdf = { name: 'doc.pdf', size: 1000, type: 'application/pdf', __raw: 'JVBERi0x', __shrink: null };
  const ev = { preventDefault() {}, dataTransfer: { files: [pdf] } };
  await h.g._csOnDrop(ev, 'review');
  await h.g._mrOnDrop(ev, 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls.toast.filter((m) => /doc\.pdf: JPG·PNG·GIF·WebP 사진만/.test(m)).length, 2, `★ 칸·여러 건 끌어다 놓기 둘 다 안내 — 실제: ${JSON.stringify(h.calls.toast)}`);
  const bind = fn(SA, 'bindDragDrop');
  assert.ok(bind && /addFiles\(Array\.from\(e\.dataTransfer\.files\)\)/.test(bind) && !/\.filter\(/.test(bind), '단건 끌어다 놓기도 거르지 않고 넣는 함수로');
});

test('L5-3 규칙 단일 출처 — 넣는 길 3곳·제출 두 길에 크기·형식 숫자/판정 사본이 없다', () => {
  for (const name of ['addFiles', '_mrAddFiles', '_csAddFiles']) {
    const b = fn(SA, name);
    assert.ok(/_reviewPhotoAdd\(/.test(b), `${name} 이 공용 판정(_reviewPhotoAdd)을 부르지 않는다`);
    assert.ok(!/1024 \* 1024|MAX_FILE_SIZE|ALLOWED_MIME|10MB|actualType|fileToBase64/.test(b), `${name} 에 규칙 사본이 남았다`);
    assert.ok(/_preCheckFiles\s*\(/.test(b), `${name} 의 1차 필터 연결(결정 406)은 그대로`);
  }
  for (const name of ['submitReview', '_submitReviewSlots']) {
    const b = fn(SA, name);
    assert.ok(/_reviewPhotoSendCheck\(/.test(b), `${name} 이 보낼 크기 판정을 부르지 않는다`);
    assert.ok(!/MAX_TOTAL_MB|fo\.size|총 용량/.test(b), `${name} 에 원본 크기 합 판정이 남았다`);
    assert.ok(b.indexOf('_reviewPhotoSendCheck(') < b.indexOf('gasPostUpload('), `${name}: 크기 판정은 업로드 앞`);
    assert.ok(b.indexOf('_preAwaitChecks(') < b.indexOf('_reviewPhotoSendCheck('), `${name}: 결정 406 의 기다림 뒤의 사진 상태로 본다`);
  }
  const rules = fn(SA, '_reviewPhotoRules');
  assert.match(rules, /types: APP_CONFIG\.ALLOWED_MIME/, '형식 = 설정의 단일 출처');
  assert.match(rules, /maxFileBytes: APP_CONFIG\.MAX_FILE_SIZE/, '한 장 = 설정의 단일 출처');
  assert.ok(!/\b10 \* 1024 \* 1024\b/.test(fn(SA, '_csAddFiles') + fn(SA, '_mrAddFiles')), '숫자 박은 10MB 사본 0');
});

/* ═══ 서버가 진짜 관문 — 서버 상한은 그대로, 화면 값은 그 안 ═══ */
test('S-1 서버 본문 상한(express.json 15mb)은 그대로이고, 화면의 한 번 보내기 예산은 그보다 작다', () => {
  assert.ok(/app\.use\(express\.json\(\{ limit: '15mb' \}\)\);/.test(APP_JS), '★ 서버 상한을 바꾸지 않는다(완화 금지 — 서버가 진짜 관문)');
  const h = harness();
  const R = h.g._reviewPhotoRules();
  assert.ok(R.maxSendChars > 0 && R.maxSendChars + 512 * 1024 <= 15 * MB, `한 번 보내기 예산(${R.maxSendChars})은 서버 15MB 본문 안 + 나머지 칸 여유`);
  assert.ok(Math.ceil(R.maxFileBytes * 4 / 3) <= R.maxSendChars, '한 장 상한(10MB)짜리 한 장은 혼자 보낼 수 있다');
  assert.equal(R.maxFileBytes, 10 * MB);
});

test('S-2 형식 판별은 실제 바이트 앞머리로 — JPG·PNG·GIF·WebP 는 맞히고 HEIC·PDF 는 모른다', () => {
  const h = harness();
  const b = (buf) => Buffer.from(buf).toString('base64');
  const sniff = h.g._reviewPhotoSniff;
  assert.equal(sniff(b([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'image/jpeg');
  assert.equal(sniff(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])), 'image/png');
  assert.equal(sniff(b(Buffer.from('GIF89a\x01\x00'))), 'image/gif');
  assert.equal(sniff(b(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x10, 0x00, 0x00]), Buffer.from('WEBPVP8 ')]))), 'image/webp');
  assert.equal(sniff(b(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypheic')]))), '');
  assert.equal(sniff(b(Buffer.from('%PDF-1.4'))), '');
  assert.equal(sniff(''), '');
});
