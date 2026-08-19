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
ok('작업표 쓰기 라우트는 POST 뿐 — PUT/DELETE 는 없다(되돌리기 어려운 표면 최소화)',
  (() => {
    const wt = _layers.filter(l => /^\/worktable/.test(l.route.path));
    const writes = wt.filter(l => l.route.methods.post || l.route.methods.put || l.route.methods.delete);
    const paths = writes.map(l => l.route.path).sort();
    // ⚠ W5 줄 정리(`/retire-rows`)가 뒤늦게 합류해 이 목록이 드리프트해 있었다(가드가 계속 빨간 상태였다).
    // ⚠ 중복 줄 정리(`/dedupe-rows`·`/dedupe-scan`, 2026-08-19 본섭 합류)도 같은 드리프트 — 목록만 갱신(검사 의미 불변).
    return paths.join(',') === '/worktable/add-blogger,/worktable/create,/worktable/dedupe-rows,/worktable/dedupe-scan,/worktable/delete,/worktable/delete-tab,/worktable/retire-rows,/worktable/template'
      && writes.every(l => l.route.methods.post && !l.route.methods.put && !l.route.methods.delete);
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
// ★★ 2026-08-10 사용자 확정: 지금부터 들어오는 작업은 무시트가 기본이라 **URL 이 없으면 무시트로 접수**한다.
//   시트 경로를 탈 때의 URL·gid 검증은 그대로 남아 있고(그 400 은 킬스위치·명시 요청에서만 도달),
//   판정은 서비스 단일 출처(`resolveAcceptMode`)가 한다.
ok('★★ 시트 경로의 URL+gid 검증 문구는 그대로 남아 있다(킬스위치 복귀 시 안내)',
  /작업시트탭URL이 없습니다/.test(order)
  && /needsSheet: true/.test(order)
  && /gid가 없습니다/.test(order));
ok('★★ URL 없는 접수는 막다른 길이 아니라 무시트로 간다(판정 단일 출처 호출)',
  /const acceptMode = resolveAcceptMode\(\{ workOrder: o, body: req\.body \}\);/.test(order));
ok('★★ 그래도 "접수된 오더 = linked_tab_* 보유" 불변식은 유지(무시트도 가상 탭을 등록한다)',
  /const gidMatch = url\.match\(\/\[#\?&\]gid=\(\\d\+\)\/\)/.test(order)
  && /linked_tab_sheet_id = \$3/.test(order));
ok('AE 폼: 시트URL 이 선택 항목으로 표시된다',
  !/작업시트탭URL <span class="req">\*<\/span>/.test(staff)
  && /비워두셔도 됩니다/.test(staff));
ok('AE 폼: 제출 시 클라이언트 필수 검증도 제거',
  !/showToast\("작업시트탭URL은 필수입니다"/.test(staff));
ok('AE 목록: 시트 미첨부 오더가 그렇게 보인다(빈 값이 조용히 "-" 로 숨지 않음)',
  /시트 미첨부 — 접수 시 작업표 생성/.test(staff));
// ★★ 탈 구글시트(2026-08-10): 시트URL 없는 오더는 막지 않고 **무시트로 접수**한다 — 화면은 확인만 받는다.
ok('관리자 접수 안내 문구가 새 흐름을 알려준다(무시트 접수 확인)',
  /구글시트 없이 시스템 작업표로 접수할까요\?/.test(idxApp)
  && !/woNotice\("작업시트탭URL이 없습니다/.test(idxApp));

/* ══════════════════════════════════════════════════════════
   E. 화면 배선 — 작업표는 "설정" 안에, 공유 모듈 한 벌
   ══════════════════════════════════════════════════════════ */
ok('★ 작업표는 상단 탭이 아니라 **설정 안**에 있다(사용자 확정) — nav 잔재·죽은 렌더 함수 0',
  !/data-v="worktable"/.test(wdesk)
  && !/renderWorktableView/.test(wdesk)
  && !/_wtRenderReport|_loadWorktableStats/.test(wdesk));
// ★ 패널이 늘어도 통과하도록 **목록 전체**가 아니라 "관리자 목록에 worktable 이 있고
//   AE 목록엔 없다"를 본다(검사 의미 불변 — 패널 하나 추가에 무관한 가드가 깨지지 않게).
// ★ AE 목록도 늘 수 있으므로(2026-08: gatecriteria 개방) "AE 목록에 worktable 이 **없다**"로 본다
//   — 작업표 표준 열은 전사 설정이라 서버가 여전히 adminOrMaster 다.
ok('리뷰웹시스템[3버전] 설정 패널 목록에 worktable 이 있다(관리자만 — 서버 adminOrMaster 와 1:1)', (() => {
  const m = /panels: isAdmin \? \[([^\]]*)\] : \[([^\]]*)\]/.exec(wdesk);
  return !!m && /'worktable'/.test(m[1]) && !/'worktable'/.test(m[2]);
})());
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
  /CR_GUIDE_CHANNELS\.map/.test(setJs) && /function _wtChannels/.test(setJs));
ok('★ 기본 4채널 + 직접 추가 채널 = _wtChannels() 한 벌(목록 사본 금지)',
  /function _wtChannels\(\)[\s\S]{0,400}CR_GUIDE_CHANNELS\.map/.test(setJs)
  && /_wtTpl && _wtTpl\.customChannels/.test(setJs)
  // 저장 페이로드도 같은 목록을 쓴다 — 하드코딩 4채널이면 지마켓 열이 저장에서 빠진다
  && /_wtChannels\(\)\.forEach\(function \(c\) \{\s*channels\[c\.key\]/.test(setJs));
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
ok('★★ 채널·작업유형은 **알약 줄 한 벌**(_wtRenderPills) — 채널마다 행을 그리던 사본이 없다',
  /function _wtRenderPills/.test(setJs)
  && /_wtChannels\(\)\.map\(function \(c\) \{[\s\S]{0,400}wtPvChan/.test(setJs)
  && /_wtTypes\(\)[\s\S]{0,400}wtPvType/.test(setJs)
  && !/function _wtRowHtml|function _wtRowsHtml/.test(setJs)     // 행 빌더 제거됨
  && (setJs.match(/id="wtChips_core"/g) || []).length === 1);
ok('★ 공통 = 표준 열 한 벌(별도 개념 없음) — core 배열을 두 뷰가 함께 본다',
  /function _wtListFor/.test(setJs)
  && /key === 'core'\) return \(_wtTpl\.core/.test(setJs)
  && /function _wtSyncColumns[\s\S]{0,600}_wtRenderChans\(\)/.test(setJs));
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
ok('프리셋·통계불러오기는 공통만 바꾼다(채널·유형 열 보존)',
  /_wtTpl\.core = WT_PRESET_CORE\.slice\(\)/.test(setJs)
  && !/wtLoadPreset[\s\S]{0,400}_wtTpl\.channels\s*=/.test(setJs));
ok('★★ 후보 클릭은 **인덱스**로 넘긴다 — onclick 문자열에 열 이름을 넣지 않는다(따옴표 탈출 차단)',
  (() => {
    const m = /onclick="wtAddPick\([^"]*"/.exec(setJs);
    return !!m && /h\.i/.test(m[0]) && !/name/.test(m[0]);
  })());
ok('통계는 지연 로드 + 캐시 한 벌(_wtEnsureStats) — 고르기·리포트·불러오기가 같은 것을 쓴다',
  /async function _wtEnsureStats/.test(setJs)
  && (setJs.match(/_wtFetch\(WT_EP\.stats\)/g) || []).length === 1);
ok('★ 자유 입력은 그대로 — 새 이름도 만들 수 있다(고르기는 보조 수단)',
  /function wtChAdd\(key, name\)/.test(setJs)
  && setJs.includes('id="wtAddInput"')                 // 팝오버의 유일한 입력칸
  && /function wtAddSubmit[\s\S]{0,300}wtChAdd\(_wtAddTo, name\)/.test(setJs));
ok('이미 담긴 후보는 비활성(중복 추가 클릭 자체가 불가)',
  /dup \? ' disabled' : ''/.test(setJs) && /as-wtpickchip.*dup/.test(setJs)
  && /_wtListFor\(_wtAddTo\)/.test(setJs));
ok('★★ 담는 곳은 한 번에 하나 — 켠 알약들만 후보로 보여 주고 고르게 한다(조용한 추측 금지)',
  /function _wtAddTargets[\s\S]{0,700}_wtPvChan[\s\S]{0,400}_wtPvTypes/.test(setJs)
  && /onclick="wtAddTarget\(/.test(setJs)
  && /function wtAddOpen[\s\S]{0,400}_wtAddTo = t\.length > 1/.test(setJs));
ok('렌더는 escHtml 통과 + 편집 시 dirty 표시(조용한 유실 방지)',
  /escHtml\(n\)/.test(setJs)
  // 공통·채널·유형 모든 열 편집이 _wtAfterEdit 로 수렴하고, 거기서 dirty 가 켜진다
  && /function _wtAfterEdit[\s\S]{0,300}_wtDirty\(true\)/.test(setJs)
  && ['wtChAdd', 'wtChDel', 'wtChMove'].every(function (f) {
       var i = setJs.indexOf('function ' + f + '(');
       var body = setJs.slice(i, i + 900);
       return i > -1 && /_wtAfterEdit\(key\)/.test(body);
     })
  && /function _wtSyncColumns[\s\S]{0,600}_wtDirty\(true\)/.test(setJs));
ok('리포트는 펼칠 때 1회만 로드(설정 열 때마다 무거운 집계 금지)',
  /_wtStats\) return _wtRenderReport/.test(setJs));
ok('편집 중 저장 안 함 경고가 뜬다(조용한 유실 방지)',
  /저장하지 않은 변경이 있습니다/.test(setJs));

/* ── 열 구성 한 줄 미리보기(공통 블록 바로 아래) ────────────────
   이름 블록만으로는 "작업표가 실제로 어떤 표가 되는지"가 안 그려져 표 머리 축소판을 깐다.
   고정할 것은 모양이 아니라 ① 자리(공통 아래·채널 위) ② 편집 즉시 따라 갱신
   ③ 데이터 사본 없음 ④ **한 줄** 유지(줄바꿈·가로 스크롤 금지) 넷이다. */
ok('★ 순서 = 🌐 공통 요약 → 채널·유형 알약 줄 → 미리보기(담기·조절이 끝나는 자리)',
  (() => {
    const i = setJs.indexOf('id="wtChips_core"');
    const pl = setJs.indexOf('_wtPillRowsHtml()', i);
    const pv = setJs.indexOf('id="wtPreview"', pl);
    return i > -1 && pl > i && pv > pl && !/id="wtRows"/.test(setJs);
  })());
ok('★ 편집할 때마다 따라 갱신 — _wtRenderCols 가 미리보기를 부른다(로더에만 두면 옛 순서가 남는다)',
  /function _wtRenderCols\(\)[\s\S]{0,400}_wtRenderPreview\(\)/.test(setJs));
ok('★★ 데이터 사본 없음 — 미리보기 합성도 저장 배열(_wtListFor)과 서버 분류(_wtTpl.columns)만 본다',
  /function _wtMergeCols[\s\S]{0,2000}_wtTpl\.columns/.test(setJs)
  && /function _wtMergeCols[\s\S]{0,2600}_wtListFor\(/.test(setJs)
  && /function _wtRenderPreview[\s\S]{0,400}_wtMergeCols\(_wtPvChan, _wtPvTypes\)/.test(setJs));
ok('★★ 한 줄 유지 — 줄바꿈·가로 스크롤 없이 칸만 줄인다(넘치면 말줄임 + title 에 전체 이름)',
  (() => {
    const row = /'\.as-wtpvrow\{([^']*)\}'/.exec(setJs);
    const cell = setJs.slice(setJs.indexOf("'.as-wtpvc{"), setJs.indexOf("'.as-wtpvc:last-child"));
    return !!row && !/flex-wrap/.test(row[1]) && !/overflow-x\s*:\s*auto|scroll/.test(row[1])
      && /white-space:nowrap/.test(cell) && /text-overflow:ellipsis/.test(cell)
      && /min-width:0/.test(cell)
      && /flex:0 1 auto/.test(cell)              // 균등(1 1 0)이면 짧은 이름까지 잘린다(실측)
      && /title="/.test(setJs.slice(setJs.indexOf('function _wtRenderPreview'), setJs.indexOf('function _wtRenderCols')));
  })());
ok('★★ [＋ 열 추가] 는 미리보기 **오른쪽 끝**에 있고, 열이 0개일 때도 있다(처음 담을 창구)',
  (() => {
    const i = setJs.indexOf('function _wtRenderPreview');
    const body = setJs.slice(i, setJs.indexOf('\nfunction wtPvSel', i));
    // 빈 상태 분기와 일반 분기 **양쪽** 에 addCell 이 들어간다
    return /addcell" onclick="wtAddOpen\(\)/.test(body)
      && (body.match(/addCell/g) || []).length >= 3
      && /cells \+ addCell/.test(body);
  })());

/* ── 공통 열 조절 창구 단일화 + 제출 매칭 설명(사용자 확정 2026-08-04) ────────
   종전엔 공통 행 칩·작업표 미리보기·공통 열 상세 세 곳이 같은 배열을 그렸고 그중
   둘(칩 ◀▶✕ · 상세 ↑↓✕)이 편집까지 돼 창구가 갈렸다 → **조절은 미리보기 하나**,
   공통 행은 추가 창구만, 상세는 읽기 전용 설명표(시스템 인식 + 구매양식 제출 매칭). */
ok('★★ 🌐 공통 줄은 개수 요약만 — 담기·조절은 미리보기 하나(중복 창구 제거)',
  (() => {
    const i = setJs.indexOf('function _wtRenderChans');
    const body = setJs.slice(i, setJs.indexOf('\n/** 열 담기 단일 경로', i));
    return i > -1 && /작업표 미리보기/.test(body) && !/as-wtchip/.test(body)
      && !/onclick/.test(body);   // 요약 줄에는 편집 버튼이 없다
  })());
ok('★★ 미리보기 칸 클릭 = 조절(선택 → ◀▶✕) — onclick 은 인덱스만(열 이름 미포함 = 따옴표 탈출 차단)',
  (() => {
    const m = /onclick="wtPvSel\([^"]*"/.exec(setJs);
    return !!m && /\+ i \+/.test(m[0]) && !/name/.test(m[0])
      && /function wtPvSel/.test(setJs) && /as-wtpvc\.sel/.test(setJs);
  })());
ok('★ 툴바 이동·빼기는 기존 단일 편집 경로(wtChMove/wtChDel)로 위임 — 편집 경로 사본 없음',
  /function wtPvMove[\s\S]{0,700}wtChMove\(s\.list, s\.idx, dir\)/.test(setJs)
  && /function wtPvDel[\s\S]{0,500}wtChDel\(s\.list, s\.idx\)/.test(setJs));
ok('★★ 미리보기가 조절하는 대상은 **그 묶음의 저장 배열** — 합성 인덱스로 직접 splice 하지 않는다',
  (() => {
    const i = setJs.indexOf('function wtPvMove');
    const j = setJs.indexOf('function wtPvDel');
    const body = setJs.slice(i, j > i ? j : i + 1500);
    return i > -1 && !/\.splice\(/.test(body) && /_wtListFor\(s\.list\)/.test(body)
      && /function wtPvDel[\s\S]{0,500}wtChDel\(s\.list, s\.idx\)/.test(setJs);
  })());
ok('★ onclick 함수 3종은 window 에 노출된다(IIFE 스코프 — 빠지면 클릭이 ReferenceError 로 조용히 죽는다)',
  ['wtPvSel', 'wtPvMove', 'wtPvDel'].every(f => setJs.includes('window.' + f + ' = ' + f)));
ok('★★ 공통 열 상세는 읽기 전용 — 행에 조절 버튼이 없다(조절 창구는 미리보기 하나)',
  (() => {
    const i = setJs.indexOf('function _wtRenderCols');
    const body = setJs.slice(i, setJs.indexOf('\nfunction _wtSyncColumns', i));
    return i > -1 && !/onclick/.test(body) && !/as-wtbtns|wtMoveCol\(|wtDelCol\(/.test(body);
  })());
ok('★★ 상세 각 행에 구매양식 제출 매칭 설명이 표기된다 — 문장은 서버 ROLE_META.fill 단일 출처',
  (() => {
    const i = setJs.indexOf('function _wtRenderCols');
    const body = setJs.slice(i, setJs.indexOf('\nfunction _wtSyncColumns', i));
    // 프론트는 서버 값(c.fill)을 escHtml 로 표시할 뿐, 역할별 매칭 문장 사본이 없다
    return /c\.fill/.test(body) && /escHtml\(fillTxt\)/.test(body)
      && !/\[주문자\]|\[수취인\]|\[배송주소\]/.test(setJs);
  })());
ok('★ 매칭 설명은 배지 오른쪽 같은 줄(행 높이 한 줄 유지) — 넘치면 말줄임 + title 전체 문장',
  (() => {
    const i = setJs.indexOf("'.as-wtfill{");
    if (i < 0) return false;
    const rule = setJs.slice(i, setJs.indexOf('}', i));   // 문자열 이어붙임 경계 무시하고 규칙 끝까지
    return /flex:1 1 0/.test(rule) && /min-width:0/.test(rule) && /white-space:nowrap/.test(rule)
      && /text-overflow:ellipsis/.test(rule) && !/flex-basis:100%/.test(rule)
      && /as-wtfill" title="/.test(setJs);
  })());
ok('★ ROLE_META 전 역할이 fill 설명을 갖고 classifyHeaders 가 실어 나른다(실행 검증)',
  Object.values(wt.ROLE_META).every(m => typeof m.fill === 'string' && m.fill.length > 0)
  && wt.classifyHeaders(['수취인'], {})[0].fill.includes('[수취인]')
  && wt.classifyHeaders(['상품명'], {})[0].fill === null);
ok('★ 템플릿 주석(_annotate)도 fill 을 통과시켜 화면까지 닿는다',
  /fill: c\.fill/.test(svcSrc));
ok('저장 전 임시 열은 "저장하면 판정" 안내 — 매칭 없음과 구분(추측 금지)',
  /pending: true/.test(setJs) && /저장하면 시스템 인식이 판정됩니다/.test(setJs));


/* ══════════════════════════════════════════════════════════════
   F. 확장 — 채널 적용 미리보기(B) · 커스텀 작업채널(C) · 작업유형(D)
   ══════════════════════════════════════════════════════════════ */
const vm = require('vm');
/** setJs 에서 함수 하나를 이름으로 꺼낸다(중괄호 균형). 런타임 실행 가드용. */
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert(i > -1, 'grabFn: ' + name);
  let d = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { d++; started = true; }
    else if (src[k] === '}') { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('grabFn 균형 실패: ' + name);
}

ok('★★ 미리보기 합성 순서 = 서버 buildColumns 와 **같다**(사본 드리프트 차단 — 실행 대조)',
  (() => {
    // 프론트 합성 함수 3개를 실제로 실행해 서버 결과와 열 이름 순서를 비교한다.
    const sb = { _wtTpl: null };
    vm.createContext(sb);
    vm.runInContext(
      grabFn(setJs, '_wtListFor') + '\n' + grabFn(setJs, '_wtTypes') + '\n' + grabFn(setJs, '_wtMergeCols'), sb);

    const tpl = {
      core: ['번호', '구매일자', '주문자', '수취인', '연락처', '비고'],
      channels: { coupang: ['쿠팡ID'], c1: ['지마켓ID'] },
      customChannels: [{ key: 'c1', label: '지마켓' }],
      workTypes: [
        { key: 't1', label: '상품옵션', position: 'front', columns: ['옵션'] },
        { key: 't2', label: '택배발송대행', position: 'back', columns: ['택배송장번호'] },
        { key: 't3', label: '겹침시험', position: 'front', columns: ['수취인'] },   // 이미 있는 이름
      ],
    };
    // 프론트는 서버가 준 분류(columns)를 함께 본다 — 서버 _annotate 대신 classifyHeaders 로 만든다.
    tpl.columns = wt.classifyHeaders(tpl.core, {}).map(c => ({ name: c.header, role: c.role, label: c.label, tier: c.tier }));
    tpl.channelColumns = {}; tpl.workTypeColumns = {};

    const { buildColumns } = require('../src/utils/worktablePlan');
    const cases = [
      ['', []], ['coupang', []], ['c1', []],
      ['coupang', ['t1']], ['coupang', ['t2']], ['coupang', ['t1', 't2']],
      ['c1', ['t2', 't1']], ['', ['t1', 't2', 't3']], ['coupang', ['t3']],
    ];
    return cases.every(([ch, types]) => {
      sb._wtTpl = tpl;
      const front = vm.runInContext('_wtMergeCols(' + JSON.stringify(ch) + ',' + JSON.stringify(types) + ')', sb)
        .map(c => c.name).join('|');
      const server = buildColumns({ template: tpl, channel: ch, workTypes: types }).map(c => c.name).join('|');
      if (front !== server) console.log('   ↳ 불일치', ch, types, '\n     front :', front, '\n     server:', server);
      return front === server;
    });
  })());

ok('★ 채널 알약 — 누르면 그 채널이 합쳐진 완성 양식을 본다(보기·조절 전환, 저장과 무관)',
  /function wtPvChan\(key\)[\s\S]{0,300}_wtRenderPreview\(\)/.test(setJs)
  && /_wtRenderPills[\s\S]{0,1200}onclick="wtPvChan/.test(setJs)
  && !/wtPvChan[\s\S]{0,200}_wtFetch|wtPvChan[\s\S]{0,200}wtSaveTemplate/.test(setJs));
ok('★ 작업유형 알약은 다중 토글(켠 유형 열이 합쳐진다)',
  /function wtPvType\(key\)[\s\S]{0,300}_wtPvTypes\.splice/.test(setJs)
  && /onclick="wtPvType/.test(setJs));
ok('★ 지워진 채널·유형을 보고 있었으면 기본으로 되돌린다(없는 것을 그리지 않는다)',
  /_wtPvChan && !_wtChannels\(\)\.some/.test(setJs)
  && /_wtPvTypes = _wtPvTypes\.filter/.test(setJs));

/* ── C. 커스텀 작업채널 ── */
const wsvc = require('../src/services/worktable.service');
ok('★★ 기본 4채널은 삭제 불가 — 커스텀만 삭제 버튼이 보이고, 서버도 기본 키를 커스텀으로 안 받는다',
  /function wtDelChannel[\s\S]{0,300}if \(!c \|\| !c\.custom\) return;/.test(setJs)
  && /c\.custom[\s\S]{0,240}wtDelChannel/.test(setJs)          // 관리 팝오버에서 커스텀에만 렌더
  && /기본 채널 · 지울 수 없음/.test(setJs)
  && /BUILTIN_CHANNEL_KEYS/.test(svcSrc)
  && /!BUILTIN_CHANNEL_KEYS\.has\(k\)/.test(svcSrc));
ok('★ 삭제·이름변경은 평소 화면이 아니라 [⚙ 관리] 안에서만(오클릭 방지 — 시안 B 확정)',
  /function wtOpenChanMgr/.test(setJs) && /function wtOpenTypeMgr/.test(setJs)
  && /onclick="wtOpenChanMgr\(\)"[\s\S]{0,80}채널 관리/.test(setJs)
  // 알약 자체에는 삭제가 붙지 않는다
  && !/wtPvChan\('[^']*'\)"[^>]*>[\s\S]{0,60}wtDelChannel/.test(setJs));
ok('★ 열이 담긴 채널·유형 삭제는 한 번 더 묻는다(시트 무영향도 함께 안내)',
  /function wtDelChannel[\s\S]{0,500}confirm\([\s\S]{0,200}이미 만들어진 시트에는 영향이 없습니다/.test(setJs)
  && /function wtDelType[\s\S]{0,500}confirm\([\s\S]{0,200}이미 만들어진 시트에는 영향이 없습니다/.test(setJs));
ok('★★ 채널 키는 **서버가 발급**한다 — 화면 임시 키는 저장 응답으로 교체된다(고아 방지)',
  /_keyMinter\('c', keys\)/.test(svcSrc) && /_keyMinter\('t', keys\)/.test(svcSrc)
  && /function wtSaveTemplate[\s\S]{0,1100}_wtRenderChans\(\)/.test(setJs));
ok('★ 같은 이름 채널·유형 중복 추가 차단(화면·서버 양쪽)',
  /이미 있는 채널입니다/.test(setJs) && /이미 있는 작업유형 이름입니다/.test(setJs)
  && /seenLabel\.has\(label\.toLowerCase\(\)\)/.test(svcSrc));
ok('★ 상한이 있다(폭주 방지) — 채널·유형 각각',
  /MAX_CUSTOM_CHANNELS/.test(svcSrc) && /MAX_WORK_TYPES/.test(svcSrc)
  && wsvc.MAX_CUSTOM_CHANNELS > 0 && wsvc.MAX_WORK_TYPES > 0);
ok('★ 자동 채널 판정(URL 호스트)은 여전히 기본 4채널만 — 커스텀은 담당자가 고른다',
  (() => {
    const plan = require('../src/utils/worktablePlan');
    return plan.channelFromUrl('https://www.gmarket.co.kr/x') === 'unknown'
      && plan.channelFromUrl('https://www.coupang.com/x') === 'coupang'
      && plan.channelLabel('c1', { customChannels: [{ key: 'c1', label: '지마켓' }] }) === '지마켓';
  })());

/* ── D. 작업유형 ── */
const planMod = require('../src/utils/worktablePlan');
const _tplD = {
  core: ['번호', '구매일자', '수취인', '연락처', '결제금액', '비고'],
  channels: {}, customChannels: [],
  workTypes: [{ key: 't1', label: '상품옵션', position: 'front', columns: ['옵션'] },
              { key: 't2', label: '택배발송대행', position: 'back', columns: ['택배송장번호'] }],
};
const _woD = { recruit_count: 4, daily_count: 2, start_date: '2026-08-10',
  product_options_json: JSON.stringify([{ name: 'A', options: [{ label: '레드' }, { label: '블루' }] }]) };
ok('★★ 작업유형은 **켠 것만** 반영된다 — 미전송이면 종전과 완전히 같은 표(안 쓰면 무변화)',
  (() => {
    const off = planMod.buildWorktablePlan({ workOrder: _woD, template: _tplD, options: {} });
    const base = planMod.buildColumns({ template: _tplD, channel: 'unknown' });
    return off.columns.map(c => c.name).join('|') === base.map(c => c.name).join('|');
  })());
ok('★★ 제안(suggestedWorkTypes)은 계산만 하고 **자동 적용하지 않는다**(확정은 사람)',
  (() => {
    const p = planMod.buildWorktablePlan({ workOrder: _woD, template: _tplD, options: {} });
    return p.suggestedWorkTypes.join(',') === 't1'          // 옵션 2종 → 상품옵션 제안
      && !p.columns.some(c => c.name === '옵션')            // 그런데 열은 안 붙었다
      && p.enabledWorkTypes.length === 0;
  })());
ok('★ 제안 근거는 **열 역할 파생**(이름 매칭 아님) — 유형 이름을 바꿔도 따라온다',
  (() => {
    const t2 = JSON.parse(JSON.stringify(_tplD));
    t2.workTypes[0].label = '전혀 다른 이름';
    const p = planMod.buildWorktablePlan({ workOrder: _woD, template: t2, options: {} });
    return p.suggestedWorkTypes.join(',') === 't1';
  })());
ok('★ 유형 열 위치 — front 는 자동 열(번호·구매일자) 뒤, back 은 맨 뒤',
  (() => {
    const p = planMod.buildWorktablePlan({ workOrder: _woD, template: _tplD, options: { workTypes: ['t1', 't2'] } });
    const names = p.columns.map(c => c.name);
    return names[2] === '옵션' && names[names.length - 1] === '택배송장번호';
  })());
ok('★ 켠 유형의 열이 이미 있어 하나도 안 붙으면 조용히 넘기지 않고 알린다',
  (() => {
    const t3 = JSON.parse(JSON.stringify(_tplD));
    t3.workTypes.push({ key: 't9', label: '겹침', position: 'back', columns: ['비고'] });
    const p = planMod.buildWorktablePlan({ workOrder: _woD, template: t3, options: { workTypes: ['t9'] } });
    return p.warnings.some(w => w.code === 'worktype_no_column');
  })());
ok('★ 유형 열이 옵션 역할이면 생성 시 값도 채워진다(planToSheetValues 는 role 로 판정 — 사본 없음)',
  (() => {
    // ★ 2026-08-19: 리뷰옵션 칸(리뷰형태 전용)은 상품옵션 기입 대상에서 제외 — 판정은
    //   utils/reviewType.isReviewOptionHeader 단일 출처(검사 의미 확장).
    const create = readS('services/worktableCreate.service.js');
    return /idxOpt = plan\.columns\.findIndex\(c => c\.role === 'option' && !isReviewOptionHeader\(c\.name\)\)/.test(create);
  })());

/* ── 배선: 작업오더 [📋 작업표] 미리보기 ── */
ok('★ 작업표 미리보기가 채널·작업유형을 서버에 보낸다(계획은 서버가 최종 계산)',
  /q\.set\('channel',f\.channel\)/.test(wdesk)
  && /q\.set\('workTypes',f\.workTypes\.join\(','\)\)/.test(wdesk)
  && /channel:f\.channel\|\|'', workTypes:f\.workTypes\|\|\[\]/.test(wdesk));
ok('★ 값 읽기는 _wtpSyncForm 한 벌(사본 금지) — 체크박스가 있는 화면에서만 읽는다',
  /function _wtpSyncForm[\s\S]{0,700}querySelectorAll\('\.wtpType'\)/.test(wdesk)
  && /if\(tb\.length\) f\.workTypes=/.test(wdesk));
ok('★★ 제안 반영은 **첫 열림 1회**(무한 재조회 금지) + 체크로 보인다',
  /_WTP\.suggestApplied/.test(wdesk) && /suggestedWorkTypes/.test(wdesk)
  && /class="wtpType"[\s\S]{0,120}\$\{t\.enabled\?'checked':''\}/.test(wdesk));
ok('★ 서버 라우트가 workTypes 를 받는다(미전송 = 없음)',
  /q\.workTypes != null\) opt\.workTypes = String\(q\.workTypes\)\.split\(','\)/.test(routes)
  && /customChannels: b\.customChannels, workTypes: b\.workTypes/.test(routes));
ok('★ onclick 함수는 전부 window 에 노출된다(IIFE — 빠지면 클릭이 조용히 죽는다)',
  ['wtPvChan', 'wtPvType', 'wtAddChannel', 'wtDelChannel', 'wtRenameChannel', 'wtDelType',
   'wtOpenChanMgr', 'wtOpenTypeMgr', 'wtOpenTypeModal', 'wtCloseTypeModal', 'wtTypePos',
   'wtTypeColAdd', 'wtTypeColDel', 'wtTypeSave', 'wtAddOpen', 'wtAddClose', 'wtAddTarget',
   'wtAddSubmit', 'wtAddPick']
    .every(f => setJs.includes('window.' + f + ' = ' + f)));


/* ══════════════════════════════════════════════════════════════
   G. 시안 B — 팝오버·모달 화면 + 작업오더 기반 자동 선택
   ══════════════════════════════════════════════════════════════ */
ok('★★ 브라우저 기본 입력창(prompt)으로 작업유형을 만들지 않는다 — 전용 모달',
  (() => {
    // 채널 추가·이름변경은 여전히 prompt(간단한 한 줄), 작업유형은 모달이어야 한다
    const i = setJs.indexOf('function wtOpenTypeModal');
    const j = setJs.indexOf('function wtDelType');
    const body = setJs.slice(i, j > i ? j : i + 9000);
    return i > -1 && !/prompt\(/.test(body)
      && /as-wtmodalwrap/.test(setJs) && /function _wtRenderTypeModal/.test(setJs);
  })());
ok('★★ 모달은 body 직속 마운트(설정 패널 안에 두면 오버레이가 화면 흐름에 섞인다 — 레포 실측 교훈)',
  /function _wtTypeMount[\s\S]{0,600}document\.body\.appendChild/.test(setJs));
ok('★ 모달 입력값은 다시 그릴 때 날아가지 않는다(_wtTypeSync 한 벌로 읽는다)',
  /function _wtTypeSync/.test(setJs)
  && ['wtTypePos', 'wtTypeColAdd', 'wtTypeColDel', 'wtTypeSave'].every(f => {
       const i = setJs.indexOf('function ' + f + '(');
       return i > -1 && /_wtTypeSync\(\)/.test(setJs.slice(i, i + 600));
     }));
ok('★ 유형 모달에서도 "공통에 있는 열" 은 담지 못한다(같은 열 2번 생성 차단 — 담기 경로 공통 규칙)',
  /function wtTypeColAdd[\s\S]{0,900}이미 공통 열입니다/.test(setJs));
ok('★★ 조건 목록을 못 받아도 **빈 드롭다운을 그리지 않는다** — 지금 값 유지 + 잠금 + 안내 + 다시 불러오기',
  (() => {
    const i = setJs.indexOf('function _wtRenderTypeModal');
    const j = setJs.indexOf('\nasync function wtReloadTriggers', i);
    const body = setJs.slice(i, j > i ? j : i + 6000);
    return i > -1
      && /var trigMissing = !trigs\.length/.test(body)
      && /trigMissing[\s\S]{0,300}selected/.test(body)              // 지금 설정을 옵션으로 남긴다
      && /trigMissing \? ' disabled' : ''/.test(body)                // 잠근다
      && /조건 목록을 불러오지 못했습니다/.test(body)                  // 말한다
      && /wtReloadTriggers\(\)/.test(body)                          // 되살릴 길
      && /async function wtReloadTriggers[\s\S]{0,700}loadWorktableTemplate\(\)/.test(setJs)
      && setJs.includes('window.wtReloadTriggers = wtReloadTriggers');
  })());
ok('★ 잠긴 상태에서는 조건 값을 읽지 않는다(의도치 않게 건드리는 경로를 만들지 않는다)',
  /g\('wtTypeTrig'\) && !g\('wtTypeTrig'\)\.disabled/.test(setJs));
ok('★ 자동 선택 조건 목록은 **서버가 내려 준 것**을 그린다(프론트 규칙 사본 금지)',
  /function _wtTriggers\(\)[\s\S]{0,200}_wtTpl\.triggers/.test(setJs)
  && /var trigs = _wtTriggers\(\)/.test(setJs)
  && !/options_2plus|courier_proxy|delivery_real/.test(setJs));   // 조건 키가 프론트에 하드코딩되지 않음

/* ── 작업오더 기반 자동 선택(사용자 확정: 쿠팡 + 상품옵션 2가지 → 채널 쿠팡 + 상품옵션 유형) ── */
const wsvc2 = require('../src/services/worktable.service');
const plan2 = require('../src/utils/worktablePlan');
ok('★ 조건 목록은 서버 단일 출처 — 판정 함수가 그 키를 전부 안다',
  wsvc2.WORK_TYPE_TRIGGERS.length >= 6
  && wsvc2.WORK_TYPE_TRIGGERS.every(t => t.key && t.label)
  && wsvc2.WORK_TYPE_TRIGGERS.some(t => t.key === 'auto'));
ok('★★ 조건 판정 실행 — 작업오더 칸에서 파생된다',
  (() => {
    const ev = plan2.evalWorkTypeTrigger;
    const wo = { courier_proxy: true, delivery_type: '실배송', review_type: '포토' };
    return ev('options_2plus', { optionCount: 2 }) === true
      && ev('options_2plus', { optionCount: 1 }) === false
      && ev('courier_proxy', { workOrder: wo }) === true
      && ev('courier_proxy', { workOrder: { courier_proxy: false } }) === false
      && ev('courier_proxy', { workOrder: { courier_proxy: 'true' } }) === true   // 문자열 boolean 도 인정
      && ev('delivery_real', { workOrder: wo }) === true
      && ev('delivery_empty', { workOrder: wo }) === false
      && ev('review_type_set', { workOrder: wo }) === true
      && ev('review_type_set', { workOrder: { review_type: '  ' } }) === false
      && ev('always', {}) === true && ev('never', { optionCount: 9 }) === false;
  })());
ok('★★ 값 없음·모르는 값 = 기존 동작(옵션 열 보유 + 옵션 2종 이상) — 옛 저장분이 조용히 안 달라진다',
  (() => {
    const ev = plan2.evalWorkTypeTrigger;
    return ev('', { hasOptionColumn: true, optionCount: 2 }) === true
      && ev('무슨값', { hasOptionColumn: true, optionCount: 2 }) === true
      && ev('auto', { hasOptionColumn: false, optionCount: 5 }) === false
      && ev('auto', { hasOptionColumn: true, optionCount: 1 }) === false;
  })());
ok('★★ 사용자 시나리오 실행 — "쿠팡 + 상품옵션 2가지" 작업오더 → 채널 쿠팡 · 상품옵션 유형 자동 선택',
  (() => {
    const tpl = {
      core: ['번호', '구매일자', '수취인', '연락처', '비고'],
      channels: { coupang: ['쿠팡ID'] }, customChannels: [],
      workTypes: [
        { key: 't1', label: '상품옵션', position: 'front', columns: ['옵션'], autoTrigger: 'options_2plus' },
        { key: 't2', label: '택배발송대행', position: 'back', columns: ['택배송장번호'], autoTrigger: 'courier_proxy' },
      ],
    };
    const wo = {
      recruit_count: 10, daily_count: 5, start_date: '2026-08-10',
      product_url: 'https://www.coupang.com/vp/products/123',
      product_options_json: JSON.stringify([{ name: 'A', options: [{ label: '레드' }, { label: '블루' }] }]),
      courier_proxy: false,
    };
    const p = plan2.buildWorktablePlan({ workOrder: wo, template: tpl, options: {} });
    if (p.channel !== 'coupang') return false;
    if (p.suggestedWorkTypes.join(',') !== 't1') return false;       // 상품옵션만 제안
    // 화면이 그 제안을 켠 뒤(=담당자가 확인) 만들면 옵션 열이 실제로 붙는다
    const p2 = plan2.buildWorktablePlan({ workOrder: wo, template: tpl, options: { workTypes: p.suggestedWorkTypes } });
    const names = p2.columns.map(c => c.name);
    return names.indexOf('옵션') === 2 && names.indexOf('쿠팡ID') > 0 && names.indexOf('택배송장번호') < 0;
  })());
ok('★ 제안 근거를 화면이 말한다(근거 없는 자동 체크 금지)',
  /function workTypeTriggerReason/.test(readS('utils/worktablePlan.js'))
  && /suggestReason: suggested \? workTypeTriggerReason/.test(readS('utils/worktablePlan.js'))
  && /자동 제안 — \$\{esc\(t\.suggestReason\)\}/.test(wdesk));
ok('★ 옵션 개수는 **작업오더가 말한 종류 수**로 센다 — 총 건수 0(미정)이어도 제안이 죽지 않는다',
  (() => {
    const tpl = { core: ['번호'], channels: {}, customChannels: [],
      workTypes: [{ key: 't1', label: '상품옵션', position: 'front', columns: ['옵션'], autoTrigger: 'options_2plus' }] };
    const wo = { recruit_count: 0, product_options_json: JSON.stringify([{ name: 'A', options: [{ label: 'ㄱ' }, { label: 'ㄴ' }] }]) };
    return plan2.buildWorktablePlan({ workOrder: wo, template: tpl, options: {} }).suggestedWorkTypes.join(',') === 't1';
  })());
ok('★ 작업표 미리보기가 자동 선택 결과를 화면에 말해 준다(조용히 켜 두지 않는다)',
  /autoOn\s*=\s*types\.filter\(t=>t\.suggested&&t\.enabled\)/.test(wdesk)
  && /작업오더를 보고 \$\{autoOn\.length\}종이 자동 선택됨/.test(wdesk));
ok('★★ 자동 선택 조건은 **저장 페이로드 안**에 실린다 — 빠뜨리면 조용히 auto 로 되돌아간다(실측 버그)',
  (() => {
    const i = setJs.indexOf('async function wtSaveTemplate');
    const body = setJs.slice(i, setJs.indexOf('\n/* ──', i) > i ? setJs.indexOf('\n/* ──', i) : i + 2500);
    return i > -1
      && /workTypes: _wtTypes\(\)\.map/.test(body)
      && /autoTrigger: t\.autoTrigger/.test(body)        // ← 페이로드 안에 있어야 한다
      && /autoTrigger: WORK_TYPE_TRIGGER_KEYS\.has\(trig\) \? trig : 'auto'/.test(svcSrc);
  })());

console.log(`\n✅ worktableTemplate: ${n}개 통과`);
// orderLedger.service 를 require 하면 DB 풀 핸들이 열려 프로세스가 안 끝난다(레포 관용구).
process.exit(0);
