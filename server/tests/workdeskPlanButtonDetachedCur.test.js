/**
 * 작업보드 [📅 모집인원 조절] — 작업 목록을 다시 받아 STATE.cur 가 옛 객체로 남아도 연결 공고로 열린다 (2026-11-06 실사례)
 *   주소 링크(#w=…)로 바로 연 작업에서 목록이 새로 도착하면 STATE.tabs 는 새 객체가 되고, 공고 주석(campaigns)은 새 항목에만 붙는다.
 *   옛 STATE.cur 만 보면 "이 작업보드에는 연결된 모집공고가 없습니다"로 막혔다.
 *   ★ 실제 함수 본문을 vm 으로 실행한다(문자열 검사만으로는 스코프 사고를 못 잡는다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
function fnSrc(name) {
  const i = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(i >= 0, name + ' 없음');
  let depth = 0, j = html.indexOf('{', i);
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); }
  }
  throw new Error(name + ' 본문 끝 못 찾음');
}
function savedSrc() {
  const i = html.indexOf('window.CAMPAIGN_DAILY_PLAN_SAVED=function');
  assert(i >= 0);
  const j = html.indexOf('\n};', i);
  return html.slice(i, j + 3);
}

let passed = 0;
const ok = (n, c, x) => { assert(c, n + (x ? '  ← ' + x : '')); passed++; console.log('  ✓ ' + n); };

function ctx() {
  const opened = [], toasts = [], selected = [];
  const c = {
    STATE: null, opened, toasts, selected,
    window: { CampaignDailyPlan: { open: id => opened.push(id) } },
    toast: m => toasts.push(m),
    _finEnsureStats: async () => {},
    _wbPlanPickerOpen: cs => opened.push('picker:' + cs.length),
    selTab: async (i) => { selected.push(i); },
  };
  vm.createContext(c);
  const has = /function _curTabLive\(/.test(html);
  vm.runInContext((has ? fnSrc('_curTabLive') + '\n' : '') + fnSrc('openCurrentCampaignDailyPlan') + '\n' + savedSrc(), c);
  return c;
}

(async () => {
  console.log('\n[작업보드 모집인원 조절 — 옛 STATE.cur]');
  // 목록이 새로 도착한 뒤: cur 는 옛 객체(주석 없음), 목록에는 같은 작업의 새 항목(주석 있음)
  {
    const c = ctx();
    const old = { sheetId: 'wt_1', tabName: '가짜 작업 200건' };
    const fresh = { sheetId: 'wt_1', tabName: '가짜 작업 200건', campaigns: [{ id: 'camp_a', status: 'draft' }] };
    c.STATE = { cur: old, tabs: [{ sheetId: 'wt_9', tabName: '다른 작업', campaigns: [{ id: 'camp_x' }] }, fresh], campsUnavailable: false };
    await vm.runInContext('openCurrentCampaignDailyPlan()', c);
    ok('옛 cur 여도 목록 항목의 연결 공고로 연다', c.opened.length === 1 && c.opened[0] === 'camp_a', JSON.stringify({ o: c.opened, t: c.toasts }));
    ok('"연결된 모집공고가 없습니다" 로 막히지 않는다', !c.toasts.length, JSON.stringify(c.toasts));
    c.window.CAMPAIGN_DAILY_PLAN_SAVED({ campaignId: 'camp_a' });
    await new Promise(r => setTimeout(r, 0));
    ok('저장 뒤 작업보드 다시 읽기도 목록 항목 기준(옛 cur 라도)', c.selected.length === 1 && c.selected[0] === 1, JSON.stringify(c.selected));
  }
  // 정상(cur === 목록 항목) — 종전 그대로
  {
    const c = ctx();
    const t = { sheetId: 'wt_1', tabName: 'A', campaigns: [{ id: 'camp_b' }] };
    c.STATE = { cur: t, tabs: [t], campsUnavailable: false };
    await vm.runInContext('openCurrentCampaignDailyPlan()', c);
    ok('cur 가 목록 항목이면 종전 그대로', c.opened[0] === 'camp_b');
  }
  // 정말 연결 공고가 없으면 종전 안내
  {
    const c = ctx();
    const t = { sheetId: 'wt_1', tabName: 'A', campaigns: [] };
    c.STATE = { cur: { sheetId: 'wt_1', tabName: 'A' }, tabs: [t], campsUnavailable: false };
    await vm.runInContext('openCurrentCampaignDailyPlan()', c);
    ok('연결 공고가 정말 없으면 종전 안내', !c.opened.length && /연결된 모집공고가 없습니다/.test(c.toasts[0] || ''));
  }
  // 조회 실패는 "없음"으로 접지 않는다(종전)
  {
    const c = ctx();
    c.STATE = { cur: { sheetId: 'wt_1', tabName: 'A' }, tabs: [], campsUnavailable: true };
    await vm.runInContext('openCurrentCampaignDailyPlan()', c);
    ok('공고 조회 실패 = "불러오지 못했습니다"(없음으로 접지 않음)', /불러오지 못했습니다/.test(c.toasts[0] || ''));
  }
  // 목록에 같은 작업이 아예 없으면(목록 밖에서 연 작업) cur 그대로 — 통계를 받은 뒤 붙은 항목도 다시 찾는다
  {
    const c = ctx();
    const old = { sheetId: 'wt_1', tabName: 'A' };
    c.STATE = { cur: old, tabs: [], campsUnavailable: false };
    c._finEnsureStats = async () => { c.STATE.tabs.push({ sheetId: 'wt_1', tabName: 'A', campaigns: [{ id: 'camp_c' }] }); };
    await vm.runInContext('openCurrentCampaignDailyPlan()', c);
    ok('통계를 받으며 목록에 새로 붙은 항목도 찾는다', c.opened[0] === 'camp_c', JSON.stringify({ o: c.opened, t: c.toasts }));
  }
  console.log(`\n✅ workdeskPlanButtonDetachedCur: ${passed}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
