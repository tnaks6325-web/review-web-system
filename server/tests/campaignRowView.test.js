/**
 * campaignRowView.test.js — 모집공고 "행으로 보기"(시안 C 티켓형) 회귀가드
 * 실행: node tests/campaignRowView.test.js
 *
 * ★ 이 기능의 핵심 불변식: **렌더 경로는 cardHtml() 하나뿐이고, 행 보기는 CSS 표현만 바꾼다.**
 *   행 전용 HTML 빌더를 따로 만들면 상태 규칙(카운트다운·리본·인기배지·게이지·버튼 문구)이
 *   두 벌이 되어 반드시 드리프트한다 → "행 전용 렌더 함수 부재"를 테스트로 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const cards = readF('frontend/js/campaign-cards.js');
const indexHtml = readF('frontend/index.html');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 단일 렌더 경로(핵심 불변식) ──
ok('cards: 행 전용 렌더 함수 없음(cardHtml 단일 경로 — 상태 규칙 드리프트 차단)',
  !/function\s+rowHtml|function\s+cardRowHtml|renderRow\s*\(/.test(cards));
ok('cards: 행 보기는 CSS 규칙으로만 구현(.rc-view-row 스코프)', /\.rc-view-row \.pcards-grid\{/.test(cards));

// ── 시안 C 티켓형 레이아웃 ──
ok('행: 1열 그리드(minmax(0,1fr) — 긴 제목이 열을 밀지 않게)', /\.rc-view-row \.pcards-grid\{grid-template-columns:minmax\(0,1fr\)/.test(cards));
ok('행: 카드가 가로 배치', /\.rc-view-row \.pcard\{flex-direction:row/.test(cards));
ok('행: 썸네일 좌측 고정폭 92px', /\.rc-view-row \.pcard \.pthumb\{[^}]*flex:0 0 92px/.test(cards));
ok('행: 썸네일 position:static — 내부 절대배치(배지·리본)가 .pcard 기준이 되게',
  /\.rc-view-row \.pcard \.pthumb\{position:static/.test(cards));
ok('행: 카운트다운 오버레이는 썸네일 폭에만(시안 C = 썸네일 위 카운트다운)',
  /\.rc-view-row \.pcard \.pt-ovl\{right:auto;width:92px/.test(cards));
ok('행: 채널·배송·별표 배지는 우측 상단', /\.rc-view-row \.pcard \.pt-badges\{top:7px;right:8px/.test(cards));
ok('행: [인기!]·상태 리본은 본문 시작점(썸네일 오른쪽)', /\.rc-view-row \.pcard \.pt-topleft\{[^}]*left:102px/.test(cards));
ok('행: 게이지는 한 줄 압축(라벨 숨김 + 막대 flex)',
  /\.rc-view-row \.pcard \.pgauge\{flex-direction:row/.test(cards) && /\.rc-view-row \.pcard \.pg-lb\{display:none\}/.test(cards));

// ── 오버플로 방어(실측으로 잡은 버그: flex 자식 min-width:auto) ──
ok('행: 본문 min-width:0 — 긴 제목이 행을 가로로 밀어내지 않음(말줄임 동작 보장)',
  /\.rc-view-row \.pcard \.pbody\{[^}]*min-width:0/.test(cards));
ok('행: 제목 1줄 말줄임 + overflow:hidden', /\.rc-view-row \.pcard \.ptitle\{-webkit-line-clamp:1[^}]*overflow:hidden/.test(cards));
ok('행: 카드 max-width:100%(부모 밖으로 확장 금지)', /\.rc-view-row \.pcard\{[^}]*max-width:100%/.test(cards));

// ── 카드 보기 무변경 ──
ok('카드: 기본 2열 그리드 유지(행 CSS가 기본값을 덮지 않음)',
  /\.pcards-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(cards));
ok('카드: 기본 세로 배치 유지', /\.pcard\{position:relative[\s\S]{0,220}flex-direction:column/.test(cards));

// ── 홈 전환 배선(기존 토글 재사용 — 새 JS 없음) ──
ok('index: applyRecruitView가 .rc-list에 rc-view-row/card 토글(참여형 카드가 이 안에 렌더됨)',
  /classList\.toggle\('rc-view-row'/.test(indexHtml) && /classList\.toggle\('rc-view-card'/.test(indexHtml));
ok('index: 참여형 카드는 .rc-list 컨테이너(recruitPreviewList) 안에 주입',
  /id="recruitPreviewList" class="rc-list"/.test(indexHtml) && /pcards-grid/.test(indexHtml.slice(indexHtml.indexOf('loadRecruitPreview'))));
ok('index: 행 보기 토글 버튼 존재(setRecruitView)', /onclick="setRecruitView\('row'\)"/.test(indexHtml) && /onclick="setRecruitView\('card'\)"/.test(indexHtml));

console.log(`\n✅ campaignRowView: ${passed}개 통과`);
