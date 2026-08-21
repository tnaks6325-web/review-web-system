/**
 * 발주(작업오더) 정원 폴백 — 공고 총인원·일건수가 0(미설정)이면 발주서 값이 **실제 정원**이다.
 * (사용자 확정 2026-08-21: "단순 표시가 아니라 실제 적용")
 *
 * 이 가드가 고정하는 것
 *  ① 판정 단일 출처 — 공고>0 이면 공고, 0 이면 발주. 규칙 사본 0(linkedRecruitQuota).
 *  ② 상태엔진 **실제 실행** — 총량 clamp·soft_full·이월 기준선이 폴백값을 본다.
 *  ③ fail-soft — 발주를 모르면(null) 정원을 좁히지 않는다(종전 동작).
 *  ④ 비영속 — maybePersistClosed 는 여전히 DB `rc.recruit_total > 0` 만 본다.
 *  ⑤ 깔때기 — 재료는 fetchCampaignCounts 하나에 실린다(화면·게이트가 갈리지 않게).
 *  ⑥ 화면 — 총건수 출처 칩 · 일건수 "발주 기준 N건 (공고 설정 오늘 M건)".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
let pass = 0;
const t = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };

process.env.CAMPAIGN_SHEET_SCHEDULE = '0';
const S = require('../src/services/campaignState.service');
const { displayRecruitTotal } = require('../src/services/linkedRecruitQuota.service');

console.log('\n── A. 판정(공고 우선 · 0이면 발주) ──');
t('공고에 값이 있으면 언제나 공고가 이긴다', displayRecruitTotal(30, 100).total === 30
  && displayRecruitTotal(30, 100).source === 'campaign');
t('공고 0(미설정)이면 발주값이 적용된다', displayRecruitTotal(0, 100).total === 100
  && displayRecruitTotal(0, 100).source === 'work_order');
t('둘 다 없으면 none — 0을 지어내지 않는다', displayRecruitTotal(0, 0).source === 'none');

const base = { participation_mode: true, status: 'active', window_start: null, window_end: null,
               hold_ttl_min: 15, close_buffer_min: 10 };
const counts = (o = {}) => ({ activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0,
  submittedBeforeToday: 0, carry: null, hold: null, plans: null, linked: null, orderQuota: null, ...o });

console.log('\n── B. effectiveQuota ──');
t('상태엔진이 같은 판정을 노출한다(사본 금지)',
  typeof S.effectiveQuota === 'function'
  && S.effectiveQuota({ recruit_total: 0, daily_limit: 0 }, counts({ orderQuota: { recruitCount: 100, dailyCount: 9 } })).recruitTotal === 100);
t('발주 재료가 없으면 공고 값 그대로(종전 동작)',
  S.effectiveQuota({ recruit_total: 0, daily_limit: 0 }, counts()).recruitTotal === 0);

console.log('\n── C. 상태엔진 실제 실행 ──');
const run = (c, ct) => S.computeCampaignState(c, ct, new Date());
{
  const r = run({ ...base, recruit_total: 0, daily_limit: 0 },
    counts({ orderQuota: { recruitCount: 100, dailyCount: 9 }, submittedAll: 99 }));
  t('공고 0 + 발주 100 → 총량 100 이 적용되고 아직 열려 있다', r.state === 'open' && r.effectiveTotal === 100);
  t('일건수도 발주값이 그날 정원이 된다', r.dailyQuota === 9 && r.effectiveDaily === 9);
  t('출처를 payload 로 말한다(조용한 대체 금지)', r.quotaSource.total === 'work_order' && r.quotaSource.daily === 'work_order');
}
t('발주 총건수를 채우면 soft_full — 무제한으로 계속 열려 있지 않다',
  run({ ...base, recruit_total: 0, daily_limit: 0 },
    counts({ orderQuota: { recruitCount: 100, dailyCount: 9 }, submittedAll: 100 })).state === 'soft_full');
t('공고에 값이 있으면 발주값이 정원을 바꾸지 않는다',
  (() => { const r = run({ ...base, recruit_total: 30, daily_limit: 5 },
    counts({ orderQuota: { recruitCount: 100, dailyCount: 9 } }));
    return r.effectiveTotal === 30 && r.effectiveDaily === 5 && r.quotaSource.total === 'campaign'; })());
t('★ fail-soft — 발주를 모르면(null) 종전대로 무제한(정원을 좁히지 않는다)',
  (() => { const r = run({ ...base, recruit_total: 0, daily_limit: 0 }, counts({ submittedAll: 999 }));
    return r.state !== 'soft_full' && r.effectiveTotal === 0; })());
t('★ 총량 clamp 도 폴백값을 본다 — 남은 자리보다 크게 열지 않는다',
  run({ ...base, recruit_total: 0, daily_limit: 0 },
    counts({ orderQuota: { recruitCount: 100, dailyCount: 30 }, submittedBeforeToday: 95 })).dailyQuota === 5);

console.log('\n── D. 킬스위치(자식 프로세스 — env 는 require 시점에 읽힌다) ──');
{
  const { execFileSync } = require('child_process');
  const probe = `
    const S = require(${JSON.stringify(path.join(root, 'server/src/services/campaignState.service'))});
    const r = S.computeCampaignState(
      { participation_mode:true, status:'active', window_start:null, window_end:null, recruit_total:0, daily_limit:0 },
      { activeHolds:0, todayActiveHolds:0, submittedAll:999, todaySubmitted:0, submittedBeforeToday:0,
        carry:null, hold:null, plans:null, linked:null, orderQuota:{recruitCount:100, dailyCount:9} },
      new Date());
    process.stdout.write(JSON.stringify({ state: r.state, total: r.effectiveTotal }));`;
  const off = JSON.parse(execFileSync(process.execPath, ['-e', probe],
    { env: { ...process.env, CAMPAIGN_ORDER_QUOTA: '0', CAMPAIGN_SHEET_SCHEDULE: '0' } }).toString());
  t('CAMPAIGN_ORDER_QUOTA=0 이면 전건 종전 동작(폴백 미적용)', off.state !== 'soft_full' && off.total === 0);
}

console.log('\n── E. 깔때기·로더 계약 ──');
const svc = fs.readFileSync(path.join(root, 'server/src/services/campaignState.service.js'), 'utf8');
t('재료는 fetchCampaignCounts 에 실린다(counts.orderQuota)', /orderQuota: null,/.test(svc)
  && /o\.orderQuota = orderMap\.get\(id\) \|\| null;/.test(svc));
t('★ 로더는 카운트·plans·linked **뒤**에 둔다(066 가드의 쿼리 순서 계약 유지)',
  svc.indexOf('_loadPlanMaps(pool, ids)') < svc.indexOf('_loadOrderQuota(pool, ids'));
t('★ 잠금 tx(client) 에서는 SAVEPOINT 로 격리한다(082 규율)',
  /SAVEPOINT cs_order_quota/.test(svc) && /ROLLBACK TO SAVEPOINT cs_order_quota/.test(svc));
t('★ 조회 실패는 null — 폴백 미적용(모르면 정원을 좁히지 않는다)',
  /return null;\s*\/\/ ★ 모르면 종전 동작/.test(svc));
/* ★★ 짝짓기 규칙은 **공유 조각 한 곳**(linkedRecruitQuota)에만 있어야 한다 —
   여기에 SQL 사본이 되살아나면 "정원은 A 오더, 유입방식은 B 오더"가 생긴다. */
