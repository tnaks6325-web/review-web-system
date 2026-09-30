/**
 * captureLongestSideShrink.test.js — 리뷰 캡처 축소는 **긴 변 기준** 회귀가드.
 *
 * 왜:
 *   리뷰 캡처는 세로로 긴 모바일 스크린샷(예 1080×2400)이라 **가로 폭 기준**(`w > maxPx`)
 *   으로는 축소가 한 번도 걸리지 않았다 → 원본 해상도 그대로 올라가 Drive 업로드가
 *   3~9초(2026-09-22 실측). 긴 변 1600px 로 바꿔 720×1600 이 된다(사용자 확정).
 *
 * 고정하는 불변식:
 *   A. `_scale` — 긴 변/가로 두 기준, 상한 안이면 1, 확대 없음.
 *   B. 리뷰 캡처 경로(`compressImage`)는 ImageShrink 를 `{longest:true}` 로 부른다.
 *   C. 폴백(모듈 미로드)도 **같은 상한·같은 긴 변 기준**을 쓴다 — 축소가 통째로 빠지면
 *      큰 캡처가 서버 본문 상한에 걸려 증빙만 조용히 빠진다.
 *   D. ★ **구매 캡처 소비처는 가로 기준 그대로**(longest 미지정) — 주문번호·수취인·주소를
 *      AI 가 읽는 경로라 해상도를 함부로 낮추지 않는다(무회귀).
 *   E. 1MB 이하 JPEG 는 손대지 않는다(재인코딩은 화질만 깎는다).
 *
 * 실행: node tests/captureLongestSideShrink.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const front = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');
const SHRINK = front('js/image-shrink.js');
const APP = front('js/search-app.js');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  assert.ok(m, `함수를 찾지 못했습니다: ${name}`);
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++; else if (c === '}') depth--;
    i++;
  }
  const code = src.slice(m.index, i);
  new vm.Script(code);
  return code;
}

(async () => {
  /* ═══ A. 축척 규칙 실행 ═══ */
  console.log('\nA) _scale — 긴 변/가로 두 기준');
  const sandbox = { window: {}, document: { createElement: () => ({ getContext: () => ({}) }) }, Image: function () {}, URL: {}, FileReader: function () {} };
  vm.createContext(sandbox);
  vm.runInContext(SHRINK, sandbox);
  const IS = sandbox.window.ImageShrink;
  assert.ok(IS && typeof IS._scale === 'function', 'ImageShrink._scale 미노출');

  assert.strictEqual(Number(IS._scale(1080, 2400, 1600, true).toFixed(3)), 0.667,
    '세로로 긴 캡처는 긴 변 기준으로 줄어야 한다');
  ok('긴 변 기준: 1080×2400 → 0.667배(=720×1600)');

  assert.strictEqual(IS._scale(1080, 2400, 1600, false), 1,
    '가로 기준에서는 세로로 긴 캡처가 줄지 않는다 — 이것이 종전 동작이자 느림의 원인');
  ok('가로 기준: 같은 캡처가 안 줄어든다(종전 동작 재현)');

  assert.strictEqual(IS._scale(800, 1000, 1600, true), 1, '상한 안이면 그대로');
  assert.strictEqual(IS._scale(3000, 1000, 1600, false), 1600 / 3000, '가로가 크면 가로 기준도 줄인다');
  ok('상한 안이면 1(확대 없음) · 가로가 크면 두 기준 모두 줄인다');

  assert.strictEqual(IS._scale(0, 0, 1600, true), 1, '크기를 모르면 건드리지 않는다');
  ok('해상도 미상은 축소하지 않는다(fail-open)');

  /* ═══ B·C. 리뷰 캡처 경로 ═══ */
  console.log('\nB) 리뷰 캡처는 긴 변 기준으로 줄인다');
  const ci = extractFn(APP, 'compressImage');
  assert.ok(/ImageShrink\.fromFile\(file, maxPx, quality, \{ longest: true \}\)/.test(ci),
    'compressImage 가 ImageShrink 를 긴 변 기준으로 부르지 않는다');
  ok('compressImage → ImageShrink.fromFile(..., { longest: true })');

  assert.ok(/const REVIEW_CAPTURE_MAX_PX\s*=\s*1600;/.test(APP), '긴 변 상한 상수(1600) 없음');
  assert.ok(/function compressImage\(file, maxPx = REVIEW_CAPTURE_MAX_PX, quality = REVIEW_CAPTURE_QUALITY\)/.test(APP),
    '상수를 기본값으로 쓰지 않는다 — 값이 두 곳에 박히면 한쪽만 바뀐다');
  ok('상한·품질은 상수 단일 출처(REVIEW_CAPTURE_MAX_PX / _QUALITY)');

  console.log('\nC) 폴백도 같은 기준');
  assert.ok(/Math\.min\(1, maxPx \/ Math\.max\(width \|\| 1, height \|\| 1\)\)/.test(ci),
    '폴백이 긴 변 기준이 아니다 — 모듈 미로드 페이지에서 종전 버그가 되살아난다');
  ok('폴백 canvas 도 Math.max(width,height) 기준');
  assert.ok(/fileToBase64Raw\(file\)/.test(ci), '축소 실패 시 원본 폴백이 없다');
  ok('축소 실패는 원본으로 접는다(첨부를 막지 않는다)');

  /* ═══ D. 구매 캡처 무회귀 ═══ */
  console.log('\nD) 구매 캡처 경로는 가로 기준 그대로');
  const IX = front('index.html');
  assert.ok(/ImageShrink\.fromDataUrl\(_imgCtx\.dataUrl, 1920, 0\.8\)/.test(APP),
    '구매 캡처 업로드 축소 호출이 바뀌었다');
  assert.ok(/ImageShrink\.fromDataUrl\(dataUrl, 1080, 0\.6\)/.test(APP),
    '배치 축소본 호출이 바뀌었다');
  assert.ok(/ImageShrink\.fromFile\(f, 1920, 0\.8\)/.test(IX),
    '리뷰어 홈 구매 캡처 보완 업로드 호출이 바뀌었다');
  ok('구매 캡처 3소비처 모두 longest 미지정 = 가로 기준 유지');

  for (const [label, call] of [
    ['구매 캡처 업로드', /ImageShrink\.fromDataUrl\(_imgCtx\.dataUrl, 1920, 0\.8[^)]*\)/.exec(APP)],
    ['배치 축소본',     /ImageShrink\.fromDataUrl\(dataUrl, 1080, 0\.6[^)]*\)/.exec(APP)],
    ['홈 구매 캡처',    /ImageShrink\.fromFile\(f, 1920, 0\.8[^)]*\)/.exec(IX)],
  ]) {
    assert.ok(call, `${label} 호출을 찾지 못했다`);
    assert.ok(!/longest/.test(call[0]), `${label} 에 longest 가 붙었다 — OCR 입력 해상도가 조용히 낮아진다`);
  }
  ok('세 호출 어디에도 longest 가 붙지 않았다');

  /* ═══ E. 작은 JPEG 무손상 ═══ */
  console.log('\nE) 이미 작은 JPEG 는 손대지 않는다');
  assert.ok(/file\.size <= 1024 \* 1024 && file\.type === 'image\/jpeg'/.test(ci),
    '1MB 이하 JPEG 예외가 사라졌다 — 재인코딩은 화질만 깎는다');
  ok('compressImage: 1MB 이하 JPEG 는 원본 그대로');
  assert.ok(/file\.size <= 1024 \* 1024 && file\.type === 'image\/jpeg'/.test(SHRINK),
    'ImageShrink 의 같은 예외가 사라졌다');
  ok('ImageShrink: 같은 예외 유지');

  console.log(`\n✅ captureLongestSideShrink: ${n}건 통과`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ 실패:', e.message); process.exit(1); });
