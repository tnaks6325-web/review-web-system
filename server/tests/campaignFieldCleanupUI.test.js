/**
 * campaignFieldCleanupUI.test.js — 🧹 4칸 정리 도우미(개선 ③·④) 회귀가드.
 *
 * ③ 발행 모달: 유의사항/리뷰가이드/유입가이드 오염 감지(경고 전용) + 전/후 미리보기 → 사람 [적용].
 * ④ 기발행 소급: 수정 모달을 열면 같은 감지가 돌고, 관리자 카드에 🧹 배지.
 *
 * 완화 금지 3종:
 *  - 감지는 게시를 절대 막지 않는다(경고 전용 — 오탐이 정상 발행을 막으면 더 큰 사고).
 *  - 정리는 미리보기([적용] 버튼) 없이는 값이 바뀌지 않는다(조용한 자동수정 금지).
 *  - 유입가이드 원본 HTML 모드(rawHtml)는 값 수정을 제안하지 않는다(이미지 유실 방지).
 *
 * 판정·정리 단일 출처 = work-order-detail.js(_woStripReviewMeta/_woPickSections) —
 * 카드 배지(campaign-cards)와 모달 감지(index-recruit)가 같은 함수를 쓴다.
 * 실행: node tests/campaignFieldCleanupUI.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const wod = readF('js/work-order-detail.js');
const cards = readF('js/campaign-cards.js');
const rec = readF('js/index-recruit.js');
const modal = readF('js/recruit-modal.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 함수 본문 추출(중괄호 균형) — grep 은 실행 의미를 못 본다 ── */
function pick(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert(i >= 0, name + ' 를 찾지 못함');
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, j + 1);
}

/* work-order-detail 모듈을 vm 실행 → 정리 함수(단일 출처) 확보 */
const wodBox = { window: {}, console };
wodBox.window.window = wodBox.window;
vm.runInNewContext(wod, wodBox);
const W = wodBox.window;

/* ══ A. 카드 배지 감지(_campNeedsFieldCleanup) — 정리 함수와 같은 결과 ══ */
console.log('[A] 카드 배지 감지(개선 ④)');
const detCtx = {
  _woStripReviewMeta: W._woStripReviewMeta,
  _woPickSections: W._woPickSections,
};
vm.createContext(detCtx);
vm.runInContext(pick(cards, '_campNeedsFieldCleanup'), detCtx);
const needs = detCtx._campNeedsFieldCleanup;

ok('유의사항에 원문 덤프(라벨·상품번호) → 배지 ON',
  needs({ notes: '유입방식: 유입가이드\n[유입방식] 유입가이드\n쿠팡상품번호: 9088636838' }) === true);
ok('리뷰가이드 스냅샷에 유입 메타 → 배지 ON',
  needs({ work_detail: JSON.stringify({ reviewGuide: '[유입방식] 유입가이드\n[리뷰등록 가이드]\n전체 별점 5건' }) }) === true);
ok('깨끗한 공고 → 배지 OFF(무회귀)',
  needs({ notes: '와우회원 전용 · 계정당 1회', work_detail: JSON.stringify({ reviewGuide: '전체 별점 5건\n- 배송이 빠르다' }) }) === false);
ok('★ 정리 함수 없는 호스트(리뷰어 페이지) → 무조건 OFF(fail-soft)',
  (() => {
    const bare = { };
    vm.createContext(bare);
    vm.runInContext(pick(cards, '_campNeedsFieldCleanup'), bare);
    return bare._campNeedsFieldCleanup({ notes: '[유입방식] 유입가이드' }) === false;
  })());
ok('배지 배선 — admin 분기 + 단일 출처 export',
  /const cleanBadge = \(admin && _campNeedsFieldCleanup\(c\)\)/.test(cards)
  && /needsFieldCleanup: _campNeedsFieldCleanup/.test(cards)
  && /🧹 본문 정리/.test(cards));

