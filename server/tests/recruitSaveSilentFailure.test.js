'use strict';
/**
 * 모집공고 저장 — **실패를 성공으로 보고하지 않는다** 회귀가드 (2026-08-23 실사고).
 *
 * 신고: 총인원이 공란인 공고에 200 을 입력해 저장했는데, "✓ 저장됨 · 공고 수정이
 *   반영되었습니다"(변경 목록에 '총 모집인원'까지)가 뜨고 모달이 닫혔다. 그런데 다시 열면
 *   여전히 공란이었다.
 *
 * 원인: 이 API 의 errorHandler 는 **GAS 호환**으로 실패를 `HTTP 200 + { error }` 로 돌려준다
 *   (`server/src/middleware/error.middleware.js`). 저장 코드가 `res.ok`(HTTP 상태)만 보고
 *   본문을 안 봐서, 서버가 거부한 저장(예: "이미 참여자 또는 구매양식이 있는 작업보드
 *   인원보다 낮게 목표 인원을 설정할 수 없습니다")이 그대로 성공 경로를 탔다.
 *   → 아무것도 저장되지 않았는데 화면은 성공을 말하고, 다시 열면 옛 값이라
 *     "고쳐도 저장이 안 된다"로 보인다.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const recruit = fs.readFileSync(path.join(root, 'frontend/js/index-recruit.js'), 'utf8');
const errMw = fs.readFileSync(path.join(root, 'server/src/middleware/error.middleware.js'), 'utf8');

let fail = 0;
const t = (name, fn) => { try { fn(); console.log('ok -', name); } catch (e) { fail++; console.error('NOT OK -', name, '\n   ', e.message); } };

t('★ 이 검사의 전제 — errorHandler 는 실패를 HTTP 200 + { error } 로 돌려준다', () => {
  if (!/res\.status\(200\)\.json\(\{\s*\n?\s*error:/.test(errMw))
    throw new Error('errorHandler 가 200+{error} 를 돌려주지 않는다면 이 가드의 전제가 바뀐 것이다 — 저장 판정도 함께 재검토할 것');
  if (!/req\.path\.startsWith\('\/api\/campaign\/'\)/.test(errMw))
    throw new Error('/api/campaign/ 이 isAdminApi 에서 빠지면 사유가 마스킹돼 화면이 원인을 못 말한다');
});

t('저장 응답은 본문으로 판정한다 — ok:false 또는 error 면 실패', () => {
  if (!/if \(saved && \(saved\.ok === false \|\| saved\.error\)\) \{[\s\S]{0,220}?throw new Error\(String\(saved\.error/.test(recruit))
    throw new Error('HTTP 200 + { error } 를 실패로 읽지 않으면 거부된 저장이 "✓ 저장됨"으로 표시된다');
});

t('★ 판정은 성공 처리보다 **앞**에 온다', () => {
  const body = recruit.slice(recruit.indexOf('async function saveRecruitPostImpl'),
                             recruit.indexOf('async function saveRecruitPost('));
  const check = body.indexOf('saved.ok === false || saved.error');
  const newId = body.indexOf('const newCampId');
  const okFlag = body.indexOf('_ok = true;');
  const feedback = body.indexOf('campSaveFeedback(');
  if (check < 0) throw new Error('본문 판정이 saveRecruitPostImpl 안에 없다');
  if (!(check < newId && check < okFlag && check < feedback))
    throw new Error('판정이 늦으면 역연결·성공 안내·모달 닫힘이 먼저 일어난다');
});

t('★ HTTP 상태 검사는 그대로 둔다 — 두 갈래를 모두 막는다', () => {
  if (!/if \(!res\.ok\) \{[\s\S]{0,200}?throw new Error\(errData\.error/.test(recruit))
    throw new Error('상태코드 검사를 없애면 진짜 4xx/5xx 가 통과한다(본문 판정으로 대체 금지)');
});

t('★ 성공 응답은 종전대로 — data 만 있고 error 가 없으면 통과', () => {
  // 판정은 error/ok:false 에만 걸린다. data 유무로 실패를 단정하면(예: 응답 shape 변화)
  // 정상 저장이 실패로 보고되어 담당자가 같은 저장을 반복한다.
  if (/if \(saved && !saved\.data\)/.test(recruit))
    throw new Error('data 부재를 실패로 단정하지 말 것 — 성공 응답 shape 변화에 취약하다');
});

t('실패는 모달을 열어 둔 채 사유를 남긴다(토스트로 흘리지 않는다)', () => {
  if (!/_rfSaveBlocked\("저장하지 못했습니다 — "/.test(recruit))
    throw new Error('실패 사유가 모달 안에 남지 않으면 "눌렀는데 아무 반응 없음"이 된다');
});

console.log(fail ? `\n${fail}건 실패` : '\n전부 통과');
process.exit(fail ? 1 : 0);
