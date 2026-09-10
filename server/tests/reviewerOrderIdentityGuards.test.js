'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const service = read('src/services/reviewerOrderIdentity.service.js');
const reviewerRoutes = read('src/routes/reviewer.routes.js');
const submitRoutes = read('src/routes/submit.routes.js');
const reviewerServiceSource = read('src/services/reviewer.service.js');
const corsMiddleware = read('src/middleware/cors.middleware.js');
const diagRoutes = read('src/routes/diag.routes.js');
const gemini = read('src/services/gemini.service.js');
const migration = read('migrations/147_reviewer_shopping_identity_match.sql');
const appJs = read('../frontend/js/search-app.js');
const searchCss = read('../frontend/css/search.css');
const campaign = read('../frontend/campaign.html');
const index = read('../frontend/index.html');
const envExample = read('../.env.example');

let passed = 0;
function ok(label, condition) { assert.ok(condition, label); passed++; console.log('  ✓ ' + label); }

ok('명의 게이트는 기본 OFF인 명시적 기능 플래그다',
  /REVIEWER_CAPTURE_IDENTITY_ENABLED === 'true'/.test(service)
  && /REVIEWER_CAPTURE_IDENTITY_ENABLED=false/.test(envExample));
ok('명의별 공통 아이디와 비식별 감사원장을 가산형 마이그레이션으로 추가한다',
  /ADD COLUMN IF NOT EXISTS shopping_id/.test(migration)
  && /CREATE TABLE IF NOT EXISTS reviewer_identity_match_audits/.test(migration)
  && /selected_identity_hash/.test(migration)
  && !/recipient|address|phone\s+TEXT/i.test(migration));
ok('리뷰어 프로필 신규 경로는 서명 세션과 소유자 UUID로만 접근한다',
  /profile\/secure', reviewerSessionMiddleware/.test(reviewerRoutes)
  && /req\.reviewer\.ownerReviewerId/.test(reviewerRoutes));
