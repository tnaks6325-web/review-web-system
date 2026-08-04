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
ok('★ 집계 서비스에 쓰기 SQL 이 없다(순수 읽기)',
  !/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i.test(svcSrc));
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
ok('작업표 라우트는 읽기 전용 — POST/PUT/DELETE 미등록',
  !_layers.some(l => /^\/worktable/.test(l.route.path)
    && (l.route.methods.post || l.route.methods.put || l.route.methods.delete)));

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
   E. 통합작업대 화면 배선
   ══════════════════════════════════════════════════════════ */
ok('작업표 탭이 nav 에 있고 switchView 가 분기한다',
  /data-v="worktable"/.test(wdesk) && /v==='worktable'\) renderWorktableView\(\)/.test(wdesk));
ok('작업표 탭은 관리자 nav 에만 노출(AE nav 미포함 — 서버 adminOrMaster 와 1:1)',
  (() => {
    const navs = wdesk.split('isStaff?`<nav class="nav">');
    return /data-v="worktable"/.test(navs[0]) && !/data-v="worktable"/.test(navs[1] || '');
  })());
ok('리포트는 서버 분류 결과를 그릴 뿐 — 프론트에 키워드 사본 없음',
  /header-stats/.test(wdesk)
  && !/includes\('수취인'\)|includes\('예금주'\)/.test(wdesk));
ok('헤더·본문 폭 상한이 같은 값(어긋나면 제목만 화면 끝으로 밀린다 — 레포 규칙)',
  (() => {
    const h = /#wthead \.mh\{max-width:(\d+)px\}/.exec(wdesk);
    const b = /#wtbody\{max-width:(\d+)px\}/.exec(wdesk);
    return h && b && h[1] === b[1];
  })());
ok('출력은 전부 esc() 통과(헤더명은 시트에서 온 자유 문자열)',
  !/\$\{(u\.name|r\.label|v\.name)\}/.test(wdesk));

console.log(`\n✅ worktableTemplate: ${n}개 통과`);
// orderLedger.service 를 require 하면 DB 풀 핸들이 열려 프로세스가 안 끝난다(레포 관용구).
process.exit(0);
