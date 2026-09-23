/**
 * orderCaptureUploadRobust.test.js — 구매 캡처 업로드 유실 방지 회귀가드.
 *
 * 고정하는 불변식(둘 다 "주문은 접수됐는데 증빙만 조용히 빠지는" 사고의 원인이었다):
 *   A. 업로드 직전 축소 — 서버 본문 상한 10MB 인데 base64 는 원본의 약 1.33배라
 *      큰 캡처는 413 으로 통째로 실패한다. 축소 규칙은 **단일 출처 ImageShrink**.
 *      ★ 예산 안이면 원본 그대로 보낸다(증빙 화질을 이유 없이 깎지 않는다).
 *   B. 분당 상한 — image-extract 와 **버킷을 나눈다**(같은 통이면 카드 5장 제출이 정확히
 *      한도에 걸려 뒤 카드 캡처가 유실). 프론트는 업로드를 **순차 큐**로 보내고,
 *      429 는 짧은 백오프로 풀리지 않으므로 **창이 지날 때까지** 기다린다.
 *   C. 413 은 200 으로 접지 않는다 — 클라이언트가 429(기다리면 풀림)와 구분해야
 *      "더 줄여 보내기" 재시도가 성립한다.
 *
 * 실행: node tests/orderCaptureUploadRobust.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const front = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');
const srv = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok   ' + name); };

const SA = front('js/search-app.js');
const IX = front('index.html');
const SH = front('search.html');
const API = front('api.js');
const MOD = front('js/image-shrink.js');
const RL = srv('src/middleware/rateLimit.middleware.js');
const DG = srv('src/routes/diag.routes.js');
const EM = srv('src/middleware/error.middleware.js');

// 업로드 블록(제출 루프 안)만 잘라서 본다 — 파일 전체로 보면 무관한 곳의 문자열이 대신 통과한다.
const UP = (() => {
  const i = SA.indexOf('window._capUploadChain');
  assert.ok(i > 0, '업로드 순차 큐가 없다');
  return SA.slice(i, SA.indexOf('_renderCaptureChecklist();', i));
})();

console.log('\nA) 업로드 직전 축소');

t('A1. 축소 모듈이 두 화면에 로드된다(구매양식·리뷰어 홈 보완 첨부)', () => {
  assert.ok(/<script src="js\/image-shrink\.js"><\/script>/.test(SH), 'search.html 미로드');
  assert.ok(/<script src="js\/image-shrink\.js"><\/script>/.test(IX), 'index.html 미로드');
});

t('A2. 모듈은 실패해도 throw 하지 않는다(축소 실패가 첨부를 막으면 안 된다)', () => {
  assert.ok(/global\.ImageShrink = \{/.test(MOD), '전역 노출 없음');
  assert.ok(/fromDataUrl/.test(MOD) && /fromFile/.test(MOD), '두 입력 형태를 다루지 않음');
  assert.ok(!/reject\(/.test(MOD), 'reject 경로가 있으면 호출부가 첨부를 잃는다');
  assert.ok(/UPLOAD_BUDGET/.test(MOD), '예산 상수가 모듈에 없다(호출부 사본을 부른다)');
});

t('A3. 예산 초과일 때만 줄인다 — 그 안이면 원본 그대로 보낸다', () => {
  assert.ok(/UPLOAD_BUDGET/.test(UP), '예산을 모듈에서 읽지 않는다');
  assert.ok(/if \(b64\.length > _BUD && window\.ImageShrink\)/.test(UP), '무조건 축소하면 증빙 화질이 깎인다');
  assert.ok(/ImageShrink\.fromDataUrl\(_imgCtx\.dataUrl, 1920, 0\.8\)/.test(UP), '업로드용 축소 호출 없음');
});

t('A4. 축소 규칙 사본이 늘지 않았다 — 리뷰어 경로는 모듈만 쓴다', () => {
  const batch = SA.slice(SA.indexOf('function _batchShrinkDataUrl'), SA.indexOf('function _batchRestoreCaps'));
  assert.ok(/ImageShrink\.fromDataUrl\(dataUrl, 1080, 0\.6\)/.test(batch), '배치 축소본이 모듈을 쓰지 않음');
  assert.ok(!/toDataURL/.test(batch), '축소 사본이 되살아났다');
  assert.ok(/ImageShrink\.fromFile\(f, 1920, 0\.8\)/.test(IX), '리뷰어 홈 보완 첨부가 원본을 그대로 보낸다');
});

t('A5. 리뷰어 홈 보완 첨부도 축소 실패 시 원본으로 폴백한다(첨부 자체를 막지 않는다)', () => {
  const fn = IX.slice(IX.indexOf('function _mcOnFile'), IX.indexOf('function _mcOnFile') + 2200);
  assert.ok(/모듈 부재·축소 실패 → 원본으로 폴백/.test(fn), '폴백 없음');
  assert.ok(/mimeType: mime/.test(fn), '축소 후 mime 을 갱신하지 않으면 확장자·타입이 어긋난다');
});

console.log('\nB) 분당 상한 — 다건 제출에서 뒤 카드 캡처 유실 방지');

t('B1. image-upload 는 image-extract 와 다른 버킷을 쓴다', () => {
  assert.ok(/const imageUploadLimiter = rateLimit\(/.test(RL), '업로드 전용 리미터 없음');
  assert.ok(/imageUploadLimiter/.test(RL.slice(RL.indexOf('module.exports'))), 'export 누락');
  assert.ok(/router\.post\('\/image-upload', imageUploadLimiter,/.test(DG), '업로드 라우트가 여전히 공용 버킷');
  assert.ok(/router\.post\('\/image-extract', imageApiLimiter,/.test(DG), '추출 라우트 버킷이 바뀌면 안 된다');
});

t('B2. 업로드 상한이 추출 상한보다 넉넉하다(다건 제출 + 재시도 여유)', () => {
  const up = /const imageUploadLimiter = rateLimit\(\{[\s\S]*?max: (\d+)/.exec(RL);
  const ex = /const imageApiLimiter = rateLimit\(\{[\s\S]*?max: (\d+)/.exec(RL);
  assert.ok(up && ex, 'max 를 읽지 못함');
  assert.ok(Number(up[1]) > Number(ex[1]), '업로드 상한이 추출 상한 이하면 같은 사고가 재현된다');
  assert.ok(Number(up[1]) < 1000, '사실상 무제한이면 남용 방어가 사라진다');
});

t('B3. 업로드는 순차 큐로 나간다(동시 폭주 금지) + 한 건 예외가 큐를 끊지 않는다', () => {
  assert.ok(/window\._capUploadChain = \(window\._capUploadChain \|\| Promise\.resolve\(\)\)\.then/.test(SA), '순차 큐 아님');
  const chain = SA.slice(SA.indexOf('window._capUploadChain'), SA.indexOf('window._capUploadChain') + 6000);
  assert.ok(/\}\)\.catch\(\(\) => \{\}\);\s*\/\/ 한 건의 예외가 큐를 끊지 않게/.test(chain), '큐 예외 처리 없음');
  assert.ok(!/await window\._capUploadChain/.test(SA), '제출을 업로드에 묶으면 리뷰어가 기다리게 된다');
});

t('B4. 429 는 창이 지날 때까지 기다린다(짧은 백오프는 전부 같은 창)', () => {
  assert.ok(/st === 429 \? 62000/.test(UP), '429 전용 대기 없음');
  assert.ok(/_httpStatus/.test(UP), '상태코드를 보지 않으면 429 를 구분할 수 없다');
});

console.log('\nC) 413 — 기다려도 안 풀리는 실패는 더 줄여 보낸다');

t('C1. 서버가 413 을 200 으로 접지 않는다(본문의 error 계약은 유지)', () => {
  const i = EM.indexOf("err.status === 413");
  assert.ok(i > 0, '413 분기 없음');
  const blk = EM.slice(i - 400, i + 400);
  assert.ok(/res\.status\(413\)\.json\(\{ ok: false, error:/.test(blk), '상태코드/본문 계약 불일치');
});

t('C2. 프론트는 413 이면 한 번 더 줄여 즉시 재시도한다(무한 반복 금지)', () => {
  assert.ok(/shrunkFor413/.test(UP), '413 재시도 플래그 없음');
  assert.ok(/fromDataUrl\(_imgCtx\.dataUrl, 1280, 0\.7\)/.test(UP), '더 줄이는 2차 시도 없음');
  assert.ok(/tooLarge && !shrunkFor413/.test(UP), '한 번만 줄이는 가드가 없다(루프 위험)');
  assert.ok(/too large\|용량이 초과/.test(UP), '구버전 백엔드(200+error) 폴백 판정 없음');
});

t('C3. 상태코드는 가산 필드다(기존 소비처 계약 불변)', () => {
  const fn = API.slice(API.indexOf('function _xhrPost'), API.indexOf('async function gasPostUpload'));
  assert.ok(/out\._httpStatus = xhr\.status/.test(fn), '상태코드 미노출');
  assert.ok(/JSON\.parse\(xhr\.responseText\)/.test(fn), '기존 파싱 계약이 바뀌었다');
  assert.ok(/서버 응답 파싱 실패 \(HTTP/.test(fn), '파싱 실패 폴백이 사라졌다');
});

t('C4. 캡처폴더 저장은 세션에 고정된 좌표로 업로드 서버가 소유한다', () => {
  assert.ok(!/_saveCaptureFolderOnce|firstCaptureFolderUrl/.test(SA), '공개 화면의 별도 폴더 저장 경로가 남아 있다');
  assert.ok(/captureSessionId:_capSession\.id/.test(UP), '세션 ID가 업로드 요청에 없다');
  assert.ok(/captureSessionToken:_capSession\.token/.test(UP), '세션 토큰이 업로드 요청에 없다');
  assert.ok(/캡처폴더 URL은 업로드 서버가 세션에 고정된 작업 좌표로 직접 저장한다/.test(SA), '서버 소유 계약 설명이 없다');
});

console.log(`\n${n} checks passed`);
