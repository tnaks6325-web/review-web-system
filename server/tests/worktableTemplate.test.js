/**
 * worktableTemplate.test.js — 작업표 생성 M1 회귀가드.
 *
 * 지키는 것 2가지:
 *  ① **컬럼 역할 분류기가 매퍼에서 파생된다**(사본 금지). 키워드 표를 복사해 두면
 *     "제출은 A열에 쓰는데 작업표는 B열을 만든다"는 드리프트가 조용히 생긴다 →
 *     매퍼의 키워드를 바꿔 놓고 분류기가 **자동으로 따라가는지**를 실제 실행으로 확인한다.
 *  ② **작업시트탭URL 제출 필수 해제**(PRD Q2 확정)가 배선돼 있고, 그럼에도
 *     **접수(accept) 게이트는 유지**된다 = "접수된 오더는 linked_tab_* 보유" 불변식 생존.
 *
 * 실행: node tests/worktableTemplate.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const wt = require('../src/utils/worktableTemplate');
const ledger = require('../src/services/orderLedger.service');

const utilSrc = readS('utils/worktableTemplate.js');
const svcSrc = readS('services/worktable.service.js');
const routes = readS('routes/trackB.routes.js');
const order = readS('routes/order.routes.js');
const staff = readF('staff.html');
const wdesk = readF('workdesk.html');
const idxApp = readF('js/index-app.js');
const adminHtml = readF('admin.html');
const setJs = readF('js/admin-settings.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ══════════════════════════════════════════════════════════
   A. 분류기 — 매퍼 파생(실행 검증)
   ══════════════════════════════════════════════════════════ */
const STD = ['번호', '구매일자', '옵션', '주문자', '수취인', '쿠팡ID', '연락처',
  '배송주소', '은행', '계좌번호', '예금주', '결제금액', '주문번호', '리뷰제출', '입금', '비고'];
const cls = wt.classifyHeaders(STD, { submitCol: '리뷰제출', submitCol2: '입금' });
const roleOf = (h) => (cls.find(c => c.header === h) || {}).role || null;

ok('표준 헤더 16종이 전부 역할을 갖는다(미분류 0)',
  cls.every(c => c.role !== null));
ok('제출이 채우는 칸이 core 로 분류된다(주문자·수취인·연락처·주소·계좌·금액)',
  ['주문자', '수취인', '연락처', '배송주소', '계좌번호', '결제금액'].every(h => {
    const c = cls.find(x => x.header === h);
    return c && c.tier === 'core';
  }));
ok('번호·구매일자는 auto(생성 시 시스템이 값까지 채움)',
  roleOf('번호') === 'seq' && roleOf('구매일자') === 'dateStr'
  && cls.find(c => c.header === '번호').tier === 'auto');
ok('옵션은 work(작업별) — 작업지시 선기입 칸',
  roleOf('옵션') === 'option' && cls.find(c => c.header === '옵션').tier === 'work');
ok('리뷰제출·입금은 status — 매퍼가 쓰지 않는 칸이라 탭 설정으로만 판정된다',
  roleOf('리뷰제출') === 'submit' && roleOf('입금') === 'paid');
ok('탭 설정(submitCol)이 없으면 상태 칸은 매퍼 규칙대로 미분류로 남는다(추측 금지)',
  (() => {
    const c2 = wt.classifyHeaders(['리뷰제출'], {});
    return c2[0].role === null;
  })());

/* ★★ 핵심: 매퍼 파생 증명 — 매퍼가 인식하는 별칭 헤더를 넣으면 분류기가 따라온다.
   (키워드 사본이 있었다면 이 별칭들이 미분류로 떨어진다) */
ok('★ 매퍼 별칭 헤더를 분류기가 그대로 따라간다(사본이면 실패)',
  (() => {
    const alias = ['받는분', '휴대폰', 'address', 'bank', 'depositor', 'price', '특이사항'];
    const c3 = wt.classifyHeaders(alias, {});
    const r = h => (c3.find(x => x.header === h) || {}).role;
    return r('받는분') === 'recipient' && r('휴대폰') === 'phone' && r('address') === 'address'
      && r('bank') === 'bank' && r('depositor') === 'depositor' && r('price') === 'price'
      && r('특이사항') === 'memo';
  })());
ok('★ 분류기는 키워드 표를 복사하지 않고 매퍼를 실행해 파생한다',
  /require\('\.\.\/services\/orderLedger\.service'\)/.test(utilSrc)
  && /mapOrderToSheetRow\(list, FIELD_SENTINELS\)/.test(utilSrc)
  && /optionWriteColumns\(list\)/.test(utilSrc));
