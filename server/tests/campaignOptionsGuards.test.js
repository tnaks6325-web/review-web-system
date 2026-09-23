/**
 * campaignOptionsGuards.test.js — 참여형 상품옵션 서버 반영사항 회귀가드 (061, 소스 grep 방식)
 * 실행: node tests/campaignOptionsGuards.test.js
 *
 * 고정하는 것(레드/블루/심판 반영):
 *  - apply 옵션게이트: 옵션 등록 캠페인은 선택 필수(전부 마감이어도 NULL 우회 금지) + 소진 사유코드
 *  - change-option: 캠페인 행 FOR UPDATE 직렬화 + 만료(expires_at) 미연장 + status='applied' 조건부 UPDATE
 *  - submit 서버권위: 홀드 option_key로 selectedOptKey override(fail-open)
 *  - _saveCampaignOptions: 자체 트랜잭션 + recruit_campaigns FOR UPDATE(TOCTOU 봉합) + 참여자 있으면 closed·미삭제
 *  - 공개뷰 금액 은닉(_publicOptionView) / 리뷰어앱 스코프 토큰은 옵션 편집 전 조기반환
 *  - 마이그레이션 idempotent
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const routes = read('src/routes/campaign.routes.js');
const submit = read('src/routes/submit.routes.js');
const state = read('src/services/campaignState.service.js');
const mig = read('migrations/061_campaign_options.sql');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── apply 옵션 게이트 ──
ok('apply: 옵션 등록 캠페인은 선택 필수(allOpts.length 분기)', /const \{ rows: allOpts \}[\s\S]*?WHERE campaign_id = \$1 ORDER BY \(status='closed'\)/.test(routes));
// ★ 2026-08-07 우레온 건으로 규칙 정정: 옵션 공고 판정은 **살아있는 옵션 기준**(liveOptions).
//   관리자가 정리(마감)한 옵션만 남은 공고는 옵션 없는 공고로 참여 허용 —
//   종전 `option_unavailable` 전면 거부는 잘못 생긴 옵션을 정리하면 공고가 영구 잠기는 원인이었다.
ok('apply: 옵션 공고 판정 = 살아있는 옵션(liveOptions) — closed-only 는 옵션 없는 공고', /const activeOpts = liveOptions\(allOpts\)/.test(routes) && /if \(activeOpts\.length\) \{/.test(routes));
ok('apply: closed-only 전면거부(option_unavailable) 부활 금지', (() => {
  // 주석 제외 후 판정 — 사고 경위 주석에 남은 이름이 가드를 통과/실패시키지 않게
  const code = routes.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  return !/option_unavailable/.test(code) && !/!activeOpts\.length/.test(code);
})());
// ★★ 완화 금지 — soldout/today_done 은 '살아있는 옵션'이라 여전히 차단된다(우회 참여 금지 원칙 유지)
ok('liveOptions: closed 만 제외(soldout·today_done 은 살아있는 옵션)', (() => {
  const { liveOptions } = require('../src/services/campaignState.service');
  const rows = [{ status: 'closed' }, { status: 'active' }];
  const views = [{ status: 'closed' }, { status: 'soldout' }, { status: 'today_done' }];
  return liveOptions(rows).length === 1 && liveOptions(views).length === 2
      && liveOptions([{ status: 'closed' }]).length === 0 && liveOptions(null).length === 0
      && liveOptions([{}]).length === 1;   // status 미지정 = active
})());
ok('apply: 미선택 option_required / 잘못된 옵션 option_invalid', /reason: 'option_required'/.test(routes) && /reason: 'option_invalid'/.test(routes));
ok('apply: 소진 사유코드 option_soldout/option_today_done', /option_soldout/.test(routes) && /option_today_done/.test(routes));
ok('apply: 옵션게이트는 캠페인 행 FOR UPDATE 안에서 카운트 재집계', /FOR UPDATE', \[id\]\)[\s\S]*?fetchOptionCounts\(client, id, now\)/.test(routes));
ok('apply INSERT에 option_key 포함($8, 063 owner_phone8 포함)', /VALUES \(\$1,\$2,\$3,\$4,\$5,'applied',\$6,\$7,\$8(,\$\d+)*\)/.test(routes) && /chosenOpt \? chosenOpt\.opt_key : null/.test(routes));

// ── change-option ──
ok('change-option: 캠페인 행 FOR UPDATE 직렬화', /change-option[\s\S]*?SELECT \* FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(routes));
ok('change-option: 만료 미연장(UPDATE는 option_key만 SET)', /SET option_key=\$4\s+WHERE id=\$1 AND campaign_id=\$2 AND hold_token=\$3 AND status='applied' AND expires_at > NOW\(\)/.test(routes));
ok('change-option: 제출완료/만료면 변경불가(not_changeable)', /reason: 'not_changeable'/.test(routes));

// ── submit 서버권위 override ──
// ★ D9: 옵션 서버권위 조회는 _authoritativeHold(hold_token 기준 1회 조회)로 이관됐다 —
//   판정 자체(홀드 option_key가 클라값을 override)는 불변, 조회 주체만 바뀜(왕복 순증 0).
ok('submit: 홀드 option_key로 selectedOptKey override', /SELECT ca\.phone8, ca\.option_key/.test(submit) && /ctx\.optionKey = rows\[0\]\.option_key/.test(submit) && /if \(holdCtx && holdCtx\.optionKey\) effectiveOptKey = holdCtx\.optionKey/.test(submit));
ok('submit: fail-open(조회실패 클라값 유지)', /홀드 서버확정 실패\(클라값 유지\)/.test(submit));
ok('submit: override는 홀드 문맥(_campaignHoldCtx) 있을 때만', /const holdCtx = await _authoritativeHold\(_campaignHoldCtx\(b, loginPhone8\)\)/.test(submit) && /if \(!ctx \|\| !ctx\.applicationId \|\| !ctx\.holdToken\) return ctx;/.test(submit));

// ── _saveCampaignOptions TOCTOU 봉합 ──
ok('saveOptions: 자체 트랜잭션 + 캠페인 행 FOR UPDATE(상호배제)', /_saveCampaignOptions[\s\S]*?BEGIN'\);[\s\S]*?SELECT id FROM recruit_campaigns WHERE id=\$1 FOR UPDATE/.test(routes));
ok('saveOptions: 참여자 있는 옵션은 closed(삭제 금지)', /status IN \('applied','submitted'\)[\s\S]*?UPDATE campaign_options SET status='closed'/.test(routes));
ok('saveOptions: 실패 시 응답 optionsWarning 표면화', /optionsWarning/.test(routes));

// ── 노출·격리 ──
const _povBody = (routes.match(/function _publicOptionView\(v\) \{([\s\S]*?)\n\}/) || [])[1] || '';
ok('공개뷰: _publicOptionView는 payAmount 제외(참여 전 금액 비공개)', /remaining: v\.remaining/.test(_povBody) && !/payAmount/.test(_povBody));
ok('work-detail: 선택옵션·변경가능 노출(canChangeOption)', /canChangeOption/.test(routes) && /selectedOption/.test(routes));
ok('스코프 토큰은 옵션 편집 전 조기반환(레드 #4)', routes.indexOf("via === 'reviewer_campaign'") < routes.indexOf('options, // ★ 061: 상품옵션 목록(배열'));

// ── 상태엔진 순수함수 계약 ──
ok('computeOptionView: used=제출+유효홀드, soldout/today_done 판정', /const used = \(Number\(c\.submitted\)[\s\S]*?\+ \(Number\(c\.activeHolds\)/.test(state) && /status = 'soldout'/.test(state) && /status = 'today_done'/.test(state));
ok('fetchOptionCounts: option_key IS NOT NULL 필터 + 시각기준 유효홀드', /WHERE campaign_id = \$1 AND option_key IS NOT NULL/.test(state) && /status='applied'\s+AND expires_at > NOW\(\)/.test(state));

// ── 마이그레이션 idempotent ──
ok('migration 061: CREATE TABLE/INDEX IF NOT EXISTS + ADD COLUMN IF NOT EXISTS', /CREATE TABLE IF NOT EXISTS campaign_options/.test(mig) && /ADD COLUMN IF NOT EXISTS option_key/.test(mig) && /CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_options_key/.test(mig));
ok('migration 061: ON DELETE CASCADE(캠페인 삭제 시 옵션 정리)', /REFERENCES recruit_campaigns\(id\) ON DELETE CASCADE/.test(mig));

console.log(`\n✅ campaignOptionsGuards: ${passed}개 통과`);
