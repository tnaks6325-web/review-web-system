// 구매캡쳐 누락 방지 5단계 회귀가드.
//   운영 실측: '캡처 미첨부' 알림의 85%가 진짜 미첨부였고, 원인은 화면이 캡처를 "(선택) 자동추출"로
//   보여줘 안 올려도 되는 줄 알았기 때문. 아래 가드는 그 원인이 되살아나는 것을 막는다.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SA = fs.readFileSync(path.join(__dirname, '../../frontend/js/search-app.js'), 'utf8');
const SH = fs.readFileSync(path.join(__dirname, '../../frontend/search.html'), 'utf8');
const IX = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const RR = fs.readFileSync(path.join(__dirname, '../src/routes/reviewer.routes.js'), 'utf8');

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok   ' + name); pass++; };

// ── ① 문구: 캡처를 '선택/편의기능'으로 보여주면 안 된다 ────────
t('1. 캡처 섹션에서 "(선택)" 표기가 사라지고 [필수] 배지가 붙었다', () => {
  assert.ok(!/주문 캡처 자동추출 <span[^>]*>\(선택\)/.test(SA),
    '"(선택)" 표기가 남아 있으면 리뷰어는 안 올려도 되는 줄 안다 — 미첨부의 최대 원인');
  const badges = (SA.match(/구매 캡처 <span[^>]*>필수<\/span>/g) || []);
  assert.strictEqual(badges.length, 2, '쿠팡·일반 두 카드 모두 [필수] 배지가 있어야 함: ' + badges.length);
});

t('2. 업로드 존 문구가 "증빙"임을 밝히고, 자동입력은 부가 설명으로 내려갔다', () => {
  const zones = (SA.match(/주문완료 화면을 캡처해 올려주세요/g) || []);
  assert.strictEqual(zones.length, 2, '두 카드 모두 증빙 문구여야 함');
  assert.ok(/증빙 자료<\/b>입니다/.test(SA), '왜 필요한지(증빙) 설명 누락');
  assert.ok(/자동 입력됩니다/.test(SA), '자동입력 이점 안내가 사라지면 첨부 동기가 줄어든다');
  assert.ok(!/주문캡처본 업로드 \(AI 자동추출\)/.test(SA), '옛 "편의기능" 문구가 남아 있음');
});

// ── ② 제출 게이트 ─────────────────────────────────────────────
t('3. 미첨부 카드를 실제로 골라낸다(_cardsMissingCapture, data: 접두 판정)', () => {
  assert.ok(/function _cardsMissingCapture\(\)/.test(SA), '게이트 판정 함수 없음');
  const fn = SA.slice(SA.indexOf('function _cardsMissingCapture'), SA.indexOf('function _closeCaptureGate'));
  assert.ok(/_imgThumb/.test(fn) && /startsWith\("data:"\)/.test(fn), '썸네일 data URI 로 첨부 여부를 봐야 함');
  assert.ok(/document\.getElementById\(cid\)/.test(fn), '삭제된 카드를 제외하지 않으면 유령 미첨부가 잡힌다');
});

t('4. confirmOrderSubmit 이 미첨부 시 게이트를 먼저 띄운다', () => {
  const fn = SA.slice(SA.indexOf('function confirmOrderSubmit'), SA.indexOf('async function submitOrderForm'));
  assert.ok(/_cardsMissingCapture\(\)/.test(fn), '제출 직전 미첨부 검사 없음');
  assert.ok(/captureGateModal/.test(fn), '게이트 모달을 띄우지 않음');
  assert.ok(fn.indexOf('_cardsMissingCapture') < fn.indexOf('_openOrderConfirm'),
    '기존 확인 모달보다 캡처 게이트가 먼저 와야 함');
});