ok('★ 센티널에 공백·NUL 없음(매퍼가 trim 하고, NUL 은 git 이 바이너리 취급 — 실측으로 밟은 함정)',
  Object.values(wt.FIELD_SENTINELS).every(s => /^[A-Za-z_]+$/.test(s) && s.length > 0));

/* 매퍼가 실제로 그 열에 쓰는지 교차 확인 — 분류 결과와 쓰기 표면이 일치해야 한다 */
ok('★ core 로 분류된 열은 매퍼가 실제로 값을 쓰는 열이다(분류 ≡ 쓰기 표면)',
  (() => {
    const mapped = ledger.mapOrderToSheetRow(STD, wt.FIELD_SENTINELS);
    return cls.every(c => {
      if (c.tier !== 'core') return true;
      return typeof mapped[c.index] === 'string' && mapped[c.index].length > 0;
    });
  })());

/* NC(동시진행) — 매퍼는 일부러 안 쓰지만 작업표에는 그 열이 필요하다 */
ok('NC 탭(쿠팡+네이버 id 2열)도 두 열 모두 channel 로 분류된다',
  (() => {
    const c4 = wt.classifyHeaders(['쿠팡id', '네이버아이디'], {});
    return c4.every(c => c.role === 'userId' && c.tier === 'channel');
  })());
ok('★ 그럼에도 매퍼는 NC 에서 두 id 열을 비운다(쓰기 표면 무변경 — 오기입 방지 규칙 생존)',
  (() => {
    const mapped = ledger.mapOrderToSheetRow(['쿠팡id', '네이버아이디'], wt.FIELD_SENTINELS);
    return mapped[0] !== wt.FIELD_SENTINELS.userId && mapped[1] !== wt.FIELD_SENTINELS.userId;
  })());
ok('관리자 보호열(상품명)은 미분류로 남아 "미분류 헤더"로 보고된다',
  wt.classifyHeaders(['상품명'], {})[0].role === null);

/* ── 코드리뷰 반영분(#449 후속) — 이 4가지를 되돌리지 말 것 ── */
ok('★★ 상태 칸은 탭 설정이 매퍼 판정을 이긴다 — submit_col2=\'입금일자\' 가 구매일자로 뒤바뀌지 않는다',
  (() => {
    const c = wt.classifyHeaders(['입금일자'], { submitCol2: '입금일자' })[0];
    return c.role === 'paid' && c.tier === 'status';
  })());
ok('★ 그 겹침은 신호로 남는다(conflict) — 제출이 상태 칸을 덮어쓸 수 있다는 뜻이라 조용히 삼키지 않는다',
  wt.classifyHeaders(['입금일자'], { submitCol2: '입금일자' })[0].conflict === 'dateStr');
ok('겹치지 않는 정상 상태 칸은 conflict 없음(경고 도배 방지)',
  wt.classifyHeaders(['리뷰제출'], { submitCol: '리뷰제출' })[0].conflict === null);
ok('★★ 관리자 보호열 \'상품아이디\' 는 채널 열로 오분류되지 않는다(id 규칙이 지는 열)',
  wt.classifyHeaders(['상품아이디'], {})[0].role === null);
ok('★ 메모열 \'비고(아이디확인)\' 도 채널이 아니라 비고',
  wt.classifyHeaders(['비고(아이디확인)'], {})[0].role === 'memo');
