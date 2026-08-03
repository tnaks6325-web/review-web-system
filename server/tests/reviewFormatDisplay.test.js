/**
 * reviewFormatDisplay.test.js — D: 리뷰어에게 "내 행의 리뷰 형태" 표시 회귀가드.
 *
 * 배경: 시트 옵션 칸의 ㉯ 작업옵션('텍스트'·'포토리뷰')은 관리자가 로스터에 미리 적어두는
 *   작업지시인데, 지금까지 관리자만 보고 **리뷰어는 자기 행의 지시를 확인할 방법이 없었다**.
 *   (C′로 시스템이 그 칸을 덮지 않게 됐으니, 이제 그 값을 리뷰어에게 보여준다.)
 *
 * ★ 노출 경로는 이미 행 소유권(강한-키)을 검증하는 participation-brief 하나뿐 —
 *   새 엔드포인트를 만들면 무인증 표면이 하나 더 생긴다.
 * ★ 어떤 칸이 '옵션 칸'인지는 C′의 단일 출처 optionWriteColumns(매퍼 파생)를 쓴다 —
 *   헤더 문자열 규칙(optionColIndexes)을 쓰면 '옵션금액'(=결제금액)·'비고(옵션확인)'(=메모)이
 *   리뷰어 화면으로 새어 나간다.
 *
 * 실행: node tests/reviewFormatDisplay.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const RF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const nc = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const routes = nc(R('src/routes/reviewEdit.routes.js'));
const home = nc(RF('index.html'));
const { optionWriteColumns } = require('../src/services/orderLedger.service');

/* ═══ 값 추출 — 실제 함수로 실행(라우트와 같은 파생 규칙) ═══ */
const extract = (rj) => {
  const headers = Object.keys(rj);
  return optionWriteColumns(headers)
    .map(i => ({ label: headers[i], value: String(rj[headers[i]] == null ? '' : rj[headers[i]]).trim() }))
    .filter(o => o.label && o.value);
};
{
  const rj = { '번호': '4', '구매일자': '8 / 3 (월)', '': '', '리뷰옵션': '텍스트', '인애드명단': '',
               '수취인': '김영숙', '연락처': '010-3225-0135', '결제금액': '22000',
               '옵션금액': '1000', '비고(옵션확인)': '내부메모' };
  const out = extract(rj);
  ok('★ 그 행의 리뷰 형태를 뽑아낸다', JSON.stringify(out) === JSON.stringify([{ label: '리뷰옵션', value: '텍스트' }]));
  ok('★★ 결제금액(옵션금액)·내부메모(비고(옵션확인))는 새어 나가지 않는다',
    !out.some(o => /금액|비고/.test(o.label)) && !out.some(o => o.value === '내부메모' || o.value === '1000'));
  ok('제목 없는 빈 열은 무시', !out.some(o => !o.label));
}
ok('빈 값은 표시하지 않는다(없는 지시를 지어내지 않는다)',
  extract({ '번호': '1', '리뷰옵션': '', '수취인': 'A' }).length === 0);
ok('옵션 칸이 없는 탭은 빈 목록(무영향)', extract({ '번호': '1', '수취인': 'A' }).length === 0);
ok('여러 옵션 칸이면 전부 병기', (() => {
  const out = extract({ '옵션1': '블랙', '리뷰옵션': '포토리뷰', '수취인': 'A' });
  return out.length === 2 && out[0].value === '블랙' && out[1].value === '포토리뷰';
})());
// ★ 한계(의도된 것): 헤더에 '상품'이 들어간 옵션열은 매퍼가 관리자 전용열로 보호해 기입 대상이
//   아니므로 표시에서도 빠진다. 표시 규칙을 따로 만들면 "쓰는 칸"과 "보여주는 칸"이 갈려 드리프트한다.
ok('한계 고정: 상품옵션명류(관리자 보호열)는 표시 대상 아님',
  extract({ '상품옵션명': '블랙', '수취인': 'A' }).length === 0);

/* ═══ 서버 배선 ═══ */
ok('participation-brief 가 workOptions 를 반환한다', /workOptions,\s*$/m.test(routes) || /workOptions,/.test(routes));
ok('★ 판정은 C′ 단일 출처(optionWriteColumns) — 헤더 문자열 규칙 재구현 금지',
  /const \{ optionWriteColumns \} = require\('\.\.\/services\/orderLedger\.service'\)/.test(routes)
  && !/optionColIndexes/.test(routes));
ok('★ 소유권 검증 뒤에서만 읽는다(무인증 노출 금지)', (() => {
  const i = routes.indexOf("router.get('/participation-brief'");
  const body = routes.slice(i, routes.indexOf('POST /api/review-edit/request') > 0 ? routes.indexOf('router.post(', i) : routes.length);
  return body.indexOf('_verifyRowOwnership') < body.indexOf('workOptions');
})());
ok('★ 새 엔드포인트를 만들지 않았다(기존 brief 확장)',
  (routes.match(/router\.get\('\/participation-brief'/g) || []).length === 1
  && !/router\.(get|post)\('\/(review-format|work-option)/.test(routes));
ok('★ 읽기 전용 · fail-soft(추출 실패해도 나머지 brief 는 나간다)',
  /SELECT row_json FROM review_index/.test(routes)
  && /catch \(_\) \{ \/\* 표시용 — 실패해도 나머지 brief 는 그대로 나간다 \*\/ \}/.test(R('src/routes/reviewEdit.routes.js')));
ok('★ 공고 미연결 탭에서도 리뷰 형태는 알려준다(공고가 아니라 그 행의 지시)',
  /return res\.json\(\{ ok: true, brief: workOptions\.length \? \{ workOptions \} : null \}\)/.test(routes));

/* ═══ 프론트 표시 ═══ */
ok('참여상품 정보 팝업이 workOptions 를 읽는다', /brief\.workOptions/.test(home));
ok('★ 상품정보보다 위에 온다(무엇을 어떻게 써야 하는가가 먼저)',
  home.indexOf('brief.workOptions') < home.indexOf("_partInfoRow('상품'"));
ok('★ 값·라벨 모두 escape(시트 값이 innerHTML 로 나간다)',
  /escHtml\(o\.label\)/.test(home) && /escHtml\(o\.value\)/.test(home));
ok('★ 라벨은 시트 헤더명을 그대로 쓴다(우리가 고쳐 부르면 탭과 어긋난다)',
  !/리뷰\s*형태\s*['"]?\s*[:+]/.test(home.slice(home.indexOf('brief.workOptions'), home.indexOf('brief.workOptions') + 900)));
ok('값이 없으면 블록 자체를 그리지 않는다', /const wopts = Array\.isArray\(brief\.workOptions\) \? brief\.workOptions\.filter\(o => o && o\.value\) : \[\];/.test(home)
  && /if \(wopts\.length\) rows\.push\(/.test(home));
ok('구버전 서버 응답(workOptions 없음)에도 안전', /Array\.isArray\(brief\.workOptions\)/.test(home));

console.log(`\n✅ reviewFormatDisplay: ${n}개 통과`);