t('5. ★ [캡처 없이 제출] 탈출구가 남아 있다(정당한 무캡처 제출 유실 방지)', () => {
  assert.ok(/_captureGateSkip\(\)/.test(SH), '탈출구 버튼이 없으면 수기·재제출 건이 통째로 막힌다');
  assert.ok(/function _captureGateSkip\(\)/.test(SA), '탈출구 핸들러 없음');
  const skip = SA.slice(SA.indexOf('function _captureGateSkip'), SA.indexOf('function _openOrderConfirm'));
  assert.ok(/_openOrderConfirm\(\)/.test(skip), '탈출 시 기존 제출 흐름으로 이어지지 않음');
});

t('6. 게이트 모달이 없는 구버전에서도 제출이 막히지 않는다(하위호환)', () => {
  const fn = SA.slice(SA.indexOf('function confirmOrderSubmit'), SA.indexOf('async function submitOrderForm'));
  assert.ok(/missing\.length && gate/.test(fn), '모달 부재 시 게이트를 건너뛰지 않으면 제출 불가가 된다');
});

t('7. [지금 올리기]는 그 카드로 스크롤 + 파일 선택을 연다', () => {
  const fn = SA.slice(SA.indexOf('function _captureGateAttach'), SA.indexOf('function _captureGateSkip'));
  assert.ok(/_imgZone/.test(fn) && /scrollIntoView/.test(fn), '해당 카드로 이동하지 않음');
  assert.ok(/_imgInput/.test(fn) && /click\(\)/.test(fn), '파일 선택창을 열지 않음');
});

// ── ③ 업로드 상태 추적 ────────────────────────────────────────
t('8. 업로드 진행/성공/실패가 추적된다(과거엔 실패해도 화면은 성공)', () => {
  assert.ok(/_capUploads/.test(SA), '업로드 추적 배열 없음');
  assert.ok(/_capSlot\.status = "uploading"/.test(SA), '진행 상태 없음');
  assert.ok(/_capSlot\.status = "ok"/.test(SA), '성공 반영 없음');
  assert.ok(/_capSlot\.status = "fail"/.test(SA), '실패 반영 없음');
  assert.ok(/window\._capUploads = \[\]/.test(SA), '재제출 시 초기화하지 않으면 이전 결과가 남는다');
});

