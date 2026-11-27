'use strict';
/**
 * workboardTopDelete.test.js — 작업보드 상단 [⋯] → [🗑 작업 삭제] (결정 424 · 사용자 확정 2026-11-25)
 *   실행: node tests/workboardTopDelete.test.js
 *
 * 배경: 인트라넷에서 오더를 지워도 손댄 작업은 리뷰웹에 남는다(결정 254 — 일부러). 직원이 그 작업을 치우려 해도
 *   삭제 창구가 홈 작업목록 [⋯] 안에만 있어 찾지 못했다 → 작업보드 상단 [⋯ 작업 도구]에도 같은 삭제를 단다.
 *
 *   ★ 사본 0 — 홈과 **같은** openTaskDelete(미리보기 → 체크 → 실행)·같은 게이트 _taskDelAllowed 를 탄다.
 *   ★ 지운 뒤 사라진 작업 화면·열린 작업 줄에 머물지 않는다(홈으로 · 줄에서 뺀다).
 *   실제 함수 원문을 vm 으로 실행한다.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
function grab(name) {
  const m = new RegExp('(?:async )?function ' + name + '\\(').exec(HTML);
  assert.ok(m, '함수 ' + name + ' 없음');
  let d = 0, started = false;
  for (let k = HTML.indexOf('{', m.index); k < HTML.length; k++) {
    if (HTML[k] === '{') { d++; started = true; } else if (HTML[k] === '}' && started && --d === 0) return HTML.slice(m.index, k + 1);
  }
  throw new Error(name);
}
let passed = 0;
const ok = async (n, f) => { await f(); passed++; console.log('  ✓ ' + n); };
const TABS = [{ sheetId: 'S', tabName: '다른 작업' }, { sheetId: 'S', tabName: '네이버 ㅂㅂ 미소 누룽칩' }];

function sandbox(role, cur) {
  const log = { opened: [], toasts: [], views: [], closed: [], api: [] };
  const sb = {
    STATE: { role, cur, tabs: TABS.map(t => ({ ...t })), wd: { roster: [] } }, _MHB: null, log,
    document: { getElementById: id => (id === 'tdOk' ? { checked: true } : null) },
    toast: m => log.toasts.push(m), alert() {}, esc: s => String(s),
    openTaskDelete: i => log.opened.push(i),
    api: async (url, o) => { log.api.push(url); return { ok: true, totalRows: 3, tables: [] }; },
    _closeTaskMenu() {}, _tdClose() {}, loadTabs: async () => {}, switchView: v => log.views.push(v),
    _favKey: t => t.sheetId + '␟' + t.tabName, _wtList: () => ['S␟네이버 ㅂㅂ 미소 누룽칩', 'S␟다른 작업'],
    wtClose: (_e, k) => log.closed.push(k), JSON,
  };
  vm.createContext(sb);
  vm.runInContext([grab('_taskDelAllowed'), grab('_ddCan'), grab('_brCanAdd'), grab('_ddCount'), grab('_mhKey'),
    grab('_mhToolsVisible'), grab('_mhMenuHtml'), grab('openTaskDeleteCurrent'), grab('_tdGo')].join('\n'), sb);
  return sb;
}

(async () => {
  console.log('\n── 노출 = 홈 [⋯] 와 같은 게이트 ──');
  await ok('admin·master 에게는 작업보드 [⋯] 가 뜨고 그 안에 [🗑 작업 삭제]', () => {
    for (const r of ['admin', 'master']) {
      const sb = sandbox(r, { ...TABS[1], sheetless: false, workKind: 'review' });
      assert.equal(vm.runInContext('_mhToolsVisible()', sb), true, r);
      assert.match(vm.runInContext('_mhMenuHtml()', sb), /openTaskDeleteCurrent\(\)[^>]*>🗑 작업 삭제/);
    }
  });
  await ok('AE(staff)·광고주에게는 삭제가 없다(서버 adminOrMaster — 눌러도 막히는 버튼 금지)', () => {
    for (const r of ['staff', 'advertiser']) {
      const sb = sandbox(r, { ...TABS[1], sheetless: false, workKind: 'review' });
      assert.doesNotMatch(vm.runInContext('_mhMenuHtml()', sb), /openTaskDeleteCurrent/, r);
    }
  });

  console.log('\n── 실행 = 홈과 같은 확인창 ──');
  await ok('지금 연 작업을 목록 인덱스로 바꿔 openTaskDelete 를 부른다(목록이 새 객체여도 좌표로 찾는다)', () => {
    const sb = sandbox('admin', { ...TABS[1] });
    vm.runInContext('openTaskDeleteCurrent()', sb);
    assert.deepEqual(sb.log.opened, [1]);
  });
  await ok('목록에 없으면 엉뚱한 작업을 열지 않고 말한다', () => {
    const sb = sandbox('admin', { sheetId: 'S', tabName: '없는 작업' });
    vm.runInContext('openTaskDeleteCurrent()', sb);
    assert.deepEqual(sb.log.opened, []); assert.match(sb.log.toasts.join(' '), /찾지 못했습니다/);
  });

  console.log('\n── 지운 뒤 ──');
  await ok('★ 보고 있던 작업을 지우면 홈으로 가고, 열린 작업 줄에서도 뺀다', async () => {
    const sb = sandbox('admin', { ...TABS[1] }); sb.STATE.tdI = 1;
    await vm.runInContext('_tdGo()', sb);
    assert.ok(sb.log.api.some(u => u === '/api/trackb/work-tab/delete'));
    assert.deepEqual(sb.log.views, ['home']); assert.equal(sb.STATE.cur, null);
    assert.deepEqual(sb.log.closed, ['S␟네이버 ㅂㅂ 미소 누룽칩']);
  });
  await ok('홈 목록에서 다른 작업을 지우면 지금 화면은 그대로(줄에서만 뺀다)', async () => {
    const sb = sandbox('admin', { ...TABS[1] }); sb.STATE.tdI = 0;
    await vm.runInContext('_tdGo()', sb);
    assert.deepEqual(sb.log.views, []); assert.equal(sb.STATE.cur.tabName, TABS[1].tabName);
    assert.deepEqual(sb.log.closed, ['S␟다른 작업']);
  });

  console.log(`\nworkboardTopDelete: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
