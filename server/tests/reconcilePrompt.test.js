'use strict';
/**
 * 회귀가드 — 오더·공고 값이 다른 작업 담당자 팝업 (결정 284 · 사용자 확정 2026-10-23 「1.가 2.좋다」)
 *
 * 실행: node tests/reconcilePrompt.test.js
 *
 * ★ 지키는 것:
 *   ① 묻는 대상 = 그 작업 담당자만 · 따로 두기·막힌 작업·오늘 「나중에」는 묻지 않는다(화면 원본을 vm 으로 실제 실행)
 *   ② 「공고대로 / 오더대로」는 서버 판정(campaignSide·orderSide)이 막은 칸이 하나라도 있으면 고를 수 없다 — 섞어서 보내지 않는다
 *   ③ 따로 두기 = 「묻지 않음」 표시 하나뿐 — 연결(bidir_state)·값은 건드리지 않고, 이미 연결된 작업은 거절(fail-closed)
 *   ④ 배선: 관리자 이상만 시작 · 로그아웃/세션 끊김에 멈춤 · 라우트는 adminOrMaster · 칸은 REQUIRED_SCHEMA · 마이그레이션은 가산 전용
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const RF = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

function loadPrompt(store) {
  const ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const win = { localStorage: ls, _pmManagerName: v => (v === '박은비' ? '망고' : v === '박세희' ? '만두' : v) };
  const ctx = { window: win, localStorage: ls, document: { getElementById: () => null }, setInterval: () => 0, clearInterval: () => {}, setTimeout, console };
  vm.createContext(ctx);
  vm.runInContext(RF('frontend/js/reconcile-prompt.js'), ctx);
  return win.ReconcilePrompt;
}

const F_OK = { id: 'option:a.recruit_total', label: '인원 (a)', leaf: 'recruit_total', order: 500, campaign: 200, orderText: '500', campaignText: '200', campaignSide: { ok: true } };
const F_CAMP_LOCKED = { id: 'scalar:x', label: '주소', order: 'u1', campaign: 'u2', campaignSide: { ok: false, reason: '공고 쪽으로 옮길 수 없는 칸' } };
const F_ORDER_LOCKED = { id: 'scalar:skip_weekends', label: '주말 제외', order: 'unset', campaign: 0, campaignSide: { ok: true }, orderSide: { ok: false, reason: '오더에 아직 정하지 않은 값' } };
const F_DERIVED = { id: 'scalar:daily_limit', label: '일 진행 건수', derived: true, campaignSide: { ok: false } };
const item = (over) => Object.assign({ workOrderId: 'wo_1', title: '쟈니베어', workManager: '박세희', fields: [F_OK, F_DERIVED], fingerprint: 'fp1', blocked: null, skipped: false }, over);

(async () => {
  console.log('\n[reconcilePrompt] 오더·공고 다름 담당자 팝업(결정 284)');

  await t('① 내 담당 작업만 묻는다 — 작업보드 표기 이름(박세희→만두)으로 맞춰 비교', async () => {
    const P = loadPrompt({});
    P._state.name = '박세희';
    P._state.items = [item(), item({ workOrderId: 'wo_2', workManager: '박은비' }), item({ workOrderId: 'wo_3', workManager: '' })];
    assert.deepStrictEqual(P._mine().map(x => x.workOrderId), ['wo_1']);
    P._state.name = '박은비';
    assert.deepStrictEqual(P._mine().map(x => x.workOrderId), ['wo_2']);
    P._state.name = 'Claude/Codex 자동화';
    assert.deepStrictEqual(P._mine().map(x => x.workOrderId), [], '담당 작업이 없는 계정에는 아무것도 묻지 않는다');
  });
  await t('① 따로 두기 · 막힌 작업 · 다른 칸 없음 · 오늘 「나중에」 는 묻지 않는다(날이 바뀌면 다시)', async () => {
    const d = new Date(); const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const P = loadPrompt({ 'wd_rcask_later_v1_박세희': JSON.stringify({ wo_later: today, wo_old: '2000-01-01' }) });
    P._state.name = '박세희';
    P._state.items = [item({ workOrderId: 'wo_skip', skipped: true }), item({ workOrderId: 'wo_blk', blocked: '못 맞춤' }), item({ workOrderId: 'wo_none', fields: [] }),
      item({ workOrderId: 'wo_later' }), item({ workOrderId: 'wo_old' })];
    assert.deepStrictEqual(P._mine().map(x => x.workOrderId), ['wo_old']);
  });
  await t('② 공고대로 — 공고 쪽을 막은 칸이 있으면 고를 수 없다(이유 = 서버 문구) · 오더대로는 된다', async () => {
    const P = loadPrompt({});
    const it = item({ fields: [F_OK, F_CAMP_LOCKED] });
    assert.match(P._sideBlock(it, 'campaign'), /주소 — 공고 쪽으로 옮길 수 없는 칸/);
    assert.strictEqual(P._sideBlock(it, 'order'), '');
  });
  await t('② 오더대로 — 오더 쪽을 막은 칸(주말 제외 미정)이 있으면 고를 수 없다', async () => {
    const P = loadPrompt({});
    assert.match(P._sideBlock(item({ fields: [F_OK, F_ORDER_LOCKED] }), 'order'), /주말 제외 — 오더에 아직 정하지 않은 값/);
  });
  await t('② 합계만 다른 작업(고를 칸 0) — 공고대로는 못 고르고 오더대로(옵션별 합계)만', async () => {
    const P = loadPrompt({});
    const it = item({ fields: [F_DERIVED] });
    assert.ok(P._sideBlock(it, 'campaign'));
    assert.strictEqual(P._sideBlock(it, 'order'), '');
  });
  await t('② 보내는 고르기 = 고를 칸 전부 한쪽(파생 칸은 보내지 않는다 — 서버가 따라 맞춘다)', async () => {
    const P = loadPrompt({});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(P._picksFor(item(), 'campaign'))), { 'option:a.recruit_total': 'campaign' });
  });

  const svc = require('../src/services/sharedReconcile.service');
  await t('③ 따로 두기 — 연결 안 된·안 지운 작업만 · 표시 칸 두 개만 쓴다(bidir_state·값 무접촉)', async () => {
    let seen = null;
    const db = { query: async (sql, params) => { seen = { sql, params }; return { rows: [{ id: 'wo_1', bidir_reconcile_skip_at: new Date('2026-10-23T00:00:00Z'), bidir_reconcile_skip_by: '박세희' }] }; } };
    const r = await svc.setReconcileSkip({ workOrderId: 'wo_1', skip: true, actor: '박세희', db });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.skipped, true); assert.strictEqual(r.body.skippedBy, '박세희');
    assert.match(seen.sql, /WHERE id = \$1 AND deleted_at IS NULL AND COALESCE\(bidir_state, 'off'\) <> 'on'/);
    const sets = seen.sql.slice(seen.sql.indexOf('SET'), seen.sql.indexOf('WHERE'));
    assert.deepStrictEqual((sets.match(/\b(\w+)\s*=/g) || []).map(x => x.replace(/\s*=$/, '')), ['bidir_reconcile_skip_at', 'bidir_reconcile_skip_by']);
    assert.deepStrictEqual(seen.params, ['wo_1', true, '박세희']);
  });
  await t('③ 이미 연결됐거나 지운 작업 = 409(조용히 성공으로 접지 않는다) · 작업오더 없음 = 400', async () => {
    const db = { query: async () => ({ rows: [] }) };
    assert.strictEqual((await svc.setReconcileSkip({ workOrderId: 'wo_1', skip: true, db })).status, 409);
    assert.strictEqual((await svc.setReconcileSkip({ workOrderId: '', skip: true, db })).status, 400);
  });
  await t('③ 목록 표시 — 칸이 없는 옛 DB 행은 「정하지 않음」', async () => {
    assert.deepStrictEqual(svc._skipInfo({ id: 'x' }), { skipped: false });
    assert.strictEqual(svc._skipInfo({ bidir_reconcile_skip_at: new Date() }).skipped, true);
  });

  await t('④ 배선 — 관리자 이상만 시작 · 세션 끊김·로그아웃 둘 다에서 멈춤 · 스크립트 로드', async () => {
    const wd = RF('frontend/workdesk.html'), js = RF('frontend/js/reconcile-prompt.js');
    assert.match(js, /if \(!\(opts\.role === 'admin' \|\| opts\.role === 'master'\)\) return;/);
    assert.match(wd, /const _rp=\{ api, name: STATE\.name, role: STATE\.role \};/);
    assert.strictEqual((wd.match(/window\.__RCASK_PENDING=null; if\(window\.ReconcilePrompt\) window\.ReconcilePrompt\.stop\(\);/g) || []).length, 2);
    assert.match(wd, /<script src="js\/reconcile-prompt\.js\?v=\d{8}/);
  });
  await t('④ 서버 — 따로 두기 라우트는 adminOrMaster · 칸은 REQUIRED_SCHEMA · 마이그레이션은 칸 더하기만', async () => {
    const rt = RF('server/src/routes/trackB.routes.js');
    assert.match(rt, /router\.post\('\/bidir\/reconcile\/:woId\/skip', authMiddleware, adminOrMasterMiddleware,/);
    assert.match(RF('server/index.js'), /\['work_orders', 'bidir_reconcile_skip_at'\]/);
    const mig = RF('server/migrations/200_work_order_reconcile_skip.sql').split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    assert.ok(!/\b(UPDATE|DELETE|DROP|TRIGGER)\b/i.test(mig), '가산 전용이어야 한다');
    assert.strictEqual((mig.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 2);
  });
  await t('④ 맞추기 화면 — 따로 둠 표시 · 다시 묻기(구버전 서버면 버튼 없음)', async () => {
    const wd = RF('frontend/workdesk.html');
    assert.match(wd, /if\(it\.skipped===undefined\) return '';/);
    assert.match(wd, /따로 둠\(담당자 팝업이 묻지 않음\)/);
  });

  console.log(`\n결과: ${pass} 통과 · ${fail} 실패`);
  if (fail) process.exit(1);
})();
