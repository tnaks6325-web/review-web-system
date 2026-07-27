/**
 * campaignAdminPreview.test.js — 관리자 "리뷰어 화면 미리보기" 회귀가드 (소스 grep + 순수 판정)
 * 실행: node tests/campaignAdminPreview.test.js
 *
 * 고정하는 불변식:
 *  ① 서버 미리보기는 **관리자 전용 별도 라우트**이며 무인증 work-detail 게이트는 미변경(격리)
 *  ② 미리보기 경로는 **DB write 0** — campaign_applications INSERT/UPDATE 없음(홀드·정원 카운터 무오염)
 *  ③ campaign.html 미리보기는 홀드 상태를 읽지도 쓰지도 않음(같은 브라우저 리뷰어 홀드 격리)
 *  ④ 미리보기에서 서버 상태를 바꾸는 동작(참여·옵션변경·취소) 전부 차단
 *  ⑤ **구매양식 제출 차단** — preview 플래그는 embed 컨텍스트 안에서만 존재하고,
 *     리뷰어 진입 URL에는 preview가 실리지 않아 제출 동작이 불변(최악 시나리오 방어)
 *  ⑥ 관리자 토큰은 프래그먼트(#tok=)로 전달 후 주소창에서 제거
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const camp = readF('campaign.html');
const sapp = readF('js/search-app.js');
const recjs = readF('js/index-recruit.js');
const routes = readS('routes/campaign.routes.js');
const authmw = readS('middleware/auth.middleware.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── ① 서버: 관리자 전용 라우트 · 리뷰어 게이트 무변경 ──
ok('①-1 GET /admin/:id/preview 는 authMiddleware + adminOrMaster',
  /router\.get\('\/admin\/:id\/preview',\s*authMiddleware,\s*adminOrMasterMiddleware/.test(routes));
ok('①-2 무인증 work-detail 의 이중열쇠 게이트 그대로(phone8 8자리 + holdToken)',
  /router\.get\('\/:id\/work-detail'/.test(routes)
  && /phone8\(8자리\)과 holdToken이 필요합니다/.test(routes)
  && /reason: 'no_hold'/.test(routes));
ok('①-3 work-detail 에 관리자 우회 분기가 생기지 않음(_isAdminReq 미사용)', (() => {
  const m = routes.match(/router\.get\('\/:id\/work-detail'[\s\S]*?\n\}\);/);
  return !!m && !/_isAdminReq|adminOrMaster|req\.admin/.test(m[0]);
})());
ok('①-4 참여형 공고에만 미리보기 허용(레거시 공고 차단)', (() => {
  const m = routes.match(/router\.get\('\/admin\/:id\/preview'[\s\S]*?\n\}\);/);
  return !!m && /participation_mode/.test(m[0]) && /참여형 공고가 아닙니다/.test(m[0]);
})());

// ── ② 미리보기 라우트는 DB write 0 ──
ok('②-1 preview 라우트 본문에 INSERT/UPDATE/DELETE 없음(홀드·카운터 무오염)', (() => {
  const m = routes.match(/router\.get\('\/admin\/:id\/preview'[\s\S]*?\n\}\);/);
  return !!m && !/\b(INSERT|UPDATE|DELETE)\b/i.test(m[0]);
})());
ok('②-2 application 은 미저장 가짜 객체(id:\'preview\')', /id: 'preview'/.test(routes));
ok('②-3 미리보기에서는 옵션 변경 불가(canChangeOption:false)', (() => {
  const m = routes.match(/router\.get\('\/admin\/:id\/preview'[\s\S]*?\n\}\);/);
  return !!m && /canChangeOption: false/.test(m[0]);
})());

// ── ①b 토큰 격리: 리뷰어앱 스코프 토큰은 preview 라우트에 도달 불가 ──
ok('①b reviewer_campaign 스코프 토큰 허용은 PUT + 끝앵커라 GET /preview 미허용',
  /req\.method === 'PUT' && \/\^\\\/api\\\/campaign\\\/admin\\\/\[\^\/\]\+\$\//.test(authmw));

// ── ③ campaign.html: 홀드 격리 ──
ok('③-1 PREVIEW 는 ?preview=1 **그리고 관리자 토큰**이 있을 때만 true(링크 공유 사고 방지)',
  /const PREVIEW_REQ = new URLSearchParams\(location\.search\)\.get\('preview'\) === '1'/.test(camp)
  && /let PREVIEW = false;/.test(camp)
  && /if\(PREVIEW_REQ\)\{ _pvCaptureToken\(\); PREVIEW = !!_pvToken\(\); \}/.test(camp));
ok('③-2 미리보기는 홀드를 읽지 않음(getHold 조기 null)', /function getHold\(\)\{[\s\S]{0,120}if\(PREVIEW\) return null;/.test(camp));
ok('③-3 미리보기는 홀드를 쓰지 않음(setHold/clearHold 가드)',
  /function setHold\(h\)\{ if\(PREVIEW\) return;/.test(camp) && /function clearHold\(\)\{ if\(PREVIEW\) return;/.test(camp));
ok('③-4 미리보기는 폴링하지 않음', /if\(!PREVIEW\) startPolling\(\)/.test(camp));
ok('③-5 미리보기 진입은 관리자 전용 엔드포인트 + Bearer', /\/api\/campaign\/admin\/'[\s\S]{0,80}\/preview'[\s\S]{0,120}Authorization[\s\S]{0,20}Bearer/.test(camp));

// ── ④ 상태 변경 동작 차단 ──
for (const [label, re] of [
  ['참여하기(onJoin)', /async function onJoin\(\)\{\s*\n\s*if\(PREVIEW\) return _pvBlock/],
  ['참여신청(_doApply)', /async function _doApply\(optionKey\)\{\s*\n\s*if\(PREVIEW\) return _pvBlock/],
  ['옵션변경(_doChangeOption)', /async function _doChangeOption\(newKey\)\{\s*\n\s*if\(PREVIEW\) return _pvBlock/],
  ['참여취소(onCancel)', /async function onCancel\(\)\{\s*\n\s*if\(PREVIEW\) return _pvBlock/],
]) ok('④ 미리보기에서 ' + label + ' 차단', re.test(camp));

// ── ⑤ 구매양식 제출 차단 (최악 시나리오 방어) ──
ok('⑤-1 preview 플래그는 embed 컨텍스트 안에서만 정의(embed=1 없으면 도달 불가)',
  /if \(q\.get\("embed"\) !== "1"\) return null;/.test(sapp)
  && /preview: q\.get\("preview"\) === "1"/.test(sapp)
  && /const _PREVIEW_MODE = !!\(_EMBED_CTX && _EMBED_CTX\.preview\)/.test(sapp));
ok('⑤-2 제출 진입점 2곳 모두 조기 차단(confirmOrderSubmit·submitOrderForm)',
  /function confirmOrderSubmit\(\) \{\s*\n\s*if \(_PREVIEW_MODE\)/.test(sapp)
  && /async function submitOrderForm\(\) \{[\s\S]{0,200}?if \(_PREVIEW_MODE\)/.test(sapp));
ok('⑤-3 리뷰어 경로 iframe URL에는 preview 미포함 · 홀드 문맥만(동작 불변)',
  /if\(PREVIEW\)\{ qp\.set\('preview','1'\); \}\s*\n\s*else \{ qp\.set\('app'[\s\S]{0,120}holdToken[\s\S]{0,60}holdPhone8/.test(camp));
ok('⑤-4 미리보기 iframe에는 홀드 문맥(app·holdToken) 미전달', (() => {
  const m = camp.match(/if\(PREVIEW\)\{ qp\.set\('preview','1'\); \}/);
  return !!m && !/qp\.set\('preview','1'\);\s*qp\.set\('app'/.test(camp);
})());
ok('⑤-5 미리보기는 폼 입력값을 저장/복원하지 않음(_EMBED_FORM_KEY 공란)',
  /!_EMBED_CTX\.preview && _EMBED_CTX\.app\) \? \("embedForm_"/.test(sapp)
  && /if \(!_EMBED_CTX \|\| !_EMBED_FORM_KEY\) return;/.test(sapp));
ok('⑤-6 로그인 강제 우회는 미리보기 한정(리뷰어는 기존 게이트 유지)',
  /if \(_PREVIEW_MODE\) \{\s*\n\s*authSession = \{ name: "미리보기", phone8: "" \};\s*\n\s*\}/.test(sapp)
  && /if \(!authSession \|\| !authSession\.name\) \{/.test(sapp));
ok('⑤-7 제출 버튼 비활성 CSS는 preview 전용 body 클래스에만 적용',
  /body\.embed-preview #btnOrderFormSubmit\{opacity/.test(sapp)
  && /if \(_PREVIEW_MODE\) document\.body\.classList\.add\("embed-preview"\)/.test(sapp));

// ── ⑥ 진입점 · 토큰 전달 ──
ok('⑥-1 공고 카드에 [리뷰어 화면] 버튼(참여형만)', /openReviewerPreview\('\$\{escHtml\(c\.id\)\}'\)/.test(recjs));
ok('⑥-2 수정 모달 미리보기에 전체화면 링크(편집 중 + 참여형일 때만)',
  /_recruitEditId && document\.getElementById\("rf_participation"\)[\s\S]{0,80}openReviewerPreview/.test(recjs));
ok('⑥-3 토큰은 프래그먼트(#tok=)로 전달 — 서버 로그·Referer 미유출',
  /preview=1#tok=" \+ encodeURIComponent\(token\)/.test(recjs));
ok('⑥-4 도착 즉시 주소창·히스토리에서 토큰 제거(fetch보다 먼저)',
  /history\.replaceState\(null, ''/.test(camp)
  && /if\(PREVIEW_REQ\)\{ _pvCaptureToken\(\);[\s\S]{0,40}\}\s*\n\s*try\{\s*\n\s*await loadCampaign/.test(camp));
ok('⑥-5 전용 저장키 사용 — sessionStorage.admin_token 을 덮어쓰지 않음',
  /PV_TOK_KEY = 'camp_preview_tok'/.test(camp) && !/sessionStorage\.setItem\('admin_token'/.test(camp));

// ── ⑦ 레드팀 지적 반영(재발 방지) ──
ok('⑦-R1 주소창에서 preview 파라미터 제거 — 복사·공유해도 평범한 리뷰어 링크',
  /q\.delete\('preview'\)/.test(camp) && /history\.replaceState\(null, '', location\.pathname \+ \(qs \? '\?' \+ qs : ''\)\)/.test(camp));
ok('⑦-R2 토큰 저장 실패해도 주소창 정리는 항상 실행(finally)',
  /\}catch\(_\)\{ \/\* 저장 실패해도 아래 정리는 수행 \*\/ \}\s*\n\s*finally\{/.test(camp));
ok('⑦-R2b 미리보기 새 창은 noopener — sessionStorage(관리자 토큰) 미복제',
  /window\.open\(f\.src, '_blank', PREVIEW \? 'noopener' : ''\)/.test(camp));
ok('⑦-R3 마감·게시전 공고도 진행 화면 확인 가능(모집중 가정 토글)',
  /_pvForceOpen/.test(camp) && /if\(PREVIEW && _pvForceOpen\)\{ jb\.disabled = false;/.test(camp) && /function pvToggleForce\(\)/.test(camp));
ok('⑦-R4 수정 모달 미리보기 버튼은 참여형일 때만(레거시 공고 리다이렉트 방지)',
  /rf_participation"\)\.checked\) \? `<button onclick="openReviewerPreview/.test(recjs));
ok('⑦-R5 미리보기는 잔여 리뷰어 세션을 쓰지 않음(타인 계좌·실명 노출 차단)',
  /if \(_PREVIEW_MODE\) \{\s*\n\s*authSession = \{ name: "미리보기", phone8: "" \};/.test(sapp)
  && /if \(!_PREVIEW_MODE\) \{\s*\n\s*_prefillBankFromProfile\(\)/.test(sapp));
ok('⑦-R6 단계 전환 시 iframe 재로드 안 함(시트 쿼터 보호)',
  /if\(frame\.getAttribute\('src'\) !== _src\)\{/.test(camp));
ok('⑦-R7 미리보기 로드 실패 시 단계 버튼 제거(가짜 완료화면 방지)',
  /function _pvFail\(msgHtml\)\{/.test(camp) && /steps\.style\.display = 'none'/.test(camp));
ok('⑦-R8 카운트다운 0 재조회가 작업가이드·완료 화면을 되돌리지 않음(리뷰어 경로 포함)',
  /const onPre = \$\('vPre'\)\.style\.display !== 'none' \|\| \$\('vLoading'\)\.style\.display !== 'none';/.test(camp)
  && /if\(!onPre\) return;/.test(camp));
ok('⑦-R10 미리보기는 선택 가능한 옵션만 고정표시(마감 옵션 오표시 방지) · 리뷰어 전달 경로는 불변',
  /const _pvOptBlocked = PREVIEW && !\(_selOpt && _selOpt\.selectable\);/.test(camp)
  && /if\(j\.application && j\.application\.optionKey\) qp\.set\('optionKey', j\.application\.optionKey\)/.test(camp));
ok('⑦-R11 팝업 차단 시 안내(무반응 방지)', /if \(!w\) showToast\("팝업이 차단되었습니다/.test(recjs));

console.log(`\n✅ campaignAdminPreview: ${passed}개 통과`);