/* ══ B. 모달 감지·분리 순수함수(index-recruit) ══ */
console.log('\n[B] 모달 감지·분리(개선 ③)');
const recCtx = { _CLEAN_MIX_RE: /(주소|연락처|폰번호|전화번호|입금|계좌|송금)/ };
vm.createContext(recCtx);
vm.runInContext(pick(rec, '_cleanInflowSplit') + '\n' + pick(rec, '_cleanNotesDirty'), recCtx);

const split = recCtx._cleanInflowSplit('쿠팡 검색어 :장수돌침대 전기매트 / 택배받을 주소 폰번호 정확하게 입력해주세요 ! !');
ok('유입가이드 분리: 진입 방법은 남고 운영 멘트만 이동 후보',
  split.keep.includes('장수돌침대 전기매트') && !split.keep.includes('주소')
  && split.move.length === 1 && split.move[0].includes('주소 폰번호'));
ok('키워드 없는 유입가이드는 이동 후보 0(경고 자체가 안 뜸)',
  recCtx._cleanInflowSplit('장수돌침대 전기매트 검색 → 2번째 상품').move.length === 0);
ok('유의사항 지문 감지 — 덤프는 잡고 정상 안내는 통과',
  recCtx._cleanNotesDirty('[유입방식] 유입가이드') === true
  && recCtx._cleanNotesDirty('쿠팡상품번호: 12345') === true
  && recCtx._cleanNotesDirty('와우회원 전용 · 계정당 1회') === false);

/* ══ C. 배선 — 경고 전용·미리보기 게이트·rawHtml 보호 ══ */
console.log('\n[C] 배선(완화 금지 3종)');
ok('현재 편집 가능한 리뷰가이드·특이사항 경고 컨테이너가 모달에 있다',
  ['rf_clean_review', 'rf_clean_notes'].every(id => modal.includes(`id="${id}"`))
  && /\.rf-clean-warn\{/.test(modal) && /\.rf-clean-pv\{/.test(modal));
ok('모달을 열 때(신규·수정 공통) 감지가 돈다 — 개선 ④의 소급 경로',
  /try \{ renderRecruitFieldCleanup\(\); \} catch/.test(rec));
ok('입력 중에도 감지 갱신(디바운스)',
  /\["rf_wd_review", "rf_wd_inflow", "rf_notes"\]\.forEach/.test(rec));
ok('★ 정리는 미리보기 버튼(rfCleanPreview)만 노출 — 경고 단계에 rfCleanApply 직결 없음',
  (() => {
    const warnFn = pick(rec, 'renderRecruitFieldCleanup');
    return warnFn.includes("rfCleanPreview('") && !warnFn.includes('rfCleanApply');
  })());
ok('★ [적용](rfCleanApply)은 미리보기 안에서만 나온다',
  pick(rec, 'rfCleanPreview').includes("rfCleanApply('"));
ok('★ 감지·정리 규칙 = work-order-detail 단일 출처(_woStripReviewMeta 재사용, 사본 없음)',
  /_woStripReviewMeta\(_woPickSections\(String\(v \|\| ""\)/.test(rec)
  && !/function _woStripReviewMeta/.test(rec));   // index-recruit 에 사본을 만들지 않았다
ok('★ rawHtml(원본 서식) 모드는 값 수정 제안 없음 — 안내만',
  /rawMode = infl\.dataset\.rawHtml === "1"/.test(rec)
  && /원본 서식\(이미지 포함\) 공고라 자동 이동은 못 해요/.test(rec));
ok('★ 게시 비차단 — 저장 로직(saveRecruitPost)은 정리 도우미를 참조하지 않는다',
  !pick(rec, 'saveRecruitPost').includes('renderRecruitFieldCleanup')
  && !pick(rec, 'saveRecruitPost').includes('rfClean'));
ok('적용 후 재판정 + 미리보기 갱신(정리되면 경고가 사라진다)',
  pick(rec, 'rfCleanApply').includes('renderRecruitFieldCleanup()')
  && pick(rec, 'rfCleanApply').includes('_onPreviewInput()'));

console.log(`\n✅ campaignFieldCleanupUI: ${n}개 통과`);
