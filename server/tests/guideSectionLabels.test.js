'use strict';
/**
 * 회귀가드 — 리뷰가이드·특이사항 [머리말] 고르기(결정 282 · 완화 금지)
 *
 * 실행: node tests/guideSectionLabels.test.js
 *
 * ★ 지키는 것:
 *   ① 인트라넷 자동 머리말 목록이 관리자·발행(work-order-detail.js)과 리뷰어 화면(campaign-workdetail.js)에서 한 글자도 같다
 *   ② 사람이 쓴 제목(「[키워드 가이드]」)과 첫 머리말 앞 글은 남는다 — 종전엔 둘 다 버려 리뷰가이드가 통째로 빈 공고가 나왔다
 *   ③ 인트라넷 옛 묶음(「[유입방식]」「[배송유형]」…)은 종전대로 버리고, 지정 라벨은 머리말을 떼고 내용만 남긴다
 *   ④ 문장 중간 대괄호(「예약 객실 : [히노끼스파] 커플」)는 머리말이 아니라 글 그대로
 *   ⑤ 발행 프리필 서버 사본도 같은 결과(사본이 갈리면 발행·동기화가 다르게 나온다)
 *   예시 문장은 운영 work_orders 실측(2026-10-23) 모양을 그대로 줄였다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const WOD = fs.readFileSync(path.join(ROOT, 'frontend/js/work-order-detail.js'), 'utf8');
const CWD = fs.readFileSync(path.join(ROOT, 'frontend/js/campaign-workdetail.js'), 'utf8');
const generated = require(path.join(__dirname, '..', 'src/utils/woCampaignPrefill.generated.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

function listOf(src, name) {
  const m = src.match(new RegExp(name + '\\s*=\\s*(\\[[\\s\\S]*?\\]);'));
  assert.ok(m, name + ' 목록을 찾지 못했다');
  return JSON.parse(m[1]);
}

/** 화면 원본 그대로 실행 — 관리자·발행 쪽 */
function wodPick() {
  const s = WOD.indexOf('const _WO_MACHINE_SECTION_LABELS');
  const e = WOD.indexOf('\n}\n', WOD.indexOf('function _woPickSections(')) + 2;
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(WOD.slice(s, e) + '\nthis.pick = _woPickSections;', ctx);
  return ctx.pick;
}
/** 화면 원본 그대로 실행 — 리뷰어 쪽 */
function cwdPick() {
  const s = CWD.indexOf('var MACHINE_SECTION_LABELS');
  const e = CWD.indexOf('\n  }\n', CWD.indexOf('function pickReviewOnly(')) + 4;
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(CWD.slice(s, e) + '\nthis.pick = pickReviewOnly;', ctx);
  return ctx.pick;
}

const RV = ['리뷰등록 가이드', '리뷰가이드', '리뷰 가이드'];
const pickW = wodPick();
const pickC = cwdPick();
const pickG = generated._woPickSections;

console.log('\n[guideSectionLabels] 리뷰가이드·특이사항 머리말 고르기(결정 282)');

t('① 자동 머리말 목록이 두 화면에서 한 글자도 같다', () => {
  assert.deepStrictEqual(listOf(CWD, 'var MACHINE_SECTION_LABELS'), listOf(WOD, 'const _WO_MACHINE_SECTION_LABELS'));
});

const KW = '전체 포토리뷰\n- 글자 수: 30자 내외\n\n[키워드 가이드]\n트러블/ 모공축소/ 비건인증\n2개 이상 포함 요청';
t('② 첫 머리말 앞 글 + 사람이 쓴 제목(키워드 가이드)이 그대로 남는다 — 관리자·발행', () => {
  const r = pickW(KW, RV);
  assert.match(r, /^전체 포토리뷰/); assert.match(r, /\[키워드 가이드\]\n트러블\/ 모공축소/); assert.match(r, /2개 이상 포함 요청$/);
});
t('② 리뷰어 화면도 같은 글을 남긴다', () => {
  const r = pickC(KW);
  assert.match(r, /^전체 포토리뷰/); assert.match(r, /\[키워드 가이드\]/); assert.match(r, /2개 이상 포함 요청$/);
});
t('② 대괄호로 시작하는 한 줄(「[시험] …」)도 버리지 않는다', () => {
  assert.strictEqual(pickW('[시험] 삭제 예정 — 사용하지 마세요', RV), '[시험] 삭제 예정 — 사용하지 마세요');
  assert.strictEqual(pickC('[포토 가이드라인] 제형 컷 필수'), '[포토 가이드라인] 제형 컷 필수');
});

const BLOB = '[유입방식] 가이드유입\n[리뷰등록 가이드]\n사진 3장 이상\n[유입가이드]\n검색 경로 안내\n[유입가이드 첨부 이미지]\n1. a.png (29KB, Drive 저장됨)';
t('③ 인트라넷 옛 묶음은 종전대로 리뷰등록 가이드 내용만', () => {
  assert.strictEqual(pickW(BLOB, RV), '사진 3장 이상');
  assert.strictEqual(pickC(BLOB), '사진 3장 이상');
});
t('③ 특이사항 묶음도 특이사항 내용만(배송유형·합계 등 자동 머리말은 버린다)', () => {
  const sn = '[배송유형] 실배송\n[물건비] 현금\n[특이사항]\n주소 정확히 입력\n[합계] 최종모집인원 10명';
  assert.strictEqual(pickW(sn, ['특이사항']), '주소 정확히 입력');
});
t('④ 문장 중간 대괄호는 머리말이 아니다 — 글 전체 그대로', () => {
  const sn = '예약 객실 : [히노끼스파] 커플 1,2,3,4\n쿠폰 적용: 네이버 10% 쿠폰';
  assert.strictEqual(pickW(sn, ['특이사항']), sn);
});
t('대괄호 없는 평문은 무변화', () => {
  assert.strictEqual(pickW('  사진 3장\n글자 수 50자  ', RV), '사진 3장\n글자 수 50자');
  assert.strictEqual(pickC('  사진 3장  '), '사진 3장');
});
t('⑤ 발행 프리필 서버 사본도 같은 결과', () => {
  for (const s of [KW, BLOB, '[시험] x', '예약 객실 : [히노끼스파] 커플']) assert.strictEqual(pickG(s, RV), pickW(s, RV));
});
t('⑤ 발행 프리필 wd_review 가 키워드 가이드 오더를 비우지 않는다', () => {
  const p = generated._woCampaignPrefill({ id: 'wo_x', title: 't', review_guide: KW, special_notes: '', product_options_json: '[]' });
  assert.match(String(p.wd_review || ''), /\[키워드 가이드\]/);
  assert.match(String(p.wd_review || ''), /^전체 포토리뷰/);
});

console.log(`\n결과: ${pass} 통과 · ${fail} 실패`);
if (fail) process.exit(1);
