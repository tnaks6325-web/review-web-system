/**
 * optionColumnAudit.test.js — A′ 게시 전 옵션 칸 자동점검(경고 전용) 회귀가드.
 *
 * 배경: 시트의 '옵션' 칸은 ㉮ 상품옵션(리뷰어 선택값 기입) / ㉯ 작업옵션=리뷰형태
 *   ('텍스트'·'포토리뷰' 작업지시)의 두 종류다. 공고 옵션명이 ㉯ 칸 값과 어긋난 채
 *   게시되면 제출 때 사고가 났다(#417).
 *
 * ★ 이 점검은 **차단하지 않는다** — ㉯ 탭에서는 정상이어도 절대 일치하지 않으므로
 *   하드블록을 걸면 멀쩡한 공고 발행이 전부 막힌다(레드팀 #9와 같은 오탐 규율).
 * ★ 서버는 RAW 미러만 읽는다(시트 재읽기 0 = 쿼터 무영향).
 *
 * 실행: node tests/optionColumnAudit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const RF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
// 주석을 걷어낸 소스 — "주석에만 있는데 통과"를 막는다
const nc = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const routes = nc(R('src/routes/tabconfig.routes.js'));
const recruit = nc(RF('js/index-recruit.js'));

/* ═══ 서버: 라우트·권한·데이터 소스 ═══ */
ok('라우트 존재 — GET /option-column-audit', /router\.get\('\/option-column-audit'/.test(routes));
ok('★★ authMiddleware 가 역할 미들웨어보다 먼저다(빠뜨리면 마스터도 403)',
  /router\.get\('\/option-column-audit', authMiddleware, adminOrMasterMiddleware/.test(routes));
ok('★ RAW 미러만 읽는다 — 라이브 시트 읽기(readSheet) 호출 없음', (() => {
  const i = routes.indexOf("router.get('/option-column-audit'");
  const body = routes.slice(i, routes.indexOf("router.get('/reviewer-options'", i));
  return /FROM raw_sheet_rows/.test(body) && !/readSheet\(/.test(body) && !/throttledCall/.test(body);
})());
ok('★★ jsonb 배열 인덱싱에 ::int 캐스트(빼면 전 행 NULL — 063 무음사고 재발)',
  /cells->>\$3::int AS v FROM raw_sheet_rows/.test(routes));
ok('★ fail-soft — 실패는 {ok:false} 로 돌려 발행을 막지 않는다',
  /const bail = \(reason\) => res\.json\(\{ ok: false, reason, columns: \[\] \}\)/.test(routes)
  && /catch \(err\) \{[\s\S]{0,200}?return bail\('error'\)/.test(routes));
ok('gid 없으면 판정 포기(동명탭 오조회 금지)', /if \(!sheetId \|\| !gid\) return bail\('no_tab'\)/.test(routes));
ok('미러 전 탭은 no_mirror', /return bail\('no_mirror'\)/.test(routes));
ok('★ 옵션 칸 판정 규칙이 매퍼와 같다(옵션/option 포함)',
  /key\.includes\('옵션'\) \|\| key\.includes\('option'\)/.test(routes));
ok('★ 상품옵션 지정 여부는 tab_configs 기존 설정을 읽는다(새 저장소 0)',
  /SELECT option_columns, option_columns_map FROM tab_configs/.test(routes));
ok('차수별 설정(option_columns_map)도 합산', /Object\.values\(\(tcRows\[0\] && tcRows\[0\]\.option_columns_map\) \|\| \{\}\)\.forEach\(addDesignated\)/.test(routes));
ok('값 목록에 상한이 있다(넓은 시트 전송량 고정)', /_OPT_AUDIT_MAX_VALUES/.test(routes) && /slice\(0, _OPT_AUDIT_MAX_VALUES\)/.test(routes));

/* ═══ 프론트: 조회·경합가드·표시 ═══ */
ok('탭 변경 시 재조회 배선', /function onLinkedTabChange[\s\S]{0,900}?refreshOptColumnAudit\(\)/.test(recruit));
ok('같은 탭 중복 조회 안 함', /if \(key === _rfOptAuditKey\) return;/.test(recruit));
ok('★ 늦게 온 응답 버리기(탭 전환 경합)', /if \(_rfOptAuditKey !== key\) return;/.test(recruit));
ok('★ 조회 실패는 조용히 항목 생략(fail-soft)', /catch \(_\) \{\s*\n\s*_rfOptAudit = null;/.test(recruit));
ok('자동점검 목록에 합류', /_optColumnCheckItems\(\) \|\| \[\]\)\.forEach\(i => items\.push\(i\)\)/.test(recruit));
ok('★★ 경고 전용 — 이 항목은 fail(게시 차단)을 만들지 않는다', (() => {
  const i = recruit.indexOf('function _optColumnCheckItems');
  const body = recruit.slice(i, recruit.indexOf('\n}', recruit.indexOf('return items;', i)));
  return /warn: true/.test(body) && !/fail: true/.test(body);
})());
ok('★ 게시 차단 목록(participationCheckErrors)은 건드리지 않았다(옵션 불일치로 발행이 막히지 않음)',
  !/옵션명/.test(recruit.slice(recruit.indexOf('function participationCheckErrors'),
    recruit.indexOf('function renderPartCheck'))));
ok('옵션 없는 공고는 대조하지 않는다', /if \(!optKeys\.length\) return \[\];/.test(recruit));
ok('마감 옵션은 대조 대상에서 제외', /filter\(o => o\.status !== "closed"\)/.test(recruit));
ok('★ 상품옵션으로 지정된 칸에서만 값 대조(㉯ 작업지시 탭 오탐 차단)',
  /const product = a\.columns\.filter\(c => c\.designated\)/.test(recruit));
ok('★ 미지정 + 값이 채워진 칸은 "작업지시" 안내로 표시(보존된다는 사실 고지)',
  /const work = a\.columns\.filter\(c => !c\.designated && \(c\.filledRows \|\| 0\) > 0\)/.test(recruit)
  && /기존 값이 보존됩니다/.test(recruit));
ok('★ 표시 문자열은 escape(시트 값이 그대로 innerHTML 로 나간다)',
  /escHtml\(col\.name\)/.test(recruit) && /escHtml\(miss\.slice\(0, 3\)\.join\(", "\)\)/.test(recruit));

console.log(`\n✅ optionColumnAudit: ${n}개 통과`);