ok('리뷰어 세션 헤더는 Cloudflare와 Railway 사이 CORS preflight에서 허용한다',
  /allowedHeaders:\s*\[[^\]]*['"]X-Reviewer-Token['"]/.test(corsMiddleware));
ok('기능 활성 시 레거시 profile 및 precheck도 phone8 단독 접근을 허용하지 않는다',
  /router\.post\('\/profile', bindProfileOwnerWhenEnabled/.test(reviewerRoutes)
  && /router\.post\('\/identity-precheck', imageApiLimiter, bindProfileOwnerWhenEnabled/.test(reviewerRoutes));
ok('주문 제출은 검증 홀드에서 승인토큰을 서버 재검증하고 내부 오류도 차단한다',
  /holdCtx && holdCtx\.verified/.test(submitRoutes)
  && /verifyApprovalForSubmission/.test(submitRoutes)
  && /IDENTITY_GATE_UNAVAILABLE/.test(submitRoutes));
const newGate = submitRoutes.slice(submitRoutes.indexOf('if (_newIdentityGate)'), submitRoutes.indexOf('} else if (_idPhone8.length'));
ok('신규 제출 게이트에는 identityConfirmed 우회가 없다',
  newGate.length > 0 && !/identityConfirmed|skipDetailChecks/.test(newGate));
ok('AI 추출 응답은 이미지 해시와 추출필드 서명증명을 함께 발급한다',
  /hashImageBase64\(imageBase64\)/.test(diagRoutes)
  && /issueExtractionProof/.test(diagRoutes));
ok('Gemini 로그는 주문 원문이나 모델 원문 응답을 기록하지 않는다',
  !/주소비교 JSON 파싱 실패:\s*\$\{text\./.test(gemini)
  && !/key\.slice\(0,\s*6\)/.test(gemini)
  && /추출필드=\$\{Object\.values/.test(gemini));
ok('타계정은 허용 공고에서만 서버가 인정한다',
  /selected\.type === 'sub' && !app\.multi_account_mode/.test(service)
  && /SUB_ACCOUNT_NOT_ALLOWED/.test(service));
ok('다른 명의만 맞으면 하드 차단하고 선택 명의도 충분히 맞으면 수동확인으로 보낸다',
  /other\.matches >= 2[\s\S]{0,500}?multiple_identity_candidates[\s\S]{0,220}?status = 'MISMATCH'/.test(service));
// 배송지 예외/명의 불일치 차단은 reviewerOrderIdentity.test.js와 Flow 테스트에서
// 실제 판정 및 승인토큰 검증으로 확인한다.
ok('가림 주소는 모든 연속 가림문자를 제거해 비교한다',
  /MASK_RUN_RE = \/\[\*＊●○◯◉•·xX\]\+\/g/.test(service)
  && /replace\(MASK_RUN_RE, ' '\)/.test(service));
ok('타계정 편집 API는 전용 경로의 shoppingId를 구버전 화면에서도 보존한다',
  /SELECT reviewer_no, sub_accounts FROM reviewers/.test(reviewerServiceSource)
  && /sub\.shoppingId = String\(savedId\)/.test(reviewerServiceSource));
ok('타계정 허용+등록 타계정 존재 시 명의 선택을 옵션보다 먼저 연다',
  /if\(multiEnabled\(\)\)[\s\S]{0,180}?if\(\(_subs \|\| \[\]\)\.length\) return openAcctSheet\(null, 'option'\)/.test(campaign));
ok('과거 다명의 일괄 제출 부팅은 명시적으로 비활성화돼 카드별 명의 혼선을 막는다',
  /function _batchBoot\(\)\s*\{\s*return null;\s*\}/.test(appJs));
ok('구매양식은 체크한 경우에만 제출 성공 뒤 명의 아이디 저장 API를 호출한다',
  /saveShoppingId:\s*!!document\.getElementById\(cid\+"_saveIdChk"\)/.test(appJs)
  && /if \(o\.saveShoppingId\)[\s\S]{0,180}?_saveOrderShoppingIdIfRequested/.test(appJs));
ok('새 캡처 분석 시작 시 이전 캡처 승인·검토·추출 토큰을 모두 폐기한다',
  /새 캡처를 분석하기 시작하는 순간[\s\S]{0,420}?st\.approvalToken = ""; st\.priorApprovalToken = ""; st\.reviewToken = ""; st\.matchError = false/.test(appJs));
ok('연속 캡처 분석의 늦은 응답은 request id로 폐기해 최신 캡처 증명을 덮지 못한다',
  /const requestId = \(Number\(st\.analysisRequestId\) \|\| 0\) \+ 1/.test(appJs)
  && (appJs.match(/st\.analysisRequestId !== requestId/g) || []).length >= 5
  && /_matchCardIdentity\(cid, requestId\)/.test(appJs));
ok('공통 아이디 저장 체크는 카드 한 장만 선택 가능하다',
  /onchange="_selectShoppingIdSave\('\$\{cid\}'\)"/.test(appJs)
  && /other\.checked = false/.test(appJs));
ok('내정보 드롭다운은 아이디·수취인·연락처·배송주소 입력창 아래에만 둔다',
  (appJs.match(/\$\{_savedOrderInfoMarkup\(cid, "/g) || []).length === 4
  && ['userId', 'recipient', 'phone', 'address'].every((field) => appJs.includes(`\${_savedOrderInfoMarkup(cid, "${field}")}`))
  && !/savedOrderInfoMarkup\(cid, "(?:orderNumber|orderer|price)"\)/.test(appJs)
  && /\.of-field-control>\.of-input(?:,|\{)/.test(searchCss));
ok('드롭다운 선택값은 DOM 버튼으로 만들고 입력 임시저장 순서를 바꾸지 않는다',
  (appJs.match(/const option = document\.createElement\("button"\)/g) || []).length === 2
  && /option\.textContent =/.test(appJs)
  && !/<select class="of-saved-info-select"/.test(appJs)
  && (appJs.match(/\.filter\(el => el\.type !== "file"\)/g) || []).length === 2);
ok('아이디와 배송주소 저장값이 없어도 빈 상태 선택창을 표시한다',
  /emptyLabel: "저장된 아이디 없음"/.test(appJs)
  && /emptyLabel: "저장된 주소 없음"/.test(appJs)
  && /triggerLabel\.textContent = available\.length \? "내 정보에서 선택" : spec\.emptyLabel/.test(appJs)
  && /trigger\.disabled = available\.length === 0/.test(appJs)
  && /wrap\.hidden = false/.test(appJs)
  && !/wrap\.hidden = available\.length === 0/.test(appJs)
  && /\.of-saved-info-trigger:disabled\{/.test(searchCss));
ok('모바일 내정보 목록은 시스템 선택창 없이 버튼 아래에 겹쳐 열린다',
  /class="of-saved-info-trigger"/.test(appJs)
  && /class="of-saved-info-menu"/.test(appJs)
  && /aria-expanded="false"/.test(appJs)
  && /event\.key !== "Escape"/.test(appJs)
  && /\.of-saved-info\{position:relative/.test(searchCss)
  && /\.of-saved-info-menu\{position:absolute;top:calc\(100% \+ 3px\)/.test(searchCss)
  && /\.of-saved-info\.is-open\{z-index:40\}/.test(searchCss));
ok('저장 계좌 선택은 예금주 아래 한 곳에서 은행·계좌·예금주를 함께 반영한다',
  (appJs.match(/\$\{_savedBankAccountMarkup\(\)\}/g) || []).length === 1
  && /저장된 계좌에서 선택/.test(appJs)
  && /저장된 계좌 없음/.test(appJs)
  && /\[item\?\.bankName, item\?\.bankAccount, item\?\.accountHolder\][\s\S]{0,100}?\.every/.test(appJs)
  && /\["of_bank", identity\.bankName\][\s\S]{0,120}?\["of_account", identity\.bankAccount\][\s\S]{0,120}?\["of_depositor", identity\.accountHolder\]/.test(appJs)
  && /_scopedSavedOrderIdentities\(\)\.find/.test(appJs)
  && /_syncSharedInfoToCard\(cid\)/.test(appJs));
ok('서버는 본계정과 타계정의 계좌 3종 세트를 참여 명의 정보에 포함한다',
  /bankName: owner\.bank_name \|\| ''[\s\S]{0,120}?bankAccount: owner\.bank_account \|\| ''[\s\S]{0,120}?accountHolder: owner\.account_holder \|\| ''/.test(service)
  && /bankName: sub\.bankName \|\| sub\.bank_name \|\| ''[\s\S]{0,160}?bankAccount: sub\.bankAccount \|\| sub\.bank_account \|\| ''[\s\S]{0,160}?accountHolder: sub\.accountHolder \|\| sub\.account_holder \|\| ''/.test(service)
  && /if \(includeBank\)[\s\S]{0,160}?result\.bankName = identity\.bankName \|\| ''[\s\S]{0,160}?result\.bankAccount = identity\.bankAccount \|\| ''[\s\S]{0,160}?result\.accountHolder = identity\.accountHolder \|\| ''/.test(service)
  && (service.match(/publicIdentity\(identity, \{ includeBank: true \}\)/g) || []).length === 2);
ok('AI 상태 배지는 드롭다운 전체가 아니라 입력창 전용 래퍼에 고정한다',
  (appJs.match(/class="of-input-status-wrap"/g) || []).length === 3
  && /\.of-input-status-wrap\{position:relative;width:100%/.test(searchCss)
  && /\.of-input-status-wrap>\.of-input\{width:100%/.test(searchCss));
ok('타계정 참여는 선택 명의만 노출하고 신청 전화번호를 화면과 서버에서 잠근다',
  /context\.selected\.type === 'sub'[\s\S]{0,100}?\[context\.selected\]/.test(service)
  && /phone: applicationPhone \|\| selected\.phone/.test(service)
  && /identities = identities\.filter\(\(item\) => item\.identityKey === selected\.identityKey\)/.test(appJs)
  && /participantPhoneLocked = "1"/.test(appJs)
  && /el\.dataset\.participantPhoneLocked === "1"/.test(appJs)
  && /SELECT ca\.phone8, ca\.option_key, ca\.owner_phone8/.test(submitRoutes)
  && /holdCtx\?\.verified && holdCtx\.isSub/.test(submitRoutes)
  && /PARTICIPANT_PHONE_INVALID/.test(service)
  && /PARTICIPANT_PHONE_INVALID/.test(submitRoutes));
const unlockAiField = appJs.slice(appJs.indexOf('function _unlockAiField(fid)'), appJs.indexOf('/** ★ Promise 반환'));
ok('캡처를 삭제해도 타계정 참여 전화번호 잠금은 풀리지 않는다',
  /keepParticipantPhoneLocked = f\.dataset\.participantPhoneLocked === "1"/.test(unlockAiField)
  && /f\.readOnly = keepParticipantPhoneLocked/.test(unlockAiField));
ok('AI 추출·명의매칭 장애와 무캡처 예외는 명시 수동확인 토큰을 거친다',
  /st\.matchError && st\.extracted \? "match_error" : "ai_error"/.test(appJs)
  && /mode === 'match_error'/.test(service)
  && /mode:"no_capture", manualConfirmed:true/.test(appJs));
ok('자동 MATCH 뒤 필드 수정은 기존 승인증명을 보존해 수동 재확인할 수 있다',
  /if \(st\.approvalToken\) st\.priorApprovalToken = st\.approvalToken/.test(appJs)
  && /st\.priorApprovalToken \? "form_edit"/.test(appJs)
  && /priorApprovalToken: st\.priorApprovalToken \|\| ""/.test(appJs)
  && /st\.proofExtracted = \{ \.\.\.st\.extracted \}/.test(appJs)
  && /mode === "form_edit" \? st\.proofExtracted : st\.extracted/.test(appJs)
  && /mode === 'form_edit'/.test(service)
  && /prior\.imageHash !== extract\.imageHash/.test(service)
  && /st\.priorApprovalToken \|\| st\.reviewToken/.test(appJs));
ok('NC 주문도 각 캡처의 수취인·전화·주소를 독립 적용한다',
  /const recipient = gv\(cid\+"_recipient"\)/.test(appJs)
  && /const phone\s+= gv\(cid\+"_phone"\)/.test(appJs)
  && /const address\s+= gv\(cid\+"_address"\)/.test(appJs));
ok('하단 메뉴 명칭은 내정보이고 명의 카드 앞 이니셜 아바타를 렌더하지 않는다',
  /class="tab-my"[\s\S]{0,100}>내정보<\/button>/.test(index)
  && !/<div class="pf-avatar">/.test(index));

async function verifyLegacySubIdPreservation() {
  const pool = require('../src/db/pool');
  const reviewerService = require('../src/services/reviewer.service');
  const original = pool.query;
  let saved;
  pool.query = async (sql, params) => {
    if (/SELECT reviewer_no, sub_accounts/.test(sql)) {
      return { rows: [{ reviewer_no: null, sub_accounts: [
        { name:'김민수', phone:'010-1111-2222', shoppingId:'keep-me', address:'기존' },
        { name:'박영희', phone:'010-3333-4444', shoppingId:'keep-two' },
      ] }] };
    }
    if (/UPDATE reviewers SET sub_accounts/.test(sql)) {
      saved = JSON.parse(params[0]); return { rows: [], rowCount: 1 };
    }
    throw new Error('unexpected query: ' + sql);
  };
  try {
    const out = await reviewerService.handleReviewerProfile({
      action:'saveSubAccounts', phone8:'99998888', subAccounts: [
        { name:'김민준', phone:'010-1111-9999', address:'수정' },
        { name:'박영희', phone:'010-3333-4444' },
      ],
    });
    ok('실행 검증: 타계정 이름·번호 수정과 기존 행 수정 모두 공통 아이디를 잃지 않는다',
      out.ok && saved[0].shoppingId === 'keep-me' && saved[1].shoppingId === 'keep-two');
  } finally { pool.query = original; }
}

verifyLegacySubIdPreservation().then(() => {
  console.log(`\n✅ reviewerOrderIdentityGuards: ${passed}개 통과`);
}).catch((err) => { console.error('❌', err.stack || err.message); process.exit(1); });
