/**
 * campaignFieldPrefill.test.js — 모집공고 4칸 정리 1차(개선 ①+②) 회귀가드.
 *
 * 배경(실측: 장수돌침대 공고 · docs/design-campaign-field-cleanup.html):
 *  ① 유의사항(notes) 프리필이 "유입방식: ○○" + review_guide 원문 전체를 주입 —
 *    공고 카드에 **참여 전 모두에게 공개**되는 칸이라 상품번호·옵션:결제금액·내부 라벨까지 노출.
 *  ② 리뷰가이드 스냅샷 — [라벨] 없는 원문은 전문 폴백이라 첨부 파일명·저장 URL·상품번호 줄이
 *    그대로 들어와 리뷰어 화면에 이중 표기.
 *
 * 수정: ① notes 프리필 = 빈 값(완화 금지 — 되돌리면 공개 칸 덤프가 재발)
 *      ② _woStripReviewMeta 가 섹션 추출 뒤에도 메타 줄을 걷어낸다(줄 단위·확실한 패턴만).
 *
 * ★ grep 이 아니라 **실측 원문 픽스처로 _woCampaignPrefill 을 실제 실행**해 고정한다 —
 *   문자열 존재 검사는 조립 순서·폴백 분기를 못 본다(레포의 "grep 회귀가드의 맹점").
 * 실행: node tests/campaignFieldPrefill.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const src = readF('js/work-order-detail.js');
const modalSrc = readF('js/recruit-modal.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 모듈을 vm 으로 실제 실행(브라우저 전역 스텁 최소) ── */
const sandbox = { window: {}, console };
sandbox.window.window = sandbox.window;
vm.runInNewContext(src, sandbox, { filename: 'work-order-detail.js' });
const W = sandbox.window;
assert(typeof W._woCampaignPrefill === 'function', '_woCampaignPrefill 미노출');
assert(typeof W._woStripReviewMeta === 'function', '_woStripReviewMeta 미노출');