ok('★ 채널 열 판정은 저수준 _isIdHeader 가 아니라 _idColIndices(이기는 열)를 쓴다',
  /_idColIndices,/.test(utilSrc) && /_idColIndices\(list\)/.test(utilSrc)
  && !/_isIdHeader\(/.test(utilSrc));   // 주석의 언급은 허용, **호출**이 없어야 한다
ok('★ 이 파일에 NUL 바이트가 없다(git 이 바이너리 취급 → diff·grep 무력화. 실제로 한 번 밟았다)',
  !utilSrc.includes('\u0000') && !svcSrc.includes('\u0000'));
ok('★ 그래도 정상 id 열은 그대로 channel',
  wt.classifyHeaders(['쿠팡ID'], {})[0].role === 'userId');
ok('★★ logger 는 구조분해로 받는다 — 통째로 받으면 fail-soft catch 안에서 TypeError(500)',
  /const \{ logger \} = require\('\.\.\/utils\/logger'\)/.test(svcSrc));
ok('★★ 시트URL 생략 시 문자열 "undefined" 가 저장되지 않는다(선택 항목화의 필수 짝)',
  /String\(b\.work_sheet_url \|\| ''\)\.trim\(\)/.test(order)
  && !/String\(b\.work_sheet_url\)\.trim\(\)/.test(order));
ok('상태 칸 겹침은 리포트에 실려 화면에 뜬다(서버·프론트 배선)',
  /statusConflicts/.test(svcSrc) && /statusConflicts/.test(setJs));

/* 채널 추정 */
ok('채널 추정 — 쿠팡/네이버/동시/미상', (() => {
  const f = wt.inferChannelFromHeaders;
  return f(['쿠팡ID']) === 'coupang' && f(['네이버아이디']) === 'naver'
    && f(['쿠팡id', '네이버아이디']) === 'both' && f(['수취인']) === 'unknown';
})());
ok('★ 채널을 모르면 unknown — 틀린 채널로 분류하지 않는다(현영 안내 규율과 동일)',
  wt.inferChannelFromHeaders([]) === 'unknown'
  && /추정 실패는 unknown/.test(utilSrc));
ok('빈 헤더 배열은 빈 결과(방어)', wt.classifyHeaders([], {}).length === 0
  && wt.classifyHeaders(null, {}).length === 0);

/* ══════════════════════════════════════════════════════════
   B. 집계 서비스 — 읽기 전용·시트 무접촉
   ══════════════════════════════════════════════════════════ */
ok('★ 쓰기는 app_settings 템플릿 1곳뿐 — 운영 테이블은 절대 안 건드린다',
  (() => {
    // 'DO UPDATE SET'(업서트 절)은 대상 테이블이 아니므로 제외 — 테이블을 지목하는 쓰기만 센다.
    const writes = svcSrc.match(/\b(?:INSERT INTO|UPDATE)\s+(?!SET\b)\w+/gi) || [];
    return !/DELETE FROM/i.test(svcSrc)
      && writes.length === 1 && /app_settings/i.test(writes[0]);
  })());
ok('★ 집계(headerStats)는 여전히 순수 읽기 — 쓰기 구문이 그 함수 안에 없다',
  (() => {
    const i = svcSrc.indexOf('async function headerStats');
    const j = svcSrc.indexOf('표준 열 템플릿', i);
    const body = svcSrc.slice(i, j > i ? j : svcSrc.length);
    return !/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i.test(body);
  })());
ok('★ RAW 미러만 읽는다 — 구글시트 재읽기 0(쿼터 무영향)',
  /raw_sheet_tabs/.test(svcSrc)
  && !/sheets\.|throttledCall|getSpreadsheetMeta/.test(svcSrc));
ok('동명 탭 곱증식 차단 — LATERAL LIMIT 1 조인',
  (svcSrc.match(/LEFT JOIN LATERAL/g) || []).length >= 2
  && (svcSrc.match(/LIMIT 1\s*\n?\s*\) \w+ ON TRUE/g) || []).length >= 2);
ok('조회 실패는 빈 리포트 반환(fail-soft — 화면이 죽지 않는다)',
  /catch \(err\)[\s\S]{0,200}return empty;/.test(svcSrc));
ok('분류는 유틸에 위임(집계 파일에 키워드 사본 없음)',
  /require\('\.\.\/utils\/worktableTemplate'\)/.test(svcSrc)
  && !/includes\('수취인'\)|includes\('연락처'\)/.test(svcSrc));

/* ══════════════════════════════════════════════════════════
   C. 라우트 — 권한·등록 (라우터 스택 실검사)
   ══════════════════════════════════════════════════════════ */
const trackBRouter = require('../src/routes/trackB.routes');
const _layers = (trackBRouter.stack || []).filter(l => l.route);
const _find = (p, m) => _layers.find(l => l.route.path === p && l.route.methods[m]);
const hs = _find('/worktable/header-stats', 'get');
ok('GET /worktable/header-stats 가 실제로 등록돼 있다', !!hs);
ok('★ 헤더 학습 리포트는 adminOrMaster — 전사 통계라 AE 담당 스코프로 나눌 성격이 아니다',
  (() => {
    const names = hs.route.stack.map(s => s.handle.name);
    return names.includes('authMiddleware') && names.includes('adminOrMasterMiddleware');
  })());
