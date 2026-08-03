/**
 * campaignMultiAccountAdmin.test.js — 타계정 추가참여 3단계(관리자 화면) 회귀가드 (063, 소스 grep)
 * 실행: node tests/campaignMultiAccountAdmin.test.js
 * 고정하는 것: 공고 모달 토글·하루한도·타계정 제한시간 · 저장 페이로드 조건부 전송(축약 화면 무전송=기존값 유지) ·
 *   편집 프리필 · 게시 전 자동점검 문구 · 관제 명의 구분/소유자 묶음표 · 기본 [불가] 초기화
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const adminHtml = read('frontend/js/recruit-modal.js') + '\n' + read('frontend/admin.html');
const recruit = read('frontend/js/index-recruit.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 공고 모달 UI ──
ok('admin.html: 타계정 참여 체크박스(rf_multi_account) + 토글 핸들러', /id="rf_multi_account"[^>]*onchange="onMultiAccountToggle/.test(adminHtml));
ok('admin.html: 하루한도(rf_multi_daily)·타계정 제한시간(rf_sub_ttl) 입력', /id="rf_multi_daily"/.test(adminHtml) && /id="rf_sub_ttl"/.test(adminHtml));
ok('admin.html: 하위 설정은 rf_multi_section에 숨김(기본 display:none)', /id="rf_multi_section" style="display:none/.test(adminHtml));
ok('admin.html: 참여형(rf_part_section) 안에 위치 — 레거시 공고엔 미노출', adminHtml.indexOf('id="rf_part_section"') < adminHtml.indexOf('id="rf_multi_account"'));

// ── 토글·자동점검 ──
ok('index-recruit: onMultiAccountToggle 정의(섹션 표시 + 점검 갱신)', /function onMultiAccountToggle\(on\)[\s\S]*?rf_multi_section[\s\S]*?renderPartCheck\(\)/.test(recruit));
ok('index-recruit: 자동점검에 타계정 항목(가능/불가 + 하루한도) — 게이트 아님(fail:false)',
  /타계정 참여: 가능[\s\S]*?타계정 참여: 불가[\s\S]*?fail: false/.test(recruit));

// ── 초기화(기본 [불가]) ──
// ★ D4-lite: 하루한도 기본값 0(무제한) → 1. 0은 여전히 저장 가능(PRD §09-5)하지만 "기본"은 아니다
//   (기본이 무제한이면 토글만 켠 공고에서 한 사람이 자리를 싹쓸이할 수 있음 = 가장 약한 값이 기본인 footgun).
ok('모달 초기화: 신규 공고는 항상 unchecked + 하루한도 1 + 타계정 TTL 10',
  /_maEl\.checked = false; onMultiAccountToggle\(false\)/.test(recruit) && /_mdEl\.value = "1"/.test(recruit) && /_stEl\.value = "10"/.test(recruit));

// ── 편집 프리필 ──
ok('편집 프리필: multi_account_mode/multi_daily_limit/sub_hold_ttl_min 복원',
  /_ma\.checked = c\.multi_account_mode === true/.test(recruit) && /c\.multi_daily_limit \?\? 0/.test(recruit) && /c\.sub_hold_ttl_min \?\? 10/.test(recruit));

// ── 저장 페이로드(핵심: 조건부 전송) ──
ok('저장: 토글 UI 있는 페이지에서만 전송(없으면 미전송=서버 COALESCE 기존값 유지)',
  /if \(document\.getElementById\("rf_multi_account"\)\) \{[\s\S]*?payload\.multi_account_mode/.test(recruit));
ok('저장: multi_daily_limit는 0 이상 정수 클램프', /payload\.multi_daily_limit\s*=\s*Math\.max\(0,/.test(recruit));
ok('저장: sub_hold_ttl_min은 1 이상 클램프(0=즉시만료 footgun 차단)', /payload\.sub_hold_ttl_min\s*=\s*Math\.max\(1,/.test(recruit));
ok('저장: 참여형(isPart) 블록 안에서만 전송 — 레거시 공고 무영향',
  recruit.indexOf('payload.hold_ttl_min') < recruit.indexOf('payload.multi_account_mode'));

// ── 관제 ──
ok('관제: 타계정 판정은 owner_phone8 ≠ phone8(서버 파생값 기준)', /_isSubRow = r => !!\(r\.owner_phone8 && String\(r\.owner_phone8\) !== String\(r\.phone8\)\)/.test(recruit));
ok('관제: 헤더 통계에 오늘 타계정 건수', /타계정 \$\{todaySubCnt\}/.test(recruit));
ok('관제: 소유자 묶음표(_campOwnerTable) 정의 + 렌더', /function _campOwnerTable\(rows, now\)/.test(recruit) && /optTableHtml \+ ownerTableHtml \+ items/.test(recruit));
ok('관제 묶음표: 타계정 건 있는 소유자만 노출(본계정 단독은 제외)', /filter\(g => g\.sub > 0\)/.test(recruit));
ok('관제 묶음표: 전화번호는 뒤4자리만 표기(PII 최소화)', /\$\{g\.owner\.slice\(-4\)\}/.test(recruit) && !/\$\{g\.owner\}</.test(recruit));
ok('관제 행: 타계정 배지에 소유자 뒤4자리 병기', /타 · 본계정 \*\*\*" \+ String\(r\.owner_phone8\)\.slice\(-4\)/.test(recruit));

console.log(`\n✅ campaignMultiAccountAdmin: ${passed}개 통과`);
