'use strict';
/**
 * captureClassify.test.js — 결정 383: 옵션 없는 「택1」 공고의 캡처 분류(B안)
 * 실행: node tests/captureClassify.test.js
 *
 * A. 서비스(PGlite · 저장소 migrations 그대로) — 제출 순간 기입 · 빈 칸에만 · 직원 값 보존 · 보관/옵션 2개+/후보 없음 = 안 함 · 스위치
 * B. 실제 라우트 POST /api/submit/order + PGlite — 공고 참여 제출 뒤 「분류」 칸 · 응답 모양 불변 · 실패해도 접수
 * C. 지난 주문 버튼(결정 232 확장) — 미리보기 쓰기 0 · 적용은 빈 칸만 · 보관 공고 거절 · 같은 권한(adminOrMaster)
 * D. 작업보드 응답 classifyColumn · 공고 저장 배선 · 리뷰어 공개 뷰 미노출
 * E. 화면 배선(공고 창 입력 · 작업보드 머리글 메뉴) — 리뷰어 화면 무변경
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'classify-test-secret-' + Date.now();

const SERVER = path.join(__dirname, '..');
const ROOT = path.join(SERVER, '..');
let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

async function openDb() {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에 없는 확장(pg_trgm 등) — 이 시험의 표와 무관 */ }
  }
  return db;
}
function poolOf(db) {
  const query = async (sql, params) => {
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  // PGlite 는 연결이 하나라 트랜잭션이 섞인다 — connect() 를 한 번에 하나씩만 내줘(실제 PG 의 탭 단위 advisory 잠금처럼)
  //   두 세션이 동시에 「분류」 칸을 만들려 할 때 "잠금 뒤 다시 찾기"가 하나만 만들게 하는지 본다.
  let gate = Promise.resolve();
  const connect = async () => {
    let release; const mine = new Promise(r => { release = r; });
    const prev = gate; gate = prev.then(() => mine);
    await prev;
    return { query, release() { release(); } };
  };
  return { query, connect, on() {}, end: async () => {} };
}

const SHEET = 'wt_classify', TAB = '11/19 세라모사이드', CAMP = 'camp_classify', CAMP_OLD = 'camp_classify_old';
const CANDS = '피치, 레몬, 스트로베리';
const CAP = { name: '[먹바속촉] 세라모사이드 피치맛/레몬맛/스트로베리맛 28정 (14일분)', peach: '옵션: 세라모사이드 피치맛 28정 (2주분)', lemon: '옵션: 세라모사이드 레몬맛 28정 (2주분)' };

(async () => {
  const pg = await openDb();
  const pool = poolOf(pg);
  // 모든 실제 모듈이 PGlite 를 보게 한다(운영 DB 연결 0).
  const poolPath = require.resolve(path.join(SERVER, 'src/db/pool'));
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);
  const svc = require(path.join(SERVER, 'src/services/captureClassify.service'));

  async function seed({ candidates = CANDS, archived = false, options = [] } = {}) {
    for (const t of ['trackb_custom_column_values', 'trackb_custom_columns', 'campaign_applications', 'campaign_participants',
      'order_submissions', 'campaign_options', 'recruit_campaigns', 'tab_configs']) await q(`DELETE FROM ${t}`);
    await q(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless) VALUES ($1, $2, true)`, [SHEET, TAB]);
    await q(`INSERT INTO recruit_campaigns (id, title, participation_mode, status, recruit_total, daily_limit, start_date, linked_sheet_id, linked_tab_name, channel, classify_candidates, archived_at)
             VALUES ($1, '11/19 오전7시 세라모사이드 이너뷰티캔디', true, 'active', 400, 400, '2026-11-01', $2, $3, '올리브영', $4, $5)`,
      [CAMP, SHEET, TAB, candidates, archived ? new Date() : null]);
    for (const [i, o] of options.entries()) await q(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, status, sort_order) VALUES ($1,$2,$2,'active',$3)`, [CAMP, o, i]);
  }
  let rowSeq = 1;
  async function order({ withRow = true, capture = 'file-1', viaCampaign = true } = {}) {
    const os = (await q(`INSERT INTO order_submissions (sheet_id, tab_name, source, capture_file_id, submitted_at) VALUES ($1,$2,'order_submit',$3, now()) RETURNING id`,
      [viaCampaign ? 'campaign:' + CAMP : SHEET, viaCampaign ? 'campaign:' + CAMP : TAB, capture])).rows[0].id;
    if (withRow) {
      const seq = ++rowSeq;
      await q(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, order_submission_id, reviewer_name, active) VALUES ($1,$2,$3,'{}'::jsonb,$4,'가짜리뷰어',true)`, [SHEET, TAB, seq, os]);
    }
    return String(os);
  }
  const valueOf = async (os) => {
    const { rows } = await q(`SELECT v.value_text, v.updated_by FROM trackb_custom_column_values v JOIN trackb_custom_columns c ON c.id = v.column_id
                               WHERE c.sheet_id=$1 AND c.tab_name=$2 AND c.col_name='분류' AND v.anchor_type='order' AND v.anchor_value=$3`, [SHEET, TAB, os]);
    return rows[0] || null;
  };
  const cols = async () => (await q(`SELECT id, col_name FROM trackb_custom_columns WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`, [SHEET, TAB])).rows;

  // ── A. 서비스 ─────────────────────────────────────────────────────────
  await ok('A1 제출 순간: 옵션 글자 `피치맛` → 작업표 「분류」 칸(추가 열)을 만들고 「피치」 · 기록자 AI 캡처판독(제출 시)', async () => {
    await seed();
    const os = await order();
    const r = await svc.classifyFromSubmitCapture({ orderSubmissionId: os, campaignId: CAMP, captureName: CAP.name, captureOption: CAP.peach });
    assert.deepEqual(r, { written: true, value: '피치' });
    assert.deepEqual((await cols()).map(c => c.col_name), ['분류']);
    const v = await valueOf(os);
    assert.equal(v.value_text, '피치'); assert(/AI 캡처판독\(제출 시\)/.test(v.updated_by));
  });
  await ok('A2 ★ 빈 칸에만(결정 018) — 직원이 고친 값·비워 둔 값은 덮지 않는다 · 칸은 하나만', async () => {
    await seed();
    const os = await order();
    const col = await svc.ensureClassifyColumn({ sheetId: SHEET, tabName: TAB });
    await q(`INSERT INTO trackb_custom_column_values (column_id, anchor_type, anchor_value, value_text, updated_by) VALUES ($1,'order',$2,'레몬','망고')`, [col.id, os]);
    const r = await svc.classifyFromSubmitCapture({ orderSubmissionId: os, campaignId: CAMP, captureName: CAP.name, captureOption: CAP.peach });
    assert.deepEqual(r, { written: false, skipped: 'already_filled' });
    assert.equal((await valueOf(os)).value_text, '레몬');
    const os2 = await order();
    await q(`INSERT INTO trackb_custom_column_values (column_id, anchor_type, anchor_value, value_text, updated_by) VALUES ($1,'order',$2,'','망고')`, [col.id, os2]);
    assert.equal((await svc.classifyFromSubmitCapture({ orderSubmissionId: os2, campaignId: CAMP, captureOption: CAP.peach })).skipped, 'already_filled', '비워 둔 값도 사람이 정한 값');
    assert.equal((await svc.ensureClassifyColumn({ sheetId: SHEET, tabName: TAB })).created, false);
    assert.equal((await cols()).length, 1);
  });
  await ok('A3 못 읽음·둘 이상 = 빈칸(미분류) — 칸도 값도 안 생김 · 상품명에 세 맛 + 옵션 없음 = 모름', async () => {
    await seed();
    const os = await order();
    for (const [n, o] of [[CAP.name, ''], ['', '옵션: 피치맛 / 레몬맛'], ['', '옵션: 28정']]) {
      const r = await svc.classifyFromSubmitCapture({ orderSubmissionId: os, campaignId: CAMP, captureName: n, captureOption: o });
      assert.deepEqual(r, { written: false, skipped: 'ambiguous' }, `${n} | ${o}`);
    }
    assert.equal((await cols()).length, 0);
    assert.deepEqual(await svc.classifyFromSubmitCapture({ orderSubmissionId: os, campaignId: CAMP }), { written: false, skipped: 'no_input' });
  });
  await ok('A4 기능 꺼짐 — 후보 비움(기존 동작 그대로) · 후보 하나 · 보관 공고 · 옵션 2개 이상 공고 · 스위치 0 · 연결 공고 없음', async () => {
    for (const [cfg, why] of [[{ candidates: '' }, 'no_candidates'], [{ candidates: '피치' }, 'no_candidates'], [{ archived: true }, 'archived'], [{ options: ['피치맛', '레몬맛'] }, 'multi_option']]) {
      await seed(cfg);
      const os = await order();
      const r = await svc.classifyFromSubmitCapture({ orderSubmissionId: os, campaignId: CAMP, captureOption: CAP.peach });
      assert.deepEqual(r, { written: false, skipped: why }, JSON.stringify(cfg));
      assert.equal((await cols()).length, 0, '칸을 만들지 않는다');
    }
    await seed({ options: ['세라모사이드 28정'] });
    assert.equal((await svc.classifyFromSubmitCapture({ orderSubmissionId: await order(), campaignId: CAMP, captureOption: CAP.lemon })).value, '레몬', '옵션 1개 공고는 대상');
    await seed();
    process.env.CAPTURE_CLASSIFY_ON_SUBMIT = '0';
    assert.equal((await svc.classifyFromSubmitCapture({ orderSubmissionId: await order(), campaignId: CAMP, captureOption: CAP.peach })).skipped, 'disabled');
    delete process.env.CAPTURE_CLASSIFY_ON_SUBMIT;
    assert.equal((await svc.classifyFromSubmitCapture({ orderSubmissionId: await order(), sheetId: 'other', tabName: 'x', captureOption: CAP.peach })).skipped, 'no_campaign');
  });
  await ok('A5 공고 참여 없이 낸 구매양식(작업표 좌표) — 그 작업표에 연결된 후보 있는 공고 하나로 분류 · 작업표 줄이 아직 없어도 주문 앵커에 적어 둔다', async () => {
    await seed();
    const os = await order({ withRow: false, viaCampaign: false });
    const r = await svc.classifyFromSubmitCapture({ orderSubmissionId: os, sheetId: SHEET, tabName: TAB, captureOption: CAP.lemon });
    assert.deepEqual(r, { written: true, value: '레몬' });
  });
  await ok('A6 동시에 두 제출이 와도 「분류」 칸은 하나(탭 단위 잠금 뒤 다시 찾기)', async () => {
    await seed();
    const [a, b] = await Promise.all([order(), order()]);
    await Promise.all([
      svc.classifyFromSubmitCapture({ orderSubmissionId: a, campaignId: CAMP, captureOption: CAP.peach }),
      svc.classifyFromSubmitCapture({ orderSubmissionId: b, campaignId: CAMP, captureOption: CAP.lemon }),
    ]);
    assert.equal((await cols()).length, 1);
    assert.equal((await valueOf(a)).value_text, '피치'); assert.equal((await valueOf(b)).value_text, '레몬');
  });

  // ── B. 실제 제출 라우트 ───────────────────────────────────────────────
  const identity = require(path.join(SERVER, 'src/services/reviewerOrderIdentity.service'));
  const sheetless = require(path.join(SERVER, 'src/services/sheetlessOrder.service'));
  const queueApply = require(path.join(SERVER, 'src/services/workboardQueueApply.service'));
  const restores = [];
  const patch = (o, k, v) => { const old = o[k]; o[k] = v; restores.push(() => { o[k] = old; }); };
  patch(identity, 'isEnabled', () => false);   // 명의 확인 게이트는 이 기능과 무관 — 종전(레거시) 제출 길로 태운다
  patch(sheetless, 'writeOrderToWorktable', async () => ({ ok: true, written: true }));
  patch(queueApply, 'resolveQueuedWorkboardTarget', async () => ({ enabled: false }));
  const express = require('express');
  const router = require(path.join(SERVER, 'src/routes/submit.routes'));
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/submit', router);
  app.use((err, req, res, next) => res.status(500).json({ error: '서버 오류', message: err && err.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/submit';
  let appSeq = 100;
  async function hold() {
    const id = ++appSeq, token = 'hold-' + id;
    await q(`INSERT INTO campaign_applications (id, campaign_id, applicant_name, applicant_phone, phone8, status, applied_at, expires_at, hold_token)
             VALUES ($1,$2,'가짜리뷰어','01012345678','12345678','applied', now(), now() + interval '1 hour', $3)`, [id, CAMP, token]);
    return { campaignId: CAMP, campaignApplicationId: String(id), holdToken: token };
  }
  const submit = async (h, extra = {}) => {
    const body = { ...h, orderer: '가짜리뷰어', recipient: '가짜리뷰어', userId: 'fake-id', phone: '01012345678', address: '서울 가짜로 1',
      bank: '가짜은행', account: '000-0000', depositor: '가짜리뷰어', price: '12400', orderNum: 'Y' + Date.now() + Math.random().toString(36).slice(2, 6),
      dateStr: '2026-11-19', productCaptureName: CAP.name, ...extra };
    const r = await fetch(base + '/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const settle = () => new Promise(r => setTimeout(r, 400));   // 응답 뒤(setImmediate) 처리가 끝나기를 기다린다
  const osOf = async (h) => String((await q(`SELECT order_submission_id FROM campaign_applications WHERE id=$1`, [Number(h.campaignApplicationId)])).rows[0].order_submission_id || '');
  try {
    await ok('B1 ★ 실제 라우트: 옵션 없는 공고 참여 제출 → 접수 200 · 응답 뒤 「분류」 칸에 「피치」(AI 호출 0)', async () => {
      await seed();
      const h = await hold();
      const r = await submit(h, { productCaptureOption: CAP.peach });
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true, JSON.stringify(r.body));
      await settle();
      const os = await osOf(h);
      assert(os, '주문이 공고 참여에 묶였다');
      assert.equal((await valueOf(os)).value_text, '피치');
    });
    await ok('B2 ★ 응답 모양 불변 — 후보 없음(기능 꺼짐)과 후보 있음의 응답 칸이 같다 · 꺼짐이면 칸·값 0', async () => {
      await seed({ candidates: '' });
      const off = await submit(await hold(), { productCaptureOption: CAP.lemon });
      await settle();
      assert.equal(off.body.ok, true);
      assert.equal((await cols()).length, 0);
      await seed();
      const on = await submit(await hold(), { productCaptureOption: CAP.lemon });
      await settle();
      assert.deepEqual(Object.keys(on.body).sort(), Object.keys(off.body).sort());
      assert.equal((await cols()).length, 1);
    });
    await ok('B3 못 읽은 제출(두 맛)은 미분류로 접수 · 분류가 터져도 접수는 그대로(fail-open)', async () => {
      await seed();
      const h = await hold();
      const r = await submit(h, { productCaptureOption: '옵션: 피치맛 / 레몬맛' });
      await settle();
      assert.equal(r.body.ok, true);
      assert.equal(await valueOf(await osOf(h)), null);
      const real = svc.classifyFromSubmitCapture;
      svc.classifyFromSubmitCapture = async () => { throw new Error('일부러 터뜨림'); };
      try {
        const r2 = await submit(await hold(), { productCaptureOption: CAP.peach });
        await settle();
        assert.equal(r2.status, 200); assert.equal(r2.body.ok, true);
      } finally { svc.classifyFromSubmitCapture = real; }
    });
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise(r => server.close(r));
    restores.reverse().forEach(f => f());
  }

  // ── C. 지난 주문 버튼(결정 232 확장) ──────────────────────────────────
  const fill = require(path.join(SERVER, 'src/services/captureProductFill.service'));
  let aiCalls = 0;
  const READ = { f1: CAP.peach, f2: CAP.lemon, f3: '옵션: 피치맛 / 레몬맛' };
  fill.__setDepsForTest({
    download: async (id) => ({ buffer: Buffer.from('fake-' + id), mimeType: 'image/png', id }),
    extract: async (b64) => { aiCalls++; const id = Buffer.from(b64, 'base64').toString().slice(5); return { productName: CAP.name, productOption: READ[id] || '' }; },
    samples: async () => [],
  });
  await ok('C1 미리보기: 「분류」가 빈 주문만 · 주문당 AI 1회 · 확정/애매/캡처 없음 · 쓰기 0(칸도 안 만든다)', async () => {
    await seed();
    const a = await order({ capture: 'f1' }), b = await order({ capture: 'f2' }), c = await order({ capture: 'f3' }), d = await order({ capture: null });
    aiCalls = 0;
    const p = await svc.previewCaptureClassify({ campaignId: CAMP });
    assert.equal(p.target, 'classify'); assert.equal(p.total, 4); assert.equal(aiCalls, 3);
    const by = Object.fromEntries(p.items.map(i => [i.orderId, i]));
    assert.equal(by[a].status, 'matched'); assert.equal(by[a].optKey, '피치');
    assert.equal(by[b].optKey, '레몬'); assert.equal(by[c].status, 'ambiguous'); assert.equal(by[d].status, 'no_capture');
    assert.deepEqual(p.options.map(o => o.optKey), ['피치', '레몬', '스트로베리']);
    assert.equal((await cols()).length, 0, '미리보기는 쓰기 0');
  });
  await ok('C2 적용: 사람이 본 값 그대로(AI 재실행 0) · 빈 칸만 · 후보 밖 값·이미 적힌 주문 거절 · 기록자 구분', async () => {
    await seed();
    const a = await order({ capture: 'f1' }), b = await order({ capture: 'f3' }), c = await order({ capture: 'f2' });
    const col = await svc.ensureClassifyColumn({ sheetId: SHEET, tabName: TAB });
    await q(`INSERT INTO trackb_custom_column_values (column_id, anchor_type, anchor_value, value_text, updated_by) VALUES ($1,'order',$2,'스트로베리','망고')`, [col.id, c]);
    aiCalls = 0;
    const r = await svc.applyCaptureClassify({ campaignId: CAMP, by: '김수만', picks: [
      { orderId: a, optKey: '피치', source: 'capture' }, { orderId: b, optKey: '레몬', source: 'manual' },
      { orderId: c, optKey: '피치', source: 'capture' }, { orderId: a, optKey: '자몽', source: 'manual' }] });
    assert.equal(aiCalls, 0);
    assert.equal(r.written, 2);
    assert.equal((await valueOf(a)).value_text, '피치'); assert(/AI 캡처판독\(김수만\)/.test((await valueOf(a)).updated_by));
    assert.equal((await valueOf(b)).value_text, '레몬'); assert(/수동지정\(김수만\)/.test((await valueOf(b)).updated_by));
    assert.equal((await valueOf(c)).value_text, '스트로베리', '직원 값 보존');
    assert.deepEqual(r.results.filter(x => !x.ok).map(x => x.reason).sort(), ['not_target', 'unknown_candidate']);
    // 다시 미리보기 — 채운 주문은 대상에서 빠진다
    assert.equal((await svc.previewCaptureClassify({ campaignId: CAMP })).total, 0);
  });
  await ok('C2b ★ Codex 리뷰 #1843: 미리보기를 여러 묶음 읽고 200건 넘게 골라도 전부 적는다(조용히 잘라 버리지 않는다) · 너무 많으면 통째로 거절', async () => {
    await seed();
    const ids = [];
    for (let i = 0; i < 205; i++) ids.push(await order({ capture: 'fx' + i }));
    const r = await svc.applyCaptureClassify({ campaignId: CAMP, by: '김수만', picks: ids.map(id => ({ orderId: id, optKey: '피치', source: 'manual' })) });
    assert.equal(r.written, 205, '201번째 이후 선택도 적혀야 한다');
    assert.equal(r.results.length, 205);
    assert.equal((await valueOf(ids[204])).value_text, '피치');
    // 한 요청이 지나치게 크면 일부만 적지 않고 통째로 거절(쓰기 0) — 화면은 200건씩 나눠 보낸다
    const big = Array.from({ length: 1001 }, (_, i) => ({ orderId: 'x' + i, optKey: '피치' }));
    await assert.rejects(svc.applyCaptureClassify({ campaignId: CAMP, picks: big }), e => e.code === 'too_many');
  });
  await ok('C3 보관 공고·후보 없음·옵션 2개 이상 → 미리보기·적용 모두 거절(쓰기 0)', async () => {
    for (const [cfg, code] of [[{ archived: true }, 'archived'], [{ candidates: '' }, 'no_candidates'], [{ options: ['A', 'B'] }, 'multi_option']]) {
      await seed(cfg);
      const a = await order({ capture: 'f1' });
      await assert.rejects(svc.previewCaptureClassify({ campaignId: CAMP }), e => e.code === code);
      await assert.rejects(svc.applyCaptureClassify({ campaignId: CAMP, picks: [{ orderId: a, optKey: '피치' }] }), e => e.code === code);
      assert.equal((await cols()).length, 0);
    }
  });
  await ok('C4 라우트: 같은 창구 · 같은 권한(adminOrMaster) · target:\'classify\' 일 때만 분류 · 적용은 confirm:true', async () => {
    const src = fs.readFileSync(path.join(SERVER, 'src/routes/trackB.routes.js'), 'utf8');
    const i = src.indexOf("router.post('/campaigns/:id/capture-product-fill'");
    const blk = src.slice(i, src.indexOf('\n});', i));
    assert(/authMiddleware, adminOrMasterMiddleware/.test(blk.split('\n')[0]));
    assert(/b\.target === 'classify'/.test(blk));
    assert(/applyCaptureClassify\(/.test(blk) && /previewCaptureClassify\(/.test(blk));
    assert(/ClassifyError/.test(blk), '분류 거절 사유는 400 으로 말한다');
    const ia = blk.indexOf("b.mode === 'apply'"), ic = blk.indexOf('confirm_required');
    assert(ia > 0 && ic > ia);
  });

  // ── D. 작업보드 응답 · 공고 저장 ─────────────────────────────────────
  await ok('D1 작업보드 응답(내부만): classifyColumn = { campaignId, columnId, candidates } · 업체·보관 작업은 없음', async () => {
    await seed();
    const col = await svc.ensureClassifyColumn({ sheetId: SHEET, tabName: TAB });
    const info = await svc.classifyColumnForTab(pool, { sheetId: SHEET, tabName: TAB, customColumns: [{ id: col.id, colName: '분류' }] });
    assert.deepEqual(info, { campaignId: CAMP, columnId: col.id, column: '분류', candidates: ['피치', '레몬', '스트로베리'] });
    await seed({ candidates: '' });
    assert.equal(await svc.classifyColumnForTab(pool, { sheetId: SHEET, tabName: TAB, customColumns: [] }), null);
    const src = fs.readFileSync(path.join(SERVER, 'src/services/trackB.service.js'), 'utf8');
    const at = src.indexOf('classifyColumnForTab(');
    assert(at > 0);
    const before = src.slice(src.lastIndexOf('if (showEdits)', at), at);
    assert(/customCols/.test(before), 'showEdits(내부 · 보관 아님) 블록 안');
    assert(/res\.classifyColumn = classifyCol/.test(src));
  });
  await ok('D2 공고 저장: 생성·수정 둘 다 「분류 후보」를 따로 저장(undefined = 유지) · 연결 작업표에 칸 미리 보장 · 실패는 경고', async () => {
    const src = fs.readFileSync(path.join(SERVER, 'src/routes/campaign.routes.js'), 'utf8');
    assert(/async function _saveClassifyCandidates\(id, value, row\)/.test(src));
    const fn = src.slice(src.indexOf('async function _saveClassifyCandidates'), src.indexOf('// POST /api/campaign/admin/create'));
    assert(/value === undefined \|\| value === null\) return null/.test(fn));
    assert(/formatClassifyCandidates/.test(fn) && /UPDATE recruit_campaigns SET classify_candidates = \$2 WHERE id = \$1/.test(fn));
    assert(/ensureClassifyColumnForCampaign/.test(fn));
    assert.equal((src.match(/classifyWarning = await _saveClassifyCandidates\(/g) || []).length, 2, '생성·수정 두 곳');
    assert.equal((src.match(/classify_candidates, \/\/ ★ 결정 383/g) || []).length, 2, '두 라우트가 본문에서 꺼낸다');
    // 리뷰어 공개 뷰(화이트리스트)에 이 칸이 없다
    const pub = src.slice(src.indexOf('const PUBLIC_FIELDS'), src.indexOf('const PUBLIC_FIELDS') + 3000);
    assert(!/classify_candidates/.test(pub));
    assert(!/classify_candidates/.test(src.slice(src.indexOf('function _scopedEditorView'), src.indexOf('async function _scopedCampaignEdit'))));
  });
  await ok('D3 마이그레이션 225 · 부팅 필수 스키마 · PGlite 에서 칸이 생긴다(기본값 \'\' = 꺼짐)', async () => {
    assert(fs.existsSync(path.join(SERVER, 'migrations/225_campaign_classify_candidates.sql')));
    assert(/\['recruit_campaigns', 'classify_candidates'\]/.test(fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8')));
    await q(`INSERT INTO recruit_campaigns (id, title) VALUES ('camp_default_probe', 'x')`);
    assert.equal((await q(`SELECT classify_candidates FROM recruit_campaigns WHERE id='camp_default_probe'`)).rows[0].classify_candidates, '');
  });
  await ok('D4 제출 라우트 배선: 성공 응답 직전 예약 · setImmediate · .catch · 검증된 홀드 공고만 campaignId 로', async () => {
    const src = fs.readFileSync(path.join(SERVER, 'src/routes/submit.routes.js'), 'utf8');
    const i = src.indexOf('classifyFromSubmitCapture(_cls)');
    assert(i > 0);
    const blk = src.slice(src.lastIndexOf('결정 383', i), i + 300);
    assert(/holdCtx && holdCtx\.verified && holdCtx\.campaignId/.test(blk));
    assert(/setImmediate\(/.test(blk) && /\.catch\(/.test(blk));
    assert(i < src.indexOf('res.json({\n      ok: true,\n      dbSaved: true'));
  });

  // ── E. 화면 배선 ──────────────────────────────────────────────────────
  await ok('E1 공고 창: 「리뷰웹에서만 정하는 값」에 「분류 후보」 입력 하나 · 입력칸이 있을 때만 싣는다 · 불러오기·바뀐 항목·저장 안내', async () => {
    const modal = fs.readFileSync(path.join(ROOT, 'frontend/js/recruit-modal.js'), 'utf8');
    const pubStart = modal.indexOf('<h3>리뷰웹에서만 정하는 값</h3>');
    const at = modal.indexOf('id="rf_classify_candidates"');
    assert(pubStart > 0 && at > pubStart, '리뷰오더와 맞춰지는 칸이 아니라 리뷰웹 전용 칸');
    assert.equal((modal.match(/id="rf_classify_candidates"/g) || []).length, 1);
    assert(/<label class="form-label" for="rf_classify_candidates">분류 후보<\/label>/.test(modal));
    const ir = fs.readFileSync(path.join(ROOT, 'frontend/js/index-recruit.js'), 'utf8');
    assert(/\.\.\.\(document\.getElementById\("rf_classify_candidates"\)\s*\? \{ classify_candidates: document\.getElementById\("rf_classify_candidates"\)\.value\.trim\(\) \} : \{\}\)/.test(ir));
    assert(/_rfEl\.value = c\.classify_candidates \|\| ""/.test(ir), '수정 창을 열 때 저장값을 채운다');
    assert(/\["classify_candidates",\s*"분류 후보"\]/.test(ir));
    assert(/saved\.classifyWarning/.test(ir));
  });
  await ok('E2 작업보드: 「분류」 머리글 메뉴에 [📷 캡처로 분류 채우기](관리자·마스터만 = 서버와 1:1) · 빈 값은 (미분류) · 결정 232 표 재사용', async () => {
    const wd = fs.readFileSync(path.join(ROOT, 'frontend/workdesk.html'), 'utf8');
    const menu = wd.slice(wd.indexOf('function openGColMenu('), wd.indexOf('function closeGColMenu('));
    assert(/_isClassifyCol\(col\)/.test(menu));
    assert(/\(미분류\)/.test(menu));
    assert(/openCaptureClassify\(/.test(menu) && /📷 캡처로 분류 채우기/.test(menu));
    assert(/function _ccCanUse\(\)\{ return \(STATE\.role==='master'\|\|STATE\.role==='admin'\)/.test(wd));
    assert(/target:'classify'/.test(wd));
    assert(/function openCaptureClassify\(/.test(wd));
  });
  await ok('E3 리뷰어 화면 무변경 — search-app.js 는 결정 237 의 판독 글자 전송 그대로(새 칸·새 문구 0)', async () => {
    const sa = fs.readFileSync(path.join(ROOT, 'frontend/js/search-app.js'), 'utf8');
    assert(!/classify|분류 후보/.test(sa));
    assert(/productCaptureOption: o\.productCaptureOptRaw \|\| "",/.test(sa));
  });
  await ok('E4 작업보드 vm 실행: 「분류」 칸 판정 · 관리자만 버튼 · 미리보기/적용에 target:\'classify\' · 제목·문구 · 적용 뒤 표 새로고침(상품 찾기 길은 그대로)', async () => {
    const vm = require('vm');
    const html = fs.readFileSync(path.join(ROOT, 'frontend/workdesk.html'), 'utf8');
    const fn = (name) => { const m = new RegExp('(?:async )?function ' + name + '\\(').exec(html); assert(m, name);
      let i = html.indexOf('{', m.index), d = 0; for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}' && --d === 0) break; } return html.slice(m.index, i + 1); };
    const els = {}; const log = { api: [], toast: [], reload: 0 };
    const mk = (id) => ({ id, innerHTML: '', remove() { delete els[this.id]; } });
    const PREV = { ok: true, target: 'classify', total: 2, nextOffset: null, options: ['피치', '레몬', '스트로베리'].map(c => ({ optKey: c, productName: c })),
      items: [{ orderId: 'o1', seq: 2, day: '2026-11-19', status: 'matched', optKey: '피치', read: '옵션: 피치맛' }, { orderId: 'o2', seq: 3, day: '2026-11-19', status: 'ambiguous', read: '옵션: 피치맛 / 레몬맛' }] };
    const ctx = { STATE: { role: 'admin', wd: { classifyColumn: { campaignId: 'c1', columnId: 'u1', candidates: ['피치', '레몬', '스트로베리'] } } },
      esc: s => String(s == null ? '' : s).replace(/[<>&"']/g, ''),
      document: { getElementById: id => els[id] || null, createElement: () => mk('x'), body: { appendChild(e) { els[e.id] = e; } }, addEventListener() {}, removeEventListener() {} },
      api: async (u, o) => { const b = JSON.parse(o.body); log.api.push(b); return b.mode === 'preview' ? PREV : { ok: true, written: 2, results: [] }; },
      toast: m => log.toast.push(m), alert() {}, reloadWorkdesk: async () => { log.reload++; }, _wdQuotaAlert: async () => { throw new Error('분류에서는 부르지 않는다'); }, closeGColMenu() {} };
    vm.createContext(ctx);
    vm.runInContext(['_cfClose', '_cfShell', 'openCaptureFill', '_cfPick', '_cfRender', '_cfApply', '_isClassifyCol', '_ccCanUse', 'openCaptureClassify'].map(fn).join('\n') +
      '\nconst _CF_LABEL=' + html.match(/const _CF_LABEL=(\{[\s\S]*?\});/)[1] + ';', ctx);
    assert.equal(ctx._isClassifyCol('ccol:u1'), true); assert.equal(ctx._isClassifyCol('ccol:u2'), false); assert.equal(ctx._isClassifyCol('col:옵션'), false);
    assert.equal(ctx._ccCanUse(), true);
    ctx.STATE.role = 'staff'; assert.equal(ctx._ccCanUse(), false, 'AE 직원에게는 버튼 없음(서버 adminOrMaster)'); ctx.STATE.role = 'admin';
    await ctx.openCaptureClassify();
    assert.equal(log.api[0].target, 'classify'); assert.equal(log.api[0].mode, 'preview');
    const h = els.cfOv.innerHTML;
    assert(/📷 캡처로 분류 채우기/.test(h) && /「분류」가 빈 주문 <b>2건<\/b>/.test(h) && /<th>분류<\/th>/.test(h) && /1건 적용/.test(h));
    ctx._cfPick('o2', '레몬');
    await ctx._cfApply();
    const ap = log.api.find(b => b.mode === 'apply');
    assert.equal(ap.target, 'classify'); assert.equal(ap.confirm, true);
    assert.deepEqual(ap.picks, [{ orderId: 'o1', optKey: '피치', source: 'capture' }, { orderId: 'o2', optKey: '레몬', source: 'manual' }]);
    assert(/분류 2건을 채웠습니다/.test(log.toast[0])); assert.equal(log.reload, 1);
    // 상품 찾기(결정 237) 길은 target 없이 그대로
    log.api.length = 0;
    await ctx.openCaptureFill('c9', 0);
    assert.equal(log.api[0].target, undefined);
    assert(/📷 캡처로 상품 찾기/.test(els.cfOv.innerHTML));
  });

  await ok('E5 ★ Codex 리뷰 #1843: 공고 창을 새로 열면 「분류 후보」가 실제로 비워진다(vm 실행 — 후보 있는 공고 수정 → 닫기 → 새 공고)', async () => {
    const vm = require('vm');
    const ir = fs.readFileSync(path.join(ROOT, 'frontend/js/index-recruit.js'), 'utf8');
    const fnStart = ir.indexOf('async function openRecruitModal(');
    const a = ir.indexOf('/* ⚡ 참여형(M2) 필드 초기화 */', fnStart);
    const b = ir.indexOf('rfSetChatRoom(false);', a);
    assert(fnStart > 0 && a > fnStart && b > a, '초기화 묶음을 찾는다');
    // 앞 공고(후보 있음)를 수정하고 닫은 상태 그대로의 입력칸
    const els = {};
    for (const id of ['rf_start_date', 'rf_window_start', 'rf_window_end', 'rf_daily_limit', 'rf_recruit_total', 'rf_landing_url',
      'rf_wd_product', 'rf_wd_inflow', 'rf_wd_review', 'rf_wd_notes', 'rf_required_delivery_memo', 'rf_classify_candidates']) els[id] = { value: 'x' };
    els.rf_classify_candidates.value = '피치, 레몬, 스트로베리'; els.rf_required_delivery_memo.value = '00';
    els.rf_skip_weekends = { checked: true }; els.rf_cash_receipt_required = { checked: true };
    vm.runInNewContext(ir.slice(a, b), { document: { getElementById: id => els[id] || null } });
    assert.equal(els.rf_classify_candidates.value, '', '새 공고에 앞 공고의 분류 후보가 남으면 안 된다(저장 때 그대로 실려 엉뚱한 공고가 분류된다)');
    assert.equal(els.rf_required_delivery_memo.value, '', '결정 260 필수 배송메세지도 그대로 비운다');
    assert.equal(els.rf_cash_receipt_required.checked, false);
    // 같은 종류의 실수(실행할 코드가 줄 끝 주석 뒤에 붙어 실행되지 않음)를 공고 창·작업보드 파일 전체에서 막는다
    for (const f of ['frontend/js/index-recruit.js', 'frontend/js/recruit-modal.js', 'frontend/workdesk.html']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const bad = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\/\/[^"'`:]*(document\.getElementById\(|\.value *= )/.test(l));
      assert.deepEqual(bad.map(([n]) => n), [], `${f}: 주석 뒤에 숨은 실행 코드`);
    }
  });

  console.log(`\n✅ captureClassify: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
