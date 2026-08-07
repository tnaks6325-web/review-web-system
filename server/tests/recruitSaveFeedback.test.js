/**
 * recruitSaveFeedback.test.js — 모집공고 [저장] 반응 회귀가드
 * 실행: node tests/recruitSaveFeedback.test.js
 *
 * ═══════════════════════════════════════════════════════════════════
 * 고치는 사고(실측 2026-08-07):
 *   리뷰웹시스템[3버전]에서 공고를 수정하고 [저장]을 눌러도 **아무 반응이 없다**.
 *   원인 = 안내는 나갔지만 **화면에 안 보였다**:
 *     · workdesk.html 의 토스트 `.wdtoast` 는 z-index:60
 *     · 공고 모달 `#recruitModal.modal-overlay` 는 z-index:5000 + backdrop-filter:blur
 *     → 모달이 떠 있는 동안 토스트는 덮개 아래에 그려지고 블러까지 먹는다.
 *   게다가 게시 전 자동 점검(시트 탭 gid)에 걸리면 저장은 전송 전에 중단되어
 *   모달도 닫히지 않는다 → 사용자 눈에는 정확히 "아무 일도 안 일어남".
 *
 * 그래서 고정하는 것(시안 C 확정 · frontend/docs/design-recruit-save-feedback.html):
 *   A. 성공  = 버튼 ✓ → 모달 닫힘 → **화면 가운데 카드**(공고 이름 + 바뀐 항목) → 페이드아웃
 *   B. 차단·실패 = 토스트가 아니라 **모달 안쪽** 인라인 줄(rf-blockbar) + 자동 소멸 없음
 *   C. 렌더러는 recruit-modal.js **한 벌**(admin.html·workdesk.html 공용, 사본 금지)
 *   D. 오버레이는 **body 직속** + 모달(5000)보다 위 z-index
 *   E. 저장 버튼 인터랙션(hover/active/busy/done)이 **인라인 style 이 아니라 클래스**
 *      — 인라인은 :hover 의 background 를 이길 수 없어 "눌렸는지 모르겠다"가 안 고쳐진다
 * ═══════════════════════════════════════════════════════════════════
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const modal   = readF('js/recruit-modal.js');
const recruit = readF('js/index-recruit.js');
const doc     = readF('docs/design-recruit-save-feedback.html');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

/* 줄 주석만 제거(블록 주석 정규식은 이 레포의 정규식 리터럴을 물어 코드를 통째로 삼킨다 — 실측) */
const stripLine = (s) => s.split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
/** 함수 본문 뽑기(중괄호 균형) */
function pick(src, name) {
  const m = src.match(new RegExp('function\\s+' + name + '\\s*\\('));
  if (!m) return '';
  let i = src.indexOf('{', m.index), d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1); }
  }
  return '';
}

console.log('\n── A. 성공 안내(가운데 카드 → 페이드아웃) ──');
const fb = pick(modal, 'campSaveFeedback');
ok('A1. recruit-modal.js 가 campSaveFeedback 을 정의하고 전역으로 노출한다',
  fb.length > 200 && /window\.campSaveFeedback\s*=\s*campSaveFeedback/.test(modal));
ok('A2. ★ 마운트는 body 직속 — 뷰 스크롤 컨테이너에 넣으면 화면 흐름에 섞인다',
  /document\.body\.appendChild\(box\)/.test(fb));
ok('A3. ★ z-index 가 모달(5000)보다 위',
  (() => {
    const fbz = /#campSaveFb\{[^}]*z-index:(\d+)/.exec(modal);
    const mz  = /#recruitModal\.modal-overlay\{[^}]*z-index:(\d+)/.exec(modal);
    return fbz && mz && Number(fbz[1]) > Number(mz[1]);
  })());
ok('A4. 자동 페이드아웃 — 유지 후 out 클래스 → 제거',
  /classList\.add\('out'\)/.test(fb) && /box\.remove\(\)/.test(fb) && /FB_HOLD_MS/.test(fb));