ok('★ 역할 미들웨어 앞에 authMiddleware 가 있다(빠지면 마스터 포함 전원 403 — 실측 사고)',
  (() => {
    const names = hs.route.stack.map(s => s.handle.name);
    return names.indexOf('authMiddleware') < names.indexOf('adminOrMasterMiddleware');
  })());
ok('작업표 쓰기 라우트는 템플릿 저장 하나뿐(PUT/DELETE 없음)',
  (() => {
    const wt = _layers.filter(l => /^\/worktable/.test(l.route.path));
    const writes = wt.filter(l => l.route.methods.post || l.route.methods.put || l.route.methods.delete);
    return writes.length === 1 && writes[0].route.path === '/worktable/template'
      && writes[0].route.methods.post && !writes[0].route.methods.put && !writes[0].route.methods.delete;
  })());
ok('★ 템플릿 조회·저장도 authMiddleware + adminOrMaster (전사 설정 — AE 도달 불가)',
  ['get', 'post'].every(m => {
    const l = _find('/worktable/template', m);
    if (!l) return false;
    const names = l.route.stack.map(s => s.handle.name);
    return names.indexOf('authMiddleware') === 0 && names.includes('adminOrMasterMiddleware');
  }));

/* ══════════════════════════════════════════════════════════
   D. 작업시트탭URL 필수 해제 (PRD Q2 확정) — 제출은 선택, 접수는 유지
   ══════════════════════════════════════════════════════════ */
ok('★ AE 제출(/submit)에 시트URL 필수 검증이 없다',
  !/작업시트탭URL은 필수입니다/.test(order));
ok('★ 인트라넷 intake 에도 시트URL 필수 검증이 없다',
  !/work_sheet_url[\s\S]{0,80}필수입니다/.test(order));
ok('★ 빈값으로 되돌리기(시트 미첨부 전환)도 막지 않는다',
  !/작업시트탭URL은 비울 수 없습니다/.test(order));
ok('★★ 접수(accept) 게이트는 유지 — URL+gid 없으면 접수 불가',
  /작업시트탭URL이 없습니다/.test(order)
  && /needsSheet: true/.test(order)
  && /gid가 없습니다/.test(order));
ok('★★ 그래서 "접수된 오더 = linked_tab_* 보유" 불변식이 살아 있다(모집공고 프리필 전제)',
  /const gidMatch = url\.match\(\/\[#\?&\]gid=\(\\d\+\)\/\)/.test(order));
ok('AE 폼: 시트URL 이 선택 항목으로 표시된다',
  !/작업시트탭URL <span class="req">\*<\/span>/.test(staff)
  && /비워두셔도 됩니다/.test(staff));
ok('AE 폼: 제출 시 클라이언트 필수 검증도 제거',
  !/showToast\("작업시트탭URL은 필수입니다"/.test(staff));
ok('AE 목록: 시트 미첨부 오더가 그렇게 보인다(빈 값이 조용히 "-" 로 숨지 않음)',
  /시트 미첨부 — 접수 시 작업표 생성/.test(staff));
ok('관리자 접수 안내 문구가 새 흐름을 알려준다',
  /작업표를 생성한 뒤 접수해주세요/.test(idxApp));

/* ══════════════════════════════════════════════════════════
   E. 화면 배선 — 작업표는 "설정" 안에, 공유 모듈 한 벌
   ══════════════════════════════════════════════════════════ */
ok('★ 작업표는 상단 탭이 아니라 **설정 안**에 있다(사용자 확정) — nav 잔재·죽은 렌더 함수 0',
  !/data-v="worktable"/.test(wdesk)
  && !/renderWorktableView/.test(wdesk)
  && !/_wtRenderReport|_loadWorktableStats/.test(wdesk));
// ★ 패널이 늘어도 통과하도록 **목록 전체**가 아니라 "관리자 목록에 worktable 이 있고
//   AE 목록엔 없다"를 본다(검사 의미 불변 — 패널 하나 추가에 무관한 가드가 깨지지 않게).
ok('통합 작업대 설정 패널 목록에 worktable 이 있다(관리자만 — 서버 adminOrMaster 와 1:1)',
  /panels: isAdmin \? \[[^\]]*'worktable'[^\]]*\] : \['nickname'\]/.test(wdesk));
ok('관리자 대시보드 설정 탭에도 같은 패널이 뜬다(공유 모듈 — 두 화면이 갈라지지 않는다)',
  /panels: \[[^\]]*'worktable'[^\]]*\], autoload: false/.test(adminHtml)
  && /loadWorktableTemplate\(\)/.test(idxApp));
