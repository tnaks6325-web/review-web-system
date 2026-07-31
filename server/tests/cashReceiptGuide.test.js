/**
 * cashReceiptGuide.test.js — 현금영수증 안내(1단계) 회귀가드.
 *
 * 현영 탭 공고에서 리뷰어가 결제 **전에** 지출증빙 발행을 알 수 있어야 한다.
 * 발행 여부의 진실원본은 tab_configs.income_type 하나 — 공고 폼은 읽기 전용 표시만(이중 관리 방지).
 * 실행: node tests/cashReceiptGuide.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const camp = readS('routes/campaign.routes.js');
const tabc = readS('routes/tabconfig.routes.js');
const wd = readF('js/campaign-workdetail.js');
const adm = readF('js/recruit-modal.js') + '\n' + readF('admin.html');
const app = readF('js/index-app.js');
const rec = readF('js/index-recruit.js');
const campHtml = readF('campaign.html');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 서버: 판정과 동봉 ── */
ok('현영 판정은 연결 탭의 income_type 하나만 본다(공고 컬럼 신설 없음)',
  /SELECT income_type FROM tab_configs WHERE sheet_id = \$1 AND tab_name = \$2/.test(camp)
  && /incomeType\.includes\('현영'\)/.test(camp));
ok('현영이 아니면 null — 일반 공고는 응답·화면 모두 불변',
  /if \(!incomeType\.includes\('현영'\)\) return null;/.test(camp));
ok('사업자번호 + 채널별 발행방법 이미지를 함께 조회',
  /cash_receipt_guide_naver/.test(camp) && /cash_receipt_guide_coupang/.test(camp)
  && /company_business_no/.test(camp));
ok('채널에 맞는 이미지 선택(쿠팡/네이버, 그 외는 문구만)',
  /쿠팡\/\.test\(ch\) \? \(map\.cash_receipt_guide_coupang/.test(camp)
  || /\/쿠팡\/\.test\(ch\)/.test(camp));
ok('조회 실패는 null 폴백 — 안내 장애가 작업내용 응답을 막지 않는다',
  /async function _cashReceiptInfo[\s\S]{0,1400}catch \(_\) \{\s*\n\s*return null;/.test(camp));
ok('리뷰어 work-detail 응답에 cashReceipt 동봉',
  /cashReceipt: await _cashReceiptInfo\(camp\),\s*\/\/ 현영 탭만/.test(camp));
ok('관리자 미리보기도 같은 값 — 미리보기 = 실제 화면',
  /cashReceipt: await _cashReceiptInfo\(camp\),\s*\/\/ 미리보기/.test(camp));

/* ── 설정: 채널별 이미지 등록 ── */
ok('발행방법 이미지 저장 엔드포인트(adminOrMaster)',
  /router\.post\('\/cash-receipt-guide', adminOrMasterMiddleware/.test(tabc));
ok('채널 화이트리스트(naver|coupang)만 허용',
  /channel !== 'naver' && channel !== 'coupang'/.test(tabc));
ok('★ imageUrl은 https 절대 URL만 — 리뷰어 화면에 <img src>로 나가므로 자유 문자열 금지',
  /!\/\^https:\\\/\\\/\\S\+\$\/i\.test\(imageUrl\)/.test(tabc));
ok('provider-info가 등록된 이미지를 함께 반환(설정탭 프리필 공용)',
  /cashReceiptGuides/.test(tabc));

/* ── 렌더러: 리뷰어가 보는 카드 ── */
ok('현영일 때만 안내 카드 렌더(일반 공고는 미출력)',
  /var cr = d\.cashReceipt;/.test(wd) && /if \(cr && cr\.required\)/.test(wd));
ok('안내에 지출증빙 + 사업자번호 + 발행방법 이미지',
  /지출증빙 현금영수증/.test(wd) && /cr\.businessNo/.test(wd) && /cr\.guideImageUrl/.test(wd));
ok('결제 전 시점에 보이도록 상품 카드 바로 뒤에 배치',
  /상품 · 옵션 · 결제금액[\s\S]{0,700}var cr = d\.cashReceipt/.test(wd));
ok('제출 때 영수증 캡처가 필요하다는 예고 문구',
  /발행 내역 캡처가 필요해요/.test(wd));
ok('리뷰어 페이지가 서버 값을 렌더러에 전달', /cashReceipt: j\.cashReceipt/.test(campHtml));

/* ── 관리자 화면 ── */
ok('설정탭에 채널별 발행방법 이미지 업로드 2칸',
  /crGuideFileNaver/.test(adm) && /crGuideFileCoupang/.test(adm)
  && /function uploadCashReceiptGuide/.test(app));
ok('업로드는 guide-image 인프라 재사용(신규 저장소 없음)',
  /\/api\/order\/guide-image/.test(app) && /cashreceipt_/.test(app));
ok('공고 모달의 현금영수증은 읽기 전용 — 입력 필드가 아니다',
  /id="rf_cashrcpt_ro"/.test(adm) && !/id="rf_income_type"/.test(adm)
  && /탭 설정 · 읽기 전용/.test(adm));
ok('탭을 바꾸면 발행 여부를 다시 판정',
  /refreshRecruitCashReceipt\(\);\s*\/\/ 탭이 바뀌면/.test(rec));

console.log(`\n✅ cashReceiptGuide: ${n}개 통과`);
