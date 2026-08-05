/**
 * cashReceiptTiming.test.js — 현금영수증 안내 D안(3시점) + 캡처 선택화 회귀가드.
 *
 * 사용자 확정(2026-08-05) 실제 워크플로우:
 *   ① 공고 확인 시 현금영수증건임을 인지할 수 있어야 한다(참여 전 배지·예고).
 *   ② 결제 단계에서 지출증빙 발행을 신청해야 한다(참여 직후 작업가이드 상세 — 현행 위치).
 *   ③ 발행확정(일련번호)은 배송완료·구매확정 후 0~3일 — 따라서 **발행 내역 캡처는
 *      구매양식/리뷰 제출의 필수요소가 아니다**(제출 화면에선 선택 슬롯 + 발행방법 재안내).
 *
 * + 모집공고 카드 [👁 보기] — 마감·투입완료 공고도 리뷰어 참여 화면(현영 안내 포함)을
 *   기존 관리자 미리보기(campaign.html?preview=1, DB write 0)로 확인한다.
 *
 * 실행: node tests/cashReceiptTiming.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ═══ A. 슬롯 선택화(순수함수 실행) — 화면엔 뜨되 완료를 막지 않는다 ═══ */
console.log('A. 현금영수증 슬롯 선택화');
const cs = require('../src/utils/captureSlots');

ok('현영 탭 화면 슬롯은 여전히 2개(리뷰+현금영수증) — 슬롯 UI 무회귀', (() => {
  const eff = cs.effectiveCaptureSlots(null, '사업자현영');
  return eff && eff.length === 2 && eff[0].key === 'review' && eff[1].key === 'receipt';
})());
ok('★★ 완료 판정에서 현금영수증 제외 — 리뷰 캡처만으로 완료(발행확정 0~3일 대기 무관)',
  JSON.stringify(cs.requiredSlotKeys(null, '사업자현영')) === JSON.stringify(['review']));
ok('영수증 슬롯에 required:false 가 실려 프론트가 "(선택)"으로 그린다',
  cs.RECEIPT_SLOT.required === false
  && cs.effectiveCaptureSlots(null, '현영').find(s => s.key === 'receipt').required === false);
ok('일반 탭·구매확정 단독은 종전과 완전 동일(무회귀)',
  cs.effectiveCaptureSlots(null, '일반') === null
  && JSON.stringify(cs.requiredSlotKeys(null, '')) === JSON.stringify(['review'])
  && cs.effectiveCaptureSlots(null, '', 'confirm') === null);

/* ═══ B. 완료 판정 배선 — 슬롯 모드 판정은 화면 슬롯 기준(영수증만 올리고 완료 차단) ═══ */
console.log('B. submit.routes 완료 판정');
const submit = readS('routes/submit.routes.js');
ok('★★ isMultiSlot 은 effectiveCaptureSlots(화면 슬롯) 기준 — required 개수로 판정하면 '
   + '현영 탭이 fast-path 를 타서 영수증만 올려도 완료가 된다',
  /effectiveCaptureSlots\(ctxRows\[0\]\?\.capture_slots, ctxRows\[0\]\?\.income_type, _rt\)/.test(submit)
  && /Array\.isArray\(_effSlots\) && _effSlots\.length > 1/.test(submit)
  && !/required\.length === 1 && required\[0\] === 'review'/.test(submit));
ok('완료 판정(필수 슬롯 ⊆ 제출 슬롯)은 여전히 requiredSlotKeys 단일 출처',
  /requiredSlotKeys\(ctxRows\[0\]\?\.capture_slots, ctxRows\[0\]\?\.income_type, _rt\)/.test(submit));

/* ═══ C. D안 ① — 참여 전 인지(공개 목록·상세 배지) ═══ */
console.log('C. 참여 전 배지(cashReceiptRequired)');
const camp = readS('routes/campaign.routes.js');
ok('공개 목록/상세에 cashReceiptRequired 파생(_cashReceiptFlags) — 불리언만(발행방법·사업자번호는 참여 후)',
  /_cashReceiptFlags/.test(camp)
  && /view\.cashReceiptRequired = crMap\.get\(r\.id\) === true/.test(camp)
  && /view\.cashReceiptRequired = _crm\.get\(id\) === true/.test(camp));
