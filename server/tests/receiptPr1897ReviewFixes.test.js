/**
 * receiptPr1897ReviewFixes.test.js — 영수증리뷰 3단계 PR #1897 자동 리뷰 3건 (결정 434 「PR #1897 리뷰 반영」)
 * 실행: node tests/receiptPr1897ReviewFixes.test.js   (DL_SOFT=1 = 실패를 모두 보여 준다)
 *
 * ① 담당자가 리뷰 완료를 처리한 영수증(수동 리뷰제출 · 리뷰제출일 기록)에도 「리뷰 냄」(receipt_pool.reviewed_at)이 같은 트랜잭션에 새겨진다 —
 *    안 새기면 담당자가 그 줄을 지울 때 영수증이 보충 줄로 옮겨 가 **이미 쓴 영수증이 다음 참여자에게 간다**.
 *    + 완료를 새기지 않는 길(작업표 표시만 있는 줄)이라도 줄 삭제가 영수증을 옮기는 순간 「리뷰 냄」으로 굳힌다(옮기는 곳 단일 출처).
 *    + 다른 종류 작업은 쓰기 0(같은 문장 순서 · 영수증 표 0줄).
 * ② 매분 정리(sweepExpiredHolds)의 마감 백스톱이 영수증 공고를 closed 로 굳히지 않는다 — 굳으면 돌아온 영수증을 아무도 못 받는다.
 *    다른 공고는 종전 그대로 닫힌다(얼린 종전 후보 SQL 과 대조).
 * ③ 리뷰어 [참여 취소] 처리기가 영수증 취소로 넘어가기 전에 빌린 연결을 먼저 반납한다 — 연결 1개(DB_POOL_MAX=1)에서도 끝난다 ·
 *    반납은 정확히 한 번(오류 길 포함).
 * ★ 실제 처리기·실제 서비스 · PGlite(저장소 migrations 그대로) · 가짜 이름·가짜 파일 번호 · 운영 0.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const SOFT = process.env.DL_SOFT === '1';
const fails = [];
const t = (name, cond, extra) => {
  if (!cond && SOFT) { fails.push(name); console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); return; }
  assert(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 800) : ''));
  pass++; console.log('  ✓ ' + name);
};

const SERVER = path.join(__dirname, '..');
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-receipt-pr1897-secret';
process.env.ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || 'root-folder-test';

async function openDb() {
  const mod = process.env.PGLITE_MODULE || '@electric-sql/pglite';
  const { PGlite } = require(mod);
  // 수동 리뷰제출이 읽는 review_submissions.completed_at(155)이 pg_trgm·pgcrypto 를 쓰는 앞 migration 에 기대므로 확장을 그대로 올린다
  //   (시험 실행기는 PGLITE_MODULE 에 파일 경로를 넣는다 — 확장은 그 설치본 기준으로 찾는다 · bookingPayment 와 같은 방식)
  const extensions = {};
  const base = path.dirname(require.resolve(mod));
  const ext = n => require(require.resolve('@electric-sql/pglite/contrib/' + n, { paths: [base] }))[n];
  try { extensions.pgcrypto = ext('pgcrypto'); extensions.pg_trgm = ext('pg_trgm'); } catch (_) { /* 없으면 아래 확인이 알려 준다 */ }
  const db = new PGlite({ extensions });
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에 없는 확장을 쓰는 몇 파일 — 이 시험의 표와 무관 */ }
  }
  const { rows } = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'review_submissions' AND column_name = 'completed_at'`);
  assert(rows.length === 1, 'migration 155(review_submissions.completed_at)가 올라가야 한다 — PGlite 확장 확인');
  return db;
}

/* 풀 흉내 — 평소 = 무제한 · strict = 연결 1개(DB_POOL_MAX=1): 빌린 연결이 있는 동안 다른 연결(pool.query 포함)은 기다리다 시간초과. */
function poolOf(db) {
  const st = { strict: false, held: null, waiters: [], log: null, releases: new Map(), doubleRelease: 0, secondWhileHeld: 0 };
  const raw = async (sql, params) => {
    const r = await db.query(sql, params || []);
    const out = { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
    if (st.log) st.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), rowCount: out.rowCount });
    return out;
  };
  const acquire = (who) => new Promise((resolve, reject) => {
    if (!st.strict || !st.held) { st.held = who; return resolve(); }
    st.secondWhileHeld++;
    const w = { who, resolve, timer: null };
    w.timer = setTimeout(() => { st.waiters = st.waiters.filter(x => x !== w); reject(new Error('POOL_TIMEOUT — 연결 1개를 쥔 채 두 번째 연결을 기다림(교착)')); }, 1500);
    st.waiters.push(w);
  });
  const free = () => {
    st.held = null;
    const w = st.waiters.shift();
    if (w) { clearTimeout(w.timer); st.held = w.who; w.resolve(); }
  };
  let n = 0;
  const pool = {
    _st: st,
    query: async (sql, params) => {
      if (!st.strict) return raw(sql, params);
      const me = 'q' + (++n);
      await acquire(me);
      try { return await raw(sql, params); } finally { if (st.held === me) free(); }
    },
    connect: async () => {
      const me = 'c' + (++n);
      if (st.strict) await acquire(me);
      st.releases.set(me, 0);
      return {
        query: raw,
        release() {
          const k = st.releases.get(me) + 1; st.releases.set(me, k);
          if (k > 1) { st.doubleRelease++; return; }
          if (st.strict && st.held === me) free();
        },
      };
    },
    on() {}, end: async () => {},
  };
  return pool;
}
function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {}, sent: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.send = b => { res.sent = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.setHeader = res.set;
  return res;
}
function handlerOf(router, method, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  return layer && layer.route.stack[layer.route.stack.length - 1].handle;
}

(async () => {
  console.log('\n▶ 영수증리뷰 3단계 — PR #1897 자동 리뷰 3건(결정 434)\n');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);
  const rp = require('../src/services/receiptPool.service');
  const tb = require('../src/services/trackB.service');
  const drive = require('../src/services/drive.service');
  drive.downloadFile = async (id) => ({ buffer: Buffer.from('IMG:' + id), mimeType: 'image/jpeg', name: id });
  const cs = require('../src/services/csBridge.service');
  cs.postAdminNotice = async () => ({ ok: true });
  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);

  /* 영수증 작업표 + 공고 한 벌 */
  async function makeReceiptWork({ tab, wo: woId, camp, n, place }) {
    const fid = k => `fake_r1897_${camp}_${String(k).padStart(3, '0')}_abcdefghijk`;
    const receipts = Array.from({ length: n }, (_, i) => ({ file_id: fid(i + 1) }));
    const opt = { name: place, url: 'https://map.naver.com/p/entry/place/0000009', option_schema_version: 2, product_mode: 'none',
      base: { pay: 0, count: n, daily: 0, review_type_mix: [] }, options: [], receipt: { review_deadline_days: 3, place_address: '서울 가짜구 가짜로 9', receipts } };
    const wo = { id: woId, title: tab, work_kind: 'receipt', workboard_schema_version: 2, recruit_count: n, review_fee: 5000, pay_amount: 0, start_date: null,
      product_options_json: JSON.stringify([opt]) };
    await q(`INSERT INTO work_orders (id, title, work_kind, workboard_schema_version, recruit_count, review_fee, pay_amount, product_options_json, status)
             VALUES ($1, $2, 'receipt', 2, $3, 5000, 0, $4, 'published')`, [woId, tab, n, wo.product_options_json]);
    for (const r of receipts) await rp.registerReceiptUpload(r.file_id, { source: 'upload:intranet', mimeType: 'image/jpeg' });
    const made = await require('../src/services/sheetlessAccept.service').createSheetlessWorktable({ workOrder: wo, tabName: tab, by: 'test' });
    await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'receipt', TRUE, 2)`, [made.sheetId, tab, made.gid]);
    await made.persist();
    await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, linked_tab_gid, work_kind,
               recruit_total, daily_limit, hold_ttl_min, multi_account_mode, review_fee)
             VALUES ($1, $2, 'active', TRUE, $3, $4, $5, 'receipt', $6, $6, 20, FALSE, 5000)`, [camp, place, made.sheetId, tab, made.gid, n]);
    await q(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, pay_amount, recruit_total, daily_limit, status, sort_order)
             VALUES ($1, $2, $2, 'product', 0, $3, 0, 'active', 0)`, [camp, place, n]);
    return { sheetId: made.sheetId, tab, camp, place };
  }

  const W1 = await makeReceiptWork({ tab: '12월 가짜카페 직원완료', wo: 'wo_r1897_a', camp: 'camp_r1897_a', n: 3, place: '가짜카페 역삼점' });
  const W2 = await makeReceiptWork({ tab: '12월 가짜카페 매분정리', wo: 'wo_r1897_b', camp: 'camp_r1897_b', n: 2, place: '가짜카페 삼성점' });

  const wk = require('../src/utils/workKind');
  const campaignRoutes = require('../src/routes/campaign.routes');
  const submitRoutes = require('../src/routes/submit.routes');
  const apply = handlerOf(campaignRoutes, 'post', '/:id/apply');
  const cancelH = handlerOf(campaignRoutes, 'post', '/:id/cancel');
  const joinH = handlerOf(submitRoutes, 'post', '/receipt');
  const call = async (h, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    const res = fakeRes(); let err = null;
    await h({ body, params, query, headers, ip: '127.0.0.1', get: () => '' }, res, e => { err = e; });
    return Object.assign(res, { err });
  };
  const names = ['가짜직원A', '가짜직원B', '가짜직원C', '가짜직원D', '가짜정리E', '가짜정리F', '가짜정리G', '가짜정리H'];
  const people = names.map((n, i) => [n, '0103' + String(1000000 + i * 1111).slice(-7)]);
  for (const [n, ph] of people) {
    await q(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder, address) VALUES ($1, $2, '가짜은행', $3, $1, '서울 가짜구')`, [n, ph, '000-' + ph.slice(-4)]);
  }
  const rs = require('../src/services/reviewerSession.service');
  const who = async (i) => {
    const [n, ph] = people[i]; const p8 = ph.slice(-8);
    const id = (await q('SELECT id FROM reviewers WHERE phone8 = $1', [p8])).rows[0].id;
    return { name: n, phone: ph, p8, id, H: { 'x-reviewer-token': rs.issueReviewerSession({ ownerReviewerId: id, loginName: n, loginPhone8: p8 }) } };
  };
  const P = [];
  for (let i = 0; i < people.length; i++) P.push(await who(i));
  const [A, B, C, D, E, F, G, H] = P;
  const doApply = (W, p) => call(apply, { params: { id: W.camp }, body: { name: p.name, phone: p.phone, optionKey: W.place }, headers: p.H });
  const joinAs = async (W, p) => {
    const a = await doApply(W, p);
    if (!(a.statusCode === 200 && a.body && a.body.ok)) return { fail: a.body || a.err };
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [a.body.applicationId, p.id]);
    const j = await call(joinH, { body: { campaignId: W.camp, campaignApplicationId: a.body.applicationId, holdToken: a.body.holdToken, holdPhone8: p.p8, loginPhone8: p.p8 }, headers: p.H });
    if (!(j.statusCode === 200 && j.body && j.body.ok)) return { fail: j.body || j.err };
    const seat = await rp.poolForApplication(pool, a.body.applicationId);
    return { app: a.body, seat, orderId: j.body.orderSubmissionId };
  };
  const rowAt = async (W, seq) => (await q(`SELECT id, seq, order_submission_id, row_json, is_submitted FROM campaign_participants
                                              WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL`, [W.sheetId, W.tab, seq])).rows[0];
  const poolRow = async (W, poolSeq) => (await q(`SELECT id, seq, reviewed_at FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2 AND pool_seq = $3`, [W.sheetId, W.tab, poolSeq])).rows[0];
  const free = async (W) => (await rp.freeCountsForTab(pool, W.sheetId, W.tab)).free;
  const ensureIndexRow = async (W, seq, name) => {
    const ex = await q('SELECT 1 FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3', [W.sheetId, W.tab, seq]);
    if (!ex.rows.length) await q(`INSERT INTO review_index (reviewer_name, sheet_id, tab_name, row_index, is_submitted) VALUES ($1, $2, $3, $4, FALSE)`, [name, W.sheetId, W.tab, seq]);
  };
  const addReviewFile = (W, seq, fileId) => q(`INSERT INTO review_submissions (sheet_id, tab_name, row_index, slot_key, file_id, file_name, source, uploaded_at)
                                                VALUES ($1, $2, $3, 'review', $4, $4, 'upload', NOW())`, [W.sheetId, W.tab, seq, fileId]);

  const saved = wk.NOT_READY_WORK_KINDS.slice();
  wk.NOT_READY_WORK_KINDS.length = 0;   // ★ 시험 안에서만 비운다(끝에 되돌림)
  try {
    /* ══ ① 담당자 리뷰 완료도 「리뷰 냄」 ══════════════════════════════ */
    console.log('① 담당자 완료(수동 리뷰제출·리뷰제출일 기록)도 영수증을 「쓴 것」으로');
    const jA = await joinAs(W1, A);
    t('준비: A = 1번 영수증 · 참여 확정', jA.seat && jA.seat.pool_seq === 1, jA.fail);
    const rowA = await rowAt(W1, jA.seat.seq);
    await ensureIndexRow(W1, jA.seat.seq, A.name);
    await addReviewFile(W1, jA.seat.seq, 'fake_r1897_review_A');
    const mA = await tb.manualWorkdeskReviewSubmit({ sheetId: W1.sheetId, tabName: W1.tab, rowId: rowA.id, fileIds: ['fake_r1897_review_A'], by: 'test-staff' });
    t('담당자 [수동 리뷰제출] = 성공', mA && mA.ok === true, mA);
    t('★★★ 수동 리뷰제출 트랜잭션이 그 영수증에 「리뷰 냄」을 새긴다(reviewed_at)', !!(await poolRow(W1, 1)).reviewed_at, await poolRow(W1, 1));
    const freeBeforeDel = await free(W1);
    const hA = await tb.hideWorkdeskRow({ sheetId: W1.sheetId, tabName: W1.tab, rowId: rowA.id, by: 'test-staff', actorRole: 'admin' });
    t('담당자 [줄 삭제](리뷰 낸 줄) = 성공(종전대로 지울 수 있다)', hA && hA.ok === true, hA);
    const p1 = await poolRow(W1, 1);
    t('1번 영수증은 보충 줄로 옮겨 갔다(2단계 그대로)', p1.seq !== jA.seat.seq);
    t('★★★ 남은 영수증이 늘지 않는다(쓴 영수증은 돌아오지 않는다)', (await free(W1)) === freeBeforeDel, { before: freeBeforeDel, after: await free(W1) });
    const jB = await joinAs(W1, B);
    t('★★★ 다음 참여자 B 는 쓴 1번이 아니라 2번 영수증을 받는다', jB.seat && jB.seat.pool_seq === 2, jB.seat || jB.fail);

    const rowB = jB.seat && await rowAt(W1, jB.seat.seq);
    const bf = rowB && await tb.backfillWorkdeskReviewSubmitDate({ sheetId: W1.sheetId, tabName: W1.tab, rowId: rowB.id, value: '11/28', by: 'test-staff' });
    t('담당자 [리뷰제출일 기록] = 성공', bf && bf.ok === true, bf);
    t('★★★ 리뷰제출일 기록 트랜잭션도 「리뷰 냄」을 새긴다', !!(await poolRow(W1, 2)).reviewed_at, await poolRow(W1, 2));

    // 완료를 새기지 않는 길(작업표 표시만 — 시트 반영·옛 데이터)이라도 줄 삭제가 영수증을 옮기는 순간 굳힌다.
    const jC = await joinAs(W1, C);
    t('준비: C = 3번 영수증', jC.seat && jC.seat.pool_seq === 3, jC.seat || jC.fail);
    const rowC = jC.seat && await rowAt(W1, jC.seat.seq);
    if (rowC) {
      await q('UPDATE campaign_participants SET is_submitted = TRUE WHERE id = $1', [rowC.id]);
      await ensureIndexRow(W1, jC.seat.seq, C.name);
      await q('UPDATE review_index SET is_submitted = TRUE WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3', [W1.sheetId, W1.tab, jC.seat.seq]);
    }
    t('준비: 3번 영수증에 「리뷰 냄」 표시 없음(표시 없이 완료된 줄)', !(await poolRow(W1, 3)).reviewed_at);
    const hC = rowC && await tb.hideWorkdeskRow({ sheetId: W1.sheetId, tabName: W1.tab, rowId: rowC.id, by: 'test-staff', actorRole: 'admin' });
    t('담당자 [줄 삭제] = 성공', hC && hC.ok === true, hC);
    t('★★★ 줄 삭제가 리뷰 낸 줄의 영수증을 옮길 때 「리뷰 냄」으로 굳힌다(옮기는 곳 단일 출처 · 받침)', !!(await poolRow(W1, 3)).reviewed_at, await poolRow(W1, 3));
    const aD = await doApply(W1, D);
    t('★★★ 영수증 셋 다 쓰였다 → 다음 참여자 D = 「영수증이 모두 나갔어요」(쓴 영수증을 다시 주지 않음)', aD.statusCode === 409 && aD.body && aD.body.reason === 'receipt_sold_out', aD.body);

    // 리뷰 전 줄 삭제는 종전 그대로 다음 사람에게 간다(받침이 「리뷰 안 낸 줄」을 굳히지 않는다).
    const W3 = await makeReceiptWork({ tab: '12월 가짜카페 리뷰전삭제', wo: 'wo_r1897_c', camp: 'camp_r1897_c', n: 1, place: '가짜카페 대치점' });
    const jH = await joinAs(W3, H);
    const rowH = jH.seat && await rowAt(W3, jH.seat.seq);
    const hH = rowH && await tb.hideWorkdeskRow({ sheetId: W3.sheetId, tabName: W3.tab, rowId: rowH.id, by: 'test-staff', actorRole: 'admin' });
    t('★★ 리뷰 전 줄 삭제 = 영수증이 그대로 돌아온다(「리뷰 냄」 없음 · 남은 1장)', hH && hH.ok === true && !(await poolRow(W3, 1)).reviewed_at && (await free(W3)) === 1, hH);

    // 리뷰어 리뷰 캡처 제출이 지나는 「리뷰제출」 칸 실행부(markStatusCell · 완료 트랜잭션 client) — 같은 트랜잭션에서 굳고, 되돌리면 같이 되돌려진다.
    const jD = await joinAs(W3, D);
    t('준비: D = W3 의 돌아온 1번 영수증', jD.seat && jD.seat.pool_seq === 1, jD.seat || jD.fail);
    const sls = require('../src/services/sheetlessStatus.service');
    const markIn = async (finish) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const st = await sls.markStatusCell({ sheetId: W3.sheetId, tabName: W3.tab, rowIndex: jD.seat.seq, kind: 'submit', value: '11/28 10:00', by: 'review-submit', client: c });
        await c.query(finish);
        return st;
      } finally { c.release(); }
    };
    const stR = await markIn('ROLLBACK');
    t('★★ 리뷰제출 칸 기록을 되돌리면 「리뷰 냄」도 같이 되돌려진다(커밋 뒤 따로 쓰지 않음 — 완료와 한 몸)', stR && stR.ok === true && !(await poolRow(W3, 1)).reviewed_at, stR);
    const stC = await markIn('COMMIT');
    t('★★★ 리뷰어 리뷰 캡처 제출 길(리뷰제출 칸 실행부)도 같은 트랜잭션에서 「리뷰 냄」을 새긴다', stC && stC.ok === true && !!(await poolRow(W3, 1)).reviewed_at, stC);

    /* ── ① 다른 종류 작업: 쓰기 0 · 같은 문장 순서 ── */
    console.log('\n①-나 다른 종류(일반 리뷰) 작업 = 영수증 쓰기 0 · 종전과 같은 문장');
    const NT = '12월 가짜 일반리뷰';
    const nwo = { id: 'wo_r1897_plain', title: NT, work_kind: 'review', workboard_schema_version: 2, recruit_count: 2, review_fee: 5000, pay_amount: 10000, start_date: null,
      review_type: '포토', product_options_json: JSON.stringify([{ name: '가짜상품', option_schema_version: 2, product_mode: 'none',
        base: { pay: 10000, count: 2, daily: 0, review_type_mix: [{ type: '포토', quantity: 2 }] }, options: [] }]) };
    await q(`INSERT INTO work_orders (id, title, work_kind, workboard_schema_version, recruit_count, review_fee, pay_amount, product_options_json, status)
             VALUES ($1, $2, 'review', 2, 2, 5000, 10000, $3, 'published')`, [nwo.id, NT, nwo.product_options_json]);
    const nm = await require('../src/services/sheetlessAccept.service').createSheetlessWorktable({ workOrder: nwo, tabName: NT, by: 'test' });
    assert(nm && nm.sheetId, '준비: 일반 리뷰 작업표 :: ' + JSON.stringify(nm));
    await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'review', TRUE, 2)`, [nm.sheetId, NT, nm.gid]);
    await nm.persist();
    const NW = { sheetId: nm.sheetId, tab: NT };
    const nrows = (await q(`SELECT id, seq FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL ORDER BY seq`, [nm.sheetId, NT])).rows;
    t('준비: 일반 리뷰 작업표 2줄', nrows.length >= 2, nrows);
    const rpBefore = JSON.stringify((await q('SELECT * FROM receipt_pool ORDER BY id')).rows);
    const runPlain = async (r, i) => {
      await q(`UPDATE campaign_participants SET reviewer_name = $2, submit_col = '리뷰', row_json = row_json || jsonb_build_object('수취인', $2::text) WHERE id = $1`, [r.id, '가짜일반' + i]);
      await ensureIndexRow(NW, r.seq, '가짜일반' + i);
      await addReviewFile(NW, r.seq, 'fake_r1897_plain_' + i);
      pool._st.log = [];
      const out = await tb.manualWorkdeskReviewSubmit({ sheetId: nm.sheetId, tabName: NT, rowId: r.id, fileIds: ['fake_r1897_plain_' + i], by: 'test-staff' });
      const log = pool._st.log; pool._st.log = null;
      return { out, log };
    };
    const real = await runPlain(nrows[0], 0);
    const origHelper = rp.markReceiptReviewedInTx;
    rp.markReceiptReviewedInTx = async () => 0;   // 도우미를 빼면(= 종전) 무엇이 다른가
    const stub = await runPlain(nrows[1], 1);
    rp.markReceiptReviewedInTx = origHelper;
    t('일반 리뷰 두 줄 수동 리뷰제출 = 성공', real.out && real.out.ok && stub.out && stub.out.ok, { a: real.out, b: stub.out });
    const S = l => l.map(x => x.sql);
    const diff = [];
    { // real 에서 stub 에 없는 문장(순서 보존 LCS 대신 간단히: 앞에서부터 맞춰 나간다)
      let j = 0; const sl = S(stub.log);
      for (let i = 0; i < real.log.length; i++) {
        if (j < sl.length && real.log[i].sql === sl[j]) { j++; continue; }
        diff.push(real.log[i]);
      }
      if (j !== sl.length) diff.push({ missing: sl.slice(j) });
    }
    t('★★ 다른 종류: 도우미가 더하는 문장은 영수증 표 「리뷰 냄」 UPDATE(+ 격리 지점)뿐 · 나머지 문장은 종전과 같은 순서', diff.length > 0
      && diff.every(d => d.sql && (/^SAVEPOINT receipt_reviewed$|^RELEASE SAVEPOINT receipt_reviewed$/.test(d.sql) || /^UPDATE receipt_pool SET reviewed_at/.test(d.sql))), diff);
    t('★★★ 다른 종류: 그 UPDATE 는 0줄(쓰기 0)', diff.filter(d => /^UPDATE receipt_pool/.test(d.sql || '')).every(d => d.rowCount === 0));
    t('★★★ 다른 종류: 영수증 표 그대로', JSON.stringify((await q('SELECT * FROM receipt_pool ORDER BY id')).rows) === rpBefore);

    /* ══ ② 매분 정리가 영수증 공고를 닫지 않는다 ═══════════════════════ */
    console.log('\n② 매분 정리(sweepExpiredHolds) 마감 백스톱 — 영수증 공고 제외 · 다른 공고 종전 그대로');
    const jE = await joinAs(W2, E);
    const jF = await joinAs(W2, F);
    t('준비: 영수증 2장 모두 배정·확정(공고 정원 2 = 확정 2)', jE.seat && jF.seat
      && Number((await q(`SELECT COUNT(*)::int AS n FROM campaign_applications WHERE campaign_id = $1 AND status = 'submitted'`, [W2.camp])).rows[0].n) === 2);
    t('준비: 참여 확정 직후에도 공고는 active(maybePersistClosed 제외 — 종전 결정 434)', (await q('SELECT status FROM recruit_campaigns WHERE id = $1', [W2.camp])).rows[0].status === 'active');
    // 일반 참여형 공고(영수증 아님) — 정원 1 · 확정 1 → 종전대로 닫혀야 한다.
    await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, recruit_total, daily_limit, hold_ttl_min)
             VALUES ('camp_r1897_plain', '가짜 일반공고', 'active', TRUE, $1, $2, 1, 1, 20)`, [nm.sheetId, NT]);
    await q(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, status, hold_token, submitted_at)
             VALUES ('camp_r1897_plain', '가짜일반확정', '01099990000', '99990000', 'submitted', 'tok_plain', NOW())`);
    // 얼린 종전 후보 SQL(이 PR 전 sweepExpiredHoldsInTx ③ 그대로)
    const frozen = (await q(`SELECT rc.id FROM recruit_campaigns rc
      WHERE rc.participation_mode AND rc.status = 'active' AND rc.recruit_total > 0
        AND rc.id <> ALL($1::text[])
        AND (SELECT COUNT(*) FROM campaign_applications ca WHERE ca.campaign_id = rc.id AND ca.status = 'submitted') >= rc.recruit_total`, [[]])).rows.map(r => r.id).sort();
    t('준비: 종전 후보 = 영수증 공고 + 일반 공고', frozen.includes(W2.camp) && frozen.includes('camp_r1897_plain'), frozen);
    const { sweepExpiredHolds } = require('../src/services/campaignHold.service');
    const sw = await sweepExpiredHolds(pool);
    const st2 = (await q('SELECT status FROM recruit_campaigns WHERE id = $1', [W2.camp])).rows[0].status;
    t('★★★ 매분 정리 뒤에도 영수증 공고는 active(closed 로 굳지 않는다)', st2 === 'active', { st2, sw });
    const closedNow = (await q(`SELECT id FROM recruit_campaigns WHERE status = 'closed' ORDER BY id`)).rows.map(r => r.id);
    const receiptCamps = [W1.camp, W2.camp, W3.camp];
    t('★★ 다른 공고는 종전 그대로 닫힌다(닫힌 목록 = 얼린 종전 후보 − 영수증 공고)', JSON.stringify(closedNow) === JSON.stringify(frozen.filter(id => !receiptCamps.includes(id)))
      && sw.closedPersisted === closedNow.length, { closedNow, frozen, sw });
    await sweepExpiredHolds(pool);
    t('정리를 한 번 더 돌려도 영수증 공고 active', (await q('SELECT status FROM recruit_campaigns WHERE id = $1', [W2.camp])).rows[0].status === 'active');

    /* ══ ③ 취소 처리기 — 연결 1개에서도 끝난다 · 반납 정확히 한 번 ═════════ */
    console.log('\n③ 리뷰어 [참여 취소](확정된 영수증) — 연결 1개(DB_POOL_MAX=1)');
    pool._st.strict = true; pool._st.secondWhileHeld = 0; pool._st.doubleRelease = 0; pool._st.releases.clear();
    const t0 = Date.now();
    const cE = await call(cancelH, { params: { id: W2.camp }, body: { phone8: E.p8, holdToken: jE.app.holdToken }, headers: E.H });
    const ms = Date.now() - t0;
    pool._st.strict = false;
    t('★★★ 연결 1개에서도 취소가 끝난다(200 · 교착·시간초과 없음)', cE.statusCode === 200 && cE.body && cE.body.ok === true && !cE.err, { s: cE.statusCode, b: cE.body, err: cE.err && cE.err.message, ms });
    t('★★★ 영수증 취소로 넘어가기 전에 빌린 연결을 반납한다(쥔 채 두 번째 연결을 기다린 적 0)', pool._st.secondWhileHeld === 0, pool._st.secondWhileHeld);
    t('★★ 빌린 연결은 모두 정확히 한 번 반납(두 번 반납 0)', pool._st.doubleRelease === 0 && [...pool._st.releases.values()].every(v => v === 1), [...pool._st.releases.entries()]);
    // 참여(신청 트랜잭션 안 영수증 배정)·참여 확정도 연결 1개에서 끝나야 한다(이 PR 이 더한 길에 연결을 쥔 채 다른 연결을 기다리는 곳 없음)
    pool._st.strict = true; pool._st.secondWhileHeld = 0; pool._st.doubleRelease = 0; pool._st.releases.clear();
    const jG = await joinAs(W2, G);
    pool._st.strict = false;
    t('★★★ 취소 뒤 공고가 active 라 다음 참여자 G 가 돌아온 영수증을 받는다(연결 1개에서 참여·참여 확정)', jG.seat && jG.seat.pool_seq === jE.seat.pool_seq, jG.seat || jG.fail);
    t('★★ 참여·참여 확정: 쥔 채 두 번째 연결을 기다린 적 0 · 반납 정확히 한 번', pool._st.secondWhileHeld === 0 && pool._st.doubleRelease === 0 && [...pool._st.releases.values()].every(v => v === 1),
      { second: pool._st.secondWhileHeld, rel: [...pool._st.releases.entries()] });

    // 오류 길: 영수증 취소 도중 예외 → next(err) · 반납 한 번 · 두 번 반납 없음
    pool._st.strict = true; pool._st.secondWhileHeld = 0; pool._st.doubleRelease = 0; pool._st.releases.clear();
    const origPFA = rp.poolForApplication;
    rp.poolForApplication = async () => { throw new Error('가짜 조회 실패'); };
    const cF = await call(cancelH, { params: { id: W2.camp }, body: { phone8: F.p8, holdToken: jF.app.holdToken }, headers: F.H });
    rp.poolForApplication = origPFA;
    pool._st.strict = false;
    t('★★ 오류 길: 예외는 오류 처리기로(next) · 연결은 정확히 한 번 반납 · 두 번 반납 0', cF.err && /가짜 조회 실패/.test(cF.err.message)
      && pool._st.doubleRelease === 0 && [...pool._st.releases.values()].every(v => v === 1) && pool._st.secondWhileHeld === 0,
      { err: cF.err && cF.err.message, rel: [...pool._st.releases.entries()], dbl: pool._st.doubleRelease, second: pool._st.secondWhileHeld });
    t('오류 길: F 참여는 그대로(submitted)', (await q('SELECT status FROM campaign_applications WHERE id = $1', [jF.app.applicationId])).rows[0].status === 'submitted');

    // 확정 전(applied) 취소 = 종전 길 · 연결 1개에서도 그대로
    const W4 = await makeReceiptWork({ tab: '12월 가짜카페 확정전취소', wo: 'wo_r1897_d', camp: 'camp_r1897_d', n: 1, place: '가짜카페 논현점' });
    const aH = await doApply(W4, H);
    pool._st.strict = true; pool._st.releases.clear(); pool._st.doubleRelease = 0; pool._st.secondWhileHeld = 0;
    const cH = await call(cancelH, { params: { id: W4.camp }, body: { phone8: H.p8, holdToken: aH.body.holdToken }, headers: {} });
    pool._st.strict = false;
    t('확정 전 홀드 취소 = 종전 길(200) · 반납 한 번', cH.statusCode === 200 && [...pool._st.releases.values()].every(v => v === 1) && pool._st.doubleRelease === 0, { b: cH.body, rel: [...pool._st.releases.entries()] });
    const c404 = await call(cancelH, { params: { id: W4.camp }, body: { phone8: H.p8, holdToken: 'wrong' }, headers: {} });
    t('취소할 참여 없음 = 종전 404', c404.statusCode === 404, c404.body);
  } finally {
    pool._st.strict = false;
    wk.NOT_READY_WORK_KINDS.length = 0; wk.NOT_READY_WORK_KINDS.push(...saved);
  }
  t('★★ 시험 뒤 준비 중 목록 원상 복귀(receipt 포함)', JSON.stringify(wk.NOT_READY_WORK_KINDS) === JSON.stringify(saved) && wk.NOT_READY_WORK_KINDS.includes('receipt'));

  if (fails.length) { console.log(`\n✗ ${fails.length} failed (soft)`); process.exit(1); }
  console.log(`\n✅ receiptPr1897ReviewFixes: ${pass}개 통과\n`);
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
