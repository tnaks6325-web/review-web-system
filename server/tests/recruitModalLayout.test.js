/**
 * recruitModalLayout.test.js — 관리자 공고 수정 모달 레이아웃 회귀가드 (v2 레일 배치).
 *
 * v2 재구성(디자인 시안 C — frontend/docs/design-recruit-modal-v2.html):
 *  · 참여형이 기본 — 스위치(녹색 박스) 제거, hidden 체크박스만 유지(저장·프리필·서버 분기 무변경).
 *  · 통일 카드 문법 — 색 박스 4종(참여형 녹·기간별 리뷰비 녹·타계정 보라·현영 주황) 폐기,
 *    흰 카드(.rf-card) + 회색 헤더바 + 라벨 82px 한 종(.rf-hrow)으로 통일.
 *  · 레일 = 배치 편집기 — 좌측 목차에서 ⠿ 드래그로 본문 카드 재배치, localStorage 저장(서버 0).
 *    고정 2(link 맨 위 · pub 맨 아래) + 자유 5(prod/cond/fee/info/work).
 *
 * ★ 실측 버그 고정(유지): CSS를 @media 안에 넣어 특정 폭에서만 적용되던 것 — 최상위에 있어야 한다.
 * ★ 실측 사고 고정(유지): 모듈 CSS를 어긋나게 잘라 붙여 중괄호 불균형 → 브라우저가 조용히 파싱 포기.
 *   grep 으론 못 잡으므로 토큰을 센다.
 * 실행: node tests/recruitModalLayout.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

// 모달 마크업·CSS·배치 로직은 공유 모듈(js/recruit-modal.js) 한 벌 — admin·리뷰웹시스템[3버전] 공용(사본 금지)
const modalSrc = readF('js/recruit-modal.js');
const adm = modalSrc + '\n' + readF('admin.html');
const rec = readF('js/index-recruit.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/** 모달 영역만 잘라 검사(다른 모달과 섞이지 않게) */
const modal = adm.slice(adm.indexOf('id="recruitModal"'), adm.indexOf('id="recruitSettingsModal"') > 0
  ? adm.indexOf('id="recruitSettingsModal"') : adm.indexOf('id="recruitModal"') + 40000);

/* ── 3단 구조: 레일(배치) / 입력 카드 / 미리보기 ── */
ok('모달이 레일(배치 편집) / 입력 / 미리보기 3단', /class="rf-rail"/.test(modal)
  && /class="rf-split"/.test(modal) && /class="rf-main"/.test(modal) && /class="rf-side"/.test(modal));
ok('미리보기가 오른쪽 열 안에 있다(입력란 아래 스택 아님)',
  /<aside class="rf-side">[\s\S]{0,400}id="rf_preview_section"/.test(modal));
ok('모달 폭 확대(3단이 들어갈 만큼)', (() => {
  const m = /class="modal-box rf-box"[^>]*max-width:(\d+)px/.exec(modal);
  return !!m && Number(m[1]) >= 1200;
})());
ok('입력 영역만 스크롤(모달 전체가 아니라)', /class="modal-body"[^>]*overflow-y:auto[^>]*flex:1/.test(modal));

