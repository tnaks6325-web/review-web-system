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
// ★ 063 2단계에서 홀드 저장이 v2(명의별 맵)로 바뀌며 PREVIEW 차단 지점이 _allHolds로 이동.
//   getHold()는 _allHolds()를 거치므로 미리보기에서 여전히 null(실행 검증 완료).
ok('③-2 미리보기는 홀드를 읽지 않음(_allHolds 조기 빈 맵 → getHold null)',
  /function _allHolds\(\)\{\s*\n?\s*if\(PREVIEW\) return \{\}/.test(camp)
  && /function getHold\(p8\)\{[\s\S]{0,160}_allHolds\(\)/.test(camp));
// ★ 063 2단계 v2: 쓰기 경로가 4개(_saveHolds/setHold/clearHold/setActiveP8)로 늘었다 — 전부 PREVIEW 차단.
ok('③-3 미리보기는 홀드를 쓰지 않음(저장 경로 4곳 전부 PREVIEW 가드)',
  /function _saveHolds\(m\)\{ if\(PREVIEW\) return;/.test(camp)
  && /function setHold\(h\)\{\s*\n?\s*if\(PREVIEW \|\| !h/.test(camp)
  && /function clearHold\(p8\)\{\s*\n?\s*if\(PREVIEW\) return;/.test(camp)
  && /function setActiveP8\(p8\)\{ if\(PREVIEW\) return;/.test(camp));
ok('③-4 미리보기는 폴링하지 않음', /if\(!PREVIEW\) startPolling\(\)/.test(camp));
ok('③-5 미리보기 진입은 관리자 전용 엔드포인트 + Bearer',
  /_pvGet\('\/api\/campaign\/admin\/' \+ encodeURIComponent\(CAMP_ID\) \+ '\/preview'\)/.test(camp)
  && /Authorization[\s\S]{0,20}Bearer \' \+ tok/.test(camp));
/* ★ 리뷰웹시스템[3버전](인트라넷 SSO 토큰 via:'intranet')는 `/api/campaign/admin/*` 에 도달 자체가 불가 →
   같은 핸들러를 위임하는 `/api/trackb/campaigns/:id/preview` 로 **401/403 일 때만** 한 번 더 시도한다.
   그 외 오류까지 재시도하면 실패 원인이 가려진다(무한 폴백 금지). */
ok('③-5b Track B 경로 폴백은 401/403 에서만',
  /if\(r\.status === 401 \|\| r\.status === 403\)\s*\n\s*r = await _pvGet\('\/api\/trackb\/campaigns\/'/.test(camp));

// ── ④ 상태 변경 동작 차단 ──
for (const [label, re] of [
  // ★ 옵션변경은 "막기" 대신 **가상 시뮬레이션**으로 바뀌었다(관리자가 흐름을 끝까지 볼 수 있게).
  //   규칙은 그대로다 — 서버 상태를 바꾸지 않는다. 아래에서 그 시뮬레이션에 **서버 호출이 0** 임을 못박는다.
  ['옵션변경(_doChangeOption)', /async function _doChangeOption\(newKey\)\{\s*\n\s*if\(PREVIEW\) return _pvSimulateChangeOption/],
  // ★ 063 2단계 신규 진입점도 동일 차단(명의 선택·타계정 추가참여)
  ['명의선택(openAcctSheet)', /async function openAcctSheet\(optionKey, next\)\{\s*\n\s*if\(PREVIEW\) return _pvBlock/],
  ['타계정 추가참여(onAddSubJoin)', /async function onAddSubJoin\(\)\{\s*\n\s*if\(PREVIEW\) return _pvBlock/],
]) ok('④ 미리보기에서 ' + label + ' 차단', re.test(camp));
ok('④ 미리보기에서 명의 전환(switchAcct)도 무동작', /async function switchAcct\(p8\)\{\s*\n\s*if\(PREVIEW\) return;/.test(camp));
// ★★ 시뮬레이션 경로에 **서버 호출이 한 줄도 없어야** "미리보기는 서버 상태를 안 바꾼다"가 성립한다.
//   (막는 대신 흉내내는 방식으로 바뀐 만큼, 이 검사가 그 전제를 대신 지킨다.)
for (const fn of ['_pvSimulateChangeOption', '_pvSimulateApply']) {
  const i = camp.indexOf('function ' + fn);
  ok('④ ' + fn + ' 가 존재한다', i > -1);
  const m = /\n(?:async )?function /g; m.lastIndex = i + 10;
  const e = m.exec(camp);
  const body = camp.slice(i, e ? e.index : i + 2000);
  ok('★★ ' + fn + ' 는 서버를 부르지 않는다(가상 진행만)',
    !/\bfetch\(|\bapi\(|_pvGet\(|\/apply|\/change-option/.test(body));
}
ok('★ 미리보기임을 화면이 말한다(실제 기록으로 오해 금지)',
  /실제 참여 기록은 남지 않습니다/.test(camp));

// ── ⑤ 구매양식 제출 차단 (최악 시나리오 방어) ──
ok('⑤-1 preview 플래그는 embed 컨텍스트 안에서만 정의(embed=1 없으면 도달 불가)',
  /if \(q\.get\("embed"\) !== "1"\) return null;/.test(sapp)
  && /preview: q\.get\("preview"\) === "1"/.test(sapp)
  && /const _PREVIEW_MODE = !!\(_EMBED_CTX && _EMBED_CTX\.preview\)/.test(sapp));
ok('⑤-2 제출 진입점은 미리보기 전용 로컬 완료 경로를 거친다', (() => {
  const confirm = sapp.slice(sapp.indexOf('function confirmOrderSubmit'), sapp.indexOf('function _closeOrderConfirm'));
  const submit = sapp.slice(sapp.indexOf('async function submitOrderForm'), sapp.indexOf('function _renderCaptureChecklist'));
  return /if \(_PREVIEW_MODE\) \{ _openOrderConfirm\(\); return; \}/.test(confirm)
    && /if \(_PREVIEW_MODE\) \{ _finishPreviewSubmit\(\); return; \}/.test(submit);
})());
ok('⑤-3 리뷰어 경로 iframe URL에는 preview 미포함 · 홀드 문맥만(동작 불변)',
  /if\(PREVIEW\)\{ qp\.set\('preview','1'\); \}\s*\n\s*else \{\s*\n?\s*qp\.set\('app'[\s\S]{0,160}holdToken[\s\S]{0,80}holdPhone8/.test(camp));
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
ok('⑤-7 제출 버튼은 미리보기에서도 가상 제출을 위해 활성 상태다',
  !/body\.embed-preview #btnOrderFormSubmit\{opacity/.test(sapp)
  && /if \(_PREVIEW_MODE\) document\.body\.classList\.add\("embed-preview"\)/.test(sapp));

// ── ⑤-8 관리자 미리보기 진행 시뮬레이션 ──
ok('⑤-8-1 미리보기 참여는 로컬 가상 신청으로만 진행하고 /apply 요청을 보내지 않는다', (() => {
  const fn = camp.slice(camp.indexOf('async function _doApply'), camp.indexOf('async function _doChangeOption'));
  return /if\(PREVIEW\) return _pvSimulateApply\(optionKey\);/.test(fn)
    && /function _pvSimulateApply\(optionKey\)/.test(camp)
    && !/\/apply'/.test(fn.slice(0, fn.indexOf("const s = getSession")));
})());
ok('⑤-8-2 미리보기 가상 제출은 부모에만 완료 신호를 보내고 실제 주문 전송을 하지 않는다', (() => {
  const confirm = sapp.slice(sapp.indexOf('function confirmOrderSubmit'), sapp.indexOf('function _closeOrderConfirm'));
  const submit = sapp.slice(sapp.indexOf('async function submitOrderForm'), sapp.indexOf('function _renderCaptureChecklist'));
  return /if \(_PREVIEW_MODE\) \{ _openOrderConfirm\(\); return; \}/.test(confirm)
    && /if \(_PREVIEW_MODE\) \{ _finishPreviewSubmit\(\); return; \}/.test(submit)
    && /function _finishPreviewSubmit\(\)/.test(sapp)
    && /simulation: true/.test(sapp);
})());
ok('⑤-8-3 가상 제출 완료는 실제 참여 확정 문구 대신 시뮬레이션 완료로 표시한다',
  /if\(PREVIEW\)\{[\s\S]{0,600}_pvSimSubmitted/.test(camp)
  && /시뮬레이션 제출 완료/.test(camp));

// ── ⑥ 진입점 · 토큰 전달 ──
ok('⑥-1 공고 카드에 [리뷰어 화면] 버튼(참여형만)', /openReviewerPreview\('\$\{escHtml\(c\.id\)\}'\)/.test(recjs));
// 인라인 모형 카드가 실제 렌더러(CampWorkDetail)로 교체되면서 버튼이 템플릿 문자열 → HTML+배선으로 이동.
// 게이트 의도(편집 중 + 참여형일 때만 노출)와 openReviewerPreview 연결은 동일하게 고정한다.
ok('⑥-2 수정 모달 미리보기에 전체화면 링크(편집 중 + 참여형일 때만)',
  /rf_preview_full/.test(recjs)
  && /_recruitEditId && _part && _part\.checked/.test(recjs)
  && /_pvBtn\.onclick = \(\) => openReviewerPreview\(_recruitEditId\)/.test(recjs)
  && /id="rf_preview_full"/.test((readF('js/recruit-modal.js') + readF('admin.html'))));
ok('⑥-3 토큰은 프래그먼트(#tok=)로 전달 — 서버 로그·Referer 미유출',
  /preview=1(?:&previewBuild=sim-20260814)?#tok=" \+ encodeURIComponent\(token\)/.test(recjs));
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
// 버튼이 템플릿 문자열 → HTML+배선으로 이동(인라인 모형 제거). 게이트 규칙은 동일 —
// 참여형(rf_participation 체크)이 아니면 display:none 이라 레거시 공고에선 눌릴 수 없다.
ok('⑦-R4 수정 모달 미리보기 버튼은 참여형일 때만(레거시 공고 리다이렉트 방지)',
  /_pvBtn\.style\.display = \(_recruitEditId && _part && _part\.checked\) \? "" : "none"/.test(recjs)
  && /id="rf_preview_full"[\s\S]{0,240}display:none/.test((readF('js/recruit-modal.js') + readF('admin.html'))));
ok('⑦-R5 미리보기는 잔여 리뷰어 세션을 쓰지 않음(타인 계좌·실명 노출 차단)',
  /if \(_PREVIEW_MODE\) \{\s*\n\s*authSession = \{ name: "미리보기", phone8: "" \};/.test(sapp)
  && /if \(!_PREVIEW_MODE\) \{[\s\S]{0,500}_prefillBankFromProfile\(\)/.test(sapp));
ok('⑦-R6 미리보기 단계 전환 시만 iframe 재로드 생략(리뷰어는 항상 재로드 = TOCTOU 봉합 유지)',
  /if\(!PREVIEW \|\| frame\.getAttribute\('src'\) !== _src\)\{/.test(camp));
ok('⑦-R8b 참여 취소 후에는 참여 전 화면으로 명시 복귀(가드로 인한 정체 방지)',
  /참여가 취소되었어요'\); await loadCampaign\(\); if\(_camp\) renderPre\(\);/.test(camp));
ok('⑦-R7 미리보기 로드 실패 시 단계 버튼 제거(가짜 완료화면 방지)',
  /function _pvFail\(msgHtml\)\{/.test(camp) && /steps\.style\.display = 'none'/.test(camp));
ok('⑦-R8 카운트다운 0 재조회가 작업가이드·완료 화면을 되돌리지 않음(리뷰어 경로 포함)',
  /const onPre = \$\('vPre'\)\.style\.display !== 'none' \|\| \$\('vLoading'\)\.style\.display !== 'none';/.test(camp)
  && /if\(!onPre\) return;/.test(camp));
ok('⑦-R10 미리보기 실제 상태 모드는 선택 가능한 옵션만 고정표시(마감 옵션 오표시 방지) · 리뷰어 전달 경로는 불변',
  /const _pvOptBlocked = PREVIEW && !_pvOpenSim\(\) && !\(_selOpt && _selOpt\.selectable\);/.test(camp)
  && /if\(j\.application && j\.application\.optionKey\) qp\.set\('optionKey', j\.application\.optionKey\)/.test(camp));
ok('⑦-R11 팝업 차단 시 안내(무반응 방지)', /if \(!w\) showToast\("팝업이 차단되었습니다/.test(recjs));
ok('⑦-R12 관리자 미리보기는 새 URL로 열려 이전 캐시가 아닌 현재 시뮬레이션 코드를 사용',
  /&preview=1&previewBuild=sim-20260814#tok=/.test(recjs)
  && /q\.delete\('previewBuild'\)/.test(camp));

// ── ⑧ '모집중 가정' = 마감 공고도 끝까지 시뮬레이션 (사용자 확정 2026-08-20) ──
//   마감된 공고는 카드·옵션·참여 버튼이 전부 잠겨 정작 확인하려는 진행 화면을 볼 수 없었다.
//   판정은 _pvOpenSim() 하나로 모으고(사본 금지), 토글을 끄면 즉시 실제 상태로 복귀한다.
ok('⑧-1 모집중 가정 판정 단일 출처 _pvOpenSim()',
  /function _pvOpenSim\(\)\{ return PREVIEW && _pvForceOpen; \}/.test(camp));
ok('⑧-2 모집중 가정에서는 마감 옵션도 선택 가능(실제 리뷰어 경로는 서버 selectable 그대로)',
  /function _pvOptionSelectable\(o\)\{ return !!o && \(_pvOpenSim\(\) \|\| o\.status === 'open'\); \}/.test(camp)
  && /o => PREVIEW \? _pvOptionSelectable\(o\) : o\.selectable/.test(camp));
ok('⑧-3 카드도 열린 모습으로 그린다 — 단, 서버 데이터(_camp)는 안 건드린다',
  /_pvOpenSim\(\)\s*\n?\s*\? \{ \.\.\.c, state:'open', stateReason:'', status:'active' \}/.test(camp)
  && /CampCards\.cardHtml\(_cardData\)/.test(camp));
ok('⑧-4 옵션 목록에 마감 표기·흐림 처리를 하지 않는다',
  /if\(_pvOpenSim\(\) && o\.status !== 'open'\) return '모집중 가정\(미리보기\)';/.test(camp)
  && /if\(_pvOpenSim\(\)\) return '';/.test(camp)
  && /const dim = !_pvOpenSim\(\) && o\.status !== 'open';/.test(camp));
ok('⑧-5 실제 상태 토글로 되돌릴 수 있다(가정은 표시 전용)',
  /function pvToggleForce\(\)\{[\s\S]{0,320}_pvForceOpen = !_pvForceOpen;/.test(camp));
ok('⑧-6 서버 상태 변경 0 유지 — 가상 참여는 여전히 _pvSimulateApply 로만',
  /if\(PREVIEW\) return _pvSimulateApply\(optionKey\); \/\/ 어떤 경로로도/.test(camp));

console.log(`\n✅ campaignAdminPreview: ${passed}개 통과`);
