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

const adminHtml = read('frontend/admin.html');
const recruit = read('frontend/js/index-recruit.js');
const app = read('frontend/js/index-app.js');
const routes = readSrv('src/routes/campaign.routes.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 공고 모달 옵션표 ──
ok('admin.html: 옵션표 UI(#rf_opt_rows + 옵션 추가)', /id="rf_opt_rows"/.test(adminHtml) && /onclick="addOptRow\(\)"/.test(adminHtml) && /id="rf_opt_summary"/.test(adminHtml));
ok('index-recruit: 옵션표 CRUD(addOptRow/renderOptRows/readOptRows)', /function addOptRow\(/.test(recruit) && /function renderOptRows\(/.test(recruit) && /function readOptRows\(/.test(recruit));
ok('index-recruit: 자동점검(_optSummary — 정원합/하루합/중복)', /function _optSummary\(/.test(recruit) && /옵션명 중복/.test(recruit) && /정원합/.test(recruit));
ok('index-recruit: 저장 payload.options(옵션표 있을 때만) + 중복 하드블록', /if \(document\.getElementById\("rf_opt_rows"\)\) \{[\s\S]*?payload\.options = readOptRows\(\)/.test(recruit) && /_optChk\.dup\) \{ showToast\("옵션명이 중복/.test(recruit));
ok('index-recruit: readOptRows 파이프 정규화·빈옵션 제거', /replace\(\/\\\|\/g, ""\)\.trim\(\)/.test(recruit) && /if \(!optKey\) return;/.test(recruit));
ok('index-recruit: 마감(closed) 옵션 상태 보존(재활성화 방지, 리뷰 #1)', /row\.dataset\.status = status/.test(recruit) && /status:\s*r\.dataset\.status === "closed" \? "closed" : "active"/.test(recruit) && /rf-opt-reopen/.test(recruit));
ok('index-recruit: 하루합 오탐 방지(전부 하루한도 있을 때만 비교)', /allHaveDaily = active\.length > 0 && active\.every\(o => o\.dailyLimit > 0\)/.test(recruit));
ok('index-recruit: 편집 프리필 renderOptRows(json.options)', /renderOptRows\(json\.options \|\| \[\]\)/.test(recruit));
ok('index-recruit: 신규 모달 옵션표 초기화 renderOptRows([])', /renderOptRows\(\[\]\);\s*\/\/ .*옵션표 초기화/.test(recruit));
ok('index-recruit: 작업오더 프리필 renderOptRows(prefill.options)', /renderOptRows\(prefill\.options \|\| \[\]\)/.test(recruit));

// ── 작업오더 → 발행 옵션 프리필 ──
ok('index-app: _woOptionRows(product_options_json → 옵션행)', /function _woOptionRows\(o\)/.test(app) && /product_options_json/.test(app));
ok('index-app: 옵션 2개 이상일 때만(단일=옵션없음)', /return rows\.length >= 2 \? rows : \[\]/.test(app));
ok('index-app: prefill에 options 포함', /options:\s*\(typeof _woOptionRows === "function"\) \? _woOptionRows\(o\) : \[\]/.test(app));

// ── 관제 옵션별 현황 ──
ok('applications API: option_key 반환 + 옵션 뷰 집계', /order_submission_id, late_order_id, option_key/.test(routes) && /options = await _loadOptionViews\(pool, id, st, now\)/.test(routes));
ok('index-recruit: 관제 옵션 현황표(_campOptionTable)', /function _campOptionTable\(/.test(recruit) && /옵션별 현황/.test(recruit) && /누적 확정/.test(recruit));
ok('index-recruit: 관제 표는 신청행 기반 오늘 집계(진행중/제출/누적)', /todayHold: 0, todaySub: 0, cumSub: 0/.test(recruit));

console.log(`\n✅ campaignOptionsAdminGuards: ${passed}개 통과`);