ok('★ 화면은 설정 공유 모듈 한 벌 — workdesk/admin.html 에 사본 없음',
  /WT_EP/.test(setJs) && /header-stats/.test(setJs)
  && !/header-stats/.test(wdesk) && !/header-stats/.test(adminHtml));
ok('★ 리포트·표준열 경로는 재기준하지 않는다(두 화면이 같은 설정을 본다)',
  /\/api\/trackb\/worktable\/header-stats/.test(setJs)
  && /\/api\/trackb\/worktable\/template/.test(setJs));
ok('경로 표(EP_DEFAULT·EP_SUFFIX) 키 개수는 그대로 — 작업표는 표에 넣지 않았다',
  (() => {
    const d = (setJs.match(/var EP_DEFAULT = \{[\s\S]*?\};/) || [''])[0];
    const f = (setJs.match(/var EP_SUFFIX = \{[\s\S]*?\};/) || [''])[0];
    const keys = t => (t.match(/^\s{4}\w+:/gm) || []).length;
    return keys(d) > 0 && keys(d) === keys(f);
  })());
ok('리포트는 서버 분류 결과를 그릴 뿐 — 프론트에 키워드 사본 없음',
  !/includes\('수취인'\)|includes\('예금주'\)/.test(setJs));
ok('출력은 전부 escHtml() 통과(헤더명·열이름은 사용자·시트에서 온 자유 문자열)',
  !/\+ *(u\.name|c\.header|c\.name|v\.name) *\+/.test(setJs)
  && /escHtml\(c\.name\)/.test(setJs) && /escHtml\(u\.name\)/.test(setJs));
ok('채널별 추가 열은 현영 4채널 표를 재사용한다(채널 목록 사본 금지)',
  /CR_GUIDE_CHANNELS\.map/.test(setJs) && /wtCh_/.test(setJs));
ok('★ 채널 열은 블록 편집(추가·✕제거·◀▶이동) — 채널당 한 줄(라벨+블록) 레이아웃',
  /function wtChAdd/.test(setJs) && /function wtChDel/.test(setJs) && /function wtChMove/.test(setJs)
  && /as-wtchrow/.test(setJs) && /as-wtchlabel/.test(setJs) && /wtChips_/.test(setJs));
ok('★ 저장은 배열 그대로 — 쉼표 구분 파싱이 없다(열 이름에 쉼표가 들어가도 안전)',
  (() => {
    // wtSaveTemplate 본문에 split(',') 가 없어야 한다(이미지 dataURL split 은 다른 함수라 무관)
    const i = setJs.indexOf('async function wtSaveTemplate');
    const j = setJs.indexOf('\nasync function', i + 10);
    const body = setJs.slice(i, j > i ? j : i + 2000);
    return i > -1 && !/split\(','\)/.test(body) && /channels\[c\.key\] = \(\(_wtTpl\.channels \|\| \{\}\)\[c\.key\] \|\| \[\]\)\.slice\(\)/.test(setJs);
  })());
ok('★ 열 추가 후보 = 헤더 학습 리포트의 열들(역할 변형 + 미분류) — 별도 목록을 만들지 않는다',
  /function _wtBuildCandidates/.test(setJs)
  && /_wtStats \|\| \{\}\)\.roles[\s\S]{0,220}headerVariants/.test(setJs)
  && /_wtStats \|\| \{\}\)\.unmapped/.test(setJs));
