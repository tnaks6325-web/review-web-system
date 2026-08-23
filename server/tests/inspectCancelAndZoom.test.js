/**
 * inspectCancelAndZoom.test.js — 리뷰검수 ① 돋보기 ② 주문취소 유형 회귀가드.
 * 실행: node tests/inspectCancelAndZoom.test.js
 *
 * 사용자 요청(2026-08-23)
 *  ① 검수 카드·상세에서 **이미지만 크게** 볼 수 있는 돋보기
 *  ② 새 유형 **주문취소** — 리뷰어가 그 작업을 취소한 신호(캡처에 "취소완료")
 *
 * 이 가드가 고정하는 것
 *  - 돋보기 실행부는 **공유 라이트박스 한 벌**(woImageModal) — 오버레이 사본 금지
 *  - onclick 에는 **인덱스만**(파일ID는 외부발 문자열 — 보간 금지)
 *  - 주문취소는 **별도 축**이고 화면 주 이슈에서 **맨 앞**(취소가 먼저 읽혀야 한다)
 *  - 취소 카드의 주 조치는 **이동이 아니라 종결**(옮길 건이 아니다)
 *  - 화면 유형 키 ≡ 서버 유형 키(순서까지) · 반려 문구 유형도 1:1
 *  - 캐시 접두 상향(새 kind 를 옛 캐시가 모른 채 히트하지 않게)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const gem = readS('services/gemini.service.js');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const IIT = require('../src/utils/inspectIssueTypes');
const MSG = require('../src/utils/inspectMessages');

/* ═══ ① 돋보기 ═══════════════════════════════════════════════════ */
console.log('\n▶ ① 돋보기');
const zoomFn = /function riZoom\(i, which\)\{[\s\S]*?\n\}/.exec(wd);
assert(zoomFn, 'riZoom 을 찾지 못했다');
ok('★★ 실행부는 공유 라이트박스 한 벌(woImageModal) — 오버레이를 새로 만들지 않는다',
  /woImageModal\(url\)/.test(zoomFn[0])
  && !/createElement\(["']div["']\)/.test(zoomFn[0]));
ok('★ 모듈이 없으면 사유를 말한다(조용히 죽지 않는다)',
  /typeof woImageModal!=='function'/.test(zoomFn[0]) && /_toast\(/.test(zoomFn[0]));
ok('★ 이미지가 없으면 사유를 말한다', /볼 수 있는 이미지가 없습니다/.test(zoomFn[0]));
ok('★ 라이트박스 모듈이 실제로 로드된다', /<script src="js\/work-order-detail\.js/.test(wd));
ok('★★ onclick 은 인덱스만 — 파일ID(외부발 문자열) 보간 금지',
  /onclick="event\.stopPropagation\(\);riZoom\(\$\{i\}\)"/.test(wd)
  && /onclick="riZoom\(\$\{idx\}\)"/.test(wd)
  && !/riZoom\('\$\{/.test(wd));
ok('★ 카드 썸네일 클릭(상세 열기)은 그대로 — 돋보기는 별도 버튼이 stopPropagation',
  /<div class="nc-th" onclick="riOpenDetail\(\$\{i\}\)">/.test(wd)
  && /class="rizoom"[^>]*event\.stopPropagation\(\)/.test(wd));
ok('★ 이미지가 없는 카드에는 돋보기를 그리지 않는다(눌러도 아무 일 없는 버튼 금지)',
  /\$\{thumb\?`<button class="rizoom"/.test(wd));
ok('중복 비교 두 장 모두 각자 크게 볼 수 있다',
  /riZoom\(\$\{idx\},'dup'\)/.test(wd) && (wd.match(/class="rizoomable"/g) || []).length >= 3);
ok('★ 라이트박스가 검수 모달 위에 뜬다(z-index)', (() => {
  const ri = /\.rimodal\{[^}]*z-index:(\d+)/.exec(wd);
  const wo = /z-index:(\d+)[^"]*background:rgba\(0,0,0,\.82\)/.exec(
    fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'work-order-detail.js'), 'utf8'));
  return ri && wo && Number(wo[1]) > Number(ri[1]);
})());
ok('커서로도 확대 가능함을 알린다(zoom-in)', /\.rizoomable\{cursor:zoom-in\}/.test(wd));

/* ═══ ② 주문취소 유형 ════════════════════════════════════════════ */
console.log('\n▶ ② 주문취소 유형');
ok('★ AI 판별 종류에 order_cancel 이 있다(줄 추가만)',
  /- "order_cancel": 주문이 취소된 화면/.test(gem) && /취소완료/.test(gem));
ok('★ order_capture 가 배타 조건으로 취소를 넘긴다(두 종류가 같은 화면을 가져가지 않게)',
  /취소 표시가 보이면 order_cancel/.test(gem));
ok('★ kind 화이트리스트에 합류', gem.includes("'order_capture', 'order_cancel', 'other'"));
ok('★★ 캐시 접두 상향 — 옛 캐시가 새 종류를 모른 채 히트하지 않게',
  /_getCacheKey\('classify7:'/.test(gem) && !/_getCacheKey\('classify[1-6]?:'/.test(gem));
ok('★★ 오래 검증된 3줄은 여전히 불변',
  gem.includes('- "review": 쇼핑몰 리뷰 화면. 별점(★), 리뷰 본문, 상품평 목록, "리뷰 작성 완료" 같은 UI가 보임.')
  && gem.includes('- "receipt": 현금영수증/결제 영수증. 국세청, 현금영수증, 승인번호, 사업자등록번호, 지출증빙, 거래일시 중 하나 이상이 보임.')
  && gem.includes('- "other": 둘 다 아님(상품 사진, 주문내역, 빈 화면 등).'));

console.log('\n▶ 유형 판정(서버 단일 출처)');
const V = (o) => ({ checks: { format: Object.assign({ verdict: 'fail' }, o) } });
ok('취소 화면 → cancel 축', IIT.issueTypesOf(V({ kind: 'order_cancel' })).includes('cancel'));
ok('★ format_fail 과 함께 세어진다(의도 — 칩은 원래 중복 계수)',
  IIT.issueTypesOf(V({ kind: 'order_cancel' })).join(',') === 'cancel,format_fail');
ok('★ 자동분류 판정값(got)으로도 잡는다(원장은 kind, 라우팅은 got)',
  IIT.issueTypesOf({ checks: { format: { verdict: 'warn', got: 'order_cancel' } } }).includes('cancel'));
ok('주문내역은 cancel 이 아니다', !IIT.issueTypesOf(V({ kind: 'order_capture' })).includes('cancel'));
ok('통과 건은 아무 축에도 안 잡힌다', IIT.issueTypesOf({ checks: { format: { verdict: 'pass', kind: 'review' } } }).length === 0);
ok('★ SQL 조각도 같은 규칙을 파생한다',
  /COALESCE\(i\.checks->'format'->>'got', i\.checks->'format'->>'kind'\) = 'order_cancel'/
    .test(IIT.issueTypeCountSql('i.checks')));

console.log('\n▶ 화면 배선');
const riTypes = /const RI_TYPES=\[([\s\S]*?)\];/.exec(wd);
assert(riTypes, 'RI_TYPES 를 찾지 못했다');
const frontKeys = [...riTypes[1].matchAll(/\['([a-z_]+)'/g)].map(x => x[1]);
ok('★★ 화면 칩 키 ≡ 서버 유형 키(순서까지)',
  JSON.stringify(frontKeys) === JSON.stringify(IIT.ISSUE_KEYS));
ok('★ 주 이슈 판정에서 취소가 맨 앞(담당자에게 먼저 읽혀야 한다)',
  /for\(const k of \['cancel','duplicate','format_fail'/.test(wd));
ok('판별 종류 라벨에 취소 화면', /order_cancel:'주문 취소 화면'/.test(wd));
/* ★★ 문자열 존재만 보면 **어느 함수 안에 있는지**를 못 본다 — 실제로 이 블록이
     `_riTypeLabel`(라벨 문자열을 돌려주는 함수) 안에 잘못 들어가 그 화면이 통째로
     ReferenceError 로 죽었고, 옛 가드는 그것을 통과시켰다(2026-08-23 브라우저가 잡았다).
     그래서 **함수 본문을 잘라서** 그 안에 있는지 본다. */
function bodyOf(name) {
  const i = wd.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < wd.length; j++) {
    if (wd[j] === '{') { d++; started = true; }
    else if (wd[j] === '}') { d--; if (started && d === 0) return wd.slice(i, j + 1); }
  }
  return '';
}
const actBody = bodyOf('_riCardActions'), labBody = bodyOf('_riTypeLabel');
ok('★★ 취소 카드의 주 조치는 이동이 아니라 종결(옮길 건이 아니다)',
  /if\(p==='cancel'\) return \{main:\{\.\.\.A\.bad/.test(actBody));
ok('★★ 그 블록이 라벨 함수에 잘못 들어가 있지 않다(화면 전체가 죽는다)',
  !!labBody && !/A\.bad/.test(labBody) && /if\(p==='cancel'\) return '🚫 주문취소'/.test(labBody));
ok('★ 유형 색 띠가 정의돼 있다(없으면 회색 t-none 으로 떨어져 신호가 죽는다)',
  /cancel:\{cls:'t-cancel'/.test(wd) && /\.nc-type\.t-cancel\{/.test(wd));
ok('★★ 근거 문장이 "리뷰 화면이 아니다"라고 말하지 않는다 — 담당자가 다른 칸으로 옮기려 든다',
  (wd.match(/주문이 취소된 화면입니다 — 리뷰어가 이 작업을 취소한 것으로 보입니다/g) || []).length >= 2);

console.log('\n▶ 반려 문구');
const kinds = MSG.INSPECT_MSG_KINDS.map(k => k.key);
ok('★ 반려 문구에도 주문취소 유형이 있다', kinds.includes('cancel'));
const def = MSG.INSPECT_MSG_KINDS.find(k => k.key === 'cancel').def;
ok('★★ "다시 제출하라"고 하지 않는다 — 이미 취소한 사람에게 틀린 안내가 된다',
  /참여를 취소하신 것이라면 그대로 두셔도 됩니다/.test(def));
ok('★ 다른 문구와 같은 평문(태그를 넣으면 글자로 보인다)', !/<[a-z]/i.test(def));
ok('★ 화면 유형 키 ⊆ 반려 문구 유형(문구 없는 유형이 없다)',
  IIT.ISSUE_KEYS.every(k => kinds.includes(k)));

console.log(`\n✅ ${n} 케이스 통과`);
