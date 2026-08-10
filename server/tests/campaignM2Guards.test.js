/**
 * campaignM2Guards.test.js — M2 서버 반영사항 회귀가드 (소스 grep 방식)
 * 실행: node tests/campaignM2Guards.test.js
 *
 * 고정하는 것:
 *  변경① apply 시점 내정보 게이트 — 구매양식 신원게이트(#272)의 검사를 참여 시점으로 전진(자리 미점유 403)
 *  변경② 공고 등록/수정의 참여형 필드 + 활성화 게이트 병합 판정 + work_detail 저장시 sanitize
 *  my-status의 활성 홀드(stage:'applied') 병합 — 시각 기준 유효홀드만
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const routes = read('src/routes/campaign.routes.js');
const reviewer = read('src/routes/reviewer.routes.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 변경① apply 내정보 게이트 ──
ok('apply: profileMissing 재사용(identity.service)', /require\('\.\.\/services\/identity\.service'\)/.test(routes) && /profileMissing\(reg\.rows\[0\]\)/.test(routes));
ok('apply: profile_missing 403 + missing 목록 반환', /reason: 'profile_missing', missing/.test(routes));
// ★ 082: INSERT 에 review_fee_snapshot($9)이 붙었다 — 순서 검사 의미는 그대로.
//   ★ 위치를 못 찾으면(-1) 통과로 새지 않게 존재부터 단언한다(약한 단언은 잘못된 이유로 통과한다).
{
  const _iGate = routes.indexOf("reason: 'profile_missing'");
  // ★ 파라미터는 컬럼이 늘 때마다 뒤에 붙는다 — 꼬리를 고정하지 않는다(101 blog_url 에서 실제로 드리프트)
  const _iIns = routes.search(/VALUES \(\$1,\$2,\$3,\$4,\$5,'applied',\$6,\$7,\$8(,\$\d+)*\)/);
  ok('apply: 게이트는 홀드 INSERT 이전(자리 미점유) — profile_missing이 INSERT보다 앞 (063 owner_phone8 · 082 리뷰비 스냅샷 포함)',
    _iGate > 0 && _iIns > 0 && _iGate < _iIns);
}
ok('apply: 등록 조회가 프로필 필드 포함(name/address/bank_*) + 063 sub_accounts', /SELECT name, phone, phone8, address, bank_name, bank_account, account_holder, sub_accounts\s+FROM reviewers/.test(routes));

// ── 변경② 공고 등록/수정 참여형 필드 ──
for (const f of ['participation_mode', 'thumbnail_url', 'landing_url', 'daily_limit', 'recruit_total', 'window_start', 'window_end', 'close_buffer_min', 'hold_ttl_min', 'work_detail', 'source_work_order_id']) {
  ok(`admin update: ${f} 편집 지원`, new RegExp(`${f} = (COALESCE\\(|CASE WHEN)`).test(routes));
}
ok('admin create: 참여형 active 생성도 활성화 게이트 통과 필요', /participation_mode && \(status === 'active'\)/.test(routes));
ok('admin update 게이트: 시간창·일일건수도 본문값 병합 판정(J7 확장, 062: auto_order 반영 유효값)', /window_start: pick\(_wsEff/.test(routes) && /daily_limit: pick\(daily_limit/.test(routes));
ok('work_detail 저장 시 sanitize(1차) — _prepWorkDetail', /_prepWorkDetail[\s\S]*?sanitizeGuideHtml\(wd\.inflowGuideHtml\)/.test(routes));
ok('work_detail: undefined=유지 시맨틱(CASE WHEN $29)', /work_detail = CASE WHEN \$29::boolean THEN \$30::jsonb ELSE work_detail END/.test(routes));

// ── my-status 홀드 병합 ──
ok("my-status: stage 'applied' 병합", /stage: 'applied'/.test(reviewer) && /source: 'campaign_hold'/.test(reviewer));
ok('my-status: 유효홀드 시각 기준(expires_at > NOW())', /ca\.status = 'applied' AND ca\.expires_at > NOW\(\)/.test(reviewer));
ok('my-status: 병합 실패는 기존 응답을 막지 않음(try/catch)', /홀드 병합 실패/.test(reviewer));
ok('my-status stats: applied 카운트 추가', /applied: items\.filter\(i => i\.stage === 'applied'\)/.test(reviewer));

console.log(`\n✅ campaignM2Guards: ${passed}개 통과`);