/* ══ ① 유의사항 프리필 폐지 ══ */
console.log('[①] 유의사항(notes) 프리필 폐지');
const JANGSU = {
  title: '장수돌침대 26년형 올뉴블랙에디션',
  inflow_type: 'guide',
  inflow_keyword: '유입가이드',
  inflow_guide: '쿠팡 검색어 :장수돌침대 전기매트 / 택배받을 주소 폰번호 정확하게 입력해주세요 ! !',
  review_guide: [
    '[유입방식] 유입가이드',
    '',
    '[유입가이드]',
    '장수돌침대 전기매트',
    '',
    '[유입가이드 첨부 이미지]',
    '1. 0722 장수산업 유입.png (29KB, Drive 저장됨)',
    'https://sublime-magic-production-790b.up.railway.app/api/order/guide-image/1mdb2dR2Bz_4sX-2V251kl3XtdjyT6Q1J',
    '',
    '[리뷰등록 가이드]',
    '전체 별점 5건',
    '- 배송이 빠르다',
    '- 겨울맞이 미리 준비했다 등',
    '1~2줄 자연스러운 리뷰 작성희망',
  ].join('\n'),
  special_notes: '',
};
const p = W._woCampaignPrefill(JANGSU);
ok('★ notes(유의사항)는 빈 값 — 공개 칸에 원문 덤프 금지(완화 금지)', p.notes === '');
ok('배선: 프리필 소스에 review_guide → notes 조립이 없다',
  !/notes:\s*\[[\s\S]{0,200}review_guide/.test(src));
ok('유의사항 placeholder 가 용도를 말한다(참여 전 공개 안내 전용)',
  /placeholder="참여 전 모두에게 공개되는 짧은 안내만/.test(modalSrc));

/* ══ ② 리뷰가이드 메타 스트립 ══ */
console.log('\n[②] 리뷰가이드 메타 줄 스트립');
ok('섹션 추출: [리뷰등록 가이드] 본문만 남는다',
  p.wd_review.includes('전체 별점 5건') && p.wd_review.includes('1~2줄 자연스러운 리뷰 작성희망'));
ok('유입 라벨·유입 본문 미포함', !p.wd_review.includes('[유입') && !p.wd_review.includes('장수돌침대 전기매트'));
ok('첨부 파일명·저장 URL 미포함', !p.wd_review.includes('유입.png') && !p.wd_review.includes('guide-image'));

// 전문 폴백([라벨] 0개) — 종전엔 통째로 들어오던 케이스. 메타 줄만 걷어내고 본문은 보존.
const FALLBACK = {
  review_guide: [
    '쿠팡상품번호: 9088636838 - 26709533044',
    '▶옵션:결제금액◀사이즈 멀티싱글 1개 78,000원 색상은 자율',
    '전체 별점 5건',
    'https://sublime-magic-production-790b.up.railway.app/api/order/guide-image/1mdb2dR2Bz_4sX',
    '- 배송이 빠르다',
    '1. 캡처.png (12KB, Drive 저장됨)',
    '리뷰 작성 후 링크 공유',
  ].join('\n'),
};
const p2 = W._woCampaignPrefill(FALLBACK);
ok('★ 전문 폴백에서도 상품번호·옵션:결제금액 줄 제거',
  !p2.wd_review.includes('상품번호') && !p2.wd_review.includes('▶옵션'));
ok('★ 전문 폴백에서도 첨부 URL·파일명 줄 제거',
  !p2.wd_review.includes('guide-image') && !p2.wd_review.includes('캡처.png'));
ok('본문 문장은 전부 보존(순서 유지)',
  p2.wd_review === '전체 별점 5건\n- 배송이 빠르다\n리뷰 작성 후 링크 공유');

// 오탐 방지 — 문장 속 단어는 지우지 않는다(지우는 오탐이 놓치는 것보다 나쁘다)
const SAFE = W._woStripReviewMeta([
  '상품번호를 주문내역에서 확인해 주세요',      // 콜론 없는 서술 = 보존
  '결제금액이 표시된 화면을 캡처해 주세요',      // ▶…◀ 형식 아님 = 보존
  '자세한 방법: https://blog.naver.com/guide 참고', // URL 이 문장 속 = 보존
  '1. 별점을 남긴다 (필수)',                     // 번호 목록이지만 저장됨/업로드 아님 = 보존
].join('\n'));
ok('★ 오탐 0 — 서술형 문장·일반 URL·번호 목록은 건드리지 않는다',
  SAFE.split('\n').length === 4 && SAFE.includes('상품번호를') && SAFE.includes('결제금액이')
  && SAFE.includes('blog.naver.com') && SAFE.includes('별점을 남긴다'));
ok('빈 입력은 빈 값', W._woStripReviewMeta('') === '' && W._woStripReviewMeta(null) === '');

/* ══ 무회귀 — 다른 칸은 종전 그대로 ══ */
console.log('\n[③] 무회귀');
ok('유입가이드 프리필 경로 불변(원문 텍스트 경로)',
  W._woCampaignPrefill({ inflow_type: 'guide', inflow_guide: '검색어: 립밤' }).wd_inflow_text === '검색어: 립밤');
ok('특이사항은 여전히 special_notes 그대로',
  W._woCampaignPrefill({ special_notes: '주소 정확히!' }).wd_notes === '주소 정확히!');
ok('참여형 기본·제목·채팅방 등 다른 키 불변',
  p.participation === true && p.title === '장수돌침대 26년형 올뉴블랙에디션');
ok('관리자 상세 표시(_woDetailHtml)는 무접촉 — 원문 보존 취지 유지',
  !/_woStripReviewMeta/.test(src.slice(src.indexOf('function _woDetailHtml'), src.indexOf('function _woDetailHtml') + 4000)));

console.log(`\n✅ campaignFieldPrefill: ${n}개 통과`);
