/**
 * campaignSequentialDisplay.test.js — 순차진행 공고의 제목·사진을 지금 모집 중인 상품으로 바꾸기 (결정 213 · 사용자 확정 2026-10-08)
 * 실행: node tests/campaignSequentialDisplay.test.js
 *
 * 규칙: ① 제목 안의 상품 이름 부분만 바꾼다(앞에 붙인 "빈)))" 같은 표시는 유지)
 *       ② 제목에 상품 이름이 없으면 제목 그대로 + "지금 모집: ○○"
 *       ③ 사진 = 지금 모집 중 상품의 사진, 없으면 공고 사진
 *       ④ 참여한 사람(내 참여 내역·참여 후 화면)은 내가 고른 상품으로 고정
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sequentialDisplay, joinedDisplay, swapTitle } = require('../src/utils/sequentialDisplay');
const { computeOptionViews } = require('../src/services/campaignState.service');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// 실제 운영 공고 모양(10/8 제주도아 — 상품 단위 선택지 3개, 공고 제목은 관리자가 첫 상품 이름에 "빈)))"을 붙여 적음)
const JEJU_TITLE = '빈)))1. 제주은갈치 단품 : 400g이상 1마리';
const rows = [
  { opt_key: '1. 제주은갈치 단품 : 400g이상 1마리', product_name: '1. 제주은갈치 단품 : 400g이상 1마리', unit_kind: 'product', recruit_total: 10, daily_limit: 5, status: 'active', thumbnail_url: 'https://img.example/galchi.jpg' },
  { opt_key: '2. 참옥돔 : 옥돔 중 180g이상 3마리', product_name: '2. 참옥돔 : 옥돔 중 180g이상 3마리', unit_kind: 'product', recruit_total: 5, daily_limit: 5, status: 'active', thumbnail_url: 'https://img.example/okdom.jpg' },
  { opt_key: '3. 고등어살 : 0.5kg(팩당 120g 4팩)', product_name: '3. 고등어살 : 0.5kg(팩당 120g 4팩)', unit_kind: 'product', recruit_total: 15, daily_limit: 5, status: 'active', thumbnail_url: '' },
];
const cnt = (a = 0, b = 0, c = 0) => new Map([
  [rows[0].opt_key, { submitted: a }], [rows[1].opt_key, { submitted: b }], [rows[2].opt_key, { submitted: c }],
]);
const views = (a, b, c, seq = true) => computeOptionViews(rows, cnt(a, b, c), { state: 'open' }, { sequential: seq });
const BASE = { title: JEJU_TITLE, thumbnailUrl: 'https://img.example/campaign.jpg' };

console.log('\n[1] 제목 안의 상품 이름만 바꾼다');
let d = sequentialDisplay(BASE, views(0, 0, 0));
ok('은갈치 모집 중 — 제목 그대로, 지금 모집 줄 없음', d.title === JEJU_TITLE && d.nowRecruiting === '');
ok('사진 = 은갈치 사진', d.thumbnailUrl === 'https://img.example/galchi.jpg');
d = sequentialDisplay(BASE, views(10, 0, 0));
ok('은갈치 마감 → 제목이 옥돔으로, 앞의 "빈)))" 유지', d.title === '빈)))2. 참옥돔 : 옥돔 중 180g이상 3마리');
ok('사진 = 옥돔 사진', d.thumbnailUrl === 'https://img.example/okdom.jpg');
d = sequentialDisplay(BASE, views(10, 5, 0));
ok('옥돔까지 마감 → 고등어살로', d.title === '빈)))3. 고등어살 : 0.5kg(팩당 120g 4팩)');
ok('고등어살은 사진이 없으니 공고 사진', d.thumbnailUrl === 'https://img.example/campaign.jpg');
ok('전부 마감 → 바꾸지 않음(null = 저장된 제목·사진)', sequentialDisplay(BASE, views(10, 5, 15)) === null);
ok('순차진행이 아니면 바꾸지 않음', sequentialDisplay(BASE, views(10, 0, 0, false)) === null);

console.log('\n[2] 제목에 상품 이름이 없으면 "지금 모집" 한 줄');
// 실제 운영 공고 모양(9/17 아르퓨레 — 옵션 단위, 제목에 옵션명 없음)
const arpure = [
  { opt_key: '1.멀티크리너', product_name: '1.멀티크리너 500ml 1개', unit_kind: 'option', recruit_total: 15, daily_limit: 0, status: 'active' },
  { opt_key: '2.표백제', product_name: '2.표백제 60개입 1개', unit_kind: 'option', recruit_total: 15, daily_limit: 10, status: 'active' },
];
const av = computeOptionViews(arpure, new Map([['1.멀티크리너', { submitted: 15 }]]), { state: 'open' }, { sequential: true });
d = sequentialDisplay({ title: '네이버 클리너or표백제 실배송', thumbnailUrl: '' }, av);
ok('제목 그대로', d.title === '네이버 클리너or표백제 실배송');
ok('지금 모집: 옵션 단위면 옵션명', d.nowRecruiting === '2.표백제');

console.log('\n[3] 같은 상품의 옵션들이 함께 쓰는 상품명은 단서로 쓰지 않는다');
const shared = [
  { opt_key: '빨강', product_name: '에코백', unit_kind: 'option', recruit_total: 5, status: 'active' },
  { opt_key: '파랑', product_name: '에코백', unit_kind: 'option', recruit_total: 5, status: 'active' },
];
const sv = computeOptionViews(shared, new Map([['빨강', { submitted: 5 }]]), { state: 'open' }, { sequential: true });
d = sequentialDisplay({ title: '에코백 체험단 10명', thumbnailUrl: '' }, sv);
ok('제목의 "에코백"은 두 옵션 공용 → 제목 그대로 + 지금 모집: 파랑', d.title === '에코백 체험단 10명' && d.nowRecruiting === '파랑');
d = sequentialDisplay({ title: '에코백 빨강 체험단', thumbnailUrl: '' }, sv);
ok('옵션명이 제목에 있으면 그 부분만 바꿈', d.title === '에코백 파랑 체험단' && d.nowRecruiting === '');

console.log('\n[4] 긴 이름을 먼저 찾는다');
const r = swapTitle('빈)))1. 은갈치 단품 행사', [
  { optKey: '은갈치', productName: '은갈치', unitKind: 'product' },
  { optKey: '1. 은갈치 단품', productName: '1. 은갈치 단품', unitKind: 'product' },
  { optKey: '2. 옥돔', productName: '2. 옥돔', unitKind: 'product' },
], { optKey: '2. 옥돔', productName: '2. 옥돔', unitKind: 'product' });
ok('"1. 은갈치 단품" 전체가 "2. 옥돔"으로', r.title === '빈)))2. 옥돔 행사');

console.log('\n[5] 참여한 사람은 내가 고른 상품으로 고정');
const jv = views(10, 0, 0);   // 지금은 옥돔 모집 중
let j = joinedDisplay(BASE, jv, jv[0]);
ok('은갈치 참여자: 제목·사진 은갈치 그대로', j.title === JEJU_TITLE && j.thumbnailUrl === 'https://img.example/galchi.jpg');
j = joinedDisplay(BASE, jv, jv[2]);
ok('고등어살 참여자: 제목 고등어살 · 사진 없으니 공고 사진', j.title === '빈)))3. 고등어살 : 0.5kg(팩당 120g 4팩)' && j.thumbnailUrl === 'https://img.example/campaign.jpg');
j = joinedDisplay(BASE, jv, null);
ok('고른 상품을 모르면 저장된 제목·사진', j.title === JEJU_TITLE && j.thumbnailUrl === 'https://img.example/campaign.jpg');

console.log('\n[6] 서버 — 상품 사진 주소 정규화(https 만 · 미전달=유지)');
const routes = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
const fnSrc = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1); }
  throw new Error('no ' + name);
};
const sb = {}; vm.createContext(sb); vm.runInContext(fnSrc(routes, '_normalizeOptionThumb') + ';this.f=_normalizeOptionThumb;', sb);
ok('미전달 = null(저장된 사진 유지 — 구버전 화면이 저장해도 안 지워짐)', sb.f(undefined) === null);
ok("빈 값 = '' (지움)", sb.f('') === '' && sb.f('   ') === '');
ok('https 주소는 그대로', sb.f(' https://cdn.example/a.jpg ') === 'https://cdn.example/a.jpg');
ok('http·javascript·따옴표 섞인 주소 = 거절(undefined)', sb.f('http://x/a.jpg') === undefined && sb.f('javascript:alert(1)') === undefined && sb.f('https://x/a".jpg') === undefined);
ok('형식 불량이면 저장 거절(400) — 생성·수정 둘 다', (routes.match(/const optionThumbError = _optionThumbError\(normOpts\);\n\s*if \(optionThumbError\) return res\.status\(400\)/g) || []).length === 2);

console.log('\n[7] 배선');
ok('저장: 미전달이면 기존 사진 유지(COALESCE)', /thumbnail_url=COALESCE\(\$14, campaign_options\.thumbnail_url\)/.test(routes)
  && /\(typeof o\.thumbnailUrl === 'string'\) \? o\.thumbnailUrl : null/.test(routes));
ok('목록·상세가 같은 표시 함수(_applySequentialDisplay)를 쓴다', (routes.match(/_applySequentialDisplay\(view, (optViews|opts)\);/g) || []).length === 2);
ok('공개 선택지 뷰에 사진·지금 모집 표시', /thumbnailUrl: v\.thumbnailUrl \|\| '',\n\s*sequenceCurrent: v\.sequenceCurrent === true/.test(routes));
ok('목록·상세 선택지 SELECT 에 thumbnail_url', /product_name, unit_kind, thumbnail_url\n\s*FROM campaign_options WHERE campaign_id = ANY\(\$1\)/.test(routes)
  && /inflow_guide_images, thumbnail_url\n\s*FROM campaign_options WHERE campaign_id=\$1/.test(routes));
ok('관리자 프리필에 thumbnailUrl', /thumbnail_url AS "thumbnailUrl"\n\s*FROM campaign_options WHERE campaign_id=\$1/.test(routes));
ok('참여 후 화면: 순차진행이면 내가 고른 상품 표시(joinedDisplay)', /joinedDisplay: joinedView/.test(routes) && /selectedOption && selectedOption\.sequential/.test(routes));
const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
ok('필수 스키마에 campaign_options.thumbnail_url', /\['campaign_options', 'thumbnail_url'\]/.test(idx));
ok('마이그레이션 181 — 가산 칸(빈 값 기본)', /ADD COLUMN IF NOT EXISTS thumbnail_url TEXT NOT NULL DEFAULT ''/.test(
  fs.readFileSync(path.join(__dirname, '../migrations/181_campaign_option_thumbnail.sql'), 'utf8')));
const rev = fs.readFileSync(path.join(__dirname, '../src/routes/reviewer.routes.js'), 'utf8');
ok('내 참여 내역(참여 중): 순차진행이면 고른 상품으로', /await _applyJoinedDisplay\(holdRows\)/.test(rev) && /ca\.option_key AS "optionKey"/.test(rev));
ok('리뷰비 내역 사진: 고른 상품 사진 우선, 없으면 공고 사진', /COALESCE\(NULLIF\(co\.thumbnail_url, ''\), rc\.thumbnail_url\) AS "thumbnailUrl"/.test(rev)
  && /LEFT JOIN campaign_options co ON co\.campaign_id = rc\.id AND co\.opt_key = ca\.option_key/.test(rev));

console.log('\n[8] 화면');
const rec = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-recruit.js'), 'utf8');
ok('관리자 공고 설정: 상품별 사진 줄 + 저장·불러오기', /function _buildOptThumbLine\(row, initial\)/.test(rec)
  && /thumbnailUrl:\s+String\(\(r\._thumbEl && r\._thumbEl\.value\) \|\| ""\)\.trim\(\)/.test(rec)
  && /thumbnailUrl: o\.thumbnailUrl \?\? o\.thumbnail_url \?\? ""/.test(rec));
ok('공고 썸네일 업로드와 같은 업로드 창구(_uploadImageToProxy) — 사본 0', /const url = await _uploadImageToProxy\(file, "campthumb_"\)/.test(rec)
  && /await _uploadImageToProxy\(file, "optthumb_"\)/.test(rec)
  && !/fetch\(/.test(fnSrc(rec, '_uploadCampThumbFile')));
const cards = fs.readFileSync(path.join(__dirname, '../../frontend/js/campaign-cards.js'), 'utf8');
ok('리뷰어 카드: 지금 모집 줄', /c\.nowRecruiting \? `<div class="pt-now"/.test(cards));
const camp = fs.readFileSync(path.join(__dirname, '../../frontend/campaign.html'), 'utf8');
ok('참여 후 머리 제목 = 내가 고른 상품', /j\.joinedDisplay && j\.joinedDisplay\.title\) \$\('hdTitle'\)\.textContent = j\.joinedDisplay\.title/.test(camp));

console.log(`\n✅ campaignSequentialDisplay — ${passed} passed`);
