/**
 * recruitModalLayout.test.js — 관리자 공고 수정 모달 레이아웃 회귀가드.
 *
 * 문제였던 것: 미리보기가 입력란 **아래 같은 스크롤**에 붙어 있어, 미리보기를 보면
 * 입력란이 화면 밖으로 나가 "고치면서 확인"이 불가능했다. 좌우 2단 + 탭 4개로 바꿨다.
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

/* ── 탭 ── */
ok('탭 4개(기본·연결·모집조건·작업내용)', (() => {
  const t = modal.match(/class="rf-tab[^"]*" data-pane="(\w+)"/g) || [];
  return t.length === 4 && ['basic', 'link', 'part', 'work'].every(k => modal.includes(`data-pane="${k}"`));
})());
ok('패널 4개가 탭과 짝', (modal.match(/class="rf-pane[^"]*" data-pane="/g) || []).length === 4);
ok('탭 전환 함수', /function switchRecruitPane\(name\)/.test(rec));
ok('탭을 바꾸면 스크롤을 맨 위로(빈 화면처럼 보이는 것 방지)', /body\.scrollTop = 0/.test(rec));
ok('모달을 열면 항상 첫 탭', /switchRecruitPane\("basic"\);\s*\/\/ 열 때는 항상 첫 탭/.test(rec));

/* ── 참여형 게이트 (옵션·작업내용을 밖으로 뺀 대가) ── */
ok('옵션·작업내용이 참여형 섹션 밖 형제로 분리', /id="rf_work_section"/.test(modal));
ok('★ 참여형 스위치가 rf_work_section도 함께 토글 — 안 하면 레거시 공고에 옵션이 보인다',
  /const work = document\.getElementById\("rf_work_section"\)[\s\S]{0,120}work\.style\.display = on \? "" : "none"/.test(rec));
ok('참여형이 꺼지면 모집조건·작업내용 탭 비활성 + 기본 탭으로 복귀',
  /function _syncRecruitPaneGate\(on\)/.test(rec) && /switchRecruitPane\("basic"\)/.test(rec));

/* ── 필드 보존 (ID를 건드리지 않았는지) ── */
ok('저장·프리필이 참조하는 필드가 모두 살아있다', (() => {
  const ids = ['rf_title', 'rf_product_url', 'rf_review_fee', 'rf_time_range', 'rf_linked_campaign',
    'rf_linked_tab', 'rf_status', 'rf_max_slots', 'rf_participation', 'rf_start_date',
    'rf_window_start', 'rf_window_end', 'rf_daily_limit', 'rf_recruit_total', 'rf_landing_url',
    'rf_thumb_file', 'rf_thumb_url', 'rf_multi_account', 'rf_multi_daily', 'rf_sub_ttl',
    'rf_hold_ttl', 'rf_close_buffer', 'rf_opt_rows', 'rf_part_check',
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

console.log(`\n✅ recruitModalLayout: ${n}개 통과`);
