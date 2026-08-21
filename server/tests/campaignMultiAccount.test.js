/**
 * campaignMultiAccount.test.js — 타계정 추가참여 1단계(서버 규칙) 회귀가드 (063, 소스 grep + 순수함수)
 * 실행: node tests/campaignMultiAccount.test.js
 * 고정하는 것(레드-블루-심판 최종안): 명의 phone8 키잉 유니크 불변 · 잠금 계층(owner→명의) · 레거시 상한 불변 ·
 *   소유자 합산 상한 · 캠페인별 타계정 하루한도(상태 무관) · submit 홀드문맥 단일화+owner 폴백 ·
 *   옵션 드리프트 백스톱 · closed 재오픈 봉합 · 스코프 토큰 토글 불가 · 공개필드 정책 · my-status PII 미역유출
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const mig045 = read('migrations/045_reviewer_participation.sql');
const mig063 = read('migrations/063_multi_account_participation.sql');
const routes = read('src/routes/campaign.routes.js');
const submit = read('src/routes/submit.routes.js');
const hold = read('src/services/campaignHold.service.js');
const reviewer = read('src/routes/reviewer.routes.js');
const { findSubAccount } = require('../src/services/identity.service');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── D1: 유니크 불변(명의 키잉) ──
ok('045: uq_campaign_apps_active_hold (campaign_id, phone8) 무변경', /uq_campaign_apps_active_hold\s+ON campaign_applications \(campaign_id, phone8\)\s+WHERE status IN \('applied','submitted'\)/.test(mig045));
ok('063: 유니크 재정의 없음(홀드는 명의 phone8 키잉 유지)', !/uq_campaign_apps_active_hold/.test(mig063.replace(/--[^\n]*/g, '')));
// ── 063 스키마 ──
ok('063: multi_account_mode 기본 FALSE(§09-1)', /multi_account_mode BOOLEAN NOT NULL DEFAULT FALSE/.test(mig063));
ok('063: multi_daily_limit·sub_hold_ttl_min·owner_phone8', /multi_daily_limit/.test(mig063) && /sub_hold_ttl_min/.test(mig063) && /ADD COLUMN IF NOT EXISTS owner_phone8 TEXT/.test(mig063));
ok('063: COALESCE 식 부분 인덱스(owner 활성홀드)', /\(\(COALESCE\(owner_phone8, phone8\)\)\) WHERE status = 'applied'/.test(mig063));
ok('063: idempotent(IF NOT EXISTS)', !/ADD COLUMN (?!IF NOT EXISTS)/.test(mig063) && !/CREATE INDEX (?!IF NOT EXISTS)/.test(mig063));
// ── apply 게이트 ──
for (const r of ['multi_disabled', 'sub_invalid', 'sub_shares_owner_phone', 'sub_not_registered', 'owner_hold_cap', 'sub_daily_limit']) {
  ok(`apply: 사유 '${r}' 존재`, routes.includes(`'${r}'`));
}
const applyBody = routes.slice(routes.indexOf('async function _applyParticipation'), routes.indexOf("router.post('/:id/apply'"));
ok('apply 잠금 순서: 캠페인 행 → owner → 명의(camp_hold_owner가 camp_hold_phone보다 앞)',
  applyBody.indexOf('camp_hold_owner:') > 0 && applyBody.indexOf('camp_hold_owner:') < applyBody.indexOf('camp_hold_phone:'));
ok('apply: 레거시 상한 불변(CAMPAIGN_HOLD_CAP 기본 2) + 신설 CAMPAIGN_OWNER_HOLD_CAP 기본 10',
  /CAMPAIGN_HOLD_CAP \|\| '2'/.test(applyBody) && /CAMPAIGN_OWNER_HOLD_CAP \|\| '10'/.test(applyBody));
ok('apply: owner cap은 COALESCE(owner_phone8, phone8) 시각 기준', /COALESCE\(owner_phone8, phone8\) = \$1 AND status = 'applied' AND expires_at > NOW\(\)/.test(applyBody));
ok('apply: 타계정 하루한도는 구매양식 제출완료(submitted_at)만 집계',
  /owner_phone8 = \$2 AND phone8 <> owner_phone8[\s\S]*?status = 'submitted' AND submitted_at >= \$3/.test(applyBody));
