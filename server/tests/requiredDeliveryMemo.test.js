/**
 * 결정 260 — 공고별 필수 배송메세지(예: "배송메세지 00 넣어서 구매"). 캡처 배송메세지에 그 글자가 없으면 구매양식을 받지 않고,
 * 같은 주문번호로 두 번째부터 막힌 리뷰어는 「직원 확인 요청」으로 제출 → 작업보드 🚩(직원이 보고 반려).
 *   A. 순수 — 들어 있으면 통과(띄어쓰기·대소문자·숫자만이면 영문 O 허용), 판정 4갈래, 문구
 *   B. 스텁 pool — 공고 찾기(검증된 홀드 → campaign:<id> 범위 → 작업표 연결) · 조회 실패 = null(막지 않음)
 *   C. 배선 — 제출 게이트 위치(쓰기 전 · orderData.deliveryMemo 단일 출처) · 원장 $22 · 스키마 · 공고 저장 · 화면 3곳
 *   D. 화면 실행(vm) — 막힌 횟수 세기 · 작업보드 미리보기 🚩
 *   E. PGTEST_URL(전체 마이그레이션 DB) 있으면 진짜 PG + 실제 라우트: 막힘/통과/직원 확인 요청/필수 없음 → 원장 값 → 작업보드(내부만 🚩)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const rdm = require('../src/services/requiredDeliveryMemo.service');

// ── A. 순수 ──
{
  assert.equal(rdm.normalizeRequired('  0  0 '), '0 0');
  assert.equal(rdm.normalizeRequired(null), '');
  assert.equal(rdm.normalizeRequired('가'.repeat(50)).length, rdm.REQUIRED_MAX);
  const ok = (memo, req) => rdm.memoSatisfies(memo, req);
  assert.ok(ok('00', '00') && ok('00 부재시 문앞', '00') && ok('기타사항 (00)', '00'), 'contains = pass (사용자 확정 가)');
  assert.ok(ok('0 0', '00'), 'spaces ignored');
  assert.ok(ok('OO', '00') && ok('oo 문앞', '00'), 'digits-only required: AI 가 영문 O 로 읽은 것도 0');
  assert.ok(ok('００', '00'), 'full-width digits (NFKC)');
  assert.ok(!ok('문 앞', '00') && !ok('', '00') && !ok('0', '00'), 'missing → fail');
  assert.ok(ok('ABC 부탁', 'abc') && !ok('OO', 'O0X'), 'letters: case-insensitive, O→0 only for digits-only required');
  assert.ok(ok('', '') && ok('아무거나', '  '), 'no required → always pass');
  // 2026-10-30 — 문장부호·기호 무시(운영: 「문앞에 놓아주세요!」 공고에서 느낌표만 빠진 5건이 직원 확인으로)
  assert.ok(ok('문 앞에 놓아주세요', '문앞에 놓아주세요!') && ok('문앞에 놓아주세요.', '문앞에 놓아주세요!') && ok('문앞에~놓아주세요!!', '문앞에 놓아주세요!'), 'punctuation ignored');
  assert.ok(!ok('문앞에 보관해주세요!', '문앞에 놓아주세요!'), 'different words still fail');
  assert.ok(ok('(00)', '00') && ok('0-0', '00') && ok('OO!', '00'), 'digits: symbols between/around ignored, O→0 kept');
  assert.ok(ok('부재시 ♥♥', '♥♥') && !ok('부재시', '♥♥'), 'symbol-only required: compared as-is, never pass-all');
  // Codex P2 2건 — ○ 로 읽힌 0 · 꾸밈 문자가 붙은 이모지
  assert.ok(ok('○○', '00') && ok('0○', '00') && ok('〇〇 부재시', '00'), 'circle zeros converted before symbols are stripped');
  assert.ok(ok('부재시 ❤️', '❤️') && !ok('☀️', '❤️') && !ok('부재시', '❤️'), 'emoji-only required: variation selector does not make it pass-all');

  assert.deepEqual(rdm.decide({ required: '', memo: '' }), { action: 'none' });
  assert.equal(rdm.decide({ required: '00', memo: '00' }).action, 'ok');
  // 결정 300 — 직원 확인 요청은 두 번째 사진을 서버가 받은 경우(secondCaptureProven)만. 플래그만으로는 막힌다.
  const sNo = rdm.decide({ required: '00', memo: '문 앞', staffReviewRequested: true });
  assert.equal(sNo.action, 'block', 'staff flag alone (no 2nd photo) → still blocked');
  assert.equal(sNo.needSecondCapture, true);
  assert.equal(rdm.decide({ required: '00', memo: '문 앞', staffReviewRequested: true, secondCaptureProven: 'true' }).action, 'block', 'only boolean true counts');
  assert.equal(rdm.decide({ required: '00', memo: '문 앞', staffReviewRequested: true, secondCaptureProven: true }).action, 'staff_review');
  const s2 = rdm.decide({ required: '00', memo: '', secondCaptureProven: true });
  assert.equal(s2.action, 'block'); assert.equal(s2.needSecondCapture, false); assert.ok(/두 번째 사진에서도/.test(s2.error), '2nd photo present → different guidance');
  const b1 = rdm.decide({ required: '00', memo: '' });
  assert.equal(b1.action, 'block');
  assert.ok(/「00」/.test(b1.error) && /보이지 않아요/.test(b1.error) && /두 번째 사진으로 추가/.test(b1.error) && b1.needSecondCapture === true, 'no memo message asks for a 2nd photo');
  const b2 = rdm.decide({ required: '00', memo: '문 앞' });
  assert.ok(/「문 앞」/.test(b2.error) && b2.readMemo === '문 앞', 'read memo echoed to reviewer');
  assert.equal(rdm.decide({ required: '00', memo: '00', staffReviewRequested: true }).action, 'ok', 'satisfied wins over staff flag');
}

// ── B. 스텁 pool ──
async function stubs() {
  const calls = [];
  let mode = 'ok';
  rdm.__setPoolForTest({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (mode === 'throw') throw new Error('boom');
      if (/WHERE id = \$1/.test(sql)) return { rows: params[0] === 'camp_a' ? [{ required_delivery_memo: ' 00 ' }] : [] };
      return { rows: params[0] === 'sheet-1' ? [{ required_delivery_memo: '77' }] : [] };
    },
  });
  assert.equal(await rdm.requiredForSubmission({ holdCtx: { verified: true, campaignId: 'camp_a' }, sheetId: 'campaign:camp_a', tabName: 'campaign:camp_a' }), '00', 'verified hold');
  assert.equal(await rdm.requiredForSubmission({ holdCtx: null, sheetId: 'campaign:camp_a', tabName: 'campaign:camp_a' }), '00', 'sheetless scope without hold');
  assert.equal(await rdm.requiredForSubmission({ holdCtx: { verified: false, campaignId: 'camp_x' }, sheetId: 'campaign:camp_a', tabName: 'campaign:camp_a' }), '00', 'unverified hold ignored → scope');
  assert.equal(await rdm.requiredForSubmission({ sheetId: 'campaign:none', tabName: 'campaign:none' }), '', 'unknown campaign → no check');
  assert.equal(await rdm.requiredForSubmission({ sheetId: 'sheet-1', tabName: '탭' }), '77', 'linked worktable');
  assert.ok(/required_delivery_memo <> ''/.test(calls[calls.length - 1].sql) && /ORDER BY rc\.created_at DESC/.test(calls[calls.length - 1].sql), 'linked: newest non-empty');
  assert.equal(await rdm.requiredForSubmission({ sheetId: '', tabName: '' }), '', 'no scope → no check');
  mode = 'throw';
  assert.equal(await rdm.requiredForSubmission({ sheetId: 'campaign:camp_a', tabName: 'campaign:camp_a' }), null, 'lookup failure = null (unknown)');
  assert.deepEqual(rdm.decide({ required: null, memo: '' }), { action: 'none' }, 'unknown → fail-open (not blocked)');
  rdm.__setPoolForTest(null);
}

// ── C. 배선 ──
{
  const sr = read('server/src/routes/submit.routes.js');
  const at = sr.indexOf("const rdm = require('../services/requiredDeliveryMemo.service')");
  assert.ok(at > 0, 'gate wired');
  const odAt = sr.indexOf('deliveryMemo: reviewerOrderIdentity.readDeliveryMemoProof(b.deliveryMemoToken, orderNum)');
  assert.ok(odAt > 0 && odAt < at, 'gate after orderData (judges the value that will be saved)');
  for (const w of ['resolveQueuedWorkboardTarget', 'createOrderLedgerEntry(']) {
    const wAt = sr.indexOf(w, odAt);
    assert.ok(wAt > at, `gate before any write (${w})`);
  }
  const gate = sr.slice(at, sr.indexOf('\n    }\n', at));
  assert.ok(/memo: orderData\.deliveryMemo/.test(gate), 'single source = orderData.deliveryMemo');
  assert.ok(/requiredForSubmission\(\{ holdCtx, sheetId: orderScope\.sheetId, tabName: orderScope\.tabName \}\)/.test(gate));
  assert.ok(/b\.deliveryMemoStaffReview === true \|\| b\.deliveryMemoStaffReview === 'true'/.test(gate));
  assert.ok(/code: 'DELIVERY_MEMO_REQUIRED'/.test(gate) && /return res\.json\(/.test(gate), 'block returns before writing');
  assert.ok(/orderData\.deliveryMemoCheck = 'ok'/.test(gate) && /orderData\.deliveryMemoCheck = 'staff_review'/.test(gate));
  assert.ok(!/b\.deliveryMemo[^TS]/.test(gate), 'no plaintext memo from the request');

  const ol = read('server/src/services/orderLedger.service.js');
  const m = ol.match(/const ORDER_INSERT_SQL = `INSERT INTO order_submissions\s*\(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)\s*RETURNING id`/);
  const cols = m[1].split(',').map(s => s.trim()); const vals = m[2].split(',').map(s => s.trim());
  assert.equal(cols.length, vals.length);
  assert.equal(vals[cols.indexOf('delivery_memo_check')], '$22');
  assert.ok(/orderData\.deliveryMemo \|\| '',\n[^\n]*\n\s*orderData\.deliveryMemoCheck \|\| '',\n  \];/.test(ol), '$22 param is deliveryMemoCheck (after deliveryMemo)');

  const mig = read('server/migrations/192_required_delivery_memo.sql');
  assert.ok(/ALTER TABLE recruit_campaigns ADD COLUMN IF NOT EXISTS required_delivery_memo TEXT NOT NULL DEFAULT ''/.test(mig));
  assert.ok(/ALTER TABLE order_submissions ADD COLUMN IF NOT EXISTS delivery_memo_check TEXT NOT NULL DEFAULT ''/.test(mig));
  const idx = read('server/index.js');
  assert.ok(/\['order_submissions', 'delivery_memo_check'\]/.test(idx) && /\['recruit_campaigns', 'required_delivery_memo'\]/.test(idx), 'schema preflight');

  const cr = read('server/src/routes/campaign.routes.js');
  assert.equal((cr.match(/await _saveRequiredDeliveryMemo\(/g) || []).length, 2, 'create + update both save');
  assert.ok(/await _saveRequiredDeliveryMemo\(rows\[0\]\.id, required_delivery_memo, rows\[0\]\)/.test(cr) && /await _saveRequiredDeliveryMemo\(id, _rdmStore, rows\[0\]\)/.test(cr))
  // 결정 287: 연결 공고(_bx)는 공유 저장 트랜잭션(projectToCampaignInTx)만 이 칸을 쓴다 — 트랜잭션 밖 재기록 금지(Codex P2, PR #1687)
  assert.ok(/const _rdmStore = _bx \? undefined : required_delivery_memo;/.test(cr), 'linked campaign: no post-transaction memo write');
  assert.ok(!/SELECT required_delivery_memo FROM work_orders/.test(cr), 'no out-of-transaction order memo read-back');
  assert.equal((cr.match(/required_delivery_memo, \/\/ ★ 결정 260/g) || []).length, 2, 'destructured in create + update');
  assert.equal((cr.match(/\.\.\.\(requiredMemoWarning \? \{ requiredMemoWarning \} : \{\}\)/g) || []).length, 2, 'save failure surfaced in both responses');
  assert.ok(/if \(value === undefined \|\| value === null\) return null;/.test(cr), 'undefined = keep (screens without the field)');

  const modal = read('frontend/js/recruit-modal.js');
  assert.ok(/<input id="rf_required_delivery_memo" maxlength="30"/.test(modal), 'editor field');
  const ir = read('frontend/js/index-recruit.js');
  assert.ok(/\.\.\.\(document\.getElementById\("rf_required_delivery_memo"\)\s*\? \{ required_delivery_memo: document\.getElementById\("rf_required_delivery_memo"\)\.value\.trim\(\) \} : \{\}\)/.test(ir), 'payload only when the field exists');
  assert.ok(/_rdmEl\.value = c\.required_delivery_memo \|\| ""/.test(ir) && /_rdmEl\.value = ""/.test(ir), 'prefill + reset');
  assert.ok(/saved\.requiredMemoWarning/.test(ir), 'save warning shown');
  // 옛 관리자 대시보드(admin.html · index-app.js)는 결정 267 로 폐기 — 공고 창은 작업보드에만 있다.
  {
    const h = read('frontend/workdesk.html');
    assert.ok(/recruit-modal\.js\?v=20261024-reqmemo/.test(h) && /index-recruit\.js\?v=20261024-reqmemo/.test(h), 'workdesk cache-bust');
  }

  const sa = read('frontend/js/search-app.js');
  const hAt = sa.indexOf('res.code === "DELIVERY_MEMO_REQUIRED"');
  assert.ok(hAt > 0 && hAt < sa.indexOf('res.code === "IDENTITY_APPROVAL_STALE"', hAt) && hAt > sa.indexOf('res.code === "NEED_SUB_REGISTER"'),
    'reviewer form: handled after identity retries (their resubmit may come back blocked) and before generic failure');
  const h = sa.slice(hAt, sa.indexOf('res.code === "IDENTITY_APPROVAL_STALE"', hAt));
  assert.ok(/if \(n >= 2 && has2\) \{\s*staff = confirm\(/.test(h) && /payload\.deliveryMemoStaffReview = "true";/.test(h), 'staff review only from the 2nd block, with a 2nd photo, after confirm');
  assert.ok(/const has2 = !!o\.capture2Token && res\.needSecondCapture !== true;/.test(h) && /if \(!has2\) _rdmNeedImg2\(o\.cid\);/.test(h), '결정 300 — no 2nd photo → show the add-photo button');
  assert.ok(/results\.push\(\{[^}]*ok: false/.test(h) && /continue;/.test(h), 'declined → this order marked failed, not silently dropped');

  const tb = read('server/src/services/trackB.service.js');
  assert.ok(/NULL::text AS "deliveryMemoCheck"/.test(tb) && /purpose_order\.delivery_memo_check AS "deliveryMemoCheck"/.test(tb), 'both roster queries');
  assert.ok(/if \(showEdits && r\.deliveryMemoCheck === 'staff_review'\) syn\.deliveryMemoCheck = 'staff_review';/.test(tb), 'internal only');
  const wd = read('frontend/workdesk.html');
  assert.ok(/\$\{ruleMark\}\$\{memoMark\}\$\{esc\(r\.name\|\|'—'\)\}/.test(wd), 'grid 🚩 before the name');
  assert.ok(/\$\{r\.deliveryMemoCheck==='staff_review'\?' <span class="src"[^>]*>🚩 배송메세지 확인 필요<\/span>':''\}/.test(wd), 'view table badge (edit off)');
}

// ── D. 화면 실행 ──
{
  const sa = read('frontend/js/search-app.js');
  const s = sa.indexOf('const _RDM_MEM = {};');
  const e = sa.indexOf('\n}\n', sa.indexOf('function _rdmBump', s)) + 3;
  const store = {};
  const ctx = { sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
  vm.createContext(ctx);
  vm.runInContext(sa.slice(s, e) + '; this._rdmBump = _rdmBump;', ctx);
  assert.equal(ctx._rdmBump('campaign:c1', '2026-1019-001'), 1);
  assert.equal(ctx._rdmBump('campaign:c1', '20261019001'), 2, 'same order number (punctuation ignored) → 2nd');
  assert.equal(ctx._rdmBump('campaign:c1', '999'), 1, 'other order counts separately');
  const ctx2 = { sessionStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } };
  vm.createContext(ctx2);
  vm.runInContext(sa.slice(s, e) + '; this._rdmBump = _rdmBump;', ctx2);
  assert.equal(ctx2._rdmBump('t', '1'), 1); assert.equal(ctx2._rdmBump('t', '1'), 2, 'storage blocked → memory still counts');

  const wd = read('frontend/workdesk.html');
  const start = wd.indexOf('function _rvRender2(pane){');
  const fnSrc = wd.slice(start, wd.indexOf('\n}\n', start) + 3);
  const outs = [];
  const c = {
    STATE: { rvImgs: {}, rvSel: 'r1', wd: { roster: [] } },
    _rvReceiptActive: () => false, _rvStatHtml: () => '', _rvNoHtml: () => '', _rvWho: (r) => r.name,
    _rvFill: (p, h) => outs.push(h), _rvKindFiles: () => [], _rvUrl: () => '', _thumbAttrs: () => '',
    _isInternalRole: () => true, _rvReceiptApplies: () => false, esc: (x) => String(x),
  };
  vm.createContext(c); vm.runInContext(fnSrc, c);
  c.STATE.wd.roster = [{ id: 'r1', seq: 1, name: '가짜', deliveryMemoCheck: 'staff_review' }];
  c._rvRender2({});
  assert.ok(/🚩 확인 필요/.test(outs[0]) && /주문 취소/.test(outs[0]), 'preview flag line');
  c.STATE.wd.roster = [{ id: 'r1', seq: 1, name: '가짜', deliveryMemoCheck: 'ok', deliveryMemo: '00' }];
  c._rvRender2({});
  assert.ok(!/🚩/.test(outs[1]), 'ok → no flag');
}

async function pg() {
  process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const tb = require('../src/services/trackB.service');
  const roi = require('../src/services/reviewerOrderIdentity.service');
  const cid = 'camp_rdm_' + Date.now();
  const scope = 'campaign:' + cid;
  const srv = app.listen(0);
  try {
    await pool.query(`INSERT INTO recruit_campaigns (id, title, required_delivery_memo) VALUES ($1, '가짜 00 공고', '00')`, [cid]);
    const port = srv.address().port;
    const post = async (body) => (await fetch(`http://127.0.0.1:${port}/api/submit/order`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const base = { sheetId: scope, tabName: scope, orderer: '가짜', recipient: '가짜', phone: '010-0000-0000', address: '가짜주소', price: '1000' };
    const r1 = await post({ ...base, orderNum: 'T1' });
    assert.equal(r1.code, 'DELIVERY_MEMO_REQUIRED', 'no memo → blocked');
    const r2 = await post({ ...base, orderNum: 'T1', deliveryMemoToken: roi.issueDeliveryMemoProof('문 앞', 'T1') });
    assert.equal(r2.code, 'DELIVERY_MEMO_REQUIRED'); assert.equal(r2.readMemo, '문 앞');
    const r3 = await post({ ...base, orderNum: 'T2', deliveryMemoToken: roi.issueDeliveryMemoProof('문 앞', 'T1') });
    assert.equal(r3.code, 'DELIVERY_MEMO_REQUIRED', "another order's memo token does not count");
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM order_submissions WHERE tab_name=$1`, [scope])).rows[0].n, 0, 'blocked = nothing written');
    const r4 = await post({ ...base, orderNum: 'T3', deliveryMemoToken: roi.issueDeliveryMemoProof('OO 부재시 문앞', 'T3') });
    assert.equal(r4.ok, true, '00 present → accepted');
    // 결정 300 — 두 번째 사진 서명 없이 직원 확인 요청 → 막힘(쓰기 0) · 다른 주문의 서명도 막힘 · 이 주문의 서명 → 접수
    const r5a = await post({ ...base, orderNum: 'T4', deliveryMemoToken: roi.issueDeliveryMemoProof('문 앞', 'T4'), deliveryMemoStaffReview: 'true' });
    assert.equal(r5a.code, 'DELIVERY_MEMO_REQUIRED', 'staff flag without 2nd photo → blocked'); assert.equal(r5a.needSecondCapture, true);
    const r5b = await post({ ...base, orderNum: 'T4', deliveryMemoStaffReview: 'true', capture2Token: roi.issueSecondCaptureProof('T1', 'h') });
    assert.equal(r5b.code, 'DELIVERY_MEMO_REQUIRED', "another order's 2nd-photo proof does not count");
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM order_submissions WHERE tab_name=$1 AND order_num='T4'`, [scope])).rows[0].n, 0, 'blocked staff request = nothing written');
    const r5 = await post({ ...base, orderNum: 'T4', deliveryMemoToken: roi.issueDeliveryMemoProof('문 앞', 'T4'), deliveryMemoStaffReview: 'true', capture2Token: roi.issueSecondCaptureProof('T4', 'h') });
    assert.equal(r5.ok, true, 'staff review request with 2nd photo → accepted');
    await pool.query(`UPDATE recruit_campaigns SET required_delivery_memo='' WHERE id=$1`, [cid]);
    const r6 = await post({ ...base, orderNum: 'T5' });
    assert.equal(r6.ok, true, 'no required → unchanged behaviour');
    const rows = (await pool.query(`SELECT id, order_num, delivery_memo_check FROM order_submissions WHERE tab_name=$1 ORDER BY order_num`, [scope])).rows;
    assert.deepEqual(rows.map(r => [r.order_num, r.delivery_memo_check]), [['T3', 'ok'], ['T4', 'staff_review'], ['T5', '']]);

    // 작업보드 — 내부만 🚩
    const sid = 'rdm-wd-' + Date.now(), tab = '필수메세지탭';
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name) VALUES ($1,$2,'1','가짜')`, [sid, tab]);
    const byNum = Object.fromEntries(rows.map(r => [r.order_num, r.id]));
    for (const [seq, num] of [[1, 'T3'], [2, 'T4']]) {
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, reviewer_name, order_submission_id, active) VALUES ($1,$2,$3,'가짜',$4,TRUE)`, [sid, tab, seq, byNum[num]]);
    }
    const flags = (res) => Object.fromEntries((res.roster || []).map(r => [r.seq, r.deliveryMemoCheck]));
    assert.deepEqual(flags(await tb.workdeskTab({ sheetId: sid, tabName: tab, role: 'master' })), { 1: undefined, 2: 'staff_review' }, 'internal sees 🚩 only on staff_review');
    assert.deepEqual(flags(await tb.workdeskTab({ sheetId: sid, tabName: tab, role: 'advertiser', advertiserId: 'rdm-adv', allowAllWorkdesk: true })), { 1: undefined, 2: undefined }, 'advertiser never sees it');
    await pool.query(`DELETE FROM campaign_participants WHERE sheet_id=$1`, [sid]);
    await pool.query(`DELETE FROM tab_configs WHERE sheet_id=$1`, [sid]);
    console.log('requiredDeliveryMemo: PG passed');
  } finally {
    srv.close();
    await pool.query(`DELETE FROM order_submissions WHERE tab_name=$1`, [scope]).catch(() => {});
    await pool.query(`DELETE FROM recruit_campaigns WHERE id=$1`, [cid]).catch(() => {});
    await pool.end().catch(() => {});
  }
}

(async () => {
  await stubs();
  if (process.env.PGTEST_URL) await pg();
  console.log('requiredDeliveryMemo: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