ok('판정 규칙은 utils/captureSlots.isCashReceiptIncome 단일 출처(슬롯 파생과 같은 규칙)',
  /isCashReceiptIncome/.test(camp.slice(camp.indexOf('_cashReceiptFlags'))));
ok('조회 실패는 필드 미동봉(fail-soft) — false 로 꾸미지 않는다',
  /if \(crMap\) view\.cashReceiptRequired/.test(camp) && /if \(_crm\) view\.cashReceiptRequired/.test(camp));

const cards = readF('js/campaign-cards.js');
ok('카드 🧾 배지는 cashReceiptRequired === true 일 때만(필드 부재 = 구버전 백엔드 = 배지 없음)',
  /c\.cashReceiptRequired === true/.test(cards) && /pt-badge cr/.test(cards)
  && /\.pt-badge\.cr\{/.test(cards));

const campHtml = readF('campaign.html');
ok('참여 전 상세 예고(renderCrNotice) — renderPre 에서 호출 + === true 게이트',
  /renderCrNotice\(\);/.test(campHtml)
  && /_camp\.cashReceiptRequired === true/.test(campHtml)
  && /발행이 필요한 작업이에요/.test(campHtml));
ok('참여 전 예고는 발행방법 상세를 미노출(참여 후 공개 원칙) — 참여 후 안내를 문구로 예고',
  /참여 후<\/b> 작업가이드에서 안내/.test(campHtml));

/* ═══ D. D안 ② — 참여 직후 상세(현행 위치) 문구: 발행확정 0~3일 + 필수 아님 ═══ */
console.log('D. 작업가이드 상세 문구');
const wd = readF('js/campaign-workdetail.js');
ok('결제 전 발행 신청 경고 유지(어떤 조합에서도 A 시점은 유지)',
  /결제 화면을 지나기 전에 꼭 발행을 신청해 주세요/.test(wd));
ok('★ 발행확정 0~3일 + 캡처는 구매양식 제출 필수 아님 안내',
  /발행이 확정된 뒤\(배송완료·구매확정 후 0~3일\)/.test(wd)
  && /구매양식 제출 때 필수가 아니에요/.test(wd));

/* ═══ E. D안 ③ — 제출 화면: 선택 슬롯 표시 + 발행방법 다시 보기 ═══ */
console.log('E. 제출 화면 재안내');
const app = readF('js/search-app.js');
ok('required:false 슬롯은 "(선택 · 발행 확정 후 제출)" 표기 + 상태칩 "선택"',
  /slot\.required === false/.test(app) && /선택 · 발행 확정 후 제출/.test(app));
ok('발행방법 다시 보기(_csLoadCrGuides) — 영수증 슬롯이 있을 때만, fail-soft',
  /_csLoadCrGuides/.test(app)
  && /slots\.some\(s => s\.key === 'receipt'\)/.test(app));
ok('가이드 이미지는 https 절대 URL만 + 따옴표 포함 값 폐기(속성 breakout 방지)',
  /\^https:\\\/\\\/\[\^"'<>\\s\]\+\$/.test(app));
const tabcfg = readS('routes/tabconfig.routes.js');
ok('provider-info 가 라벨 붙은 목록(cashReceiptGuideList)을 내려준다 — 채널 표(단일 출처)에서 파생',
  /cashReceiptGuideList = CASH_RECEIPT_CHANNELS/.test(tabcfg)
  && /cashReceiptGuideList\b/.test(tabcfg));

/* ═══ F. 마감 공고 리뷰어 화면 확인 — 카드 [👁 보기] ═══ */
console.log('F. 카드 [👁 보기]');
ok('관리자 카드 액션 줄에 👁 보기 — 기존 openReviewerPreview 재사용(참여형만 활성)',
  /openReviewerPreview\('\$\{id\}'\)/.test(cards)
  && /👁 보기/.test(cards));
ok('레거시(비참여형) 공고는 비활성 버튼(눌러도 아무 일 없는 버튼 금지 — 사유 툴팁)',
  /참여형 공고만 리뷰어 화면 미리보기를 지원합니다/.test(cards));
const recruit = readF('js/index-recruit.js');
ok('openReviewerPreview 는 여전히 preview=1 + #tok 프래그먼트(미리보기 격리 계약 불변)',
  /campaign\.html\?id=.*preview=1.*#tok=/.test(recruit.replace(/\n/g, ' ')));

console.log(`\n✅ cashReceiptTiming — ${n}개 통과`);
process.exit(0);
