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
ok('prefill: 유입가이드 원본 HTML 보존(wd_inflow_html)', /wd_inflow_html:.*o\.inflow_guide/.test(app));
ok('prefill: 링크유입이면 landing_url = 유입링크 우선', /_woGuideUrls\(o\.inflow_guide\)\[0\]/.test(app));
ok('modal: 프리필 소비 시 참여형 토글 자동 ON + 시간대 파서', /prefill\.participation && document\.getElementById\("rf_participation"\)/.test(recjs) && /_parsePurchaseTime\(prefill\.purchase_time/.test(recjs));
ok('modal: 원본 HTML은 미수정 시 그대로 전송(수정하면 평문 전환)', /_useRawInflow \? window\._wdInflowRawHtml/.test(recjs) && /dataset\.rawHtml = ""/.test(recjs));
ok('modal: 미리보기 변환(_htmlToPlainPreview) 존재', /function _htmlToPlainPreview/.test(recjs));

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