// ★ 082 에서 review_fee_snapshot(참여 시점 리뷰비)이 뒤에 추가됐다 — 검사 의미는 그대로
//   (앞쪽 컬럼 순서·owner_phone8 존재·명의 phone8 위치). 뒤에 컬럼이 붙는 것은 허용한다.
ok('apply INSERT: owner_phone8 포함 + 명의 phone8($4)', /\(campaign_id, applicant_name, applicant_phone, phone8, owner_phone8, status, expires_at, hold_token, option_key(, \w+)*\)/.test(applyBody));
ok('apply 응답: phone8 = 명의(holdP8) 계약', /phone8: holdP8,/.test(applyBody));
ok('apply: 타계정 TTL = sub_hold_ttl_min(기본 15 — migration 133)', /isSubApply \? \(Number\(camp\.sub_hold_ttl_min\) \|\| 15\)/.test(applyBody));
ok('apply: 명의 검증은 findSubAccount(identity.service 공유 정규화)', /findSubAccount/.test(applyBody));
// ── submit 홀드문맥 단일화 + owner 폴백 ──
ok('submit: _campaignHoldCtx 정의 1회', (submit.match(/function _campaignHoldCtx\(/g) || []).length === 1);
ok('submit: 인라인 (b.holdPhone8 || loginPhone8) 식은 헬퍼 안에만(1회)', (submit.match(/b\.holdPhone8 \|\| loginPhone8/g) || []).length === 1);
ok('submit: holdCtx 소비 3곳(신원폴백·옵션권위·확정문맥)', (submit.match(/holdCtx/g) || []).length >= 6);
ok('submit: owner 폴백 JOIN(소유권 3중검증 + owner_phone8 NOT NULL)', /JOIN reviewers r ON r\.phone8 = ca\.owner_phone8[\s\S]*?ca\.hold_token = \$4 AND ca\.hold_token <> '' AND ca\.owner_phone8 IS NOT NULL/.test(submit));
ok('submit: 확정 문맥에 expectedOptKey 동봉', /campaignHold: holdCtx \? \{ \.\.\.holdCtx, expectedOptKey: effectiveOptKey[,}]/.test(submit));
ok('submit: 확정 문맥에 orderIdentity 동봉(D3 명의 드리프트 경고 입력)', /orderIdentity: \{ phone \}/.test(submit));
ok('submit: SUB 자동보강은 게이트 기준 행(_rvRows[0].phone8)에 기록', /_rvRows\[0\]\.phone8 \|\| _idPhone8/.test(submit));
// ── hold 드리프트 백스톱 ──
ok('hold: confirm RETURNING id, option_key', /RETURNING id, option_key/.test(hold));
ok('hold: 드리프트 warn은 홀드 옵션 비NULL일 때만(오탐 차단)', /_dbOpt && expectedOptKey !== undefined/.test(hold));
ok('hold: expectedOptKey는 비차단(확정 UPDATE WHERE에 미사용)', !/expectedOptKey/.test((hold.match(/UPDATE campaign_applications\s+SET status = 'submitted'[\s\S]*?RETURNING id, option_key/) || [''])[0]));
// ── 옵션 closed 재오픈 봉합 ──
ok('options: 미지정 status는 기존 유지(COALESCE)', /status=COALESCE\(\$\d+, campaign_options\.status\)/.test(routes) && !/status=EXCLUDED\.status/.test(routes));
// ── 노출·격리 ──
const scoped = routes.slice(routes.indexOf('async function _scopedCampaignEdit'), routes.indexOf('// 오픈 러시 방어'));
ok('스코프 토큰: multi_account_mode/multi_daily_limit 편집 불가', !/multi_account_mode/.test(scoped) && !/multi_daily_limit/.test(scoped));
const pub = (routes.match(/PUBLIC_FIELDS_PARTICIPATION = \[[\s\S]*?\];/) || [''])[0];
ok('공개필드: multi_account_mode 배지 노출 + multi_daily_limit 비공개', pub.includes("'multi_account_mode'") && !pub.includes("'multi_daily_limit'"));
ok('/list SELECT에 multi_account_mode 포함(목록 카드 배지 — 명시 컬럼 SELECT 함정)', /hold_ttl_min, start_date,\s+multi_account_mode, sub_hold_ttl_min/.test(routes));
// ── my-status ──
ok('my-status: 소유자 병합(phone8 OR owner_phone8)', /\(ca\.phone8 = \$1 OR ca\.owner_phone8 = \$1\)/.test(reviewer));
ok('my-status: isSub만 노출(ownerPhone8 원문 미반환 — 무인증 PII 역유출 차단)', /AS "isSub"/.test(reviewer) && !/AS "ownerPhone8"/.test(reviewer));
// ── findSubAccount 순수함수 ──
const subs = [{ name: '이 영희', phone: '010-1111-2222', address: '' }, { name: '박민준', phone: '01033334444' }];
ok('findSubAccount: 공백/하이픈 정규화 정확일치', findSubAccount(subs, '이영희', '11112222').index === 0);
ok('findSubAccount: 두 번째 명의 매칭', findSubAccount(subs, '박민준', '33334444').index === 1);
ok('findSubAccount: 이름 불일치 null', findSubAccount(subs, '이영히', '11112222') === null);
ok('findSubAccount: 8자리 미만 null', findSubAccount(subs, '이영희', '1112222') === null);
ok('findSubAccount: 문자열(이중 인코딩) 파싱 벨트', findSubAccount(JSON.stringify(subs), '이영희', '11112222').index === 0);
ok('findSubAccount: 비배열/파싱실패 null', findSubAccount('not-json', '이영희', '11112222') === null && findSubAccount(null, '이영희', '11112222') === null);
// ── 관리자 3필드 ──
ok('admin create/update: multi 3필드 편집 지원', /multi_account_mode = COALESCE\(\$33, multi_account_mode\)/.test(routes) && /multi_account_mode === true,/.test(routes));
ok('관제 SELECT: owner_phone8 동봉(3단계 묶음 표시 준비)', /order_submission_id, late_order_id, option_key, owner_phone8/.test(routes));

console.log(`\n✅ campaignMultiAccount: ${passed}개 통과`);
