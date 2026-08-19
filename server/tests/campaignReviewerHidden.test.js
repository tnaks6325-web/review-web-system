/**
 * campaignReviewerHidden.test.js — 리뷰어 미노출(비공개/테스트) 공고 회귀가드 (085)
 * 실행: node tests/campaignReviewerHidden.test.js
 *
 * 왜 필요한가: 대량구매(타계정 다건 일괄 제출) 흐름을 실제로 테스트하려면
 * **참여·제출이 진짜로 되는** 공고가 필요한데, 그런 공고가 리뷰어 목록에 뜨면 안 된다.
 *   ⓐ status 를 'active' 가 아니게 두면 목록에선 빠지지만 computeCampaignState 가
 *      무조건 'closed' 로 판정해 **참여 자체가 막힌다** → 테스트 불가.
 *   ⓑ 관리자 미리보기(preview=1)는 제출 4중 차단 + _batchBoot 가 preview 에서 꺼져 배치 테스트 불가.
 *   → 그래서 "노출"과 "상태"를 분리했다. 이 가드는 그 분리가 무너지지 않는지 고정한다.
 *
 * 고정하는 것:
 *  A. 공개 목록(/list)에서만 제외 — 관리자 목록·상세·참여(apply)·work-detail 은 무변경.
 *  B. 스코프 토큰(리뷰어앱 공고수정)은 이 플래그를 못 바꾼다(노출 권한 상승 차단).
 *  C. 부팅 프리플라이트 등록(컬럼 누락 = 리뷰어 공고목록 전면 42703 이므로 fail-closed).
 *  D. 프론트 — 토글·프리필·저장 전송(토글 UI 있는 화면에서만)·관리자 전용 배지.
 *  E. PGTEST_URL 있으면 **진짜 PG 로** 필터가 실제로 숨기는지 실행 확인.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const routes    = read('src/routes/campaign.routes.js');
const indexJs   = read('index.js');
const migration = read('migrations/085_campaign_reviewer_hidden.sql');
const modal     = read('../frontend/js/recruit-modal.js');
const recruitJs = read('../frontend/js/index-recruit.js');
const cards     = read('../frontend/js/campaign-cards.js');
const adminHtml = read('../frontend/admin.html');
const workdesk  = read('../frontend/workdesk.html');

let passed = 0;
function ok(name, cond, extra) {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
}

// ── A. 서버: 공개 목록에서만 제외 ──
console.log('\n[A] 공개 목록에서만 제외');
ok('마이그레이션 085: 컬럼 추가 + 기본 FALSE(기존 공고 동작 불변)',
  /ADD COLUMN IF NOT EXISTS reviewer_hidden BOOLEAN NOT NULL DEFAULT FALSE/.test(migration));
ok('★ 공개 /list 가 미노출 공고를 제외', /WHERE status IN \('active', 'closed'\)[\s\S]{0,400}AND COALESCE\(reviewer_hidden, FALSE\) = FALSE/.test(routes));

// 리뷰어 노출 경로는 /list 하나뿐 — 다른 리뷰어 대면 목록이 새로 생기면 여기서 잡힌다
{
  const listIdx = routes.indexOf("router.get('/list'");
  const listEnd = routes.indexOf('router.get(', listIdx + 10);
  const listBody = routes.slice(listIdx, listEnd);
  ok('/list 본문 안에서 필터가 적용됨(다른 라우트에 잘못 붙지 않음)', /reviewer_hidden/.test(listBody));
}
// 참여·상세·관리자 목록은 무변경이어야 한다 = 그 라우트들엔 이 필터가 없어야 한다
for (const [label, start] of [
  ['참여(apply)', "router.post('/:id/apply'"],
  ['관리자 목록', "router.get('/admin/list'"],
]) {
  const i = routes.indexOf(start);
  assert(i > -1, '라우트를 찾지 못함: ' + start);
  const j = routes.indexOf('\nrouter.', i + 10);          // 바로 다음 라우트 선언까지만
  const body = routes.slice(i, j > i ? j : routes.length);
  ok(`★ ${label} 라우트는 미노출 필터를 쓰지 않음(테스트 참여·관리자 열람이 가능해야 한다)`, !/reviewer_hidden/.test(body));
}

ok('create 라우트가 필드를 받음', /reviewer_hidden, \/\/ ★ 085/.test(routes) && /reviewer_hidden === true,\s+\/\/ ★ 085/.test(routes));
ok('update 라우트는 COALESCE(미전달=유지)', /reviewer_hidden = COALESCE\(\$36, reviewer_hidden\)/.test(routes));
ok('update 파라미터도 null=유지 규약', /\(reviewer_hidden === undefined \|\| reviewer_hidden === null\) \? null : reviewer_hidden === true/.test(routes));

// ── B. 스코프 토큰 격리 ──
console.log('\n[B] 리뷰어앱 스코프 토큰 격리');
{
  const i = routes.indexOf('async function _scopedCampaignEdit');
  const body = routes.slice(i, i + 5000);
  ok('★ 스코프 토큰(리뷰어앱 공고수정)은 노출 플래그를 바꿀 수 없음', !/reviewer_hidden/.test(body));
}

// ── C. 부팅 프리플라이트 ──
console.log('\n[C] 부팅 프리플라이트');
ok("★ REQUIRED_SCHEMA 에 등록(컬럼 누락 = 리뷰어 목록 전면 42703 → fail-closed)",
  /\['recruit_campaigns', 'reviewer_hidden'\]/.test(indexJs));

// ── D. 프론트 ──
console.log('\n[D] 관리자 화면');
ok('모달에 "리뷰어에게 숨김" 토글', /id="rf_reviewer_hidden"/.test(modal));
ok('토글 설명에 "참여·제출은 정상" 명시(오해 방지)', /참여·제출은 정상 동작/.test(modal));
// ★ 참여형 전용 섹션(rf_part_section) 안에 두면 평소 접혀 있어 존재를 모르고, 레거시 공고는 숨길 수도 없다.
//   상태(rf_status)와 같은 "항상 보이는" 묶음에 있어야 한다. (브라우저 렌더로 실측해 잡은 회귀)
// ★★ **살아 있는 마크업만 본다** — 이 모듈에는 `<template id="rf_legacy_*_markup">` 보관 조각이 있는데,
//   브라우저는 그 안을 inert 로 다뤄 **document 에 존재하지 않는다**. 종전처럼 파일 전체를 훑으면
//   토글이 화면에서 통째로 사라져도 그 보관 조각이 대신 잡혀 "위치가 이상하다"는 엉뚱한 실패로 보인다
//   (실제로 v2 개편 때 그렇게 사라졌고, [🧪 테스트 공고]가 리뷰어 목록에 노출되고 있었다).
{
  const live = (() => { let d = 0, out = '';
    for (const line of modal.split('\n')) {
      const o = (line.match(/<template[\s>]/g) || []).length, c = (line.match(/<\/template>/g) || []).length;
      if (d === 0) out += line + '\n'; d += o - c; }
    return out; })();
  const partIdx = live.indexOf('id="rf_part_section"');
  const hidIdx  = live.indexOf('id="rf_hidden_box"');
  ok('★★ 토글이 **살아 있는 마크업**에 있다(보관용 <template> 안은 화면에 없다)', hidIdx > -1,
    { hint: '<template> 안에만 있으면 관리자가 리뷰어 숨김을 켤 수 없다' });
  assert(partIdx > -1, 'rf_part_section 을 찾지 못함');
  let depth = 0, k = live.lastIndexOf('<section', partIdx);
  if (k < 0 || live.lastIndexOf('<div', partIdx) > k) k = live.lastIndexOf('<div', partIdx);
  let end = -1;
  const tag = /<(?:div|section)\b|<\/(?:div|section)>/g; tag.lastIndex = k;
  for (let m; (m = tag.exec(live)); ) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }
  assert(end > -1, 'rf_part_section 의 끝을 찾지 못함');
  ok('★ 토글이 참여형 전용 섹션 밖(참여형을 꺼도 항상 보인다 · 레거시 공고도 숨길 수 있다)',
    hidIdx < live.lastIndexOf('<section', partIdx) || hidIdx > end, { hidIdx, partSectionEnd: end });
  ok('토글이 상태(rf_status)와 같은 묶음(모집정보)', live.indexOf('id="rf_status"') < hidIdx
    && !live.slice(live.indexOf('id="rf_status"'), hidIdx).includes('</section>'));
}
ok('★ 한계(링크를 아는 사람은 접근)를 화면에 고지', /링크를 아는 사람은 들어올 수 있습니다/.test(modal));
ok('저장 payload 전송 — ★ 토글 UI 있는 화면에서만(축약 화면이 설정을 끄지 않게)',
  /if \(document\.getElementById\("rf_reviewer_hidden"\)\) \{\s*\n\s*payload\.reviewer_hidden = !!document\.getElementById\("rf_reviewer_hidden"\)\.checked;/.test(recruitJs));
ok('편집 프리필 복원', /_rh\.checked = c\.reviewer_hidden === true/.test(recruitJs));
ok('★ 카드 배지는 관리자 화면에서만(admin 분기)', /const hidBadge = \(admin && c\.reviewer_hidden === true\)/.test(cards));

ok('테스트 공고 프리셋 함수 존재', /async function openTestCampaignModal\(\)/.test(recruitJs));
ok('★ 프리셋은 status=active(참여가 실제로 되어야 테스트가 된다)', /set\("rf_status", "active"\)/.test(recruitJs));
ok('★ 프리셋이 리뷰어 숨김을 켠다', /chk\("rf_reviewer_hidden", true\)/.test(recruitJs));
ok('★ 프리셋이 타계정 허용을 켠다(일괄 제출의 전제)', /chk\("rf_multi_account", true, onMultiAccountToggle\)/.test(recruitJs));
ok('프리셋이 참여형을 켠다(홀드·배치 경로)', /chk\("rf_participation", true, onParticipationToggle\)/.test(recruitJs));
ok('프리셋은 기존 발행 모달을 재사용(신규 모달 사본 금지)', /await openRecruitModal\(null\);/.test(recruitJs));
// ★ 창구는 리뷰웹시스템[3버전] 하나 — 관리자 대시보드에는 두지 않는다(사용자 확정).
//   Track B(리뷰웹시스템[3버전])가 관리자 대시보드를 대체하는 방향이라 버튼을 양쪽에 두면 창구가 둘이 된다.
ok('★ [🧪 테스트 공고] 버튼은 리뷰웹시스템[3버전]에만(편집 권한자에게만)',
  /STATE\.canEdit\?'<button class="btn" onclick="openTestCampaignModal\(\)"/.test(workdesk));
ok('★ 관리자 대시보드에는 버튼을 두지 않는다(창구 이중화 금지)', !/openTestCampaignModal/.test(adminHtml));
// 모달 토글은 공유 모듈이라 양쪽에서 쓴다 — 버튼(창구)만 리뷰웹시스템[3버전]으로 단일화한 것.
ok('공고 모달 토글은 공유 모듈에 유지(관리자 대시보드에서도 수정 가능)', /id="rf_reviewer_hidden"/.test(modal));

// ── E. 진짜 PG 로 필터 실행 확인(있을 때만) ──
(async () => {
  if (!process.env.PGTEST_URL) {
    console.log('\n[E] PGTEST_URL 없음 — 실제 PG 필터 검증 생략(정적 검사만 수행)');
    console.log(`\n✅ campaignReviewerHidden: ${passed}개 통과`);
    return;
  }
  console.log('\n[E] 진짜 PG 로 필터 실행 확인');
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.PGTEST_URL });
  await c.connect();
  try {
    await c.query(`CREATE TEMP TABLE recruit_campaigns (id text primary key, status text, reviewer_hidden boolean not null default false)`);
    await c.query(`INSERT INTO recruit_campaigns(id,status,reviewer_hidden) VALUES
      ('open','active',false), ('hidden','active',true), ('draft','draft',false)`);
    const vis = await c.query(
      `SELECT id FROM recruit_campaigns
        WHERE status IN ('active','closed') AND COALESCE(reviewer_hidden, FALSE) = FALSE ORDER BY id`);
    const ids = vis.rows.map(r => r.id);
    ok('★ 미노출 공고가 리뷰어 목록에서 실제로 빠짐', !ids.includes('hidden'), ids);
    ok('일반 공고는 그대로 보임', ids.includes('open'), ids);
    ok('draft 는 종전대로 안 보임(기존 동작 불변)', !ids.includes('draft'), ids);
  } finally { await c.end(); }
  console.log(`\n✅ campaignReviewerHidden: ${passed}개 통과`);
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
