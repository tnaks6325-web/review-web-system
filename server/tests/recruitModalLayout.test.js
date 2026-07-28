/**
 * recruitModalLayout.test.js — 관리자 공고 수정 모달 레이아웃 회귀가드.
 *
 * 문제였던 것: 미리보기가 입력란 **아래 같은 스크롤**에 붙어 있어, 미리보기를 보면
 * 입력란이 화면 밖으로 나가 "고치면서 확인"이 불가능했다. 좌우 2단으로 바꿨다.
 * 입력은 탭으로 나누지 않고 **한 화면에 촘촘히**(sticky 섹션 헤더) — 항목을 찾아 탭을 옮겨다니지 않게.
 * v4: 묶음을 기본정보 / 모집정보 **두 개**로 재편하고 짧은 항목은 가로 표기(.rf-hrow)로 밀도를 높였다.
 *
 * ★ 실측 버그 고정: CSS를 @media(max-width:480px) 안에 넣어 480px 이하에서만 적용되던 것
 *   → .rf-side 폭이 안 먹어 미리보기가 전체 폭을 차지했다. 최상위에 있어야 한다.
 * 실행: node tests/recruitModalLayout.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const adm = readF('admin.html');
const rec = readF('js/index-recruit.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/** 모달 영역만 잘라 검사(다른 모달과 섞이지 않게) */
const modal = adm.slice(adm.indexOf('id="recruitModal"'), adm.indexOf('id="recruitSettingsModal"') > 0
  ? adm.indexOf('id="recruitSettingsModal"') : adm.indexOf('id="recruitModal"') + 30000);

/* ── 좌우 2단 ── */
ok('모달이 좌(입력) / 우(미리보기) 2단', /class="rf-split"/.test(modal) && /class="rf-main"/.test(modal) && /class="rf-side"/.test(modal));
ok('미리보기가 오른쪽 열 안에 있다(입력란 아래 스택 아님)',
  /<aside class="rf-side">[\s\S]{0,400}id="rf_preview_section"/.test(modal));
ok('모달 폭 확대(2단이 들어갈 만큼)', (() => {
  const m = /class="modal-box rf-box"[^>]*max-width:(\d+)px/.exec(modal);
  return !!m && Number(m[1]) >= 1000;
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
ok('좁은 화면에서는 세로로 되돌린다', /@media \(max-width:900px\)[\s\S]{0,220}\.rf-split\{flex-direction:column/.test(adm));

/* ── 한 화면 · 섹션(탭 없음) ── */
ok('탭 없이 기본정보 · 모집정보 두 묶음이 한 화면에', (() => {
  const secs = modal.match(/class="rf-sec" data-pane="(\w+)"/g) || [];
  return secs.length === 2 && /data-pane="basic"/.test(modal) && /data-pane="part"/.test(modal)
    && !/class="rf-tabs"/.test(modal);
})());
ok('짧은 항목은 가로 표기(라벨 왼쪽) — 시트·탭 / 담당자·채널 / 배송·리뷰비 / 배지 / 팀채팅방',
  /\.rf-hrow\{display:grid;grid-template-columns:64px 1fr/.test(adm)
  && (modal.match(/class="rf-hrow/g) || []).length >= 8);
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
ok('섹션 헤더는 스크롤 중에도 붙어 있다(지금 어느 묶음인지)', /\.rf-sech\{position:sticky/.test(adm));
ok('밀도 — 라벨·입력 간격 축소 + 짧은 항목 2열',
  /\.rf-main \.rform-label\{margin-bottom:2px/.test(adm) && /class="rf-grid2"/.test(modal));
ok('미리보기가 모달 세로를 꽉 쓴다(고정 max-height 캡 제거)',
  /id="rf_preview_area"[^>]*flex:1/.test(modal) && !/id="rf_preview_area"[^>]*max-height:\d+px/.test(modal));

/* ── 참여형 게이트 (옵션·작업내용을 밖으로 뺀 대가) ── */
ok('옵션·작업내용이 참여형 섹션 밖 형제로 분리', /id="rf_work_section"/.test(modal));
ok('★ 참여형 스위치가 rf_work_section도 함께 토글 — 안 하면 레거시 공고에 옵션이 보인다',
  /const work = document\.getElementById\("rf_work_section"\)[\s\S]{0,120}work\.style\.display = on \? "" : "none"/.test(rec));
ok('참여형이 꺼지면 모집조건 내용이 숨는다',
  /rf_part_section[\s\S]{0,160}display = on \? "" : "none"/.test(rec));

/* ── 필드 보존 (ID를 건드리지 않았는지) ── */
ok('저장·프리필이 참조하는 필드가 모두 살아있다', (() => {
  const ids = ['rf_title', 'rf_product_url', 'rf_review_fee', 'rf_time_range', 'rf_linked_campaign',
    'rf_linked_tab', 'rf_status', 'rf_max_slots', 'rf_participation', 'rf_start_date',
    'rf_window_start', 'rf_window_end', 'rf_daily_limit', 'rf_recruit_total', 'rf_landing_url',
    'rf_thumb_file', 'rf_thumb_url', 'rf_multi_account', 'rf_multi_daily', 'rf_sub_ttl',
    'rf_hold_ttl', 'rf_close_buffer', 'rf_opt_rows', 'rf_part_check', 'rf_deadline', 'rf_notes',
    'rf_wd_product', 'rf_wd_inflow', 'rf_wd_review', 'rf_wd_notes', 'rf_preview_card'];
  return ids.every(id => modal.includes(`id="${id}"`));
})());

/* ── 리뷰어 앱과 맞춘 편의 ── */
ok('리뷰비 100원 단위(리뷰어 앱과 동일)', /id="rf_review_fee"[\s\S]{0,140}step="100"/.test(modal));
ok('상품 URL 옆 [바로가기 ↗]', /openRecruitProductUrl\(\)/.test(modal) && /function openRecruitProductUrl/.test(rec));
ok('자율주문 자동 감지 — 시간 표기에 자유/자율이면 구매시간 비움 + 안내',
  /function _isRecruitAutoOrder/.test(rec) && /자유\|자율/.test(rec)
  && /id="rf_autoorder_note"/.test(modal) && /oninput="onRecruitTimeRangeInput\(\)"/.test(modal));
ok('자율주문 판정은 사용자가 자율로 적었을 때만 값을 지운다(오작동 여지 없음)',
  /if \(auto\) \{[\s\S]{0,200}if \(el && el\.value\) el\.value = ""/.test(rec));

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

console.log(`\n✅ recruitModalLayout: ${n}개 통과`);
