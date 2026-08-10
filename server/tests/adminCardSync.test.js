/**
 * adminCardSync.test.js — 관리자 모집공고 카드 = 리뷰어 카드 동기화 회귀가드.
 *
 * 관리자 화면이 리뷰어 카드와 **같은 함수**(campaign-cards.js cardHtml)로 그려지는지,
 * 그리고 이번에 실제로 잡힌 두 버그가 되살아나지 않는지 고정한다.
 *   ① 제목 min-height 부족(2.13em) → 한 줄 제목 카드만 짧아져 아래 요소가 어긋남
 *   ② cardHtml이 CSS를 주입하지 않아 칩 넘침 측정이 스타일 없는 상태에서 이뤄짐
 * 실행: node tests/adminCardSync.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const cc = readF('js/campaign-cards.js');
const rec = readF('js/index-recruit.js');
const adm = readF('admin.html');
const routes = readS('routes/campaign.routes.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 단일 출처 ── */
ok('관리자 목록이 리뷰어 카드 모듈로 그려진다(사본 금지)',
  /CampCards\.cardHtml\(c, \{ admin: true/.test(rec) && /js\/campaign-cards\.js/.test(adm));
ok('cardHtml에 admin 분기가 있다(같은 함수, 레이어만 추가)',
  /function cardHtml\(c, o\)/.test(cc) && /const admin = !!\(o && o\.admin\)/.test(cc));

/* ── ① 카드 높이 (실측 버그) ── */
ok('★ 제목은 두 줄 자리 확보 — 2.6em 이상(2줄 = line-height 1.3 × 2)', (() => {
  const m = /\.pcard \.ptitle\{[^}]*min-height:([\d.]+)em/.exec(cc);
  return !!m && parseFloat(m[1]) >= 2.6;
})());
ok('같은 행 카드 높이 통일(grid stretch + 카드 height:100%)',
  /\.pcards-grid\{[^}]*align-items:stretch/.test(cc) && /\.pcard\{[^}]*height:100%/.test(cc));
ok('액션 바는 항상 카드 맨 아래(margin-top:auto)', /\.pcard \.pact\{[^}]*margin-top:auto/.test(cc));
ok('오늘 집계가 없는 공고도 게이지 자리를 지킨다(게시 전/오픈 전)',
  /게시 전|오픈 전/.test(cc) && /집계가 시작됩니다/.test(cc));

/* ── ② CSS 주입 순서 (실측 버그) ── */
ok('★ cardHtml이 스타일을 주입한다 — 칩 폭 측정이 스타일 적용 후 이뤄져야 함',
  /function cardHtml\(c, o\) \{\s*\n\s*_injectStyles\(\);/.test(cc));

/* ── 배치 ── */
ok('관리자 그리드는 너비만큼 채운다(2열 고정 아님)',
  /\.pcards-grid\.pc-admin\{grid-template-columns:repeat\(auto-fill,minmax\(258px,1fr\)\)/.test(cc));
ok('리뷰어 그리드는 2열 고정 유지(앱 폭 고정)',
  /\.pcards-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(cc));

/* ── 관제 뱃지 = 지각만 (C안) ── */
ok('빨간 원은 지각(late) 건수만 센다', /const late = \(c\.ops && Number\(c\.ops\.late\)\) \|\| 0/.test(cc));
ok('지각 0건이면 원을 그리지 않는다', /late > 0 \? `<span class="bdg"/.test(cc));
ok('서버가 지각 건수를 집계한다(수동확정되면 submitted라 자동 제외)',
  /late_order_id IS NOT NULL/.test(routes) && /status IN \('expired', 'cancelled'\)/.test(routes));
ok('만료·취소 자체는 뱃지로 세지 않는다(할 일이 없어 늑대소년 방지)',
  !/ops\.expired|ops\.cancelled/.test(cc));
// ── 취소확정(dismiss): 지각 배지·수동확정에서 제외 ──
ok('취소확정 라우트 존재(POST admin/:id/dismiss)',
  /'\/admin\/:id\/dismiss'/.test(routes) && /dismissed_at = NOW\(\)/.test(routes));
ok('지각(late) 배지는 취소확정(dismissed) 건 제외',
  /late_order_id IS NOT NULL[\s\S]{0,120}dismissed_at IS NULL/.test(routes));
ok('제출확정 시 dismissed_at 해제(confirm↔dismiss 정합)',
  /status = 'submitted',\s*\n\s*dismissed_at = NULL/.test(routes));

/* ── 게이지 분해 ── */
ok('관리자 게이지는 확정 + 진행중 2구간', /pg-seg sub/.test(cc) && /pg-seg hold/.test(cc));
// ★ 검사 의미 불변: "공고 확정 = todayCount − holdNow". 변수명만 subN → confirmedN 으로 바뀌었다
//   (2026-08-10 표 기준 표기 도입 — 표시 숫자는 shownN, 공고 확정은 confirmedN 으로 나뉘었다).
ok('진행중 = 유효 홀드(todayCount − holdNow = 공고 확정)',
  /const confirmedN = Math\.max\(0, today - holdNow\)/.test(cc));
ok('서버가 진행중 홀드를 내려준다', /holdNow: cnt\.activeHolds/.test(routes));

/* ── 스펙 줄 ── */
ok('유입방식 배지명은 "가이드유입"(유입가이드 아님)',
  /가이드유입/.test(cc) && !/sp-chip flow">유입가이드/.test(cc));
ok('칩은 접지 않는다(+N 미사용)', !/\+\$\{[\s\S]{0,40}length - 3\}/.test(cc) && !/sp-chip more/.test(cc));
ok('칩이 넘치면 좌우로 흐른다 — 넘칠 때만(ovf 클래스)',
  /row\.classList\.add\('ovf'\)/.test(cc) && /@keyframes pcMarquee/.test(cc));
ok('넘침은 실측으로 판정(고정값 아님)',
  /chips\.scrollWidth - wrap\.clientWidth/.test(cc));
ok('움직임 최소화 설정이면 애니메이션 대신 스크롤',
  /prefers-reduced-motion:reduce\)\{[\s\S]{0,200}\.sp-row\.ovf \.sp-chips\{animation:none/.test(cc));
ok('총 모집 숫자는 칩에 밀리지 않는다', /\.sp-tot\{[^}]*flex-shrink:0/.test(cc));

/* ── 별표 겹침 ── */
// 별표 UI는 리뷰어 홈(_realAdminTok)과 관리자 목록(admin:true)이 **하나의 컨트롤**을 공유한다 —
// 둘로 두면 관리자 화면에서 별표가 두 개 뜬다. 배지와 같은 줄에 둬야 배송 배지를 가리지 않는다.
ok('★ 별표는 채널·배송 배지와 같은 줄 + 단일 컨트롤(중복 렌더 금지)',
  /const starChip = \(admin \|\| _realAdminTok\(\)\)/.test(cc)
  && /pt-badges">\$\{starChip\}/.test(cc)
  && !/starBtn/.test(cc));
ok('별표 토글은 관리자 목록도 새로고침한다',
  /typeof window\.loadRecruitList === 'function'[\s\S]{0,120}loadRecruitList\(\)/.test(cc));

/* ── 삭제 모드 ── */
ok('카드에는 삭제 버튼이 없다(액션 = 수정·시트·관제·게시)',
  !/deleteRecruitPost/.test(cc));
// 시트 열기는 유지하고, ★ 2026-08-05 사용자 요청으로 [👁 보기]
// (리뷰어 화면 미리보기 — 마감·투입완료 공고의 현영 안내 확인용)가 다시 추가됐다.
// ⚠ 2026-08-07 시안 C 적용으로 시트 열기는 주 줄 → [⋯] 메뉴 항목(`📄 연결된 시트 열기`)으로
//   자리를 옮겼다(검사 의미 불변 — 여전히 같은 URL 을 새 창으로 연다).
ok('관리자 카드 액션 = 시트 열기 + 👁 리뷰어 화면 보기(마감 공고 포함)',
  /📄 연결된 시트 열기/.test(cc)
  && /window\.open\('\$\{_esc\(sheetUrl\)\}'/.test(cc)
  && /docs\.google\.com\/spreadsheets\/d\//.test(cc)
  && /openReviewerPreview\('\$\{id\}'\)/.test(cc));
ok('삭제는 헤더 삭제 모드로 분리', /toggleRecruitDelMode/.test(rec) && /recruitDelModeBtn/.test(adm));
ok('삭제 모드일 때만 선택 오버레이', /delMode\s*\n?\s*\? `<div class="pdelpick"/.test(cc));
ok('일괄 삭제는 확인 후 실행', /function deleteRecruitPicked/.test(rec) && /confirm\(/.test(rec));
ok('삭제 모드 중엔 카운트다운 자동 새로고침 보류(선택 유실 방지)',
  /if \(!window\._recruitDelMode\) loadRecruitList\(\)/.test(rec));

/* ── 서버 동기화 ── */
ok('관리자 목록이 리뷰어와 같은 상태 계산을 쓴다(computeCampaignState)',
  /admin\/list[\s\S]{0,2600}computeCampaignState\(r, cnt, now/.test(routes));
ok('집계 실패해도 목록은 뜬다(관리 기능 마비 방지)',
  /admin\/list 집계 실패/.test(routes));

console.log(`\n✅ adminCardSync: ${n}개 통과`);
