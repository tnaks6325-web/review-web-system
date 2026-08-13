/**
 * campaignOptionsAdminGuards.test.js — 참여형 상품옵션 3단계(관리자 화면) 회귀가드 (소스 grep)
 * 실행: node tests/campaignOptionsAdminGuards.test.js
 *
 * 고정하는 것:
 *  - 공고 모달 옵션표(admin.html #rf_opt_rows) + index-recruit 옵션표 CRUD/자동점검/저장 payload.options·중복 하드블록
 *  - 편집 프리필(renderOptRows(json.options)) + 신규 초기화(renderOptRows([]))
 *  - 작업오더→발행 옵션 프리필(index-app _woOptionRows → prefill.options, 2개 이상만)
 *  - 관제 옵션별 현황(applications 응답 option_key+options, _campOptionTable)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const readSrv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const adminHtml = read('frontend/js/recruit-modal.js') + '\n' + read('frontend/admin.html');
const recruit = read('frontend/js/index-recruit.js');
// _woOptionRows 는 공유 모듈(js/work-order-detail.js)로 이관 — 두 파일을 합쳐서 본다
const app = read('frontend/js/index-app.js') + '\n' + read('frontend/js/work-order-detail.js');
const routes = readSrv('src/routes/campaign.routes.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 공고 모달 옵션표 ──
ok('admin.html: 옵션표 UI(#rf_opt_rows + 옵션 추가)', /id="rf_opt_rows"/.test(adminHtml) && /onclick="addOptRow\(\)"/.test(adminHtml) && /id="rf_opt_summary"/.test(adminHtml));
ok('index-recruit: 옵션표 CRUD(addOptRow/renderOptRows/readOptRows)', /function addOptRow\(/.test(recruit) && /function renderOptRows\(/.test(recruit) && /function readOptRows\(/.test(recruit));
ok('index-recruit: 자동점검(_optSummary — 정원합/하루합/중복)', /function _optSummary\(/.test(recruit) && /옵션명 중복/.test(recruit) && /정원합/.test(recruit));
ok('index-recruit: 저장 payload.options(옵션표 있을 때만) + 중복 하드블록', /if \(document\.getElementById\("rf_opt_rows"\)\) \{[\s\S]*?payload\.options = readOptRows\(\)/.test(recruit) // ★ 안내 수단은 토스트 → 모달 안 인라인(_rfSaveBlocked)으로 바뀌었다 — 리뷰웹시스템[3버전]의
//   토스트(z-index 60)는 이 모달(5000+blur) 아래로 깔려 보이지 않는다.
//   고정하는 것은 "중복이면 안내하고 저장을 중단한다"이지 어느 함수로 알리느냐가 아니다.
&& /if \(_optChk\.dup\) \{[\s\S]{0,240}?옵션명이 중복[\s\S]{0,160}?return;/.test(recruit));
ok('index-recruit: readOptRows 파이프 정규화·빈옵션 제거', /replace\(\/\\\|\/g, ""\)\.trim\(\)/.test(recruit) && /if \(!optKey\) return;/.test(recruit));
ok('index-recruit: 마감(closed) 옵션 상태 보존(재활성화 방지, 리뷰 #1)', /row\.dataset\.status = status/.test(recruit) && /status:\s*r\.dataset\.status === "closed" \? "closed" : "active"/.test(recruit) && /rf-opt-reopen/.test(recruit));
// v4: 캠페인 정원이 표에서 파생되므로 "총모집≠정원합" 비교 자체가 사라졌다(항상 일치).
// allHaveDaily는 하루합 '표시' 조건으로만 남는다.
ok('index-recruit: 하루합은 전부 하루한도 있을 때만 표기',
  /allHaveDaily = active\.length > 0 && active\.every\(o => o\.dailyLimit > 0\)/.test(recruit));
// v4: 표가 [상품명·옵션명·결제금액·총인원·일건수] 5열이 되면서 프리필도 상품명을 함께 복원한다
// (campaign_options에는 상품명이 없어 작업내용 원문에서 되찾음).
ok('index-recruit: 편집 프리필 renderOptRowsWithProduct(json.options, 상품원문, 기존 공고)',
  /renderOptRowsWithProduct\(json\.options \|\| \[\], wd\.productLines, c\)/.test(recruit)
  && /function renderOptRowsWithProduct/.test(recruit));
ok('index-recruit: 신규 모달 옵션표 초기화 renderOptRows([])', /renderOptRows\(\[\]\);\s*\/\/ .*옵션표 초기화/.test(recruit));
// v4: 작업오더는 옵션 배열이 있으면 그대로, 없으면 상품정보 텍스트를 줄 단위로 분해해 표를 채운다
ok('index-recruit: 작업오더 프리필 applyProductRowsFromOrder(옵션배열 또는 텍스트 자동분해)',
  /applyProductRowsFromOrder\(prefill\)/.test(recruit)
  && /function applyProductRowsFromOrder/.test(recruit)
  && /function parseProductLinesToRows/.test(recruit));

// ── 작업오더 → 발행 옵션 프리필 ──
ok('index-app: _woOptionRows(product_options_json → 옵션행)', /function _woOptionRows\(o\)/.test(app) && /product_options_json/.test(app));
// ★ 2026-08 C′/B: 옵션명 자리에 상품명을 넣지 않으므로 '옵션 행'은 optKey 있는 행만 센다.
//   (옛 패턴 `rows.length >= 2` 를 그대로 두면 배선 변경을 못 보고 통과한다 — grep 가드 갱신 규율)
ok('index-app: 새 오더의 명시적 옵션 모드를 우선하고, 옛 오더는 옵션 2개 이상일 때만 옵션 작업으로 본다',
  /function _woProductMode\(o\)/.test(app)
  && /const explicitOptionMode = String\(\(arr\[0\] \|\| \{\}\)\.product_mode \|\| ""\) === "opt"/.test(app)
  && /return explicitOptionMode \|\| rows\.filter\(r => r\.optKey\)\.length >= 2 \? rows : \[\]/.test(app));
ok('★ index-app: 상품명을 옵션명(optKey)으로 승격하지 않는다 — 시트 옵션칸 상품명 오기입 차단',
  !/optKey: name\.replace/.test(app) && /optKey: "", payAmount: basePay/.test(app));
ok('★ index-app: 다상품이어도 옵션명 앞에 상품명을 붙이지 않는다(중복 옵션명일 때만 예외)',
  !/\(multiProduct && name \? name \+ " " : ""\)/.test(app) && /dup\.get\(r\.optKey\) > 1/.test(app));
ok('★ index-recruit: 옵션명이 상품명과 같거나 상품명으로 시작하면 옵션이 아니다',
  /optKey === productName\) optKey = ""/.test(recruit) && /optKey\.startsWith\(productName\)/.test(recruit));
ok('index-app: prefill에 options 포함', /options:\s*\(typeof _woOptionRows === "function"\) \? _woOptionRows\(o\) : \[\]/.test(app));

// ── 관제 옵션별 현황 ──
ok('applications API: option_key 반환 + 옵션 뷰 집계', /order_submission_id, late_order_id, option_key/.test(routes) && /options = await _loadOptionViews\(pool, id, st, now\)/.test(routes));
ok('index-recruit: 관제 옵션 현황표(_campOptionTable)', /function _campOptionTable\(/.test(recruit) && /옵션별 현황/.test(recruit) && /누적 확정/.test(recruit));
ok('index-recruit: 관제 표는 신청행 기반 오늘 집계(진행중/제출/누적)', /todayHold: 0, todaySub: 0, cumSub: 0/.test(recruit));

console.log(`\n✅ campaignOptionsAdminGuards: ${passed}개 통과`);