t('9. 업로드 재시도가 유지된다(1회 실패로 미링크 되지 않게)', () => {
  // ⚠ 재시도 횟수는 3 → 4 로 늘었다(429 대기 갈래 추가). 검사 의미는 불변 = "재시도 루프가 있다".
  assert.ok(/for \(let attempt = 0; attempt < [34];/.test(SA), '재시도 루프 유실');
  assert.ok(/orderSubmissionId/.test(SA), '주문 연결 키 유실 → 링크 실패');
});

// ── ④ 완료화면 체크리스트 ─────────────────────────────────────
t('10. 완료화면에 캡처 체크리스트가 렌더된다', () => {
  assert.ok(/id="capChecklist"/.test(SA), '체크리스트 자리 없음');
  assert.ok(/function _renderCaptureChecklist\(\)/.test(SA), '체크리스트 렌더러 없음');
  const done = SA.slice(SA.indexOf('doneMsgEl.innerHTML'), SA.indexOf('doneMsgEl.innerHTML') + 400);
  assert.ok(/_renderCaptureChecklist\(\)/.test(done), '완료화면에서 호출하지 않음');
});

t('11. 체크리스트가 미첨부·실패를 눈에 띄게 알리고 보완 경로를 준다', () => {
  const fn = SA.slice(SA.indexOf('function _renderCaptureChecklist'), SA.indexOf('/** ★ 제출 완료/실패 후'));
  assert.ok(/구매 캡처 미첨부/.test(fn) && /업로드 실패/.test(fn), '미첨부·실패 표시 없음');
  assert.ok(/창을 닫지 말아주세요/.test(fn), '업로드 중 창 닫음 방지 안내 없음');
  assert.ok(/리뷰어 홈/.test(fn), '사후 보완 경로 안내 없음');
  assert.ok(/_safeText\(/.test(fn), '값 이스케이프 없음');
});

// ── ⑤ 사후 보완(리뷰어 홈) ────────────────────────────────────
t('12. 서버: 내 미첨부 주문 조회는 phone8 스코프 + 컷오프 적용', () => {
  const i = RR.indexOf("router.get('/my-missing-captures'");
  assert.ok(i > 0, '엔드포인트 없음');
  const body = RR.slice(i, RR.indexOf('module.exports', i));
  assert.ok(/phone8\.length !== 8/.test(body), 'phone8 검증 없음(타인 조회 가능)');
  assert.ok(/RIGHT\(regexp_replace/.test(body), '연락처 끝 8자리 매칭이 아님');
  assert.ok(/capture_uploaded_at IS NULL/.test(body), '미첨부 조건 없음');
  assert.ok(/NOT EXISTS[\s\S]*review_index[\s\S]*ri\.is_submitted = TRUE/.test(body),
    '리뷰 제출완료 참여를 보완 알림에서 제외하지 않는다');
  assert.ok(/campaign_participants cp[\s\S]*cp\.order_submission_id = os\.id/.test(body),
    '불변 주문 링크로 완료 참여를 확인하지 않는다');
  assert.ok(/review_index_archive/.test(body), '보관된 완료 참여가 보완 알림에서 되살아난다');
  assert.ok(/deleted_at IS NULL/.test(body), '취소된 주문까지 보완 요청하면 안 됨');
  assert.ok(/reviewer_log_capture_cutoff/.test(body), '컷오프 미적용 → 과거 주문까지 독촉하게 된다');
  assert.ok(!/\b(UPDATE|INSERT|DELETE)\b/i.test(body), '조회 엔드포인트인데 쓰기 쿼리가 있음');
});

t('13. 홈: 해당 건이 없으면 영역이 숨겨진다(평상시 화면 불변)', () => {
  assert.ok(/id="sectionMissingCapture"[^>]*style="display:none"/.test(IX), '기본 노출이면 평상시 화면이 바뀐다');
  const fn = IX.slice(IX.indexOf('function _renderMissingCaptures'), IX.indexOf('function _mcPick'));
  assert.ok(/if \(!_mcItems\.length\) \{ sec\.style\.display = 'none'/.test(fn), '빈 목록일 때 숨기지 않음');
});

t('14. 홈: 첨부는 기존 업로드 경로 + orderSubmissionId 재사용(신규 쓰기 표면 0)', () => {
  const fn = IX.slice(IX.indexOf('function _mcOnFile'), IX.indexOf('function _mcOnFile') + 2600);
  assert.ok(/\/api\/image\/image-upload/.test(fn), '기존 업로드 경로를 쓰지 않음');
  assert.ok(/orderSubmissionId: it\.id/.test(fn), '주문 연결 키 누락 → 첨부해도 링크가 안 됨');
  assert.ok(/f\.size > 12 \* 1024 \* 1024/.test(fn), '용량 상한 없음');
});

t('15. 홈: 조회 실패는 조용히 넘어가고 목록 값은 이스케이프된다', () => {
  const load = IX.slice(IX.indexOf('async function _loadMissingCaptures'), IX.indexOf('function _renderMissingCaptures'));
  assert.ok(/catch \(_\) \{ _mcItems = \[\]/.test(load), '조회 실패가 홈 렌더를 깨뜨리면 안 됨');
  const rend = IX.slice(IX.indexOf('function _renderMissingCaptures'), IX.indexOf('function _mcPick'));
  assert.ok(/esc2\(/.test(rend), '탭명·업체명 이스케이프 없음');
});

t('16. 홈: 리뷰 내역 로드 후 자동 호출된다', () => {
  assert.ok(/_loadMissingCaptures\(phone8\)/.test(IX), '자동 호출 배선 없음');
});

console.log('\n' + pass + ' runtime checks passed');