ok('A5. 문구는 공고 이름(사용자 확정) — 수정/발행 두 갈래',
  /공고 수정이 반영되었습니다/.test(fb) && /공고가 발행되었습니다/.test(fb) && /「/.test(fb));
ok('A6. ★ 긴 제목은 줄인다(실측 60자+ 제목이 카드를 화면만큼 키운다)',
  /fbClip\(opts\.title/.test(fb) && /function fbClip/.test(modal));
ok('A7. ★ 항목 목록이 비면 "바뀐 내용 없음"이라 단정하지 않는다(비교 못 한 필드가 있을 수 있다)',
  /csfb-sub/.test(fb) && !/바뀐 내용이 없습니다/.test(fb));
ok('A8. 목록은 3줄 + "외 N건"으로 자른다',
  /changes\.slice\(0,\s*3\)/.test(fb) && /외 '\s*\+\s*\(changes\.length - 3\)/.test(fb));
ok('A9. 값은 escape 한다(제목·항목명은 사람이 입력한 문자열)',
  /fbEsc\(title\)/.test(fb) && /fbEsc\(c\)/.test(fb));
ok('A10. 접근성 — role=status · aria-live · 클릭을 막지 않는다',
  /'role',\s*'status'/.test(fb) && /'aria-live',\s*'polite'/.test(fb) &&
  /#campSaveFb\{[^}]*pointer-events:none/.test(modal));
ok('A11. 재호출 시 이전 안내·타이머를 정리한다(연속 저장에 카드가 겹치지 않게)',
  /_fbTimers\.forEach\(clearTimeout\)/.test(fb) && /getElementById\('campSaveFb'\)[\s\S]{0,60}remove\(\)/.test(fb));
ok('A12. prefers-reduced-motion 이면 이동·그리기를 끄고 페이드만 남긴다',
  /@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?#campSaveFb/.test(modal));

console.log('\n── B. 차단·실패는 모달 안쪽(토스트 금지) ──');
const blk = pick(modal, 'recruitSaveBlock');
ok('B1. recruitSaveBlock / recruitSaveBlockClear 전역 노출',
  /window\.recruitSaveBlock\s*=\s*recruitSaveBlock/.test(modal) &&
  /window\.recruitSaveBlockClear\s*=\s*recruitSaveBlockClear/.test(modal));
ok('B2. ★ 모달 푸터 **안쪽**에 붙인다(덮개 z-index 와 무관해진다)',
  /querySelector\('#recruitModal \.modal-footer'\)/.test(blk) && /foot\.appendChild\(bar\)/.test(blk));
ok('B3. ★ 자동 소멸 없음 — 사라지면 원인을 다시 읽을 방법이 없다',
  !/setTimeout\([^)]*bar\.remove/.test(blk) && !/bar\.classList\.add\('out'\)/.test(blk));
ok('B4. 흔들림 1회 + 사유 텍스트 escape',
  /rf-shake/.test(blk) && /fbEsc\(text\)/.test(blk));
ok('B5. #recruitModal .modal-footer 가 position:relative — 없으면 줄이 엉뚱한 곳에 뜬다',
  /#recruitModal \.modal-footer\{position:relative\}/.test(modal));

console.log('\n── C. 저장 흐름 배선(index-recruit.js) ──');
const save = pick(recruit, 'saveRecruitPost');
ok('C1. 저장 시작 시 지난 차단 사유를 지운다',
  /recruitSaveBlockClear\(\)/.test(save.slice(0, 400)));
ok('C2. ★ 성공 = 버튼 ✓ → closeRecruitModal → campSaveFeedback 순서',
  (() => {
    const iDone  = save.indexOf('✓ 저장됨');
    const iClose = save.indexOf('closeRecruitModal()');
    const iFb    = save.indexOf('campSaveFeedback(');
    return iDone > -1 && iClose > iDone && iFb > iClose;
  })());
ok('C3. 안내에 공고 이름과 바뀐 항목을 넘긴다',
  /campSaveFeedback\(\{ title: payload\.title, changes: _changed/.test(save));
ok('C4. ★ 변경 항목은 **모달을 닫기 전에** 계산한다(닫은 뒤엔 폼 값을 읽을 수 없다)',
  save.indexOf('_rfChangedLabels(payload)') > -1 &&
  save.indexOf('_rfChangedLabels(payload)') < save.indexOf('closeRecruitModal()'));
ok('C5. 실패는 모달 안 인라인으로 남긴다(토스트 아님)',
  /catch\(e\) \{[\s\S]{0,320}_rfSaveBlocked\(/.test(save) &&
  !/catch\(e\) \{[\s\S]{0,200}showToast\("저장 오류/.test(save));
ok('C6. 게시 전 자동 점검 차단도 인라인 + [점검 항목 보기]',
  /errs\.length\) \{[\s\S]{0,220}_rfSaveBlocked\([^)]*\{ go: _rfGoToCheck \}\)/.test(save));
ok('C7. ★ 성공 후에는 버튼을 원복하지 않는다(모달이 닫히므로) — 실패에만 되돌린다',
  /if \(!_ok\) \{[\s\S]{0,220}btn\.innerHTML = '<i class="fas fa-save"><\/i> 저장'/.test(save));
ok('C8. 모달을 다시 열 때 버튼 상태를 되돌린다(✓ 저장됨/비활성 잔류 방지)',
  /_sb\.classList\.remove\("busy", "done"\)/.test(pick(recruit, 'openRecruitModal')));
ok('C9. 구버전 모듈 폴백 — 렌더러가 없으면 종전 토스트로 알린다(무신호 금지)',
  /typeof campSaveFeedback === "function"/.test(save) && /showToast\(_wasEdit \?/.test(save));
/* ★ 남아 있는 showToast 2건(작업오더 역연결 실패)은 **성공 확정 후** 나가고 토스트가 5.2초
   유지되어 모달이 닫힌 뒤에도 보인다 — 그래서 그대로 둔다. 고정하는 것은
   "모달이 떠 있는 동안의 차단·오류 사유"를 토스트로 되돌리지 않는 것이다. */
ok('C10. ★ 차단·오류 사유는 토스트로 나가지 않는다(모달 덮개 아래로 깔린다)',
  (() => {
    const s = stripLine(save);
    const toasts = s.match(/showToast\([\s\S]{0,90}?\)/g) || [];
    const banned = /저장 오류|게시 불가|중복됐어요|입력해주세요|선택해주세요|저장하지 못했습니다/;
    return toasts.length <= 3 && toasts.every(t => !banned.test(t));
  })());

console.log('\n── D. 바뀐 항목 비교기 ──');
const sandbox = { window: {}, document: { getElementById: () => null, querySelector: () => null } };
const ctx = vm.createContext(sandbox);
[
  '_RF_DIFF_FIELDS', '_RF_DIFF_WORKDETAIL',
].forEach(n => {
  const m = recruit.match(new RegExp('const ' + n + ' = \\[[\\s\\S]*?\\n\\];'));
  assert(m, '재료 추출 실패: ' + n);
  vm.runInContext(m[0], ctx);
});
['_rfNormVal', '_rfSame', '_rfNormOptRows', '_rfNormFeeRows', '_rfChangedLabels'].forEach(n => {
  const body = pick(recruit, n);
  assert(body, '함수 추출 실패: ' + n);
  vm.runInContext('function ' + n + (recruit.slice(recruit.indexOf('function ' + n + '(') + ('function ' + n).length).match(/^\([^)]*\)/) || ['()'])[0] + ' ' + body, ctx);
});

const N = sandbox._rfNormVal;
ok('D1. 서버 표기 차이를 흡수한다(타임스탬프→날짜 · 10:00:00→10:00 · 1000.00→1000)',
  N('2026-08-01T00:00:00.000Z') === '2026-08-01' && N('10:00:00') === '10:00' && N('1000.00') === '1000');
ok('D2. 숫자/불리언/빈값 정규화',
  N(1000) === N('1000') && N(true) === '1' && N(null) === '' && N(undefined) === '' && N('  x ') === 'x');

const diff = (payload, loaded, extra) => {
  sandbox.window._recruitEditLoaded = loaded;
  sandbox.window._recruitEditLoadFailed = false;
  sandbox.window._recruitEditLoadedOpts = (extra && extra.opts) || null;
  sandbox.window._recruitEditLoadedFees = (extra && extra.fees) || null;
  return sandbox._rfChangedLabels(payload);
};
ok('D3. 안 바꾸면 빈 목록(라운드트립 오탐 0)',
  diff({ title: 'A', review_fee: 1000, window_start: '10:00', start_date: '2026-08-01', reviewer_hidden: false },
       { title: 'A', review_fee: '1000.00', window_start: '10:00:00', start_date: '2026-08-01T00:00:00.000Z', reviewer_hidden: false }
  ).length === 0);
ok('D4. 바꾼 칸만 한국어 라벨로 나온다',
  JSON.stringify(diff({ title: 'B', review_fee: 1500 }, { title: 'A', review_fee: 1000 })) ===
  JSON.stringify(['공고 제목', '리뷰비']));
ok('D5. 같은 라벨을 쓰는 칸(구매시간 start/end)은 한 번만 센다',
  JSON.stringify(diff({ window_start: '09:00', window_end: '12:00' }, { window_start: '10:00', window_end: '11:00' })) ===
  JSON.stringify(['구매시간']));
ok('D6. ★ payload 에 없는 키는 비교하지 않는다(축약 화면이 미전송한 설정을 "바뀜"으로 보고하지 않는다)',
  diff({ title: 'A' }, { title: 'A', daily_limit: 20, transfer_bank: 'hana' }).length === 0);
ok('D7. work_detail 4칸은 각각의 라벨로',
  JSON.stringify(diff(
    { work_detail: { productLines: 'p', inflowGuideHtml: 'x', reviewGuide: 'r', specialNotes: 'n' } },
    { work_detail: { productLines: 'p', inflowGuideHtml: 'y', reviewGuide: 'r', specialNotes: 'm' } }
  )) === JSON.stringify(['유입가이드', '특이사항']));
ok('D8. ★ 옵션표는 서버(snake_case)↔폼(camelCase) 양쪽 키를 읽는다 — 안 그러면 매번 "바뀜" 오탐',
  diff({ options: [{ optKey: 'A', payAmount: 100, recruitTotal: 10, dailyLimit: 2 }] }, {},
       { opts: [{ opt_key: 'A', pay_amount: '100', recruit_total: 10, daily_limit: 2 }] }).length === 0 &&
  diff({ options: [{ optKey: 'A', payAmount: 200, recruitTotal: 10, dailyLimit: 2 }] }, {},
       { opts: [{ opt_key: 'A', pay_amount: '100', recruit_total: 10, daily_limit: 2 }] })[0] === '진행상품·옵션');
ok('D9. 기간별 리뷰비도 같은 방식',
  diff({ fee_schedules: [{ effectiveFrom: '2026-07-01', reviewFee: 1000 }] }, {},
       { fees: [{ effective_from: '2026-07-01', review_fee: '1000' }] }).length === 0);
ok('D10. ★ 원본을 모르면(로드 실패·신규) 목록을 만들지 않는다 — 틀린 목록은 빈 목록보다 나쁘다',
  (() => {
    sandbox.window._recruitEditLoaded = { title: 'A' };
    sandbox.window._recruitEditLoadFailed = true;
    const a = sandbox._rfChangedLabels({ title: 'B' }).length === 0;
    sandbox.window._recruitEditLoaded = null;
    sandbox.window._recruitEditLoadFailed = false;
    return a && sandbox._rfChangedLabels({ title: 'B' }).length === 0;
  })());
ok('D11. ★ 빈 값 ↔ 0 은 같은 상태(실측 오탐: 서버 NULL 을 폼이 0 으로 되보내 "모집인원 바뀜"이 떴다)',
  sandbox._rfSame(0, null) && sandbox._rfSame(0, undefined) && sandbox._rfSame('', 0) &&
  !sandbox._rfSame(0, 1) &&
  diff({ max_slots: 0, review_fee: 0, reviewer_hidden: false }, { title: 'A' }).length === 0);
ok('D12. ★ 비교 결과는 저장 여부를 가르지 않는다(빈 목록이어도 저장·안내는 그대로)',
  !/_changed\.length[\s\S]{0,40}return/.test(save) && !/if \(!_changed\.length\)/.test(save));

console.log('\n── E. 저장 버튼 인터랙션 ──');
ok('E1. ★ 인라인 style 이 아니라 클래스 — 인라인은 :hover 의 background 를 이길 수 없다',
  /<button id="recruitSaveBtn" class="rf-savebtn"/.test(modal) &&
  !/id="recruitSaveBtn"[^>]*style="/.test(modal));
ok('E2. hover / active / focus-visible / disabled 규칙이 있다',
  /\.rf-savebtn:hover:not\(:disabled\)/.test(modal) && /\.rf-savebtn:active:not\(:disabled\)/.test(modal) &&
  /\.rf-savebtn:focus-visible/.test(modal) && /\.rf-savebtn:disabled/.test(modal));
ok('E3. 전송 중(busy) · 성공(done) 상태 클래스',
  /\.rf-savebtn\.busy/.test(modal) && /\.rf-savebtn\.done/.test(modal) &&
  /btn\.classList\.add\("busy"\)/.test(save) && /btn\.classList\.add\("done"\)/.test(save));
ok('E4. 전송 중에는 비활성 — 두 번 눌러 두 번 저장되지 않는다',
  /btn\.disabled = true;[\s\S]{0,120}btn\.classList\.add\("busy"\)/.test(save));
ok('E5. 스피너는 폰트어썸에 기대지 않는다(리뷰웹시스템[3버전]엔 아이콘이 없을 수 있다)',
  /rf-spin/.test(modal) && /<span class="rf-spin">/.test(save));

console.log('\n── F. 단일 출처 · 사본 금지 ──');
ok('F1. ★ 안내 렌더러 정의는 recruit-modal.js 한 곳 — 화면별 사본 금지',
  (() => {
    const others = ['js/index-recruit.js', 'js/index-app.js', 'js/campaign-cards.js', 'workdesk.html', 'admin.html']
      .map(p => { try { return readF(p); } catch (_) { return ''; } });
    return others.every(s => !/function campSaveFeedback/.test(s) && !/csfb-box/.test(s));
  })());
ok('F2. admin.html · workdesk.html 둘 다 recruit-modal.js 를 로드한다(공용)',
  /recruit-modal\.js/.test(readF('admin.html')) && /recruit-modal\.js/.test(readF('workdesk.html')));
ok('F3. FB_CSS 중괄호 균형 — 하나만 어긋나도 브라우저가 조용히 파싱을 포기한다',
  (() => {
    const m = modal.match(/var FB_CSS = `([\s\S]*?)`;/);
    if (!m) return false;
    const s = m[1];
    return (s.match(/\{/g) || []).length === (s.match(/\}/g) || []).length;
  })());
ok('F4. FB_CSS 는 남의 규칙을 품지 않는다(#campSaveFb · @media · @keyframes 만)',
  (() => {
    const m = modal.match(/var FB_CSS = `([\s\S]*?)`;/);
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
    // 최상위 선택자만 검사(중첩 블록 제외)
    let depth = 0, sel = '', bad = [];
    for (const ch of body) {
      if (ch === '{') { if (depth === 0) { const t = sel.trim(); if (t) bad.push(t); } depth++; sel = ''; }
      else if (ch === '}') { depth--; sel = ''; }
      else if (depth === 0) sel += ch;
    }
    return bad.every(t => t.startsWith('#campSaveFb') || t.startsWith('@media') || t.startsWith('@keyframes'));
  })());

console.log('\n── G. 시안 문서 ──');
ok('G1. 시안 문서가 있고 외부 리소스를 쓰지 않는다(오프라인 열람)',
  doc.length > 3000 && !/<script[^>]+src=/.test(doc) && !/<link[^>]+href="http/.test(doc));
ok('G2. 확정된 안(C · 공고 이름)이 문서에 남아 있다',
  /C 안/.test(doc) && /공고 이름/.test(doc));

console.log('\n✅ recruitSaveFeedback: ' + passed + '개 통과\n');
