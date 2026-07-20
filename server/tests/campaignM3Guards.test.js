/**
 * campaignM3Guards.test.js — M3(프리필 자동화·관제 위젯·썸네일 업로드) 회귀가드 (소스 grep)
 * 실행: node tests/campaignM3Guards.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const app = readF('js/index-app.js');
const recjs = readF('js/index-recruit.js');
const adm = readF('admin.html');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 작업오더 → 발행 자동 프리필 ──
ok('prefill: participation 플래그 포함', /participation:\s*true/.test(app));
ok('prefill: 일일건수·총모집·구매시간대 복사', /daily_limit:\s*o\.daily_count/.test(app) && /recruit_total:\s*o\.recruit_count/.test(app) && /purchase_time:\s*o\.purchase_time/.test(app));
ok('prefill: 유입가이드 원본 HTML 보존(wd_inflow_html)', /wd_inflow_html:[\s\S]{0,400}o\.inflow_guide/.test(app));
ok('prefill: 평문 가이드의 첨부이미지 URL → 실제 <img> 변환(_woPlainGuideToHtml)', /function _woPlainGuideToHtml/.test(app) && /_woPlainGuideToHtml\(o\.inflow_guide\)/.test(app));
ok('변환: guide-image 프록시·Drive URL을 <img>로, 일반 URL은 <a>로', /api\\\/order\\\/guide-image\\\/\[-\\w\]\{20,\}/.test(app) && /drive\.google\.com\/thumbnail\?id=/.test(app));
ok('변환: 이미지 없으면 ""(평문 경로 유지 — 동작 불변)', /return hasImg \? html : "";/.test(app));
ok('변환: 메타 라인 제거(_woCleanGuide 재사용)', /_woCleanGuide\(raw\)/.test(app));
ok('prefill: 링크유입이면 landing_url = 유입링크 우선', /_woGuideUrls\(o\.inflow_guide\)\[0\]/.test(app));
ok('modal: 프리필 소비 시 참여형 토글 자동 ON + 시간대 파서', /prefill\.participation && document\.getElementById\("rf_participation"\)/.test(recjs) && /_parsePurchaseTime\(prefill\.purchase_time/.test(recjs));
ok('modal: 원본 HTML은 미수정 시 그대로 전송(수정하면 평문 전환)', /_useRawInflow \? window\._wdInflowRawHtml/.test(recjs) && /dataset\.rawHtml = ""/.test(recjs));
ok('modal: 미리보기 변환(_htmlToPlainPreview) 존재', /function _htmlToPlainPreview/.test(recjs));

// ── 상품정보 기본값(작업오더) + 자동수집 성공 항목만 덮어쓰기 ──
ok('prefill: 작업오더 첫 상품명·결제금액 헬퍼(_woFirstProductInfo)', /function _woFirstProductInfo/.test(app) && /product_options_json/.test(app));
ok('prefill: product_name/price 프리필 전달', /_woFirstProductInfo\(o\)/.test(app) && /product_name:\s+_pi\.name/.test(app));
ok('prefill: 공고 제목 = 상품명 우선(업체명·건수 미노출), 오더 제목 폴백', /title:\s+_pi\.name \|\| o\.title/.test(app));
ok('modal: 작업오더 기본값을 상품 미리보기에 표시', /prefill\.product_name \|\| prefill\.price/.test(recjs));
ok('modal: 프리필 시 자동수집 1회 시도', /fetchProductInfo\(\{ auto: true \}\)/.test(recjs));
ok('fetch: 성공 항목만 덮어씀(누락 항목은 기존 값 유지)', /if \(r\.name\)\s+nEl\.value = r\.name;/.test(recjs) && /if \(r\.price\) pEl\.value = r\.price;/.test(recjs));
ok('fetch: 실패 시 작업오더 기본값 유지 + 미리보기 미숨김', /작업오더에 입력된 상품명\/가격을 유지합니다/.test(recjs) && /if \(!hasBase\) document\.getElementById\("rf_product_preview"\)\.style\.display = "none"/.test(recjs));

// ── 관제 위젯 ──
ok('관제: 참여형 카드에만 관제 버튼', /c\.participation_mode \? .*openCampControl/.test(recjs));
ok('관제: 오늘 집계는 KST + 유효홀드 시각 기준', /kstDay/.test(recjs) && /Date\.parse\(r\.expires_at\) > now/.test(recjs));
ok('관제: 수동확정 → POST admin/:id/confirm', /\/confirm`/.test(recjs) && /applicationId: appId/.test(recjs));
ok('관제: 수동확정은 만료·취소 건만(진행중 확정 = 주문링크 결번 방지, 리뷰 #4)', /canConfirm = \(r\.status === "expired" \|\| r\.status === "cancelled"\)/.test(recjs));
ok('관제: 무주문 확정은 강한 경고 분기', /연결된 구매 제출이 없는 신청/.test(recjs));
ok('관제: 기구매(late_order_id) 배지 노출', /late_order_id \? chip/.test(recjs));

// ── 썸네일 업로드 ──
ok('썸네일: guide-image 인프라 재사용(신규 업로드 API 없음)', /\/api\/order\/guide-image/.test(recjs));
ok('썸네일: 절대 프록시 URL 저장(교차 오리진 카드 표시)', /rf_thumbnail"\)\.value = j\.url/.test(recjs));
ok('썸네일: 5MB 상한', /5 \* 1024 \* 1024/.test(recjs));
ok('admin.html: 파일 입력·미리보기 존재', /rf_thumb_file/.test(adm) && /rf_thumb_preview/.test(adm));

console.log(`\n✅ campaignM3Guards: ${passed}개 통과`);
