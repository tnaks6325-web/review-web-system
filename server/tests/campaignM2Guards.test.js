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
// ★ 조각 5(결정 181, 사용자 확정 2026-09-26): 주소는 참여 뒤 구매양식에서 캡처 주소로 받는다 — 참여 게이트는
//   profileMissing 에서 '주소' 하나만 뺀 participationProfileMissing 를 쓴다(이름·전화·계좌는 그대로 요구).
{
  const idSvc = require('../src/services/identity.service');
  ok('apply: 내정보 게이트(identity.service) — 주소만 빼고 이름·전화·계좌는 요구',
    /require\('\.\.\/services\/identity\.service'\)/.test(routes) && /participationProfileMissing\(reg\.rows\[0\]\)/.test(routes)
    && JSON.stringify(idSvc.participationProfileMissing({})) === JSON.stringify(['사용자명', '전화번호', '계좌'])
    && JSON.stringify(idSvc.participationProfileMissing({ name: '김', phone: '010-1111-2222', bank_name: 'b', bank_account: '1', account_holder: '김' })) === '[]'
    && JSON.stringify(idSvc.profileMissing({})) === JSON.stringify(['사용자명', '전화번호', '주소', '계좌']));
}
ok('apply: profile_missing 403 + missing 목록 반환', /reason: 'profile_missing', missing/.test(routes));
// ★ 082: INSERT 에 review_fee_snapshot($9)이 붙었다 — 순서 검사 의미는 그대로.
//   ★ 위치를 못 찾으면(-1) 통과로 새지 않게 존재부터 단언한다(약한 단언은 잘못된 이유로 통과한다).
{
  const _iGate = routes.indexOf("reason: 'profile_missing'");
  // ★ 파라미터는 컬럼이 늘 때마다 뒤에 붙는다 — 꼬리를 고정하지 않는다(101 blog_url 에서 실제로 드리프트)
  // ★ 127: status 는 리터럴 'applied' → $n 파라미터로 바뀌었다(블로그 승인제 blog_pending 분기).
  //   검사 의미는 불변 — 게이트가 INSERT 보다 앞인지(자리 미점유)만 본다.
  const _iIns = routes.search(/VALUES \(\$1,\$2,\$3,\$4,\$5,\$\d+,\$6,\$7,\$8(,\$\d+)*\)/);
  ok('apply: 게이트는 홀드 INSERT 이전(자리 미점유) — profile_missing이 INSERT보다 앞 (063 owner_phone8 · 082 리뷰비 스냅샷 포함)',
    _iGate > 0 && _iIns > 0 && _iGate < _iIns);
}
ok('apply: 등록 조회가 UUID와 프로필 필드 포함(name/address/bank_*) + 063 sub_accounts', /SELECT id, name, phone, phone8, address, bank_name, bank_account, account_holder, sub_accounts\s+FROM reviewers/.test(routes));

// ── 변경② 공고 등록/수정 참여형 필드 ──
for (const f of ['participation_mode', 'thumbnail_url', 'landing_url', 'daily_limit', 'recruit_total', 'window_start', 'window_end', 'close_buffer_min', 'hold_ttl_min', 'work_detail', 'source_work_order_id']) {
  ok(`admin update: ${f} 편집 지원`, new RegExp(`${f} = (COALESCE\\(|CASE WHEN)`).test(routes));
}
ok('admin create: 참여형 active 생성도 활성화 게이트 통과 필요', /participation_mode && \(status === 'active'\)/.test(routes));
ok('admin update 게이트: 시간창·일일건수도 본문값 병합 판정(J7 확장, 062: auto_order 반영 유효값)', /window_start: pick\(_wsEff/.test(routes) && /daily_limit: pick\(daily_limit/.test(routes));
ok('work_detail 저장 시 sanitize(1차) — _prepWorkDetail', /_prepWorkDetail[\s\S]*?sanitizeGuideHtml\(wd\.inflowGuideHtml\)/.test(routes));
ok('work_detail: undefined=유지 시맨틱(CASE WHEN $29)', /work_detail = CASE WHEN \$29::boolean THEN \$30::jsonb ELSE work_detail END/.test(routes));

// ── my-status 홀드 병합 ──
// ★ 127: stage 는 blog_pending 분기가 붙어 삼항이 됐다(검사 의미 불변 — applied 병합 존재)
ok("my-status: stage 'applied' 병합", /'blog_pending' \? 'blog_pending' : 'applied'/.test(reviewer) && /source: 'campaign_hold'/.test(reviewer));
ok('my-status: 유효홀드 시각 기준(expires_at > NOW())', /ca\.status = 'applied' AND ca\.expires_at > NOW\(\)/.test(reviewer));
ok('my-status: 병합 실패는 기존 응답을 막지 않음(try/catch)', /홀드 병합 실패/.test(reviewer));
ok('my-status stats: applied 카운트 추가', /applied: items\.filter\(i => i\.stage === 'applied'\)/.test(reviewer));

console.log(`\n✅ campaignM2Guards: ${passed}개 통과`);