/* ── ★ CSS 스코프 (실측 버그) ── */
ok('★ 레이아웃 CSS가 미디어쿼리 밖에 있다 — 안에 두면 특정 폭에서만 적용된다', (() => {
  const i = adm.indexOf('.rf-split{display:flex');
  if (i < 0) return false;
  const before = adm.slice(0, i);
  // 직전에 열린 @media 가 이미 닫혔는지(= 최상위인지) 확인
  const opens = (before.match(/@media[^{]*\{/g) || []).length;
  const closes = (before.match(/\n\}/g) || []).length;
  return closes >= opens;
})());
ok('좁은 화면에서는 세로로 되돌리고 레일은 접는다(배치 편집은 넓은 화면 전용)',
  /@media \(max-width:900px\)[\s\S]{0,260}\.rf-split\{flex-direction:column/.test(adm)
  && /@media \(max-width:900px\)[\s\S]{0,400}\.rf-rail\{display:none\}/.test(adm));

/* ── 통일 카드 문법 (v2 — 들쭉날쭉의 원인 제거) ── */
ok('섹션 = 카드 7장(data-sec) — link·prod·cond·fee·info·work·pub', (() => {
  const keys = ['link', 'prod', 'cond', 'fee', 'info', 'work', 'pub'];
  return keys.every(k => modal.includes(`data-sec="${k}"`))
    && (modal.match(/class="rf-card"[^>]*data-sec=/g) || []).length === keys.length;
})());
ok('고정 2: link 가 첫 카드, pub 이 마지막 카드(레일 드래그도 이 사이만 허용)', (() => {
  const idx = ['link', 'prod', 'cond', 'fee', 'info', 'work', 'pub'].map(k => modal.indexOf(`data-sec="${k}"`));
  return idx[0] === Math.min(...idx) && idx[6] === Math.max(...idx.filter(i => i >= 0));
})());
ok('★ 색 박스 폐기 — 참여형 녹색(#12b886 테두리)·타계정 보라(#7C3AED)·현영 주황(#F0B45E) 박스가 없다',
  !/border:1\.5px solid #12b886/.test(modal) && !/border:1\.5px solid #7C3AED/.test(modal)
  && !/border:1\.5px solid #F0B45E/.test(modal));
ok('라벨은 82px 우측정렬 한 종 — 종전 64/76px 혼재 제거',
  /\.rf-hrow\{display:grid;grid-template-columns:82px 1fr/.test(adm)
  && !/grid-template-columns:64px 1fr/.test(adm) && !/\.rf-hrow\.rf-hrow-w\{grid-template-columns:76px/.test(adm)
  && (modal.match(/class="rf-hrow/g) || []).length >= 12);
ok('카드 헤더 한 벌(.rf-ch/.rf-ct) + 고정 배지(.rf-pinbadge)',
  /\.rf-card\{border:1px solid/.test(adm) && /\.rf-ch\{display:flex/.test(adm)
  && (modal.match(/class="rf-ch"/g) || []).length === 7
  && (modal.match(/class="rf-pinbadge"/g) || []).length === 2);
ok('진행상품 표 = 상품명·옵션명·결제금액·총인원·일건수 5열',
  /\.rf-prod-head,\.rf-opt-row\{display:grid/.test(adm)
  && /class="rf-prod-head"/.test(modal)
  && /rf-opt-prod/.test(rec) && /rf-opt-rt/.test(rec) && /rf-opt-dl/.test(rec));
ok('캠페인 정원은 표에서 파생(별도 입력칸 없음 — hidden)',
  /id="rf_daily_limit" type="hidden"/.test(modal) && /id="rf_recruit_total" type="hidden"/.test(modal)
  && /function _syncPreviewFromOptRows/.test(rec));
ok('종료일은 시트와 다르면 경고만 — 실제 모집은 시트를 따른다',
  /id="rf_deadline"/.test(modal) && /실제 모집은 <b>시트를 따릅니다<\/b>/.test(rec));
ok('현금영수증은 탭 설정 읽기 전용(공고에서 변경 불가)',
  /id="rf_cashrcpt_ro"/.test(modal) && /function refreshRecruitCashReceipt/.test(rec)
  && !/id="rf_income_type"/.test(modal));
ok('밀도 — 라벨·입력 간격 축소 + 짧은 항목 2열',
  /\.rf-main \.rform-label\{margin-bottom:2px/.test(adm) && /class="rf-grid2"/.test(modal));
ok('미리보기가 모달 세로를 꽉 쓴다(고정 max-height 캡 제거)',
  /id="rf_preview_area"[^>]*flex:1/.test(modal) && !/id="rf_preview_area"[^>]*max-height:\d+px/.test(modal));

/* ── ★ 참여형 기본 (v2 — 스위치 UI 제거, 값 계약은 불변) ── */
ok('★ 참여형 체크박스는 hidden 으로 살아 있다(저장 페이로드·서버 분기 무변경)',
  /<input type="checkbox" id="rf_participation" checked[^>]*style="display:none"/.test(modal));
ok('★ 신규 공고는 참여형이 켜져 열린다(초기화가 true)',
  /_partEl\.checked = true; onParticipationToggle\(true\)/.test(rec));
ok('★ 레거시 공고 편집은 else 분기가 다시 끈다(초기화 true 를 되돌림)',
  /pe\.checked = false; onParticipationToggle\(false\)/.test(rec));
ok('레거시 안내 카드 + [참여형으로 전환] 버튼(모듈이 처리)',
  /id="rf_legacy_note"/.test(modal) && /rfLegacyConvert\(\)/.test(modal)
  && /window\.rfLegacyConvert = function/.test(modalSrc));
ok('★ 참여형 스위치가 rf_work_section도 함께 토글 — 안 하면 레거시 공고에 작업내용이 보인다',
  /const work = document\.getElementById\("rf_work_section"\)[\s\S]{0,120}work\.style\.display = on \? "" : "none"/.test(rec));
ok('참여형이 꺼지면 모집조건 카드가 숨는다',
  /rf_part_section[\s\S]{0,160}display = on \? "" : "none"/.test(rec));
ok('★ 참여형 전용 카드는 data-part-only 로 일괄 토글(진행상품·자동점검) + 레일 동기화',
  /querySelectorAll\("#recruitModal \[data-part-only\]"\)/.test(rec)
  && (modal.match(/data-part-only/g) || []).length >= 2
  && /RecruitModal\.refreshRail\(\)/.test(rec));

/* ── ★ 레일 = 배치 편집기 (v2) ── */
ok('레일 목차 컨테이너 + 안내 + 프리셋 2종(기본 순서·수정 최적화)',
  /id="rfRailList"/.test(modal) && /RecruitModal\.preset\('default'\)/.test(modal)
  && /RecruitModal\.preset\('edit'\)/.test(modal));
ok('자유 5 = prod/cond/fee/info/work — 고정(link·pub)은 배치 대상이 아니다',
  /var SEC_FREE = \['prod', 'cond', 'fee', 'info', 'work'\]/.test(modalSrc));
ok('★ 순서는 localStorage(rf_layout_v1) 관리자별 저장 — 서버 변경 0 · 실패는 기본 순서 폴백',
  /var LAYOUT_KEY = 'rf_layout_v1'/.test(modalSrc)
  && /localStorage\.setItem\(LAYOUT_KEY/.test(modalSrc)
  && /catch \(_\) \{ return null; \}/.test(modalSrc));
ok('★ 모르는 키 무시 + 빠진 키는 기본 순서 보충(버전업 시 새 섹션이 사라지지 않게)',
  /filter\(function \(k\) \{ return SEC_FREE\.indexOf\(k\) >= 0; \}\)/.test(modalSrc)
  && /SEC_FREE\.forEach\(function \(k\) \{ if \(valid\.indexOf\(k\) < 0\) valid\.push\(k\); \}\)/.test(modalSrc));
ok('★ 재배치는 항상 pub(맨 아래 고정) 앞으로만 — 고정 2 불변식',
  /b\.insertBefore\(c, pub\)/.test(modalSrc)
  && /rail\.insertBefore\(_drag, pinb\)/.test(modalSrc));
ok('★ 드래그는 ⠿ 핸들을 잡을 때만(draggable 지연 부여 — 입력칸 텍스트 선택과 무충돌)',
  /h\.addEventListener\('mousedown', function \(\) \{ it\.draggable = true; \}\)/.test(modalSrc)
  && /it\.draggable = false/.test(modalSrc));
ok('레일은 본문 DOM 이 단일 출처(카드에서 다시 그림) — 레거시로 숨은 카드는 목차에서도 뺀다',
  /if \(c\.style\.display === 'none'\) return;/.test(modalSrc)
  && /querySelector\('\.rf-ct'\)/.test(modalSrc));
ok('레일 상태 표시(● 필수 미입력 · ⚠ 경고 · ✓ 입력됨) + 클릭 = 카드로 스크롤',
  /function _railMark\(key\)/.test(modalSrc) && /scrollIntoView\(\{ behavior: 'smooth'/.test(modalSrc)
  && /function updateRailMarks\(\)/.test(modalSrc));
ok('마운트 시 저장된 배치 복원(applyLayout) + 입력 감시(bindLive)',
  /applyLayout\(loadLayout\(\)\)/.test(modalSrc) && /bindLive\(\)/.test(modalSrc));

/* ── 리뷰어 앱과 맞춘 편의 ── */
ok('리뷰비 100원 단위(리뷰어 앱과 동일)', /id="rf_review_fee"[\s\S]{0,140}step="100"/.test(modal));
ok('상품 URL 옆 [바로가기 ↗]', /openRecruitProductUrl\(\)/.test(modal) && /function openRecruitProductUrl/.test(rec));
ok('자율주문 자동 감지 — 시간 표기에 자유/자율이면 구매시간 비움 + 안내',
  /function _isRecruitAutoOrder/.test(rec) && /자유\|자율/.test(rec)
  && /id="rf_autoorder_note"/.test(modal) && /oninput="onRecruitTimeRangeInput\(\)"/.test(modal));
ok('자율주문 판정은 사용자가 자율로 적었을 때만 값을 지운다(오작동 여지 없음)',
  /if \(auto\) \{[\s\S]{0,200}if \(el && el\.value\) el\.value = ""/.test(rec));

/* ── 필드 보존 (ID를 건드리지 않았는지) ── */
ok('저장·프리필이 참조하는 필드가 모두 살아있다', (() => {
  const ids = ['rf_title', 'rf_product_url', 'rf_review_fee', 'rf_time_range', 'rf_linked_campaign',
    'rf_linked_tab', 'rf_status', 'rf_max_slots', 'rf_participation', 'rf_start_date',
    'rf_window_start', 'rf_window_end', 'rf_daily_limit', 'rf_recruit_total', 'rf_landing_url',
    'rf_thumb_file', 'rf_thumb_url', 'rf_multi_account', 'rf_multi_daily', 'rf_sub_ttl',
    'rf_hold_ttl', 'rf_close_buffer', 'rf_opt_rows', 'rf_part_check', 'rf_deadline', 'rf_notes',
    'rf_wd_product', 'rf_wd_inflow', 'rf_wd_review', 'rf_wd_notes', 'rf_preview_card',
    'rf_review_type', 'rf_transfer_bank', 'rf_transfer_memo', 'rf_reviewer_hidden', 'rf_fee_rows'];
  return ids.every(id => modal.includes(`id="${id}"`));
})());

/* ── 작업오더 상품정보 자동 분해(사용자 확정 ②) ── */
ok('상품정보 텍스트를 줄 단위로 분해하는 파서가 있다',
  /function parseProductLinesToRows\(text, fallbackProductName\)/.test(rec));
ok('결제금액 표기(28,900원 / 26900)를 숫자로 뽑는다',
  /결제금액\\s\*\(\[\\d,\]\+\)/.test(rec) && /replace\(\/,\/g, ""\)/.test(rec));
ok('둘째 줄 상품명이 생략되면 앞 줄 상품명을 이어 쓴다',
  /if \(lastProd\) \{ productName = lastProd; optKey = parts\[0\]; \}/.test(rec));
ok('★ "옵션 없음" 류는 옵션으로 저장하지 않는다(시트 옵션열 오염·가짜 선택지 방지)',
  /\^\(옵션\\s\*없음\|없음\|단일/.test(rec));
ok('분해가 애매해도 값을 버리지 않는다(상품명 칸에 통째로)',
  /parts\.length === 1/.test(rec) && /productName = parts\[0\]/.test(rec));
ok('옵션 배열이 있으면 분해 없이 그대로 사용',
  /Array\.isArray\(p\.options\) && p\.options\.length/.test(rec));

/* ── ★★ 모듈 CSS 무결성 (실측 사고 고정) ───────────────────────────
   admin.html 인라인 CSS를 모듈로 옮길 때 **범위를 한 줄 어긋나게 잘라**
   ① 주석 한가운데서 시작해 짝 없는 `*​/` 가 생기고
   ② 뒷 줄의 남의 규칙(.dash-filter-btn)과 여분 `}` 까지 딸려와
   중괄호가 32 대 33이 됐다. 브라우저는 에러 없이 넘어가고 결과는
   **`.rf-split{display:flex}` 가 통째로 안 먹어 모달이 페이지 하단에 일반 블록으로 흘렀다**.
   문자열 존재만 보는 grep 가드는 이걸 못 잡는다(선언은 멀쩡히 '있다') →
   실제로 **토큰을 세어** 균형과 최상위 선택자 소속을 확인한다. */
function cssOf(varName) {
  const i = modalSrc.indexOf('var ' + varName + ' = `');
  assert(i >= 0, varName + ' 를 찾지 못함');
  const s = i + ('var ' + varName + ' = `').length;
  const e = modalSrc.indexOf('`;', s);
  assert(e > s, varName + ' 의 템플릿 리터럴이 닫히지 않음');
  return modalSrc.slice(s, e);
}
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
['SHELL_CSS', 'CSS'].forEach((name) => {
  const raw = cssOf(name);
  ok(`★ ${name} 주석 짝이 맞는다(범위를 어긋나게 잘라 붙인 흔적 없음)`,
    (raw.match(/\/\*/g) || []).length === (raw.match(/\*\//g) || []).length);
  const body = stripComments(raw);
  ok(`★ ${name} 중괄호 균형 — 하나만 어긋나도 뒤 규칙이 통째로 무시된다`,
    (body.match(/\{/g) || []).length === (body.match(/\}/g) || []).length);
  ok(`★ ${name} 은 남의 규칙을 품지 않는다(#recruitModal · .rf-* · @media/@keyframes 만)`, (() => {
    // 최상위(중첩깊이 0)에서 여는 `{` 앞의 선택자만 본다
    let depth = 0, sel = '', bad = [];
    for (const ch of body) {
      if (ch === '{') {
        if (depth === 0) {
          const s = sel.trim();
          if (s && !/^(#recruitModal|\.rf-|@media|@keyframes|from|to)/.test(s)) bad.push(s);
        }
        depth++; sel = '';
      } else if (ch === '}') { depth = Math.max(0, depth - 1); sel = ''; }
      else if (depth === 0) sel += ch;
    }
    if (bad.length) console.error('    ↳ 외부 선택자 혼입:', bad);
    return bad.length === 0;
  })());
  ok(`★ ${name} 은 var() 에 폴백을 단다 — admin 테마 없는 화면(리뷰웹시스템[3버전])에서 색·테두리가 날아간다`,
    (body.match(/var\(--[a-zA-Z0-9-]+\)/g) || []).length === 0);
});
ok('★ 모달 마크업의 인라인 style 도 var() 폴백을 단다', (() => {
  const html = cssOf('HTML');
  return (html.match(/var\(--[a-zA-Z0-9-]+\)/g) || []).length === 0;
})());
ok('★ 레이아웃의 핵심 선언이 살아 있다(.rf-split=flex / .rf-side=340px / .rf-rail=176px / .rf-card)', (() => {
  const body = stripComments(cssOf('CSS'));
  return /\.rf-split\{[^}]*display:flex/.test(body) && /\.rf-side\{[^}]*width:340px/.test(body)
    && /\.rf-rail\{[^}]*width:176px/.test(body) && /\.rf-card\{[^}]*border:1px solid/.test(body);
})());
ok('★ 오버레이 껍데기 CSS를 모듈이 스스로 들고 있다(호스트 테마 의존 금지)', (() => {
  const shell = stripComments(cssOf('SHELL_CSS'));
  return /#recruitModal\.modal-overlay\{[^}]*position:fixed/.test(shell)
    && /#recruitModal \.modal-box\{/.test(shell) && /#recruitModal \.rform-input\{/.test(shell);
})());
ok('★ 마운트 지점이 없으면 body 직속으로 만든다(스크롤 컨테이너에 갇히지 않게)',
  /host\.id = 'recruitModalMount';[\s\S]{0,80}document\.body\.appendChild\(host\)/.test(modalSrc)
  && /if \(!document\.body\) return false/.test(modalSrc));
ok('폰트어썸 없는 화면에서도 닫기(×)가 보인다(글리프 폴백)',
  /function injectIconFallback/.test(modalSrc) && /'fa-times':/.test(modalSrc)
  && /font\\s\*awesome/i.test(modalSrc));

console.log(`\n✅ recruitModalLayout: ${n}개 통과`);