ok('★ 공통 행과 채널 행은 **같은 빌더** 한 벌(_wtRowHtml) — 사본을 두면 버튼 동작이 갈린다',
  /function _wtRowHtml\(key, label/.test(setJs)
  && setJs.includes("_wtRowHtml('core'")                       // 공통(모든 채널) 행
  && /CR_GUIDE_CHANNELS\.map\(function \(c\) \{\s*return _wtRowHtml\(c\.key/.test(setJs)
  && setJs.includes("wtPickToggle(\\'' + key")                 // [▼] 는 빌더 안에 한 번만
  && (setJs.match(/id="wtChips_/g) || []).length === 1
  && (setJs.match(/id="wtPick_/g) || []).length === 1);
ok('★ 공통 = 표준 열 한 벌(별도 개념 없음) — core 배열을 두 뷰가 함께 본다',
  /function _wtListFor/.test(setJs)
  && /key === 'core'\) return \(_wtTpl\.core/.test(setJs)
  && /function _wtSyncColumns[\s\S]{0,400}_wtRenderChans\(\)/.test(setJs));
ok('★ 공통에 이미 있는 열을 채널에 또 넣지 못한다(작업표에 같은 열 2번 생성 차단)',
  /이미 공통 열입니다/.test(setJs));
ok('공통 기본값 프리셋 15열이 사용자 확정 목록과 일치한다',
  (() => {
    const m = /var WT_PRESET_CORE = \[([\s\S]*?)\];/.exec(setJs);
    if (!m) return false;
    const got = m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    const want = ['번호','구매일자','주문자','수취인','ID','연락처','주소','은행','계좌번호',
                  '예금주','결제금액','주문번호','리뷰제출','입금','비고'];
    return got.length === want.length && got.every((v, i) => v === want[i]);
  })());
ok('★ 프리셋은 버튼으로만 — 저장값이 없을 때 조용히 적용되지 않는다(확정은 사람이)',
  /function wtLoadPreset/.test(setJs) && /onclick="wtLoadPreset\(\)"/.test(setJs)
  && !/core = WT_PRESET_CORE[\s\S]{0,80}loadWorktableTemplate/.test(setJs));
ok('프리셋·통계불러오기는 공통만 바꾼다(채널 행 보존)',
  /_wtTpl\.core = WT_PRESET_CORE\.slice\(\)/.test(setJs)
  && !/wtLoadPreset[\s\S]{0,400}_wtTpl\.channels\s*=/.test(setJs));
ok('★★ 후보 클릭은 **인덱스**로 넘긴다 — onclick 문자열에 열 이름을 넣지 않는다(따옴표 탈출 차단)',
  (() => {
    const m = /onclick="wtPickAdd\([^"]*"/.exec(setJs);
    // h.i(인덱스)만 들어가고 c.name/h.c.name 같은 이름 참조가 없어야 한다
    return !!m && /h\.i/.test(m[0]) && !/name/.test(m[0]);
  })());
ok('통계는 지연 로드 + 캐시 한 벌(_wtEnsureStats) — 고르기·리포트·불러오기가 같은 것을 쓴다',
  /async function _wtEnsureStats/.test(setJs)
  && (setJs.match(/_wtFetch\(WT_EP\.stats\)/g) || []).length === 1);
ok('★ 자유 입력은 그대로 — 새 이름도 만들 수 있다(고르기는 보조 수단)',
  /function wtChAdd/.test(setJs)
  && setJs.includes('id="wtCh_')                       // 공용 빌더의 입력칸
  && setJs.includes("wtChAdd(\\'' + key")              // [＋] 버튼
  && /placeholder="' \+ placeholder \+ '"/.test(setJs));
ok('이미 담긴 후보는 비활성(중복 추가 클릭 자체가 불가)',
  /dup \? ' disabled' : ''/.test(setJs) && /as-wtpickchip.*dup/.test(setJs));
ok('한 번에 한 목록만 열린다(어느 채널에 넣는지 헷갈리지 않게)',
  /\['core'\]\.concat\(CR_GUIDE_CHANNELS\.map/.test(setJs));
ok('블록 렌더도 escHtml 통과 + 편집 시 dirty 표시(조용한 유실 방지)',
  /escHtml\(n\)/.test(setJs)
  // 공통·채널 모든 편집이 _wtAfterEdit 로 수렴하고, 거기서 dirty 가 켜진다
  && /function _wtAfterEdit[\s\S]{0,300}_wtDirty\(true\)/.test(setJs)
  && ['wtChAdd', 'wtChDel', 'wtChMove'].every(function (f) {
       var i = setJs.indexOf('function ' + f + '(');
       var body = setJs.slice(i, i + 900);
       return i > -1 && /_wtAfterEdit\(key\)/.test(body);
     })
  && /function _wtSyncColumns[\s\S]{0,400}_wtDirty\(true\)/.test(setJs));
ok('리포트는 펼칠 때 1회만 로드(설정 열 때마다 무거운 집계 금지)',
  /_wtStats\) return _wtRenderReport/.test(setJs));
ok('편집 중 저장 안 함 경고가 뜬다(조용한 유실 방지)',
  /저장하지 않은 변경이 있습니다/.test(setJs));

console.log(`\n✅ worktableTemplate: ${n}개 통과`);
// orderLedger.service 를 require 하면 DB 풀 핸들이 열려 프로세스가 안 끝난다(레포 관용구).
process.exit(0);
