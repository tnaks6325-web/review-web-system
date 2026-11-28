/**
 * bookingReviewerFlow.test.js — 네이버예약리뷰 3단계 회귀가드: 모집공고·날짜 고르기 신청·예약내역/리뷰 제출 (결정 409)
 * 실행: node tests/bookingReviewerFlow.test.js
 *
 * 위험:
 *  ① 같은 날 마지막 자리를 두 사람이 함께 받는다(과판매) — 신청 묶기는 자리 한 줄 = 살아 있는 신청 하나(유일 색인 228).
 *  ② 만료·취소된 신청이 자리를 계속 쥔다(빈 날이 「마감」으로 보인다).
 *  ③ 오늘·지난 날·자리 없는 날을 고를 수 있다(기본: 내일부터 — 당일 예약 제외).
 *  ④ 상태 엔진이 「이용일자」 칸을 시트 일정처럼 읽어 첫 방문일까지 「오픈 예정」으로 막는다.
 *  ⑤ 예약내역이 구매양식 길(/api/submit/order)로 들어가거나, 같은 공고에서 같은 예약번호가 두 번 들어간다.
 *  ⑥ 1단계 안전핀(저장 입구·신청 안전벨트)이 풀린다 — 3단계도 운영에서 booking 을 열지 않는다.
 * ★ 자리 묶기·만료·취소·예약번호 색인·신청/참여상세/예약내역 제출 처리기는 PGlite(저장소 migrations 그대로)에서 실제로 돌린다.
 *   운영 DB 에 닿지 않는다(가짜 이름·가짜 매장). ★ 결정 414: booking 개방 — 준비 중 목록은 배포 그대로 비어 있고, 안전벨트 장치만 시험 안에서 되돌려 본다.
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
const TAB = '12월 가짜식당 예약리뷰';
const WO = 'wo_booking_step3';
const CAMP = 'camp_booking_step3';
const OPT = '가짜식당 강남점';
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booking-step3-secret';

const DAY = 86400000;
const kstYmd = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const NOW = Date.now();
const T0 = kstYmd(NOW), T1 = kstYmd(NOW + DAY), T2 = kstYmd(NOW + 2 * DAY), T4 = kstYmd(NOW + 4 * DAY), T3 = kstYmd(NOW + 3 * DAY);

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
  console.log('\n▶ 네이버예약리뷰 3단계 — 날짜 고르기 신청 · 예약내역/리뷰 제출\n');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);
  const bs = require('../src/services/bookingSlots.service');

  /* ── 0) migration 228 ─────────────────────────────────────── */
  console.log('0) migration 228 · 기동 필수 칸');
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'campaign_applications'`)).rows.map(r => r.column_name);
  t('★ 신청 표에 booking_slot_id · booking_reservation_no', cols.includes('booking_slot_id') && cols.includes('booking_reservation_no'));
  const idx = (await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'campaign_applications'`)).rows;
  const ixSlot = idx.find(r => r.indexname === 'uq_campaign_apps_booking_slot');
  const ixResv = idx.find(r => r.indexname === 'uq_campaign_apps_booking_resv');
  t('★★ 자리 하나 = 살아 있는 신청 하나(부분 유일 색인 · applied·submitted 만)', ixSlot && /UNIQUE/.test(ixSlot.indexdef) && /applied/.test(ixSlot.indexdef) && /submitted/.test(ixSlot.indexdef));
  t('★★ 같은 공고 같은 예약번호 금지(부분 유일 색인 · 살아 있는 신청만)', ixResv && /UNIQUE/.test(ixResv.indexdef) && /campaign_id, booking_reservation_no/.test(ixResv.indexdef));
  t('migration 파일 번호 228 은 하나뿐', fs.readdirSync(path.join(SERVER, 'migrations')).filter(f => /^228_/.test(f)).length === 1);
  t('★ 기동 필수 칸(REQUIRED_SCHEMA)에 두 칸', /\['campaign_applications', 'booking_slot_id'\]/.test(S('index.js')) && /\['campaign_applications', 'booking_reservation_no'\]/.test(S('index.js')));

  /* ── 1) 예약 작업표 + 공고 준비 ─────────────────────────────── */
  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);
  const DATES = [{ date: T0, count: 1 }, { date: T1, count: 2 }, { date: T2, count: 1 }, { date: T4, count: 2 }];
  const place = { name: '가짜식당 강남점', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
    base: { pay: 25000, count: 6, daily: 0, review_type_mix: [] }, options: [],
    booking: { pay_mode: 'refund', dates: DATES, review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1' } };
  const wo = { id: WO, title: TAB, work_kind: 'booking', workboard_schema_version: 2, recruit_count: 6, review_fee: 5000, pay_amount: 150000, start_date: null,
    product_options_json: JSON.stringify([place]) };
  await q(`INSERT INTO work_orders (id, title, work_kind, workboard_schema_version, recruit_count, review_fee, pay_amount, product_options_json, status)
           VALUES ($1, $2, 'booking', 2, 6, 5000, 150000, $3, 'published')`, [WO, TAB, wo.product_options_json]);
  const acc = require('../src/services/sheetlessAccept.service');
  const made = await acc.createSheetlessWorktable({ workOrder: wo, tabName: TAB, by: 'test' });
  const sheetId = made.sheetId;
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'booking', TRUE, 2)`, [sheetId, TAB, made.gid]);
  await made.persist();
  await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, linked_tab_gid, work_kind,
             recruit_total, daily_limit, hold_ttl_min, multi_account_mode, review_fee)
           VALUES ($1, '가짜식당 강남점', 'active', TRUE, $2, $3, $4, 'booking', 6, 6, 20, FALSE, 5000)`, [CAMP, sheetId, TAB, made.gid]);
  await q(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, pay_amount, recruit_total, daily_limit, status, sort_order)
           VALUES ($1, '가짜식당 강남점', '가짜식당 강남점', 'product', 25000, 6, 0, 'active', 0)`, [CAMP]);
  t('준비: 예약 작업표 6줄 · 자리표 6칸', (await bs.calendarForTab(pool, sheetId, TAB)).length === 6);

  /* ── 2) 남은 자리 · 고를 수 있는 날 ─────────────────────────── */
  console.log('\n2) 남은 자리 · 고를 수 있는 날(기본 = 내일부터)');
  const nowD = new Date(NOW);
  t('고를 수 있는 첫날 = KST 내일(당일 예약 제외 기본값)', bs.bookableFrom(nowD) === T1 && bs.BOOKING_SAME_DAY_OK === false);
  let seats = await bs.seatsForTab(pool, sheetId, TAB, nowD);
  t('★ 날짜별 자리 = 업체가 정한 인원 그대로 · 오늘은 고를 수 없음',
    JSON.stringify(seats.map(s => [s.date, s.total, s.left, s.bookable])) === JSON.stringify([[T0, 1, 1, false], [T1, 2, 2, true], [T2, 1, 1, true], [T4, 2, 2, true]]));
  const free0 = await bs.loadFreeByCampaign(pool, [CAMP], nowD);
  t('★ 공고 정원 재료: 고를 수 있는 날의 남은 자리 합(오늘 1자리 제외 = 5)', free0 instanceof Map && free0.get(CAMP).free === 5);
  t('예약 탭 아닌 공고는 싣지 않는다', !(await bs.loadFreeByCampaign(pool, ['없는공고'], nowD)).has('없는공고'));
  t('★ 조회 실패 = null(덮지 않음 — 표시는 종전, 신청은 자리 묶기가 다시 막는다)', await bs.loadFreeByCampaign({ query: async () => { throw new Error('x'); } }, [CAMP], nowD) === null);

  /* ── 3) 자리 묶기 — 날짜 검사 · 만료/취소 풀림 · 동시 신청 ────── */
  console.log('\n3) 자리 묶기');
  const tx = await pool.connect();
  const bind = (date) => bs.bindSlotForApply(tx, { sheetId, tabName: TAB, date, now: nowD });
  t('날짜 없음 = booking_date_required', (await bind('')).reason === 'booking_date_required');
  t('형식이 틀린 날짜 = booking_date_invalid', (await bind('12/5')).reason === 'booking_date_invalid' && (await bind('2026-02-30')).reason === 'booking_date_invalid');
  t('★ 오늘(당일) = booking_date_closed', (await bind(T0)).reason === 'booking_date_closed');
  t('업체가 정하지 않은 날 = booking_date_full', (await bind(T3)).reason === 'booking_date_full');
  let appSeq = 0;
  const newApp = async (p8, { status = 'applied', expiresSql = "NOW() + interval '20 minutes'", camp = CAMP } = {}) => {
    appSeq++;
    const { rows } = await q(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, owner_phone8, status, expires_at, hold_token)
                              VALUES ($1, $2, $3, $4, $4, $5, ${expiresSql}, $6) RETURNING id`, [camp, '가짜리뷰어' + appSeq, '010' + p8, p8, status, 'tok' + appSeq]);
    return rows[0].id;
  };
  const b1 = await bind(T2);
  t('★ 고른 날의 열린 자리 하나', b1.ok === true && b1.slot && b1.slot.slot_date === T2 && Number(b1.slot.date_seq) === 1);
  const a1 = await newApp('10000001');
  await q('UPDATE campaign_applications SET booking_slot_id = $2 WHERE id = $1', [a1, b1.slot.id]);
  t('★★ 그 날 자리가 다 찼으면 booking_date_full(묶인 신청이 자리를 쥔다)', (await bind(T2)).reason === 'booking_date_full');
  seats = await bs.seatsForTab(pool, sheetId, TAB, nowD);
  t('남은 자리 표시도 같은 기준(그날 0)', seats.find(s => s.date === T2).left === 0);
  {
    let err = null;
    const a2 = await newApp('10000002');
    try { await q('UPDATE campaign_applications SET booking_slot_id = $2 WHERE id = $1', [a2, b1.slot.id]); } catch (e) { err = e; }
    t('★★ 같은 자리에 두 번째 신청을 새기면 유일 색인이 막는다(23505 uq_campaign_apps_booking_slot)',
      err && err.code === '23505' && /uq_campaign_apps_booking_slot/.test(String(err.constraint || err.message)));
    await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE id = $1`, [a2]);
  }
  // 만료 — 유예가 지난 홀드는 고르기 직전에 정리되고 그 자리가 다시 나간다
  await q(`UPDATE campaign_applications SET expires_at = NOW() - interval '10 minutes' WHERE id = $1`, [a1]);
  const b2 = await bind(T2);
  t('★★ 만료된 홀드는 자리를 놓는다(고르기 직전 expired 로 정리 · 같은 자리가 다시 나감)',
    b2.ok && String(b2.slot.id) === String(b1.slot.id) && (await q('SELECT status FROM campaign_applications WHERE id = $1', [a1])).rows[0].status === 'expired');
  // 취소 — 신청 표가 단일 출처라 자리표를 고치지 않아도 풀린다
  const a3 = await newApp('10000003');
  await q('UPDATE campaign_applications SET booking_slot_id = $2 WHERE id = $1', [a3, b2.slot.id]);
  t('묶인 뒤엔 그날 마감', (await bind(T2)).reason === 'booking_date_full');
  await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE id = $1`, [a3]);
  t('★★ 취소된 신청은 자리를 놓는다(자리표는 그대로 · 신청 표가 단일 출처)', (await bind(T2)).ok === true
    && (await bs.seatsForTab(pool, sheetId, TAB, nowD)).find(s => s.date === T2).left === 1);
  // 동시 신청 — 마지막 한 자리를 두 신청이 함께 노린다(고르기 → 신청 → 새기기). 하나만 남는다.
  {
    const race = async (p8) => {
      const r = await bind(T2);
      if (!r.ok) return { lost: r.reason };
      const id = await newApp(p8);
      await q('UPDATE campaign_applications SET booking_slot_id = $2 WHERE id = $1', [id, r.slot.id]);
      return { won: id };
    };
    const out = await Promise.allSettled([race('20000001'), race('20000002')]);
    const won = out.filter(o => o.status === 'fulfilled' && o.value.won).length;
    const held = (await q(`SELECT COUNT(*)::int AS n FROM campaign_applications WHERE booking_slot_id = $1 AND status IN ('applied','submitted')`, [b2.slot.id])).rows[0].n;
    t('★★★ 마지막 한 자리 동시 신청 → 하나만 잡는다(다른 하나는 자리 없음 또는 유일 색인 거절)', won === 1 && held === 1);
    await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE booking_slot_id = $1`, [b2.slot.id]);
    // 대기 중 신청 행 정리(동시 시험이 남긴 미묶음 신청)
    await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE campaign_id = $1 AND booking_slot_id IS NULL AND status = 'applied'`, [CAMP]);
  }
  const src = S('src/services/bookingSlots.service.js');
  t('자리 고르기 = 그날 · 열린 · 살아 있는 신청 없는 자리 · 그날 순번 순 · FOR UPDATE',
    /s\.slot_date = \$3::date AND s\.status = 'open'[\s\S]*NOT EXISTS[\s\S]*ca\.status IN \('applied', 'submitted'\)[\s\S]*ORDER BY s\.date_seq[\s\S]*FOR UPDATE OF s/.test(src));
  t('자리 고르기 유예 = 신청 홀드 유예(HOLD_GRACE_SEC 단일 출처)', /graceSec == null\) graceSec = require\('\.\/campaignHold\.service'\)\.HOLD_GRACE_SEC/.test(src));
  t('오늘 날짜(KST) 판정 = qnaSlots.kstDateStr 단일 출처(날짜 계산 사본 없음)', /require\('\.\/qnaSlots\.service'\)\.kstDateStr/.test(src));

  /* ── 4) 예약번호 ─────────────────────────────────────────── */
  console.log('\n4) 예약번호');
  const nr = bs.normalizeReservationNo;
  t('예약번호 정규화: 띄어쓰기 제거 · 영문 대문자', nr(' 1234 5678 ').value === '12345678' && nr('ab-12c').value === 'AB-12C');
  t('★ 빈 값 = 필수(booking_resv_required)', nr('').ok === false && nr('').reason === 'booking_resv_required');
  t('이상한 글자·너무 짧음·너무 김 = booking_resv_invalid', nr('12#4').reason === 'booking_resv_invalid' && nr('12').reason === 'booking_resv_invalid' && nr('1'.repeat(41)).reason === 'booking_resv_invalid');
  {
    const x1 = await newApp('30000001'), x2 = await newApp('30000002');
    await q(`UPDATE campaign_applications SET booking_reservation_no = 'R1000' WHERE id = $1`, [x1]);
    let err = null;
    try { await q(`UPDATE campaign_applications SET booking_reservation_no = 'R1000' WHERE id = $1`, [x2]); } catch (e) { err = e; }
    t('★★ 같은 공고 같은 예약번호 = DB 가 거절(23505 uq_campaign_apps_booking_resv)', err && err.code === '23505' && /uq_campaign_apps_booking_resv/.test(String(err.constraint || err.message)));
    await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode) VALUES ('camp_other', '다른 공고', 'active', TRUE)`);
    const y1 = await newApp('30000003', { camp: 'camp_other' });
    await q(`UPDATE campaign_applications SET booking_reservation_no = 'R1000' WHERE id = $1`, [y1]);
    t('다른 공고는 같은 번호를 써도 된다', true);
    await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE id = $1`, [x1]);
    await q(`UPDATE campaign_applications SET booking_reservation_no = 'R1000' WHERE id = $1`, [x2]);
    t('취소된 신청의 번호는 다시 쓸 수 있다', true);
    await q(`UPDATE campaign_applications SET status = 'cancelled' WHERE id = ANY($1::int[])`, [[x2, y1]]);
  }

  /* ── 5) 상태 엔진 ─────────────────────────────────────────── */
  console.log('\n5) 공고 상태(예약 공고는 「고를 수 있는 남은 자리」 하나로 연다)');
  const st = require('../src/services/campaignState.service');
  const C = { participation_mode: true, status: 'active', daily_limit: 6, recruit_total: 6, start_date: null, window_start: null, window_end: null, close_buffer_min: 10 };
  const base = { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 };
  const futureSched = { firstDate: T4, lastDate: T4, totalSlots: 6, byDate: { [T4]: 6 }, source: 'sheet' };
  const sOpen = st.computeCampaignState(C, { ...base, bookingFree: 3 }, nowD, futureSched);
  t('★★ 남은 자리 3 → open(이용일자 칸이 시트 일정처럼 읽혀도 「오픈 예정」으로 막지 않는다)', sOpen.state === 'open' && sOpen.dailyQuota >= 3);
  const sFull = st.computeCampaignState(C, { ...base, bookingFree: 0 }, nowD);
  t('★ 남은 자리 0 → soft_full(booking_full · 「내일 다시 오픈」 아님)', sFull.state === 'soft_full' && sFull.stateReason === 'booking_full' && !sFull.reopensAt);
  const sPlan = st.computeCampaignState(C, { ...base, bookingFree: 2, plans: { [kstYmd(NOW)]: 0 } }, nowD);
  t('예약 공고는 날짜별 계획(0명 휴무)을 보지 않는다', sPlan.state === 'open');
  const sTbl = st.computeCampaignState(C, { ...base, bookingFree: 2, tableTodayFilled: 9, tableTodayQuota: 1 }, nowD);
  t('예약 공고는 작업표 오늘 채움(이용일자 = 오늘 줄)으로 마감하지 않는다', sTbl.state === 'open');
  const sPlain = st.computeCampaignState(C, base, nowD);
  t('★ 예약 아님(bookingFree 없음) = 종전 그대로', sPlain.state === 'open' && sPlain.dailyQuota === 6);
  const css = S('src/services/campaignState.service.js');
  t('공고 정원 재료는 깔때기 맨 뒤에서 싣는다(066 순서 계약 · Q&A 다음)', /loadTodayByCampaign\(pool, ids, now\)[\s\S]{0,900}loadFreeByCampaign\(pool, ids, now\)[\s\S]{0,900}receiptPool\.service'\)\.loadFreeByCampaign\(pool, ids\)[\s\S]{0,600}return out;/.test(css));

  /* ── 6) 신청 처리기(실제 처리기 · PGlite) ────────────────────── */
  console.log('\n6) 신청 처리기');
  const wk = require('../src/utils/workKind');
  const campaignRoutes = require('../src/routes/campaign.routes');
  const apply = handlerOf(campaignRoutes, 'post', '/:id/apply');
  const detailH = handlerOf(campaignRoutes, 'get', '/:id/work-detail');
  const publicDetail = handlerOf(campaignRoutes, 'get', '/:id');
  const call = async (h, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    const res = fakeRes(); let err = null;
    await h({ body, params, query, headers, ip: '127.0.0.1', get: () => '' }, res, e => { err = e; });
    if (err) throw err;
    return res;
  };
  await q(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder, address)
           VALUES ('가짜하나', '01011112222', '가짜은행', '000-0000-0001', '가짜하나', '서울 가짜구'),
                  ('가짜둘', '01033334444', '가짜은행', '000-0000-0002', '가짜둘', '서울 가짜구')`);
  /* ★ 결정 414: booking 개방 — 신청 안전벨트 장치는 다음 종류용으로 남는다. 시험 안에서만 booking 을 준비 중으로 되돌려
       「준비 중이면 잠금 전에 거절」을 그대로 보고(검사 의미 불변), 다시 비워 흐름을 돈다. */
  // 결정 418 — 준비 중 목록에 영수증리뷰(receipt)가 들어갔다: 「booking 개방」 = 목록에 booking 없음 · 끝나면 배포 그대로 목록으로(의미 불변)
  const saved = wk.NOT_READY_WORK_KINDS.slice();   // 배포 그대로
  t('★★ 배포 그대로: 준비 중 목록에 booking 이 없다(booking 개방)', !wk.NOT_READY_WORK_KINDS.includes('booking') && wk.isWorkKindReady('booking') === true);
  wk.NOT_READY_WORK_KINDS.push('booking');
  const r0 = await call(apply, { params: { id: CAMP }, body: { name: '가짜하나', phone: '01011112222', bookingDate: T1 } });
  t('★★★ 신청 안전벨트 장치 그대로: 준비 중인 종류면 예약 공고 신청을 잠금 전에 거절(work_kind_not_ready)', r0.statusCode === 409 && r0.body.reason === 'work_kind_not_ready');
  wk.NOT_READY_WORK_KINDS.length = 0;   // ★ 시험 안에서만 — 흐름을 돌리려고 비운다(끝에 saved 로 되돌림)
  let appId = null, holdToken = null;
  try {
    const rNo = await call(apply, { params: { id: CAMP }, body: { name: '가짜하나', phone: '01011112222' } });
    t('★ 날짜 없이 신청 = 409 booking_date_required(자리 미점유)', rNo.statusCode === 409 && rNo.body.reason === 'booking_date_required');
    const rToday = await call(apply, { params: { id: CAMP }, body: { name: '가짜하나', phone: '01011112222', bookingDate: T0 } });
    t('★ 오늘 날짜 신청 = 409 booking_date_closed', rToday.statusCode === 409 && rToday.body.reason === 'booking_date_closed');
    const pub = await call(publicDetail, { params: { id: CAMP } });
    const bk = pub.body && pub.body.data && pub.body.data.booking;
    t('★★ 공고 상세(참여 전): 매장·주소·예약 주소·돈 방식·날짜별 남은 자리', bk && bk.placeName === '가짜식당 강남점' && bk.placeAddress === '서울 가짜구 가짜로 1'
      && bk.payMode === 'refund' && bk.reviewDeadlineDays === 3
      && bk.bookableFrom === T1 && bk.dates.find(d => d.date === T1).left === 2 && bk.dates.find(d => d.date === T0).bookable === false);
    t('★ 공고 상세: 예약 공고 상태 = open(남은 자리 있음)', pub.body.data.state === 'open');
    t('공고 상세는 작업표 위치·자리 번호를 내보내지 않는다', !/sheet|seq|slot_id/i.test(JSON.stringify(bk)));
    t('★ 네이버 예약 주소·결제금액은 참여 후에만(참여 전 상세에 없음 · 결정 041)', !('bookingUrl' in bk) && !('pay' in bk));
    const ok1 = await call(apply, { params: { id: CAMP }, body: { name: '가짜하나', phone: '01011112222', bookingDate: T2, optionKey: OPT } });
    t('★★★ 고른 날로 신청 → 자리 하나가 이 신청에 묶인다', ok1.statusCode === 200 && ok1.body.ok === true && ok1.body.bookingSlot && ok1.body.bookingSlot.date === T2);
    appId = ok1.body.applicationId; holdToken = ok1.body.holdToken;
    const row = (await q('SELECT booking_slot_id, expires_at, status FROM campaign_applications WHERE id = $1', [appId])).rows[0];
    t('신청 행에 자리 번호(booking_slot_id)', row.booking_slot_id != null && row.status === 'applied');
    const ttlMin = (new Date(row.expires_at).getTime() - Date.now()) / 60000;
    t('★ 예약내역 제출 기한 = 구매양식과 같은 홀드 시간(공고 hold_ttl_min 20분)', ttlMin > 18 && ttlMin <= 20.1);
    const lost = await call(apply, { params: { id: CAMP }, body: { name: '가짜둘', phone: '01033334444', bookingDate: T2, optionKey: OPT } });
    t('★★ 그날 마지막 자리는 이미 잡힘 → 다음 사람은 409 booking_date_full', lost.statusCode === 409 && lost.body.reason === 'booking_date_full');
    const det = await call(detailH, { params: { id: CAMP }, query: { phone8: '11112222', holdToken } });
    const v = det.body && det.body.bookingSlot;
    t('★ 참여 상세: 고른 날 · 리뷰 마감일(이용일 + 3일) · 매장 안내 · 환급형', det.body.ok && v && v.date === T2 && v.reviewDeadline === kstYmd(NOW + 5 * DAY)
      && v.place && v.place.placeName === '가짜식당 강남점' && v.place.payMode === 'refund' && v.reservationDone === false
      && /^https:\/\/booking\.naver\.com\//.test(v.place.bookingUrl) && v.place.pay === 25000);
    t('참여 상세: 예약 공고는 상품 바꾸기 없음', det.body.canChangeOption === false);

    /* ── 7) 예약내역 제출 창구 ─────────────────────────────── */
    console.log('\n7) 예약내역 제출');
    const submitRoutes = require('../src/routes/submit.routes');
    const subH = handlerOf(submitRoutes, 'post', '/booking');
    const orderH = handlerOf(submitRoutes, 'post', '/order');
    const rid = (await q(`SELECT id FROM reviewers WHERE phone8 = '11112222'`)).rows[0].id;
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [appId, rid]);
    const tok = require('../src/services/reviewerSession.service').issueReviewerSession({ ownerReviewerId: rid, loginName: '가짜하나', loginPhone8: '11112222' });
    const H = { 'x-reviewer-token': tok };
    const B = extra => ({ campaignId: CAMP, campaignApplicationId: appId, holdToken, holdPhone8: '11112222', ...extra });
    const noTok = await call(subH, { body: B({ reservationNo: 'R777' }) });
    t('리뷰어 세션 필수', noTok.statusCode === 401);
    const noNo = await call(subH, { body: B({ payAmount: 25000 }), headers: H });
    t('★ 예약번호 없으면 거절(BOOKING_RESV_REQUIRED · 쓰기 0)', noNo.statusCode === 400 && noNo.body.code === 'BOOKING_RESV_REQUIRED'
      && (await q('SELECT status FROM campaign_applications WHERE id = $1', [appId])).rows[0].status === 'applied');
    const noPay = await call(subH, { body: B({ reservationNo: 'R777' }), headers: H });
    t('★ 환급형은 결제금액 필수(BOOKING_PAY_REQUIRED)', noPay.statusCode === 400 && noPay.body.code === 'BOOKING_PAY_REQUIRED');
    const viaOrder = await call(orderH, { body: { ...B({}), orderer: '가짜하나', loginPhone8: '11112222' }, headers: H });
    t('★★ 구매양식 창구는 예약 자리 신청을 받지 않는다(booking_use_reservation)', viaOrder.statusCode === 409 && viaOrder.body.reason === 'booking_use_reservation');
    const slotSeq = Number((await bs.slotForApplication(pool, appId)).seq);
    const dateCellBefore = (await q(`SELECT row_json->>'이용일자' AS d FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [sheetId, TAB, slotSeq])).rows[0].d;
    const okSub = await call(subH, { body: B({ reservationNo: ' r 777 ', payAmount: '25,000', wantCaptureSession: true }), headers: H });
    t('★★★ 예약내역 제출 → 신청 확정(submitted) · 자리 줄에 기록', okSub.statusCode === 200 && okSub.body.ok === true && okSub.body.target
      && Number(okSub.body.target.rowIndex) === Number((await bs.slotForApplication(pool, appId)).seq));
    const app2 = (await q('SELECT status, booking_reservation_no, order_submission_id FROM campaign_applications WHERE id = $1', [appId])).rows[0];
    t('신청 행: submitted · 예약번호 정규화 저장', app2.status === 'submitted' && app2.booking_reservation_no === 'R777' && app2.order_submission_id);
    const cp = (await q(`SELECT row_json, order_submission_id FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [sheetId, TAB, okSub.body.target.rowIndex])).rows[0];
    t('★★ 작업표 그 자리 줄: 예약번호 · 결제금액(환급형) · 수취인 · 이용일자 그대로(자리표 표기)', cp && cp.row_json['예약번호'] === 'R777'
      && String(cp.row_json['결제금액']).replace(/\D/g, '') === '25000' && cp.row_json['수취인'] === '가짜하나'
      && cp.row_json['이용일자'] === dateCellBefore && String(cp.order_submission_id) === String(app2.order_submission_id));
    t('예약내역 캡처 세션 발급(구매캡처와 같은 저장 길)', okSub.body.captureSession && okSub.body.captureSession.id && okSub.body.captureSession.token);
    const again = await call(subH, { body: B({}), headers: H });
    t('★ 다시 누르면 같은 줄(멱등 · 줄만 다시 맞춤)', again.statusCode === 200 && again.body.alreadySubmitted === true && Number(again.body.target.rowIndex) === Number(okSub.body.target.rowIndex));
    // 같은 공고의 다른 신청이 같은 예약번호를 쓰면 막힌다
    const okB = await call(apply, { params: { id: CAMP }, body: { name: '가짜둘', phone: '01033334444', bookingDate: T1, optionKey: OPT } });
    const rid2 = (await q(`SELECT id FROM reviewers WHERE phone8 = '33334444'`)).rows[0].id;
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [okB.body.applicationId, rid2]);
    const tok2 = require('../src/services/reviewerSession.service').issueReviewerSession({ ownerReviewerId: rid2, loginName: '가짜둘', loginPhone8: '33334444' });
    const dup = await call(subH, { body: { campaignId: CAMP, campaignApplicationId: okB.body.applicationId, holdToken: okB.body.holdToken, holdPhone8: '33334444', reservationNo: 'R 777', payAmount: 25000 }, headers: { 'x-reviewer-token': tok2 } });
    t('★★ 같은 공고 같은 예약번호 = 409 BOOKING_RESV_DUP(장부·작업표 쓰기 0)', dup.statusCode === 409 && dup.body.code === 'BOOKING_RESV_DUP'
      && (await q('SELECT status FROM campaign_applications WHERE id = $1', [okB.body.applicationId])).rows[0].status === 'applied');
    const det2 = await call(detailH, { params: { id: CAMP }, query: { phone8: '11112222', holdToken } });
    t('★ 참여 상세(제출 뒤): 예약내역 접수 · 리뷰 캡처 아직(완료 화면 아님)', det2.body.bookingSlot.reservationDone === true && det2.body.bookingSlot.reviewDone === false
      && det2.body.bookingSlot.reservationNo === 'R777');
  } finally {
    wk.NOT_READY_WORK_KINDS.length = 0; wk.NOT_READY_WORK_KINDS.push(...saved);
  }
  t('★★ 시험 뒤 준비 중 목록 원상 복귀(배포 그대로)', JSON.stringify(wk.NOT_READY_WORK_KINDS) === JSON.stringify(saved) && !wk.NOT_READY_WORK_KINDS.includes('booking'));
  tx.release();

  /* ── 8) 정적 계약 ─────────────────────────────────────────── */
  console.log('\n8) 처리기 순서·화면 계약');
  const routes = S('src/routes/campaign.routes.js');
  const ap = routes.slice(routes.indexOf('async function _applyParticipation('), routes.indexOf("router.post('/:id/apply'"));
  const iBelt = ap.indexOf("reason: 'work_kind_not_ready'"), iConn = ap.indexOf('pool.connect()');
  t('★★ 신청 안전벨트는 그대로 잠금 앞 · 예약 날짜 형식 확인도 잠금 앞(자리 미점유)', iBelt > 0 && iBelt < iConn && ap.indexOf('booking_date_required') < iConn);
  const iBind = ap.indexOf('bookingSlots.bindSlotForApply'), iIns = ap.indexOf('INSERT INTO campaign_applications');
  t('★★ 자리 묶기는 모든 게이트 뒤(인기 참여권 뒤)·작업표 잠금 뒤·INSERT 앞', iBind > ap.indexOf('canUsePopularCredit') && iBind > ap.indexOf('camp_tab_daily') && iBind < iIns);
  t('INSERT 칸 목록은 그대로 — 뒤이은 UPDATE 로 booking_slot_id', /SET booking_slot_id = \$2 WHERE id = \$1/.test(ap) && !/INSERT INTO campaign_applications\s*\([^)]*booking_slot_id/.test(ap));
  t('★ 예약 신청은 개수 단계·작업표 빈 줄 관문·차례 줄을 타지 않는다', /if \(!blogApply && !qnaApply && !bookingApply(?: && !receiptApply)?\)/.test(ap)
    && /if \(!blogApply && !qnaApply && !bookingApply(?: && !receiptApply)? && camp\.linked_sheet_id/.test(ap) && /!qnaApply && !bookingApply(?: && !receiptApply)? && !blogApply && holdChain\.chainEligibleCampaign/.test(ap));
  t('★ 예약 신청 기한 = 공고 홀드 시간(구매양식과 같다 · Q&A 1시간 규칙 아님)', /const _baseExp = qnaApply \? qnaSlots\.qnaHoldExpiry\(now\)\.getTime\(\) : now\.getTime\(\) \+ ttlMs;/.test(ap));
  t('같은 공고 같은 명의 제출완료 = 막음 · 재구매 기간은 보지 않음(Q&A 와 같다)', /if \(\(qnaApply \|\| bookingApply(?: \|\| receiptApply)?\) && sameCampaignSubmittedAt\)/.test(ap) && /if \(!qnaApply && !bookingApply(?: && !receiptApply)?\) try \{/.test(ap));
  t('잠근 공고로 종류 재확인(예약 여부가 갈리면 막음)', /isBookingKind\(_lockedKind\) !== bookingApply/.test(ap));
  t('자리 이중 묶기 충돌 = 「그날 자리 찼음」', /err\.constraint === 'uq_campaign_apps_booking_slot'[\s\S]{0,160}reason: 'booking_date_full'/.test(routes));
  t('상품 바꾸기: 예약 신청은 막음(booking_option_locked)', /booking_option_locked/.test(routes));
  const sub = S('src/routes/submit.routes.js');
  const sb = sub.slice(sub.indexOf("router.post('/booking'"), sub.indexOf("router.post('/order'"));
  t('★★ 제출 창구: 기한 확인 → 예약번호 새기기 → 장부 순서', sb.indexOf("app.status !== 'applied' || !app.in_time") > 0
    && sb.indexOf("app.status !== 'applied' || !app.in_time") < sb.indexOf('booking_reservation_no = $2')
    && sb.indexOf('booking_reservation_no = $2') < sb.indexOf('createOrderLedgerEntry('));
  t('★ 작업표는 그 자리 줄 번호로만(sheetRow: target.rowIndex · 남의 줄 안 덮음)', /sheetRow: target\.rowIndex/.test(sb) && /requireEmptyOrSame: true/.test(sb));
  t('★ 제출 창구도 준비 중 판정 장치를 그대로 탄다(다음에 다시 준비 중이 되면 함께 닫힌다)', /isWorkKindReady\('booking'\)/.test(sb));
  t('홀드 조회가 booking_slot_id 를 같은 왕복에 읽는다', /ca\.qna_slot_id, ca\.booking_slot_id,/.test(sub));
  t('★ 검수 격리 그대로(리뷰 업로드의 예약 탭 건너뜀)', /_isBookingUpload/.test(S('src/routes/diag.routes.js')));

  // 화면
  const ch = F('campaign.html');
  t('★ 예약 공고: 참여 전 매장 안내 + 날짜 고르기 카드', /id="bkPreBox"/.test(ch) && /function renderBookingPre\(/.test(ch));
  t('★ 신청 본문에 고른 날짜(bookingDate)', /body\.bookingDate = _bkDate/.test(ch));
  t('★ 예약 공고는 구매양식 대신 예약 카드', /\$\('bookingBox'\)\.style\.display = _bk \? '' : 'none'/.test(ch) && /\$\('orderBox'\)\.style\.display = \(_qna \|\| _bk(?: \|\| _rc)?\) \? 'none' : ''/.test(ch));
  t('★ 제출 순서 = 예약내역 기록 → 예약내역 캡처(구매캡처 길) ', ch.indexOf("'/api/submit/booking'") > 0 && ch.indexOf("'/api/submit/booking'") < ch.indexOf("action:'uploadOrderImage'"));
  t('★ 리뷰 캡처는 기존 리뷰 업로드 길(uploadReviewImage → submitReview)', /function onBookingReviewSubmit\(/.test(ch)
    && ch.indexOf("action:'uploadReviewImage'", ch.indexOf('function onBookingReviewSubmit(')) > 0);
  t('★ 막다른 길 0: 예약내역을 낸 뒤에는 [참여 취소]를 숨긴다(서버 취소는 applied 만 받는다)',
    /\$\('joinedCancelBtn'\)\.style\.display = submitted \? 'none' : ''/.test(ch) && /id="joinedCancelBtn"[^>]*onclick="onCancel\(\)"/.test(ch)
    && /AND status IN \('applied', 'blog_pending'\)/.test(S('src/routes/campaign.routes.js')));
  t('모집 카드: 예약 공고는 「옵션 N종」 칩 대신 날짜(매장 하나)', /if \(c\.work_kind === 'booking'\) return '';/.test(F('js/campaign-cards.js')));
  t('★ 리뷰 캡처까지 내야 완료(예약내역만 냈으면 완료 화면 아님)', /if\(isBookingCampaign\(\) \|\| j\.bookingSlot\) return !!\(j\.bookingSlot && j\.bookingSlot\.reviewDone === true\)/.test(ch));
  {
    const card = ch.slice(ch.indexOf('function renderBookingPre('), ch.indexOf('function startHoldCountdown'));
    t('★ 링크에 대각선 화살표 없음(색·밑줄·「열기」로 구분)', !/[↗⬈➚]|fa-external|arrow-up-right/.test(card) && /네이버 예약 열기/.test(card));
    t('무료체험형 안내 문구(현장에서 업체가 무료 처리 · 예약만)', /현장에서 업체가 무료로 처리해요/.test(card));
  }
  t('거절 사유 문구표 하나(_APPLY_REASON_TEXT)에 예약 사유', /booking_date_full:/.test(ch) && /booking_date_closed:/.test(ch) && /booking_date_required:/.test(ch));
  // 날짜 칩 — 실제 실행(남은 자리 있는 날만 · 오늘 제외)
  {
    const fnSrc = ch.slice(ch.indexOf('function _bkPickableDates('), ch.indexOf('\n}\n', ch.indexOf('function _bkPickableDates(')) + 2);
    const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc + '\nthis.f = _bkPickableDates;', ctx);
    const out = ctx.f({ dates: [{ date: T0, left: 1, bookable: false }, { date: T1, left: 0, bookable: true }, { date: T2, left: 1, bookable: true }] });
    t('★ 날짜 칩 = 고를 수 있고 남은 자리 있는 날만(실제 실행)', out.length === 1 && out[0].date === T2);
  }
  // 작업보드 표시
  {
    const wd = F('workdesk.html');
    const fn = wd.slice(wd.indexOf('function _gridVal('), wd.indexOf('function _isPhoneHeader('));
    const kd = wd.slice(wd.indexOf('function _fmtKDate('), wd.indexOf('\n}\n', wd.indexOf('function _fmtKDate(')) + 2);
    const ctx = { _gridEditVal: (h, v) => v, _isDepositCol: () => false, _isPhoneHeader: () => false, _fmtPhone: v => v, _workdeskStatusKind: () => '', _fmtMD: v => v, _fmtSubmitCell: v => v };
    vm.createContext(ctx);
    vm.runInContext(kd + '\n' + fn + '\nthis.g = _gridVal;', ctx);
    t('★ 작업보드: 리뷰마감일도 이용일자와 같은 표기(12/7 (월))', ctx.g('리뷰마감일', '12 / 7 (월)') === '12/7 (월)' && ctx.g('이용일자', '12 / 4 (금)') === '12/4 (금)');
    t('작업보드 리뷰마감일 머리글 = 서버 상수와 같은 글자', fn.includes("h==='" + require('../src/utils/worktablePlan').BOOKING_DEADLINE_HEADER + "'"));
    t('리뷰마감일 비슷한 다른 이름 칸은 그대로(정확 일치만)', ctx.g('리뷰마감', '12 / 7 (월)') === '12 / 7 (월)');
  }
  // 발행 폼
  {
    const ir = F('js/index-recruit.js');
    t('★ 발행 폼: 예약 안내 카드(매장·주소·예약 링크·돈 방식·날짜별 인원)', /function _rfRenderBookingCard\(/.test(ir) && /rf_booking_card/.test(ir));
    {
      const hide = (ir.match(/const _RF_BOOKING_HIDE_IDS = \[([^\]]*)\]/) || [])[1] || '';
      t('★ 발행 폼: 예약 공고는 상품 리뷰 전용 칸(구매채널·배송·회수·필수 배송메세지·주말·유입 방식·상품메인 URL)을 숨기고 상품 추가를 감춘다',
        ['rf_channel_btns', 'rf_delivery_toggle', 'rf_delivery_mix_row', 'rf_recall_row', 'rf_required_delivery_memo', 'rf_skip_weekends_toggle', 'rf_inflow_type_ui', 'rf_product_main_url']
          .every(id => hide.includes('"' + id + '"'))
        && /function _rfApplyWorkKindUi\(\)[\s\S]{0,4000}_rfApplyBookingUi\(_kind === "booking"(?: \|\| _kind === "receipt", _kind)?\);/.test(ir) && /getElementById\("rf_opt_addbtn"\)[\s\S]{0,200}add\.hidden = true/.test(ir));
      t('발행 폼 게시 전 점검: 예약 공고는 구매채널·모집 시작일·하루 인원을 요구하지 않는다', /if \(!channel && !_wkBooking\)/.test(ir) && /if \(!startDate && !_wkBooking\)/.test(ir) && /!_wkBlog && !_wkBooking\) errs\.push/.test(ir));
      // 카드 실제 실행 — 무료체험형 · 링크 「열기」 · 날짜·인원
      const fnSrc = ir.slice(ir.indexOf('function _rfBkDay('), ir.indexOf('function _ensureWorkboardDisplayNameInput'));
      const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc + '\nthis.r = _rfRenderBookingCard;', ctx);
      const html = ctx.r({ placeName: '가짜식당 <b>', placeAddress: '서울 가짜구', bookingUrl: 'https://booking.naver.com/x', payMode: 'free', pay: 0,
        dates: [{ date: '2026-12-04', count: 2 }, { date: '2026-12-05', count: 1 }], total: 3, reviewDeadlineDays: 3, blockers: [] });
      t('★ 발행 폼 카드(실제 실행): 무료체험형 설명 · 「네이버 예약 열기」 · 12/4 (금) 2명 · 이름 안전 표기',
        /무료체험형/.test(html) && />네이버 예약 열기</.test(html) && /12\/4 \(금\) <b>2명<\/b>/.test(html) && /가짜식당 &lt;b&gt;/.test(html) && !/[↗⬈➚]/.test(html));
      t('발행 폼 카드: 예약 정보를 못 받으면 사실대로 말한다', /불러오지 못했습니다/.test(ctx.r(null)));
    }
    const wod = F('js/work-order-detail.js');
    t('★ 프리필: 예약 정보 = 서버 단일 출처(booking_spec ← bookingSpecFromWorkOrder)를 그대로', /booking_spec/.test(wod) && /bookingSpecFromWorkOrder/.test(S('src/routes/trackB.routes.js')));
  }

  console.log(`\n✅ ${pass}개 통과\n`);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