const lq = fs.readFileSync(path.join(root, 'server/src/services/linkedRecruitQuota.service.js'), 'utf8');
t('★ 규칙 사본을 만들지 않는다 — 공유 배치 로더를 태운다',
  /linkedWorkOrdersForCampaigns \} = require\('\.\/linkedRecruitQuota\.service'\)/.test(svc)
  && !/JOIN work_orders/.test(svc));
t('★ 소프트삭제된 오더는 근거가 아니다(공유 조각)', /w\.deleted_at IS NULL/.test(lq));
t('★ 짝짓기 우선순위는 기존 규칙과 같다(역방향 링크 우선 → 정방향)',
  /NULLIF\(w\.linked_campaign_id, ''\) = c\.id/.test(lq)
  && /NULLIF\(c\.source_work_order_id, ''\) = w\.id/.test(lq)
  && /ORDER BY c\.id, \$\{LINKED_WO_ORDER\}/.test(lq));
t('★ 이월(pendingCarry) 기준 일건수도 같은 적용값', /const dl = effectiveQuota\(c, counts\)\.dailyLimit;/.test(svc));

/* ★ 여기부터는 실제 실행 검사(await) — CommonJS 라 async IIFE 로 감싼다. */
(async () => {
console.log('\n── E2. 로더 실행(정적 검사로는 못 잡는 자리) ──');
{
  /* ★★ 문자열 검사만으로는 "SAVEPOINT 를 잡는 줄만 지운" 변이를 통과시킨다(실측) —
     잠금 tx 를 흉내 낸 스텁 client 로 **실제 실행**해 격리를 확인한다. */
  const mkClient = (fail) => {
    const seen = [];
    return {
      seen,
      release() {},                       // ← 체크아웃된 클라이언트 = 잠금 tx 가능성
      async query(sql, params) {
        seen.push(String(sql).trim().split('\n')[0].trim());
        if (/FROM work_orders|JOIN work_orders/.test(sql)) {
          if (fail) throw Object.assign(new Error('boom'), { code: '42P01' });
          return { rows: [{ campaign_id: 'c1', recruit_count: 100, daily_count: 9 }] };
        }
        return { rows: [] };
      },
    };
  };
  const ok = mkClient(false);
  const m1 = await S.fetchCampaignCounts(ok, ['c1'], new Date());
  t('잠금 tx(client) 에서 SAVEPOINT 를 실제로 잡는다',
    ok.seen.some(q => /^SAVEPOINT cs_order_quota/.test(q)));
  t('발주 정원이 counts 에 실제로 실린다', m1.get('c1').orderQuota.recruitCount === 100
    && m1.get('c1').orderQuota.dailyCount === 9);

  const bad = mkClient(true);
  const m2 = await S.fetchCampaignCounts(bad, ['c1'], new Date());
  t('★ 실패해도 ROLLBACK TO SAVEPOINT 로 tx 를 살린다(082 — 실패 쿼리 하나가 tx 전체를 죽이지 않게)',
    bad.seen.some(q => /^ROLLBACK TO SAVEPOINT cs_order_quota/.test(q)));
  t('★ 실패 = 재료 미부착(null) — 정원을 좁히지 않는다', m2.get('c1').orderQuota === null);
}

console.log('\n── E3. 작업 조건 재료(tabConditionSummary) 실행 ──');
{
  /* ★ 이 함수는 export 되지 않는다(workboardTopC 와 같은 방식으로 소스를 꺼내 실행).
     정적 패턴만 보면 `campQuota` 를 계산해 두고 **쓰지 않는** 변이를 통과시킨다(실측). */
  const tb = fs.readFileSync(path.join(root, 'server/src/services/trackB.service.js'), 'utf8');
  const st = tb.indexOf('async function tabConditionSummary(');
  const en = tb.indexOf('\nasync function ', st + 10) >= 0
    ? tb.indexOf('\nasync function ', st + 10) : tb.indexOf('\nfunction ', st + 10);
  const src = tb.slice(st, en);
  const sandbox = {
    require: (m) => require(m.startsWith('.') ? path.join(root, 'server/src/services', m) : m),
    _condWoOptions: () => [],
    logger: { warn() {}, info() {} },
    module: {}, exports: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nmodule.exports = tabConditionSummary;', sandbox);
  const run = sandbox.module.exports;
  const db = { async query(sql) {
    if (/FROM recruit_campaigns/.test(sql)) {
      return { rows: [{ id: 'c1', title: 'T', recruitTotal: 0, dailyLimit: 0, channel: '네이버',
        channelCustom: '', reviewType: '', reviewFee: 0, transferMemo: '모기만두',
        multiAccount: false, multiDailyLimit: 0, status: 'active', participationMode: true }] };
    }
    return { rows: [] };
  } };
  const wo = { recruitCount: 100, dailyCount: 9, productOption: 'P', payAmount: 13800 };
  const out = await run(db, { sheetId: 's1', tabName: 't1', meta: { tabGid: '1' }, wo });
  t('★ 공고 0 이면 발주 총건수가 실린다 — `총건수 0 건` 을 그리지 않는다', out.recruitTotal === 100);
  t('★ 일건수도 같은 규칙', out.dailyLimit === 9);
  t('★ 출처를 함께 실어 화면이 "발주 기준"이라고 말할 수 있다',
    out.recruitTotalSource === 'work_order' && out.dailyLimitSource === 'work_order');
  t('★ 발주 원값도 함께 — 일건수 칸이 두 값을 나란히 적는 재료', out.orderDailyCount === 9);

  const out2 = await run({ async query(sql) {
    if (/FROM recruit_campaigns/.test(sql)) {
      return { rows: [{ id: 'c1', recruitTotal: 30, dailyLimit: 5, channel: '', channelCustom: '',
        reviewType: '', reviewFee: 0, transferMemo: '', multiAccount: false, multiDailyLimit: 0,
        status: 'active', participationMode: true }] };
    }
    return { rows: [] };
  } }, { sheetId: 's1', tabName: 't1', meta: {}, wo });
  t('★ 공고에 값이 있으면 발주가 이기지 않는다', out2.recruitTotal === 30 && out2.recruitTotalSource === 'campaign');
}

console.log('\n── F. 비영속(완화 금지) ──');
const hold = fs.readFileSync(path.join(root, 'server/src/services/campaignHold.service.js'), 'utf8');
t('★ maybePersistClosed 는 DB recruit_total 만 본다 — 폴백으로 closed 가 굳지 않는다',
  /rc\.recruit_total > 0/.test(hold) && !/orderQuota|effectiveQuota/.test(hold));

console.log('\n── G. 화면(작업 조건 카드) ──');
const wd = fs.readFileSync(path.join(root, 'frontend/workdesk.html'), 'utf8');
const cond = wd.slice(wd.indexOf('function _condCardHtml('), wd.indexOf('function summaryStrip(') > wd.indexOf('function _condCardHtml(')
  ? wd.indexOf('function summaryStrip(') : wd.length);
const body = wd.slice(wd.indexOf('function _condCardHtml('));
const condBody = body.slice(0, body.indexOf('\nfunction '));
t('총건수는 발주 폴백일 때 출처를 칩으로 밝힌다',
  /cd\.recruitTotalSource==='work_order'/.test(condBody) && /발주 기준/.test(condBody));
t('일건수는 발주값과 공고 오늘값을 함께 적는다(사용자 확정 문구)',
  /발주 기준 \$\{odc\.toLocaleString\(\)\}/.test(condBody) && /공고 설정 오늘 \$\{tq\.toLocaleString\(\)\}건/.test(condBody));

// 렌더러를 실제로 실행해 세 갈래를 확인한다(정적 검사는 조건 뒤집힘을 못 잡는다)
{
  const src = condBody.slice(condBody.indexOf('const odc='), condBody.indexOf('})();') + 5);
  const mk = (cd, tq) => {
    const ctx = { n: v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null)), cd, tq, daily: null };
    vm.createContext(ctx);
    vm.runInContext(src.replace(/^const odc=/, 'var odc=').replace(/const daily=/, 'daily='), ctx);
    return ctx.daily;
  };
  t('발주 10 + 공고 오늘 16 → 둘 다 적는다',
    /발주 기준 10/.test(mk({ orderDailyCount: 10, dailyLimit: 16 }, 16)) && /공고 설정 오늘 16건/.test(mk({ orderDailyCount: 10, dailyLimit: 16 }, 16)));
  t('발주값만 있으면 발주만 적는다', mk({ orderDailyCount: 10 }, null).indexOf('공고 설정') < 0);
  t('발주값이 없으면 종전대로 공고 기준 표기(없는 값을 지어내지 않는다)',
    /공고 기준/.test(mk({ dailyLimit: 16 }, 16)));
  t('둘 다 없으면 null → [미설정] 배지로 떨어진다', mk({}, null) === null);
}

console.log(`\n✅ orderQuotaFallback: ${pass} cases passed`);
})().catch(e => { console.error(e); process.exit(1); });
