/**
 * bookingPayment.test.js — 네이버예약리뷰 5단계 회귀가드: 입금(환급형 = 결제금액 + 리뷰비 · 무료체험형 = 리뷰비만) (결정 411)
 * 실행: node tests/bookingPayment.test.js
 *
 * 위험:
 *  ① 예약리뷰 줄이 종전처럼 `no_price`(결제금액 조회안됨)로 멈춰 입금관리에 영영 안 올라온다(무료체험형은 결제금액 칸이 아예 없다).
 *  ② 환급형에서 리뷰어가 적은 결제금액이 오더의 1건 금액보다 크거나 비었는데 그대로(또는 상한으로 꾸며) 나간다 — 과지급·추측 지급.
 *  ③ 무료체험형에 결제금액이 섞여 나간다(업체가 현장에서 무료 처리했다).
 *  ④ 예약내역(예약번호) 없이 리뷰만 낸 줄, 리뷰 전 줄이 돈을 받는다.
 *  ⑤ 무료체험형 회차 항목이 「리뷰비만 보낸 건」(결정 292 split 모양)으로 읽혀 입금일·지급완료 없이 끝난다(결정 321·376 과 같은 함정).
 *  ⑥ 이체 파일(다운로드)에 다른 금액이 찍힌다.
 *  ⑦ 준비 중 목록(NOT_READY_WORK_KINDS)이 시험 뒤 배포 그대로가 아니다(결정 414 개방 뒤 = 빈 목록).
 * ★ 작업표 접수·신청·예약내역 제출·리뷰 제출 표시·입금 대상·회차 담기·이체 파일은 PGlite(저장소 migrations 그대로)에서 실제로 돌린다.
 *   운영 DB 에 닿지 않는다(가짜 이름·가짜 매장·가짜 계좌). 신청·예약내역 처리기는 시험 안에서만 준비 중 목록을 비워 돈다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const SERVER = path.join(__dirname, '..');
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booking-step5-secret';

const DAY = 86400000;
const kstYmd = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const NOW = Date.now();
const T1 = kstYmd(NOW + DAY), T2 = kstYmd(NOW + 2 * DAY);

async function openDb() {
  const mod = process.env.PGLITE_MODULE || '@electric-sql/pglite';
  const { PGlite } = require(mod);
  // 회차 표(payment_batch_items 의 계좌 지문 칸 · migration 121)가 pgcrypto 를 쓴다 — PGlite 확장으로 그대로 올린다(표를 손으로 만들지 않는다)
  const extensions = {};
  // 시험 실행기(test-bootstrap)는 PGLITE_MODULE 에 파일 경로(…/dist/index.cjs)를 넣는다 — 확장은 그 설치본 기준으로 찾는다
  const base = path.dirname(require.resolve(mod));
  const ext = n => require(require.resolve('@electric-sql/pglite/contrib/' + n, { paths: [base] }))[n];
  try { extensions.pgcrypto = ext('pgcrypto'); extensions.pg_trgm = ext('pg_trgm'); } catch (_) { /* 없으면 아래 확인이 알려 준다 */ }
  const db = new PGlite({ extensions });
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에서 안 도는 몇 파일 — 이 시험의 표와 무관(아래에서 필요한 칸을 확인) */ }
  }
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'payment_batch_items'`)).rows.map(r => r.column_name);
  for (const c of ['account_snapshot_fingerprint', 'is_qna', 'zero_price_purchase']) assert(cols.includes(c), 'PGlite 회차 표에 ' + c + ' 칸이 없다(마이그레이션 적용 실패)');
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
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.setHeader = res.set;
  return res;
}
function handlerOf(router, method, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  return layer && layer.route.stack[layer.route.stack.length - 1].handle;
}

(async () => {
  console.log('\n▶ 네이버예약리뷰 5단계 — 입금(환급형 결제금액 + 리뷰비 · 무료체험형 리뷰비만)\n');

  /* ── 0) 판정 단일 출처(순수 함수) ─────────────────────────────── */
  console.log('0) 판정 표 — bookingPayoutOf');
  {
    const db0 = null;   // 순수 함수 — DB 없음
    void db0;
    const { bookingPayoutOf } = require('../src/services/payment.service');
    t('판정 함수가 있다(payment.service 단일 출처)', typeof bookingPayoutOf === 'function');
    const refund = { payMode: 'refund', pay: 25000 };
    const free = { payMode: 'free', pay: 0 };
    const J = o => JSON.stringify(o);
    t('예약리뷰가 아니면 null(종전 규칙 그대로)', bookingPayoutOf({ isBooking: false, place: refund, payoutMode: 'ours', productPrice: 9000, reservationNo: 'R1' }) === null);
    const ok = bookingPayoutOf({ isBooking: true, place: refund, payoutMode: 'ours', productPrice: 25000, reservationNo: 'R1' });
    t('★ 환급형: 적은 결제금액(25,000 = 1건 금액) 그대로 · 막지 않음', ok.payMode === 'refund' && ok.productPrice === 25000 && ok.cap === 25000 && J(ok.issues) === '[]' && ok.free === false);
    const under = bookingPayoutOf({ isBooking: true, place: refund, payoutMode: 'ours', productPrice: 18000, reservationNo: 'R1' });
    t('★ 환급형: 1건 금액보다 적게 냈으면 낸 만큼(18,000 · 상한으로 올리지 않음)', under.productPrice === 18000 && J(under.issues) === '[]');
    const over = bookingPayoutOf({ isBooking: true, place: refund, payoutMode: 'ours', productPrice: 30000, reservationNo: 'R1' });
    t('★★ 환급형: 1건 금액(25,000)보다 크면 담당자 확인(booking_pay_over) — 상한으로 깎아 보내지 않는다', J(over.issues) === '["booking_pay_over"]' && over.productPrice === 30000);
    const miss = bookingPayoutOf({ isBooking: true, place: refund, payoutMode: 'ours', productPrice: 0, reservationNo: 'R1' });
    t('★★ 환급형: 결제금액이 없으면 담당자 확인(booking_pay_missing) — 0원·상한으로 꾸미지 않는다', J(miss.issues) === '["booking_pay_missing"]');
    const fr = bookingPayoutOf({ isBooking: true, place: free, payoutMode: 'ours', productPrice: 12000, reservationNo: 'R1' });
    t('★★ 무료체험형: 결제금액은 무시(0) · 리뷰비만 · 표시 free', fr.payMode === 'free' && fr.productPrice === 0 && fr.free === true && J(fr.issues) === '[]');
    const noResv = bookingPayoutOf({ isBooking: true, place: free, payoutMode: 'ours', productPrice: 0, reservationNo: '  ' });
    t('★ 예약번호(예약내역) 없음 = booking_no_reservation', noResv.issues.includes('booking_no_reservation'));
    const unk = bookingPayoutOf({ isBooking: true, place: null, payoutMode: 'ours', productPrice: 25000, reservationNo: 'R1' });
    t('★★ 예약 설정(환급형/무료체험형)을 모름 = booking_place_unknown(fail-closed)', unk.issues.includes('booking_place_unknown') && unk.free === false);
    const badMode = bookingPayoutOf({ isBooking: true, place: { payMode: 'x', pay: 1 }, payoutMode: 'ours', productPrice: 25000, reservationNo: 'R1' });
    t('알 수 없는 돈 방식 = booking_place_unknown', badMode.issues.includes('booking_place_unknown'));
    const noCap = bookingPayoutOf({ isBooking: true, place: { payMode: 'refund', pay: 0 }, payoutMode: 'ours', productPrice: 25000, reservationNo: 'R1' });
    t('환급형인데 1건 금액을 모름(0) = booking_place_unknown(상한 없이 보내지 않음)', noCap.issues.includes('booking_place_unknown'));
    const split = bookingPayoutOf({ isBooking: true, place: refund, payoutMode: 'split', productPrice: 25000, reservationNo: 'R1' });
    t('★ 제품비 업체(split) 이체은행 = booking_payout_mode(예약리뷰는 우리 은행만 · 작업 조건에서 바꾸면 풀림)', split.issues.includes('booking_payout_mode'));
  }

  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  // 0) 에서 pool 없이 불러온 서비스는 버리고 PGlite 로 다시 불러온다
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(SERVER, 'src') + path.sep) && k !== poolPath) delete require.cache[k];
  const q = (s, p) => pool.query(s, p);
  const wk = require('../src/utils/workKind');
  const bs = require('../src/services/bookingSlots.service');
  const pay = require('../src/services/payment.service');

  /* ── 1) 예약 작업표 두 개(환급형 · 무료체험형) + 공고 ───────────── */
  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);
  const acc = require('../src/services/sheetlessAccept.service');
  const works = {};
  async function makeWork({ key, tab, woId, campId, payMode, pay: unit, fee, dates, manager }) {
    const total = dates.reduce((n, d) => n + d.count, 0);
    const place = { name: tab + ' 매장', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
      base: { pay: unit, count: total, daily: 0, review_type_mix: [] }, options: [],
      booking: { pay_mode: payMode, dates, review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1' } };
    const wo = { id: woId, title: tab, work_kind: 'booking', workboard_schema_version: 2, recruit_count: total, review_fee: fee,
      pay_amount: unit * total, start_date: null, product_options_json: JSON.stringify([place]), work_manager: manager };
    await q(`INSERT INTO work_orders (id, title, work_kind, workboard_schema_version, recruit_count, review_fee, pay_amount, product_options_json, status, work_manager)
             VALUES ($1, $2, 'booking', 2, $3, $4, $5, $6, 'published', $7)`, [woId, tab, total, fee, unit * total, wo.product_options_json, manager]);
    const made = await acc.createSheetlessWorktable({ workOrder: wo, tabName: tab, by: 'test' });
    await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'booking', TRUE, 2)`, [made.sheetId, tab, made.gid]);
    await made.persist();
    await q(`UPDATE work_orders SET linked_tab_sheet_id = $2, linked_tab_name = $3 WHERE id = $1`, [woId, made.sheetId, tab]);
    await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, linked_tab_gid, work_kind,
               recruit_total, daily_limit, hold_ttl_min, multi_account_mode, review_fee, transfer_bank, transfer_memo)
             VALUES ($1, $2, 'active', TRUE, $3, $4, $5, 'booking', $6, $6, 20, FALSE, $7, '케이뱅크', '인애드')`, [campId, tab, made.sheetId, tab, made.gid, total, fee]);
    await q(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, pay_amount, recruit_total, daily_limit, status, sort_order)
             VALUES ($1, $2, $2, 'product', $3, $4, 0, 'active', 0)`, [campId, place.name, unit, total]);
    works[key] = { sheetId: made.sheetId, tab, campId, opt: place.name, payMode };
  }
  await makeWork({ key: 'R', tab: '12월 가짜식당 환급', woId: 'wo_bk5_refund', campId: 'camp_bk5_refund', payMode: 'refund', pay: 25000, fee: 5000,
    dates: [{ date: T1, count: 3 }, { date: T2, count: 1 }], manager: '만두' });
  await makeWork({ key: 'F', tab: '12월 가짜카페 무료', woId: 'wo_bk5_free', campId: 'camp_bk5_free', payMode: 'free', pay: 0, fee: 3000,
    dates: [{ date: T1, count: 2 }], manager: '망고' });
  t('준비: 환급형 4자리 · 무료체험형 2자리', (await bs.calendarForTab(pool, works.R.sheetId, works.R.tab)).length === 4
    && (await bs.calendarForTab(pool, works.F.sheetId, works.F.tab)).length === 2);

  /* ── 2) 리뷰어 신청 → 예약내역 제출(실제 처리기) ─────────────────── */
  console.log('\n2) 신청 · 예약내역 제출(실제 처리기 · 시험 안에서만 준비 중 목록을 비움)');
  const campaignRoutes = require('../src/routes/campaign.routes');
  const submitRoutes = require('../src/routes/submit.routes');
  const apply = handlerOf(campaignRoutes, 'post', '/:id/apply');
  const subH = handlerOf(submitRoutes, 'post', '/booking');
  const call = async (h, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    const res = fakeRes(); let err = null;
    await h({ body, params, query, headers, ip: '127.0.0.1', get: () => '' }, res, e => { err = e; });
    if (err) throw err;
    return res;
  };
  const people = {};
  let n = 0;
  async function reserve(who, workKey, date, payAmount) {
    n++;
    const w = works[workKey];
    const phone = '0105555' + String(1000 + n);
    const p8 = phone.slice(-8);
    await q(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder, address) VALUES ($1, $2, '국민은행', $3, $1, '서울 가짜구')`,
      [who, phone, '9000000000' + n]);
    const ap = await call(apply, { params: { id: w.campId }, body: { name: who, phone, bookingDate: date, optionKey: w.opt } });
    assert(ap.statusCode === 200 && ap.body.ok, '신청 실패 ' + who + ' ' + JSON.stringify(ap.body));
    const appId = ap.body.applicationId, holdToken = ap.body.holdToken;
    const rid = (await q(`SELECT id FROM reviewers WHERE phone8 = $1`, [p8])).rows[0].id;
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [appId, rid]);
    const tok = require('../src/services/reviewerSession.service').issueReviewerSession({ ownerReviewerId: rid, loginName: who, loginPhone8: p8 });
    const sub = await call(subH, { headers: { 'x-reviewer-token': tok },
      body: { campaignId: w.campId, campaignApplicationId: appId, holdToken, holdPhone8: p8, reservationNo: 'R' + (7000 + n), ...(payAmount != null ? { payAmount } : {}) } });
    assert(sub.statusCode === 200 && sub.body.ok, '예약내역 제출 실패 ' + who + ' ' + JSON.stringify(sub.body));
    people[who] = { ...w, rowIndex: Number(sub.body.target.rowIndex), orderId: sub.body.orderSubmissionId, phone8: p8 };
    return people[who];
  }
  const saved = wk.NOT_READY_WORK_KINDS.slice();
  wk.NOT_READY_WORK_KINDS.length = 0;   // ★ 시험 안에서만
  try {
    await reserve('가짜환급', 'R', T1, '25,000');      // 정상 — 25,000 + 5,000
    await reserve('가짜초과', 'R', T1, 30000);         // 1건 금액보다 큼 → 담당자 확인
    await reserve('가짜번호없음', 'R', T1, 20000);     // 예약번호 칸을 비운 줄(손으로 넣은 줄 흉내) → 예약내역 없음
    await reserve('가짜빈금액', 'R', T2, 25000);       // 결제금액을 지운 줄 → 담당자 확인
    await reserve('가짜무료', 'F', T1, null);          // 무료체험형 — 리뷰비 3,000만
    await reserve('가짜리뷰전', 'F', T1, null);        // 예약내역만 · 리뷰 아직 → 대상 아님
  } finally {
    wk.NOT_READY_WORK_KINDS.length = 0; wk.NOT_READY_WORK_KINDS.push(...saved);
  }
  // 결정 418 — 준비 중 목록에 영수증리뷰(receipt)가 들어갔다: 「배포 그대로」 = 시험 전 목록과 같음 + booking 없음(의미 불변)
  t('★★★ 시험 뒤 준비 중 목록 원상 복귀(배포 그대로 = booking 개방 · 결정 414)', JSON.stringify(wk.NOT_READY_WORK_KINDS) === JSON.stringify(saved)
    && !wk.NOT_READY_WORK_KINDS.includes('booking') && wk.isWorkKindReady('booking') === true);
  t('환급형 예약내역: 작업표 결제금액 칸 = 리뷰어가 적은 금액', String((await q(`SELECT row_json->>'결제금액' AS v FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND seq=$3`,
    [works.R.sheetId, works.R.tab, people['가짜초과'].rowIndex])).rows[0].v).replace(/\D/g, '') === '30000');

  // 손질: 예약번호 없는 줄 · 결제금액 없는 줄
  await q(`UPDATE campaign_participants SET row_json = row_json - '예약번호' WHERE sheet_id=$1 AND tab_name=$2 AND seq=$3`, [works.R.sheetId, works.R.tab, people['가짜번호없음'].rowIndex]);
  await q(`UPDATE campaign_participants SET row_json = jsonb_set(row_json, '{결제금액}', '""') WHERE sheet_id=$1 AND tab_name=$2 AND seq=$3`, [works.R.sheetId, works.R.tab, people['가짜빈금액'].rowIndex]);
  await q(`UPDATE order_submissions SET price = NULL WHERE id = $1`, [people['가짜빈금액'].orderId]);

  /* ── 3) 리뷰 제출 표시(작업표 리뷰 칸 · 실제 상태 기록기) ─────────── */
  const st = require('../src/services/sheetlessStatus.service');
  for (const who of ['가짜환급', '가짜초과', '가짜번호없음', '가짜빈금액', '가짜무료']) {
    const p = people[who];
    const r = await st.markStatusCell({ sheetId: p.sheetId, tabName: p.tab, rowIndex: p.rowIndex, kind: 'submit', by: 'test' });
    assert(r.handled && r.ok !== false, '리뷰 제출 표시 실패 ' + who + ' ' + JSON.stringify(r));
  }
  await require('../src/services/sheetlessLedger.service').rebuildLedgers({ sheetId: works.R.sheetId, tabName: works.R.tab, by: 'test' });
  await require('../src/services/sheetlessLedger.service').rebuildLedgers({ sheetId: works.F.sheetId, tabName: works.F.tab, by: 'test' });

  /* ── 4) 입금 대상(실제 listPaymentTargets) ─────────────────────── */
  console.log('\n4) 입금 대상');
  const { items } = await pay.listPaymentTargets({ includeFinished: true });
  const of = who => items.find(it => it.sheetId === people[who].sheetId && it.tabName === people[who].tab && Number(it.rowIndex) === people[who].rowIndex);
  const A = of('가짜환급'), O = of('가짜초과'), NR = of('가짜번호없음'), E = of('가짜빈금액'), FR = of('가짜무료'), PRE = of('가짜리뷰전');
  const brief = it => it && JSON.stringify({ p: it.productPrice, f: it.reviewFee, a: it.amount, i: it.issues, ok: it.payable });
  console.log('    환급', brief(A), '\n    초과', brief(O), '\n    번호없음', brief(NR), '\n    빈금액', brief(E), '\n    무료', brief(FR));
  t('★★★ 환급형 = 결제금액 25,000 + 리뷰비 5,000 = 30,000 · 지급 대상(no_price 로 멈추지 않음)', A && A.payable === true && A.productPrice === 25000 && A.reviewFee === 5000 && A.amount === 30000);
  t('★★ 환급형 1건 금액 초과 = 보류(booking_pay_over) · 금액은 적은 그대로 보여 줌(깎아 꾸미지 않음)', O && O.payable === false && O.issues.includes('booking_pay_over') && O.productPrice === 30000);
  t('★★ 예약번호 없는 줄 = 보류(booking_no_reservation)', NR && NR.payable === false && NR.issues.includes('booking_no_reservation'));
  t('★★ 결제금액이 빈 환급형 줄 = 보류(booking_pay_missing · no_price 아님)', E && E.payable === false && E.issues.includes('booking_pay_missing') && !E.issues.includes('no_price'));
  t('★★★ 무료체험형 = 리뷰비 3,000 만 · 제품비 0 · 지급 대상', FR && FR.payable === true && FR.productPrice === 0 && FR.reviewFee === 3000 && FR.amount === 3000 && FR.bookingFree === true);
  t('★ 리뷰 전(예약내역만) 줄은 대상이 아니다', !PRE);
  t('★ 담당자 = 작업담당(만두·망고) 그대로 — 입금관리 담당자 칩에 정상으로 실린다', A.manager === '만두' && FR.manager === '망고');
  t('예약리뷰는 「0원 구매」 판정(결정 376)을 타지 않는다', A.zeroPricePurchase === false && FR.zeroPricePurchase === false);
  // 직원이 작업보드에서 예약번호 칸을 채우면(편집 덧씌움) 풀린다 — 작업보드 표시값을 읽는다
  await q(`INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_text, created_by)
           VALUES ($1, $2, 'order', $3, 'col:예약번호', 'text', 'R9999', 'staff#1')`, [works.R.sheetId, works.R.tab, people['가짜번호없음'].orderId]);
  {
    const { items: again } = await pay.listPaymentTargets({ includeFinished: true });
    const NR2 = again.find(it => it.sheetId === works.R.sheetId && Number(it.rowIndex) === people['가짜번호없음'].rowIndex);
    t('★ 직원이 작업보드에서 예약번호를 적으면 풀린다(작업보드 표시값 · 금액 20,000 + 5,000)', NR2 && NR2.payable === true && NR2.amount === 25000 && NR2.priceSource !== 'workboard_edit');
  }
  // 예약 설정 조회가 실패하면 — 예약리뷰 줄은 보내지 않는다(fail-closed)
  {
    t('매장 안내 묶음 조회 실패 = null', await bs.placeInfoForTabs({ query: async () => { throw new Error('db down'); } }, [{ sheetId: 's', tabName: 't' }]) === null);
    const orig = bs.placeInfoForTabs;
    bs.placeInfoForTabs = async () => null;
    try {
      const { items: down } = await pay.listPaymentTargets({ includeFinished: true });
      const A2 = down.find(it => it.sheetId === works.R.sheetId && Number(it.rowIndex) === people['가짜환급'].rowIndex);
      const F2 = down.find(it => it.sheetId === works.F.sheetId && Number(it.rowIndex) === people['가짜무료'].rowIndex);
      t('★★ 예약 설정을 못 읽으면 환급형·무료체험형 모두 보류(booking_place_unknown · 종류 칸만으로도 예약 규칙)',
        A2 && A2.payable === false && A2.issues.includes('booking_place_unknown') && F2 && F2.payable === false && F2.issues.includes('booking_place_unknown') && F2.bookingFree === false);
    } finally { bs.placeInfoForTabs = orig; }
  }

  /* ── 5) 회차 담기 → 이체 파일 ──────────────────────────────────── */
  console.log('\n5) 회차 담기 · 이체 파일');
  const want = [A, FR].map(it => ({ sheetId: it.sheetId, tabName: it.tabName, rowIndex: it.rowIndex, payoutFp: it.payoutFp, payoutMode: it.payoutMode }));
  const made = await pay.createBatch({ bank: 'kbank', rows: want, by: 'test' });
  t('회차 만들기 성공 · 두 건', made.ok === true && made.items.length === 2);
  const dbItems = (await q(`SELECT sheet_id, row_index, product_price, review_fee, amount, is_qna, zero_price_purchase, bank_code, bank_account, account_holder, transfer_memo
                              FROM payment_batch_items WHERE batch_id = $1 ORDER BY amount DESC`, [made.batch.id])).rows;
  const iR = dbItems.find(r => r.sheet_id === works.R.sheetId), iF = dbItems.find(r => r.sheet_id === works.F.sheetId);
  t('★★ 회차 항목(환급형): 제품비 25,000 · 리뷰비 5,000 · 금액 30,000 · 0원 구매 아님', Number(iR.product_price) === 25000 && Number(iR.review_fee) === 5000 && Number(iR.amount) === 30000 && iR.zero_price_purchase === false);
  t('★★ 회차 항목(무료체험형): 제품비 0 · 금액 3,000 · 0원 구매 표시(리뷰비만이 정상인 항목)', Number(iF.product_price) === 0 && Number(iF.amount) === 3000 && iF.zero_price_purchase === true && iF.is_qna === false);
  t('★★ 무료체험형 항목은 「리뷰비만 보낸 건」(split)으로 읽히지 않는다(JS 판정)', pay.isFeeOnlyItem(iF) === false && pay.isFeeOnlyItem(FR) === false);
  t('★★ 같은 판정 SQL 판에서도 빠진다(feeOnlyItemSql)', (await q(`SELECT COUNT(*)::int AS n FROM payment_batch_items i WHERE i.batch_id = $1 AND ${pay.feeOnlyItemSql('i')}`, [made.batch.id])).rows[0].n === 0);
  {
    const buf = await pay.buildWorkbook('kbank', dbItems);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const rows = [];
    wb.worksheets[0].eachRow((row, i) => { if (i > 1) rows.push(row.values.slice(1)); });
    t('★★ 이체 파일(케이뱅크)에 두 줄 · 금액 30,000 / 3,000', rows.length === 2 && rows.map(r => Number(r[2])).sort((a, b) => b - a).join(',') === '30000,3000');
  }
  const { items: after } = await pay.listPaymentTargets({ includeFinished: true });
  t('담은 줄은 다시 대상이 아니다(회차 잠금 그대로)', !after.some(it => it.sheetId === works.F.sheetId && Number(it.rowIndex) === people['가짜무료'].rowIndex));

  /* ── 6) 화면(입금관리) ─────────────────────────────────────────── */
  console.log('\n6) 입금관리 화면');
  const wd = F('workdesk.html');
  const lb = wd.slice(wd.indexOf('const PAY_ISSUE_LABEL = {'), wd.indexOf('};', wd.indexOf('const PAY_ISSUE_LABEL = {')));
  const codes = [...new Set([...S('src/services/payment.service.js').matchAll(/['"](booking_[a-z_]+)['"]/g)].map(m => m[1]))]
    .filter(c => /^booking_(pay_over|pay_missing|no_reservation|place_unknown|payout_mode)$/.test(c));
  t('서버가 내는 예약리뷰 보류 사유 5종', codes.length === 5);
  t('★ 예약리뷰 보류 사유마다 한글 이름표(코드 이름이 화면에 뜨지 않게)', codes.every(c => new RegExp('\\b' + c + ":'").test(lb)));
  {
    // 보완 카드 — 실제 실행: 예약리뷰 확인 줄이 작업 카드에 실린다(고를 줄이 없어 작업 목록에서 빠져도 여기서 보인다)
    const fn = wd.slice(wd.indexOf('function _pmBuildFix('), wd.indexOf('\n}\n', wd.indexOf('function _pmBuildFix(')) + 2);
    const ctx = { PAY_ACCT_ISSUES: ['bank_unknown', 'no_account', 'no_holder'], _pmKey: it => it.sheetId + '||' + it.tabName + '||' + it.rowIndex };
    vm.createContext(ctx);
    const consts = wd.match(/const PAY_BOOKING_CHECK_ISSUES = \[[^\]]*\];/);
    t('예약리뷰 확인 사유 목록 하나(PAY_BOOKING_CHECK_ISSUES)', !!consts);
    vm.runInContext((consts ? consts[0].replace('const ', 'var ') : '') + '\n' + fn + '\nthis.b = _pmBuildFix;', ctx);
    const fix = ctx.b([
      { sheetId: 's', tabName: '예약', rowIndex: 1, tabLabel: '예약', issues: ['booking_pay_over'], warnings: [], bookingPayCap: 25000 },
      { sheetId: 's', tabName: '예약', rowIndex: 2, tabLabel: '예약', issues: ['booking_no_reservation'], warnings: [], bookingPayCap: 25000 },
      { sheetId: 's', tabName: '예약', rowIndex: 3, tabLabel: '예약', issues: [], warnings: [], payable: true },
    ]);
    t('★ 보완 카드(실제 실행): 예약리뷰 확인 2건이 그 작업 카드에 실린다', fix.works.length === 1 && fix.works[0].bookingCheck === 2 && fix.works[0].bookingPayCap === 25000);
    const blk = wd.slice(wd.indexOf('function _pmFixBlock('), wd.indexOf('\n}\n', wd.indexOf('function _pmFixBlock(')) + 2);
    t('보완 카드 문구: 예약번호·결제금액을 작업보드에서 확인', /예약리뷰 확인/.test(blk) && /w\.bookingCheck/.test(blk));
  }
  t('이체은행 사유(booking_payout_mode)는 작업 조건 창구로 고친다(PAY_FIX_KIND work)', /booking_payout_mode:'work'/.test(wd));
  {
    // PAY_FIX_KIND 를 실제로 읽어 본다 — 결정 369 때 주석이 같은 줄의 계좌 세 칸을 삼켜 표의 계좌 [보완] 버튼이 사라졌던 자리
    const src = wd.slice(wd.indexOf('const PAY_FIX_KIND = {'), wd.indexOf('};', wd.indexOf('const PAY_FIX_KIND = {')) + 2);
    const ctx = {}; vm.createContext(ctx); vm.runInContext(src.replace('const PAY_FIX_KIND', 'this.K') , ctx);
    t('★ 고치는 곳 표(실제 실행): 이체은행 3사유 = 작업 · 계좌 3사유 = 계좌(369 주석에 삼켜졌던 칸 되살림)',
      ['no_bank', 'order_goods_by_advertiser', 'booking_payout_mode'].every(k => ctx.K[k] === 'work')
      && ['bank_unknown', 'no_account', 'no_holder'].every(k => ctx.K[k] === 'account'));
  }

  /* ── 7) 정적 계약 ─────────────────────────────────────────────── */
  console.log('\n7) 정적 계약');
  const svc = S('src/services/payment.service.js');
  t('★ 상품비 판정 식 그대로(작업보드 표시값 → 주문 원장)', /const productPrice = workboardPrice \|\| orderPrice;/.test(svc));
  t('★ 예약 설정 = bookingSlots.placeInfoForTabs(접수·예약내역 창구와 같은 bookingSpecFromWorkOrder)', /placeInfoForTabs/.test(svc)
    && /bookingSpecFromWorkOrder/.test(S('src/services/bookingSlots.service.js').slice(S('src/services/bookingSlots.service.js').indexOf('function _placeFromWorkOrderRow'))));
  t('★ 회차 담기의 0원 구매 표시 = 서버가 다시 계산한 값 · 모양(제품비 0 · 금액 = 리뷰비) 확인 그대로', /\(it\.zeroPricePurchase === true \|\| it\.bookingFree === true\) && Number\(it\.productPrice\) === 0 && Number\(it\.amount\) === Number\(it\.reviewFee\)/.test(svc));
  t('★ 결정 376 판정 함수는 건드리지 않았다(예약리뷰로 넓히지 않음)', /function zeroPricePurchaseOf\(\{ payoutMode, isQna, productPrice, workboardAmountZero, orderPrices, workOrder, fee \} = \{\}\) \{\n  if \(payoutMode !== 'ours' \|\| isQna === true\) return false;/.test(svc));

  console.log(`\n✅ ${pass}개 통과\n`);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
