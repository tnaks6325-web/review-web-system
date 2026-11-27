/**
 * receiptReviewerFlow.test.js — 영수증리뷰 3단계 회귀가드: 모집공고 · 참여 순간 영수증 한 장 배정 · 내 영수증 보기 · 리뷰 제출 (결정 432)
 * 실행: node tests/receiptReviewerFlow.test.js
 *
 * 위험:
 *  ① 마지막 영수증 한 장이 두 사람에게 간다(동시 참여) — 배정 = 영수증 한 장 = 살아 있는 신청 하나(부분 유일 색인 232).
 *  ② 취소·만료·줄 삭제된 참여가 영수증을 계속 쥔다(남은 영수증이 있는데 「마감」) — 또는 리뷰를 낸 영수증이 다른 사람에게 다시 간다.
 *  ③ 영수증 사진이 배정된 리뷰어 밖(다른 리뷰어·무인증·무인증 사진 통로·공개 공고 응답)으로 샌다.
 *  ④ 참여일자·리뷰마감일(참여일 + N일 · KST)이 작업표 줄에 안 찍히거나 다른 줄에 찍힌다 · 구매양식 길로 들어간다.
 *  ⑤ 상태 엔진이 「참여일자」 칸을 시트 일정처럼 읽거나, 남은 영수증 0 을 「내일 다시 오픈」으로 보인다.
 *  ⑥ 1단계 안전핀(NOT_READY_WORK_KINDS = ['receipt'])이 풀린다 — 3단계도 운영에서 영수증리뷰를 열지 않는다.
 * ★ 배정·만료·취소·줄 삭제·신청/참여상세/참여 확정/영수증 보기 처리기는 PGlite(저장소 migrations 그대로)에서 실제로 돌린다.
 *   운영 DB·드라이브에 닿지 않는다(가짜 이름·가짜 매장·가짜 파일 번호 · 드라이브 읽기는 가짜로 세기만).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const SERVER = path.join(__dirname, '..');
const TAB = '12월 가짜카페 영수증리뷰';
const WO = 'wo_receipt_step3';
const CAMP = 'camp_receipt_step3';
const OPT = '가짜카페 역삼점';
const FID = n => `fake_receipt_${String(n).padStart(4, '0')}_abcdefghijk`;
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-receipt-step3-secret';
process.env.ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || 'root-folder-test';

const DAY = 86400000;
const kstYmd = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const NOW = Date.now();
const T0 = kstYmd(NOW), T2 = kstYmd(NOW + 2 * DAY), T3 = kstYmd(NOW + 3 * DAY);

async function openDb() {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에 없는 확장을 쓰는 몇 파일 — 이 시험의 표와 무관 */ }
  }
  return db;
}
function poolOf(db) {
  const query = async (sql, params) => {
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
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
  console.log('\n▶ 영수증리뷰 3단계 — 참여 순간 영수증 배정 · 내 영수증 · 리뷰 제출\n');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);
  const rp = require('../src/services/receiptPool.service');
  const drive = require('../src/services/drive.service');
  const reads = [];
  drive.downloadFile = async (id) => { reads.push(id); return { buffer: Buffer.from('IMG:' + id), mimeType: 'image/jpeg', name: id }; };

  /* ── 0) migration 232 ─────────────────────────────────────── */
  console.log('0) migration 232 · 기동 필수 칸');
  const colsOf = async tb => (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [tb])).rows.map(r => r.column_name);
  t('★ 신청 표에 receipt_pool_id', (await colsOf('campaign_applications')).includes('receipt_pool_id'));
  t('★ 영수증 표에 joined_date · review_deadline · reviewed_at', ['joined_date', 'review_deadline', 'reviewed_at'].every(c => fs && true) && (await colsOf('receipt_pool')).filter(c => ['joined_date', 'review_deadline', 'reviewed_at'].includes(c)).length === 3);
  const ix = (await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'campaign_applications' AND indexname = 'uq_campaign_apps_receipt_pool'`)).rows[0];
  t('★★ 영수증 한 장 = 살아 있는 신청 하나(부분 유일 색인 · applied·submitted 만)', ix && /UNIQUE/.test(ix.indexdef) && /receipt_pool_id/.test(ix.indexdef) && /applied/.test(ix.indexdef) && /submitted/.test(ix.indexdef));
  t('migration 파일 번호 232 는 하나뿐', fs.readdirSync(path.join(SERVER, 'migrations')).filter(f => /^232_/.test(f)).length === 1);
  t('★ 기동 필수 칸(REQUIRED_SCHEMA)에 세 칸', /\['campaign_applications', 'receipt_pool_id'\]/.test(S('index.js')) && /\['receipt_pool', 'review_deadline'\]/.test(S('index.js')) && /\['receipt_pool', 'reviewed_at'\]/.test(S('index.js')));

  /* ── 1) 영수증 작업표 + 공고 준비(영수증 2장) ─────────────────── */
  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);
  const receipts = [1, 2].map(n => ({ file_id: FID(n) }));
  const place = { name: OPT, url: 'https://map.naver.com/p/entry/place/0000000', option_schema_version: 2, product_mode: 'none',
    base: { pay: 0, count: 2, daily: 0, review_type_mix: [] }, options: [], receipt: { review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1', receipts } };
  const wo = { id: WO, title: TAB, work_kind: 'receipt', workboard_schema_version: 2, recruit_count: 2, review_fee: 5000, pay_amount: 0, start_date: null,
    product_options_json: JSON.stringify([place]) };
  await q(`INSERT INTO work_orders (id, title, work_kind, workboard_schema_version, recruit_count, review_fee, pay_amount, product_options_json, status)
           VALUES ($1, $2, 'receipt', 2, 2, 5000, 0, $3, 'published')`, [WO, TAB, wo.product_options_json]);
  for (const r of receipts) await rp.registerReceiptUpload(r.file_id, { source: 'upload:intranet', mimeType: 'image/jpeg' });
  const acc = require('../src/services/sheetlessAccept.service');
  const made = await acc.createSheetlessWorktable({ workOrder: wo, tabName: TAB, by: 'test' });
  const sheetId = made.sheetId;
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'receipt', TRUE, 2)`, [sheetId, TAB, made.gid]);
  await made.persist();
  await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, linked_tab_gid, work_kind,
             recruit_total, daily_limit, hold_ttl_min, multi_account_mode, review_fee)
           VALUES ($1, $2, 'active', TRUE, $3, $4, $5, 'receipt', 2, 2, 20, FALSE, 5000)`, [CAMP, OPT, sheetId, TAB, made.gid]);
  await q(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, pay_amount, recruit_total, daily_limit, status, sort_order)
           VALUES ($1, $2, $2, 'product', 0, 2, 0, 'active', 0)`, [CAMP, OPT]);
  t('준비: 영수증 작업표 2줄 · 영수증 묶음 2장', (await rp.poolForTab(pool, sheetId, TAB)).length === 2);

  /* ── 2) 남은 영수증 ────────────────────────────────────────── */
  console.log('\n2) 남은 영수증(공고 카드·정원 재료)');
  t('★ 탭의 남은 영수증 = 2/2', JSON.stringify(await rp.freeCountsForTab(pool, sheetId, TAB)) === JSON.stringify({ total: 2, free: 2 }));
  const f0 = await rp.loadFreeByCampaign(pool, [CAMP]);
  t('★ 공고 정원 재료: 공고 → 남은 영수증 2', f0 instanceof Map && f0.get(CAMP).free === 2 && f0.get(CAMP).total === 2);
  t('영수증 탭 아닌 공고는 싣지 않는다', !(await rp.loadFreeByCampaign(pool, ['없는공고'])).has('없는공고'));
  t('★ 조회 실패 = null(덮지 않음 — 표시는 종전, 참여는 배정이 다시 막는다)', await rp.loadFreeByCampaign({ query: async () => { throw new Error('x'); } }, [CAMP]) === null);
  t('참여일 + N일 = 달력 날(날짜 더하기 단일 출처)', JSON.stringify(rp.joinDatesFor(T0, 3) && [rp.joinDatesFor(T0, 3).joinedDate, rp.joinDatesFor(T0, 3).reviewDeadline]) === JSON.stringify([T0, T3]));

  /* ── 3) 배정 — 유일 색인 · 동시 참여 · 만료·취소·리뷰 냄 ───────── */
  console.log('\n3) 배정(서비스 · 실제 SQL)');
  let appSeq = 0;
  const newApp = async (p8, { status = 'applied', expiresSql = "NOW() + interval '20 minutes'" } = {}) => {
    appSeq++;
    const { rows } = await q(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, owner_phone8, status, expires_at, hold_token)
                              VALUES ($1, $2, $3, $4, $4, $5, ${expiresSql}, $6) RETURNING id`, [CAMP, '가짜시험' + appSeq, '010' + p8, p8, status, 'rtok' + appSeq]);
    return rows[0].id;
  };
  const bind = (appId) => rp.bindReceiptForApply(pool, { sheetId, tabName: TAB, applicationId: appId, now: new Date(NOW) });
  const s1 = await newApp('90000001');
  const b1 = await bind(s1);
  t('★★ 안 쓴 영수증 한 장(1번부터) · 참여일 = 오늘(KST) · 리뷰마감일 = 참여일 + 3일', b1.ok && b1.pool.pool_seq === 1 && b1.dates.joinedDate === T0 && b1.dates.reviewDeadline === T3);
  const row1 = (await q('SELECT joined_date::text AS j, review_deadline::text AS d FROM receipt_pool WHERE id = $1', [b1.pool.id])).rows[0];
  t('★ 같은 트랜잭션에서 영수증 줄에 참여일·리뷰마감일을 새긴다', row1.j === T0 && row1.d === T3);
  {
    let err = null;
    const s2 = await newApp('90000002');
    try { await q('UPDATE campaign_applications SET receipt_pool_id = $2 WHERE id = $1', [s2, b1.pool.id]); } catch (e) { err = e; }
    t('★★ 같은 영수증에 두 번째 신청을 새기면 유일 색인이 막는다(23505 uq_campaign_apps_receipt_pool)',
      err && err.code === '23505' && /uq_campaign_apps_receipt_pool/.test(String(err.constraint || err.message)));
    await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE id = $1`, [s2]);
  }
  // 동시 참여 — 남은 1장을 두 신청이 함께 노린다(고르기 → 새기기 사이에 끼어듦). 하나만 남는다.
  {
    const race = async (p8) => { const id = await newApp(p8); const r = await bind(id); return r.ok ? { won: id } : { lost: r.reason, id }; };
    const out = await Promise.allSettled([race('91000001'), race('91000002')]);
    const vals = out.map(o => o.status === 'fulfilled' ? o.value : { err: o.reason });
    const won = vals.filter(v => v.won).length;
    const held = (await q(`SELECT COUNT(*)::int AS n FROM campaign_applications WHERE receipt_pool_id IS NOT NULL AND status IN ('applied','submitted') AND campaign_id = $1`, [CAMP])).rows[0].n;
    t('★★★ 마지막 한 장 동시 참여 → 정확히 한 명만 받는다(다른 한 명은 「마감」 receipt_sold_out · 예외 없음)',
      won === 1 && held === 2 && vals.filter(v => v.lost === 'receipt_sold_out').length === 1 && !vals.some(v => v.err));
    const lost = vals.find(v => v.lost);
    t('진 신청은 영수증을 쥐지 않는다(receipt_pool_id 없음)', (await q('SELECT receipt_pool_id FROM campaign_applications WHERE id = $1', [lost.id])).rows[0].receipt_pool_id == null);
    t('★ 다 나간 뒤 = receipt_sold_out · 남은 영수증 0', (await bind(await newApp('91000003'))).reason === 'receipt_sold_out' && (await rp.freeCountsForTab(pool, sheetId, TAB)).free === 0);
    // 동시 시험 신청 정리
    await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE id = $1`, [vals.find(v => v.won).won]);
  }
  // 만료 — 유예가 지난 홀드는 고르기 직전에 정리되고 그 영수증이 다시 나간다
  await q(`UPDATE campaign_applications SET expires_at = NOW() - interval '10 minutes' WHERE id = $1`, [s1]);
  const s3 = await newApp('90000003');
  const b3 = await bind(s3);
  t('★★ 만료된 홀드는 영수증을 놓는다(고르기 직전 expired 로 정리 · 같은 1번이 다시 나감)',
    b3.ok && b3.pool.pool_seq === 1 && (await q('SELECT status FROM campaign_applications WHERE id = $1', [s1])).rows[0].status === 'expired');
  // 취소 — 신청 표가 단일 출처라 영수증 표를 고치지 않아도 풀린다
  await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE id = $1`, [s3]);
  t('★★ 취소된 신청은 영수증을 놓는다(영수증 표는 그대로 · 신청 표가 단일 출처)', (await rp.freeCountsForTab(pool, sheetId, TAB)).free === 2);
  // 리뷰를 낸 영수증 — 그 뒤 취소돼도 다시 주지 않는다(사용자 확정 2026-11-27)
  {
    const s4 = await newApp('90000004');
    const b4 = await bind(s4);
    await q(`UPDATE campaign_applications SET status = 'submitted', submitted_at = NOW() WHERE id = $1`, [s4]);
    const n = await rp.markReviewedRow(pool, sheetId, TAB, b4.pool.seq);
    await q(`UPDATE campaign_applications SET status = 'cancelled', submitted_at = NULL WHERE id = $1`, [s4]);
    t('★★★ 리뷰를 낸 영수증은 그 사람이 취소돼도 다시 배정하지 않는다(reviewed_at)', n === 1 && (await rp.freeCountsForTab(pool, sheetId, TAB)).free === 1
      && (await bind(await newApp('90000005'))).pool.pool_seq !== b4.pool.pool_seq);
    t('리뷰 냄 표시 실패는 던지지 않는다(리뷰 제출을 막지 않음)', await rp.markReviewedRow({ query: async () => { throw new Error('x'); } }, sheetId, TAB, 2) === 0);
    // 시험 데이터 되돌리기(다음 단계는 깨끗한 2장)
    await q(`UPDATE receipt_pool SET reviewed_at = NULL, joined_date = NULL, review_deadline = NULL WHERE sheet_id = $1 AND tab_name = $2`, [sheetId, TAB]);
    await q(`UPDATE campaign_applications SET status = 'cancelled', submitted_at = NULL WHERE campaign_id = $1 AND status IN ('applied','submitted')`, [CAMP]);
  }
  const src = S('src/services/receiptPool.service.js');
  t('영수증 고르기 = 열린 · 줄 있음 · 리뷰 안 냄 · 살아 있는 신청 없음 · 번호 순 · FOR UPDATE SKIP LOCKED',
    /p\.status = 'open' AND p\.seq IS NOT NULL[\s\S]*p\.reviewed_at IS NULL[\s\S]*NOT EXISTS[\s\S]*ca\.status IN \('applied', 'submitted'\)[\s\S]*ORDER BY p\.pool_seq[\s\S]*FOR UPDATE OF p SKIP LOCKED/.test(src));
  t('★ 남은 영수증 수와 배정이 같은 판정 조각(receiptTakenSql)을 쓴다', (src.match(/NOT \$\{receiptTakenSql\('p'/g) || []).length === 2);

  /* ── 4) 상태 엔진 ─────────────────────────────────────────── */
  console.log('\n4) 공고 상태(영수증 공고는 남은 영수증 하나로 연다)');
  const st = require('../src/services/campaignState.service');
  const C = { participation_mode: true, status: 'active', daily_limit: 2, recruit_total: 2, start_date: null, window_start: null, window_end: null, close_buffer_min: 10 };
  const base = { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 };
  const futureSched = { firstDate: T3, lastDate: T3, totalSlots: 2, byDate: { [T3]: 2 }, source: 'sheet' };
  const sOpen = st.computeCampaignState(C, { ...base, receiptFree: 2 }, new Date(NOW), futureSched);
  t('★★ 남은 영수증 2 → open(참여일자 칸이 시트 일정처럼 읽혀도 「오픈 예정」으로 막지 않는다)', sOpen.state === 'open' && sOpen.dailyQuota >= 2);
  const sFull = st.computeCampaignState(C, { ...base, receiptFree: 0 }, new Date(NOW));
  t('★ 남은 영수증 0 → soft_full(receipt_full · 「내일 다시 오픈」 아님)', sFull.state === 'soft_full' && sFull.stateReason === 'receipt_full' && !sFull.reopensAt);
  t('영수증 공고는 날짜별 계획·작업표 오늘 채움을 보지 않는다', st.computeCampaignState(C, { ...base, receiptFree: 1, plans: { [T0]: 0 }, tableTodayFilled: 9, tableTodayQuota: 1 }, new Date(NOW)).state === 'open');
  t('★ 영수증 아님(receiptFree 없음) = 종전 그대로', st.computeCampaignState(C, base, new Date(NOW)).dailyQuota === 2);
  t('공고 정원 재료는 깔때기 맨 뒤에서 싣는다(066 순서 계약 · 예약 다음)', /loadFreeByCampaign\(pool, ids, now\)[\s\S]{0,900}receiptPool\.service'\)\.loadFreeByCampaign\(pool, ids\)[\s\S]{0,500}return out;/.test(S('src/services/campaignState.service.js')));

  /* ── 5) 실제 처리기 ────────────────────────────────────────── */
  console.log('\n5) 신청·참여 상세·참여 확정·내 영수증 처리기');
  const wk = require('../src/utils/workKind');
  const campaignRoutes = require('../src/routes/campaign.routes');
  const submitRoutes = require('../src/routes/submit.routes');
  const apply = handlerOf(campaignRoutes, 'post', '/:id/apply');
  const cancelH = handlerOf(campaignRoutes, 'post', '/:id/cancel');
  const detailH = handlerOf(campaignRoutes, 'get', '/:id/work-detail');
  const publicDetail = handlerOf(campaignRoutes, 'get', '/:id');
  const joinH = handlerOf(submitRoutes, 'post', '/receipt');
  const imgH = handlerOf(submitRoutes, 'post', '/receipt/image');
  const orderH = handlerOf(submitRoutes, 'post', '/order');
  const call = async (h, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    const res = fakeRes(); let err = null;
    await h({ body, params, query, headers, ip: '127.0.0.1', get: () => '' }, res, e => { err = e; });
    if (err) throw err;
    return res;
  };
  const people = [['가짜하나', '01011112222'], ['가짜둘', '01033334444'], ['가짜셋', '01055556666'], ['가짜넷', '01077778888']];
  for (const [n, ph] of people) {
    await q(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder, address) VALUES ($1, $2, '가짜은행', $3, $1, '서울 가짜구')`, [n, ph, '000-' + ph.slice(-4)]);
  }
  const rs = require('../src/services/reviewerSession.service');
  const who = async (i) => {
    const [n, ph] = people[i]; const p8 = ph.slice(-8);
    const id = (await q('SELECT id FROM reviewers WHERE phone8 = $1', [p8])).rows[0].id;
    return { name: n, phone: ph, p8, id, H: { 'x-reviewer-token': rs.issueReviewerSession({ ownerReviewerId: id, loginName: n, loginPhone8: p8 }) } };
  };
  const A = await who(0), B = await who(1), Cc = await who(2), D = await who(3);
  const joinBody = (app, p) => ({ campaignId: CAMP, campaignApplicationId: app.applicationId, holdToken: app.holdToken, holdPhone8: p.p8, loginPhone8: p.p8 });
  const doApply = async (p) => call(apply, { params: { id: CAMP }, body: { name: p.name, phone: p.phone, optionKey: OPT }, headers: p.H });

  const saved = wk.NOT_READY_WORK_KINDS.slice();   // 배포 그대로
  t('★★ 배포 그대로: 준비 중 목록에 receipt 가 있다(3단계도 운영에서 열지 않는다)', wk.NOT_READY_WORK_KINDS.includes('receipt') && wk.isWorkKindReady('receipt') === false);
  const r0 = await doApply(A);
  t('★★★ 배포 그대로의 안전핀: 영수증 공고 신청을 잠금 전에 거절(work_kind_not_ready · 영수증 미점유)', r0.statusCode === 409 && r0.body.reason === 'work_kind_not_ready'
    && (await rp.freeCountsForTab(pool, sheetId, TAB)).free === 2);
  const j0 = await call(joinH, { body: { campaignId: CAMP }, headers: A.H });
  t('★ 참여 확정 창구도 안전핀을 맨 앞에서 본다(409 work_kind_not_ready)', j0.statusCode === 409 && j0.body.code === 'work_kind_not_ready');
  wk.NOT_READY_WORK_KINDS.length = 0;   // ★ 시험 안에서만 — 흐름을 돌리려고 비운다(끝에 saved 로 되돌림)
  let appA = null, appB = null;
  try {
    const pub = await call(publicDetail, { params: { id: CAMP } });
    const rc = pub.body && pub.body.data && pub.body.data.receipt;
    t('★★ 공고 상세(참여 전): 매장·주소·리뷰 기한 · 남은 영수증 2/2', rc && rc.placeName === OPT && rc.placeAddress === '서울 가짜구 가짜로 1'
      && rc.reviewDeadlineDays === 3 && rc.free === 2 && rc.total === 2 && pub.body.data.state === 'open');
    t('★ 공고 카드 재료: 남은 영수증 숫자(receiptLeft)', pub.body.data.receiptLeft === 2);
    t('★★★ 공고 상세에 영수증 파일 번호·플레이스 주소·작업표 위치가 없다(결정 041·431)', !JSON.stringify(pub.body).includes('fake_receipt_')
      && !('placeUrl' in rc) && !/sheet_id|seq|file/i.test(JSON.stringify(rc)));

    const okA = await doApply(A);
    t('★★★ 참여 → 안 쓴 영수증 한 장(1번)이 바로 묶인다', okA.statusCode === 200 && okA.body.ok && okA.body.receiptSeat && okA.body.receiptSeat.receiptNo === 1
      && okA.body.receiptSeat.joinedDate === T0 && okA.body.receiptSeat.reviewDeadline === T3);
    t('참여 응답에 파일 번호 없음', !JSON.stringify(okA.body).includes('fake_receipt_'));
    appA = okA.body;
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [appA.applicationId, A.id]);
    const det0 = await call(detailH, { params: { id: CAMP }, query: { phone8: A.p8, holdToken: appA.holdToken } });
    const v0 = det0.body.receiptSeat;
    t('★ 참여 상세(확정 전): 영수증 1번 · 마감일 · 매장 안내(플레이스 주소 = 참여 후 공개) · 아직 확정 아님',
      det0.body.ok && v0 && v0.receiptNo === 1 && v0.reviewDeadline === T3 && v0.joined === false && v0.reviewDone === false
      && v0.place && /^https:\/\/map\.naver\.com\//.test(v0.place.placeUrl) && det0.body.canChangeOption === false);
    t('★★ 참여 상세에도 파일 번호 없음', !JSON.stringify(det0.body).includes('fake_receipt_'));
    reads.length = 0;
    const imgEarly = await call(imgH, { body: joinBody(appA, A), headers: A.H });
    t('확정 전에는 영수증을 내주지 않는다(409 · 드라이브 읽기 0)', imgEarly.statusCode === 409 && imgEarly.body.code === 'RECEIPT_NOT_JOINED' && reads.length === 0);
    const viaOrder = await call(orderH, { body: { ...joinBody(appA, A), orderer: A.name }, headers: A.H });
    t('★★ 구매양식 창구는 영수증 배정 신청을 받지 않는다(receipt_use_join)', viaOrder.statusCode === 409 && viaOrder.body.reason === 'receipt_use_join');
    const jNoTok = await call(joinH, { body: joinBody(appA, A) });
    t('참여 확정: 리뷰어 세션 필수(401)', jNoTok.statusCode === 401);
    const jOther = await call(joinH, { body: joinBody(appA, A), headers: B.H });
    t('★★ 참여 확정: 다른 리뷰어 세션 = 403(남의 참여를 확정하지 못한다)', jOther.statusCode === 403 && (await q('SELECT status FROM campaign_applications WHERE id = $1', [appA.applicationId])).rows[0].status === 'applied');
    const okJ = await call(joinH, { body: joinBody(appA, A), headers: A.H });
    const poolA = await rp.poolForApplication(pool, appA.applicationId);
    t('★★★ 참여 확정 → 신청 확정(submitted) · 배정된 영수증 줄에만 기록', okJ.statusCode === 200 && okJ.body.ok && Number(okJ.body.target.rowIndex) === poolA.seq
      && (await q('SELECT status FROM campaign_applications WHERE id = $1', [appA.applicationId])).rows[0].status === 'submitted');
    const cpA = (await q(`SELECT row_json, order_submission_id FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [sheetId, TAB, poolA.seq])).rows[0];
    const lab = ymd => rp.joinDatesFor(ymd, 0).joinedLabel;
    t('★★ 작업표 그 줄: 참여일자 = 참여일(KST) · 리뷰마감일 = 참여일 + 3일 · 수취인 · 영수증 칸 그대로', cpA.row_json['참여일자'] === lab(T0)
      && cpA.row_json['리뷰마감일'] === lab(T3) && cpA.row_json['수취인'] === A.name && cpA.row_json['영수증'] === '1번' && cpA.order_submission_id);
    const again = await call(joinH, { body: joinBody(appA, A), headers: A.H });
    t('★ 다시 누르면 같은 줄(멱등 — 리뷰 단계가 줄 위치를 받는 길)', again.statusCode === 200 && again.body.alreadySubmitted === true && Number(again.body.target.rowIndex) === poolA.seq);
    const det1 = await call(detailH, { params: { id: CAMP }, query: { phone8: A.p8, holdToken: appA.holdToken } });
    t('★ 참여 상세(확정 뒤): joined · 리뷰 아직(완료 화면 아님)', det1.body.receiptSeat.joined === true && det1.body.receiptSeat.reviewDone === false);

    /* 마감 안내(결정 422 단일 출처) */
    const seatAt = ms => rp.reviewerSeatView(poolA, null, new Date(ms));
    t('★ 「내일 마감」(마감 전날 · 서버 KST)', seatAt(NOW + 2 * DAY).reviewDeadlineState === 'tomorrow' && seatAt(NOW + 2 * DAY).reviewDeadlineNotice === '내일 마감');
    t('★ 「오늘 마감」(마감 날)', seatAt(NOW + 3 * DAY).reviewDeadlineState === 'today' && seatAt(NOW + 3 * DAY).reviewDeadlineNotice === '오늘 마감');
    t('마감 지나면 overdue(리뷰어 안내 글자 없음 · 막지 않음)', seatAt(NOW + 4 * DAY).reviewDeadlineState === 'overdue' && seatAt(NOW + 4 * DAY).reviewDeadlineNotice === '');
    const dlMap = await require('../src/services/bookingSlots.service').reviewDeadlinesForRows(pool, [{ sheetId, tabName: TAB, rowIndex: poolA.seq }]);
    t('★★ 리뷰어 검색 결과 마감 안내 재료(reviewDeadlinesForRows)가 영수증 줄의 리뷰마감일을 읽는다', dlMap && dlMap.get(`${sheetId}||${TAB}||${poolA.seq}`) === T3);
    t('★ 담당자 작업보드 「마감 지남」 재료도 영수증 줄을 읽는다(같은 판정 · 같은 칸)', /FROM booking_slots WHERE sheet_id=\$1 AND tab_name=\$2\s*\n\s*UNION ALL SELECT seq, to_char\(review_deadline, 'YYYY-MM-DD'\) FROM receipt_pool/.test(S('src/services/trackB.service.js')));

    /* ── 6) 내 영수증 보기 — 배정된 리뷰어만 ─────────────────── */
    console.log('\n6) 내 영수증 보기(비공개)');
    reads.length = 0;
    const iNo = await call(imgH, { body: joinBody(appA, A) });
    t('★★ 무인증 = 401 · 드라이브 읽기 0', iNo.statusCode === 401 && reads.length === 0);
    const iOther = await call(imgH, { body: joinBody(appA, A), headers: B.H });
    t('★★★ 다른 리뷰어 = 403 · 드라이브 읽기 0', iOther.statusCode === 403 && reads.length === 0);
    const iBadTok = await call(imgH, { body: { ...joinBody(appA, A), holdToken: 'wrong' }, headers: A.H });
    t('★ 홀드 토큰이 틀리면 403 · 드라이브 읽기 0', iBadTok.statusCode === 403 && reads.length === 0);
    const iOk = await call(imgH, { body: joinBody(appA, A), headers: A.H });
    t('★★★ 배정된 본인 = 그 영수증 사진(1번 파일) · 캐시 금지 · 사진 형식만', iOk.statusCode === 200 && Buffer.isBuffer(iOk.sent) && iOk.sent.toString() === 'IMG:' + FID(1)
      && iOk.headers['Cache-Control'] === 'private, no-store' && iOk.headers['Content-Type'] === 'image/jpeg' && reads.join() === FID(1));
    // 무인증 공개 사진 통로 — 배정된 영수증 번호도 거절(결정 352·420 거절 목록)
    {
      const express = require('express');
      const appx = express();
      appx.use('/api/drive', require('../src/routes/drive.routes'));
      appx.use('/api/order', require('../src/routes/order.routes'));
      require('../src/services/imageAllowlist.service').__resetCacheForTest();
      // PGlite 에 없는 확장(pg_trgm)을 쓰는 081 이 못 만든 사진 출처 표 — 판정 SQL 이 읽는 칸만(결정 352·420 시험과 같은 모양)
      await q('CREATE TABLE IF NOT EXISTS review_inspections (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL)');
      await q(`INSERT INTO guide_image_files (file_id, source) VALUES ($1, 'test') ON CONFLICT DO NOTHING`, [FID(1)]).catch(() => {});
      const srv = http.createServer(appx);
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${srv.address().port}`;
      reads.length = 0;
      const p1 = await fetch(base + '/api/drive/image/' + FID(1), { redirect: 'manual' });
      const p2 = await fetch(base + '/api/order/guide-image/' + FID(1), { redirect: 'manual' });
      srv.close();
      t('★★★ 무인증 사진 통로 2곳은 배정된 영수증 번호도 404 · 드라이브 읽기 0(공개 목록에 함께 적혀도)', p1.status === 404 && p2.status === 404 && reads.length === 0);
    }

    /* ── 7) 다 나감 → 「마감」 · 취소·줄 삭제로 돌아옴 ───────────── */
    console.log('\n7) 마감 · 리뷰 전 취소/줄 삭제 → 다음 사람에게 다시 배정');
    const okB = await doApply(B);
    appB = okB.body;
    t('두 번째 참여 = 2번 영수증', okB.statusCode === 200 && okB.body.receiptSeat.receiptNo === 2);
    const lostC = await doApply(Cc);
    t('★★★ 마지막 영수증이 나간 뒤 = 409 receipt_sold_out(「마감」 문구 · 영수증 미점유)', lostC.statusCode === 409 && lostC.body.reason === 'receipt_sold_out' && /마감/.test(lostC.body.error));
    const pubFull = await call(publicDetail, { params: { id: CAMP } });
    t('★ 공고 상태 = soft_full(총원 · 영수증 다 나감) · 남은 영수증 0', pubFull.body.data.state === 'soft_full'
      && pubFull.body.data.receipt.free === 0 && pubFull.body.data.receiptLeft === 0);
    // 리뷰 전 취소(확정 전 홀드 — 리뷰어 [참여 취소])
    const cB = await call(cancelH, { params: { id: CAMP }, body: { phone8: B.p8, holdToken: appB.holdToken } });
    t('★★ 리뷰어 참여 취소(실제 처리기) → 2번 영수증이 돌아온다', cB.statusCode === 200 && (await rp.freeCountsForTab(pool, sheetId, TAB)).free === 1);
    const okC = await doApply(Cc);
    t('★★★ 다음 참여자가 돌아온 2번 영수증을 받는다', okC.statusCode === 200 && okC.body.receiptSeat.receiptNo === 2);
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [okC.body.applicationId, Cc.id]);
    const okCJ = await call(joinH, { body: joinBody(okC.body, Cc), headers: Cc.H });
    t('두 장 모두 참여 확정(제출 확정 2 = 모집 2)', okCJ.statusCode === 200 && (await q(`SELECT COUNT(*)::int AS n FROM campaign_applications WHERE campaign_id = $1 AND status = 'submitted'`, [CAMP])).rows[0].n === 2);
    t('★★★ 영수증이 다 나가도 공고 마감을 저장하지 않는다(closed 영속 없음 — 돌아온 영수증을 다시 주려고)', (await q('SELECT status FROM recruit_campaigns WHERE id = $1', [CAMP])).rows[0].status === 'active');
    // 리뷰 전 줄 삭제(확정된 참여 — 담당자 작업보드 [줄 삭제])
    const tb = require('../src/services/trackB.service');
    const rowA = (await q(`SELECT id FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL`, [sheetId, TAB, poolA.seq])).rows[0].id;
    const del = await tb.hideWorkdeskRow({ sheetId, tabName: TAB, rowId: rowA, by: 'test', actorRole: 'admin' });
    const stA = (await q('SELECT status FROM campaign_applications WHERE id = $1', [appA.applicationId])).rows[0].status;
    const pool1 = (await rp.poolForTab(pool, sheetId, TAB)).find(x => x.pool_seq === 1);
    t('★★ 줄 삭제(실제 처리기) → 그 참여 취소 · 1번 영수증이 보충 줄로 옮겨 다시 비었다', del && del.ok !== false && stA === 'cancelled'
      && pool1 && pool1.seq !== poolA.seq && (await rp.freeCountsForTab(pool, sheetId, TAB)).free === 1);
    const okD = await doApply(D);
    const poolD = okD.body && okD.body.ok ? await rp.poolForApplication(pool, okD.body.applicationId) : null;
    t('★★★ 다음 참여자가 1번 영수증을 새 줄로 받는다(옛 줄 아님)', okD.statusCode === 200 && okD.body.receiptSeat.receiptNo === 1 && poolD && poolD.seq === pool1.seq);
    t('남은 영수증 0 으로 돌아감', (await rp.freeCountsForTab(pool, sheetId, TAB)).free === 0);
  } finally {
    wk.NOT_READY_WORK_KINDS.length = 0; wk.NOT_READY_WORK_KINDS.push(...saved);
  }
  t('★★ 시험 뒤 준비 중 목록 원상 복귀(배포 그대로 · receipt 포함)', JSON.stringify(wk.NOT_READY_WORK_KINDS) === JSON.stringify(saved) && wk.NOT_READY_WORK_KINDS.includes('receipt'));

  /* ── 8) 정적 계약 ─────────────────────────────────────────── */
  console.log('\n8) 처리기 순서·화면 계약');
  const routes = S('src/routes/campaign.routes.js');
  const ap = routes.slice(routes.indexOf("let receiptApply = false;"), routes.indexOf("await client.query('COMMIT');", routes.indexOf('let receiptBind = null;')));
  t('★ 영수증 배정 = 잠금 안 · INSERT 뒤 · 못 묶으면 ROLLBACK(fail-closed)', ap.indexOf("const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE'") > 0
    && ap.indexOf('INSERT INTO campaign_applications') < ap.indexOf('receiptPoolSvc.bindReceiptForApply(client')
    && /if \(!rb \|\| !rb\.ok\) \{\s*await client\.query\('ROLLBACK'\);/.test(ap));
  t('★ 영수증 참여는 개수 단계·작업표 빈 줄 관문·차례 줄·재구매 기간을 타지 않는다(같은 공고 한 번)', /if \(!blogApply && !qnaApply && !bookingApply && !receiptApply\) \{/.test(routes)
    && /!bookingApply && !receiptApply && camp\.linked_sheet_id/.test(routes) && /!bookingApply && !receiptApply && !blogApply && holdChain\.chainEligibleCampaign/.test(routes)
    && /if \(\(qnaApply \|\| bookingApply \|\| receiptApply\) && sameCampaignSubmittedAt\)/.test(routes));
  t('잠근 공고로 종류 재확인(영수증 여부가 갈리면 막음)', /isReceiptKind\(_lockedKind\) !== receiptApply/.test(routes));
  const sub = S('src/routes/submit.routes.js');
  t('★ 리뷰 제출 커밋 뒤 「리뷰 냄」 표시(제출 트랜잭션 밖)', /await completionClient\.query\('COMMIT'\);[\s\S]{0,400}receiptPool\.service'\)\.markReviewedRow\(pool, sheetId, tabName, rowIndex\)/.test(sub));
  t('★ 영수증 보기 = 비공개 목록 확인 뒤에만 드라이브 읽기 · 응답에 파일 번호 없음', /isRegisteredReceiptFile\(c\.rp\.file_id\)\)\) return res\.status\(404\)[\s\S]{0,80}sendReceiptImage\(res, c\.rp\.file_id\)/.test(sub));
  t('★ 본인 확인 = 리뷰어 세션 소유자 = 참여 소유자(소유자 모르면 거절)', /if \(!app\.owner_reviewer_id \|\| String\(app\.owner_reviewer_id\) !== String\(session\.ownerReviewerId\)\)/.test(sub));
  const cv = F('campaign.html');
  t('화면: 리뷰 캡처까지 내야 완료(_isDoneDetail 영수증 갈래)', /if\(isReceiptCampaign\(\) \|\| j\.receiptSeat\) return !!\(j\.receiptSeat && j\.receiptSeat\.reviewDone === true\);/.test(cv));
  t('★ 화면: 내 영수증은 헤더 인증 fetch → blob(주소를 만들지 않는다 · 캐시 금지)', /\/api\/submit\/receipt\/image', \{ method:'POST', cache:'no-store'[\s\S]{0,300}\{ blob: true/.test(cv) && /URL\.createObjectURL\(blob\)/.test(cv)
    && !/drive\/image|guide-image/.test(cv.slice(cv.indexOf('결정 432 — 영수증리뷰 ═══'), cv.indexOf('function startHoldCountdown('))));
  t('화면: 영수증 공고 안내를 못 받으면 [참여하기] 잠금 · 남은 0 = 「마감」', /if\(!\(c && c\.receipt\)\)\{ jb\.disabled = true;/.test(cv) && /마감 — 영수증이 모두 나갔어요/.test(cv));
  t('화면: 마지막 영수증 거절 → 공고 다시 받기(receipt_sold_out)', /if\(j\.reason === 'receipt_sold_out' \|\| j\.reason === 'receipt_place_unknown'\)\{ hideAcctSheet\(\); toast\(_applyReasonText\(j\)\); await loadCampaign\(\); return; \}/.test(cv));
  const cards = F('js/campaign-cards.js');
  t('모집 카드: 🧾 영수증리뷰 배지 + 「영수증 N장 남음」(숫자 receiptLeft 만)', /🧾 영수증리뷰<\/span>\$\{typeof c\.receiptLeft === 'number'/.test(cards) && /영수증 \$\{Number\(c\.receiptLeft\)\}장 남음/.test(cards));
  t('발행 폼 카드: receipt_spec 에 파일 번호 없음(장수만)', (() => { const r = require('../src/utils/receiptPool').receiptSpecForScreen(wo); return r && r.total === 2 && r.placeName === OPT && !JSON.stringify(r).includes('fake_receipt_'); })());

  console.log(`\n✅ receiptReviewerFlow: ${pass}개 통과\n`);
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
