/**
 * bookingReviewDeadline.test.js — 네이버예약리뷰 리뷰 마감 안내(결정 422 · 사용자 확정 2026-11-25 「1번」).
 * 실행: node tests/bookingReviewDeadline.test.js
 *
 * 사용자 확정:
 *   · 리뷰 마감이 지나도 리뷰어는 **그대로 낼 수 있다**(막지 않는다 · 입금도 그대로).
 *   · 담당자 작업보드: 리뷰마감일이 지났는데 리뷰가 아직 없는 줄에 「마감 지남」(+ 표 위 「리뷰 마감 지남 N명」).
 *   · 리뷰어 화면(공고 리뷰 단계 띠 · 리뷰어 홈 리뷰 내역 카드 · 리뷰 제출 페이지 결과 카드):
 *     마감 전날 「내일 마감」 · 마감 날 「오늘 마감」. 날짜 = 서버 KST(휴대폰 시계 안 씀 · 결정 415 과 같은 방향).
 *   · 보여 주기만 — 문자·알림톡 발송 없음.
 *
 * 구성:
 *   0) 판정 단일 출처 `bookingCalendar.reviewDeadlineState` + 서버 시계(KST) 경계 — 시계를 주입해 자정 앞뒤를 본다.
 *   1) 끝에서 끝까지(PGlite · 저장소 migrations 그대로 · 실제 처리기): 오더 → 접수 → 발행 → 네 명 신청·예약내역 →
 *      자리표 리뷰마감일을 어제/오늘/내일/모레로 둔 뒤 참여 상세 · 리뷰어 검색(홈·제출 페이지 공용) · 작업보드 →
 *      마감 지난 사람이 리뷰를 **그대로 제출**(200) → 「마감 지남」이 풀린다.
 *   2) 화면(실제 함수 vm 실행): 작업보드 칸 표시·표 위 건수·열 너비 · 공고 리뷰 단계 띠 · 리뷰어 홈 카드 · 제출 페이지 카드.
 * ★ 가짜 이름·가짜 매장·가짜 계좌 · 사진 저장(구글 드라이브)만 흉내 · 외부 호출 0.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const jwt = require('jsonwebtoken');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : '')); pass++; console.log('  ✓ ' + name); };

const SERVER = path.join(__dirname, '..');
const ROOT = path.join(SERVER, '..');
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booking-deadline-secret';
process.env.ORDER_INTAKE_KEY = 'test-intake-key-booking-deadline';
process.env.REVIEW_INSPECT = '0';
process.env.BOOKING_CAPTURE_CHECK = '0';
process.env.AI_REVIEW_FOLDER_ID = 'FOLDER-ROOT-FAKE-0123456789';
process.env.WORKBOARD_V2_ENABLED = '1';

const DAY = 86400000;
const kstYmd = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const NOW = Date.now();
const TODAY = kstYmd(NOW), YESTERDAY = kstYmd(NOW - DAY), TOMORROW = kstYmd(NOW + DAY), LATER = kstYmd(NOW + 2 * DAY);
const D1 = kstYmd(NOW + 9 * DAY), D2 = kstYmd(NOW + 10 * DAY), D3 = kstYmd(NOW + 12 * DAY);

// ★ DB 연결은 맨 앞에서 대역으로 갈아 끼운다(0절에서 먼저 읽히는 모듈이 실제 연결을 붙잡지 않게) — 실제 PGlite 는 1절에서 꽂는다.
let poolImpl = null;
{
  const poolPath = require.resolve('../src/db/pool');
  const proxy = { query: (...a) => poolImpl.query(...a), connect: (...a) => poolImpl.connect(...a), on() {}, end: async () => {} };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: proxy };
}

/* ── 0) 판정 단일 출처 · KST 시계 경계 ─────────────────────────── */
console.log('\n0) 판정 — reviewDeadlineState(마감일, 오늘) · 서버 시계 KST');
{
  const cal = require('../src/utils/bookingCalendar');
  const st = cal.reviewDeadlineState;
  t('★★ 판정 함수가 계약 모듈 한 곳에 있다', typeof st === 'function' && typeof cal.reviewDeadlineNotice === 'function');
  t('  마감일 = 오늘 → today', st('2026-12-03', '2026-12-03') === 'today');
  t('  마감일 = 내일 → tomorrow', st('2026-12-03', '2026-12-02') === 'tomorrow');
  t('  마감일이 지남 → overdue', st('2026-12-03', '2026-12-04') === 'overdue' && st('2026-11-01', '2026-12-04') === 'overdue');
  t('  모레 이후 → later(안내 없음)', st('2026-12-05', '2026-12-03') === 'later');
  t('  달·해 넘김: 12/31 → 1/1 은 내일', st('2027-01-01', '2026-12-31') === 'tomorrow' && st('2026-12-01', '2026-11-30') === 'tomorrow');
  t('★ 모르는 값(빈 값·없는 날짜) = null — 「지남」으로 꾸미지 않는다', st('', '2026-12-03') === null && st('2026-02-30', '2026-02-28') === null && st('2026-12-03', null) === null);
  t('  리뷰어 안내 글자 = 오늘 마감 · 내일 마감 · 그 밖은 빈 글자', cal.reviewDeadlineNotice('today') === '오늘 마감' && cal.reviewDeadlineNotice('tomorrow') === '내일 마감'
    && cal.reviewDeadlineNotice('overdue') === '' && cal.reviewDeadlineNotice('later') === '' && cal.reviewDeadlineNotice(null) === '');

  const bks = require('../src/services/bookingSlots.service');
  const at = (iso) => bks.reviewDeadlineStateAt('2026-12-03', new Date(iso));
  t('★★ 서버 시계 KST: 12/2 23:59:59(KST) = 내일 마감', at('2026-12-02T14:59:59Z') === 'tomorrow');
  t('★★ 서버 시계 KST: 12/3 00:00(KST) = 오늘 마감(UTC 로는 아직 12/2)', at('2026-12-02T15:00:00Z') === 'today');
  t('  12/3 23:59:59(KST) = 아직 오늘 마감', at('2026-12-03T14:59:59Z') === 'today');
  t('★★ 12/4 00:00(KST) = 마감 지남', at('2026-12-03T15:00:00Z') === 'overdue');
  const v = bks.publicSlotView({ slot_date: '2026-11-30', review_deadline: '2026-12-03' }, null, new Date('2026-12-02T16:00:00Z'));
  t('★ 참여 상세 자리 정보에 마감 상태·안내 글자(서버가 정한다)', v.reviewDeadline === '2026-12-03' && v.reviewDeadlineState === 'today' && v.reviewDeadlineNotice === '오늘 마감', v);
  const v2 = bks.publicSlotView({ slot_date: '2026-11-30', review_deadline: '2026-12-03' }, null, new Date('2026-12-05T00:00:00Z'));
  t('  지난 마감은 리뷰어 안내 글자 없음(막지 않음 · 표시는 담당자 쪽)', v2.reviewDeadlineState === 'overdue' && v2.reviewDeadlineNotice === '', v2);
}

/* ── 1) 끝에서 끝까지 ─────────────────────────────────────────── */
async function openDb() {
  const mod = process.env.PGLITE_MODULE || '@electric-sql/pglite';
  const { PGlite } = require(mod);
  const base = path.dirname(require.resolve(mod));
  const ext = n => require(require.resolve('@electric-sql/pglite/contrib/' + n, { paths: [base] }))[n];
  const extensions = {};
  try { extensions.pgcrypto = ext('pgcrypto'); extensions.pg_trgm = ext('pg_trgm'); } catch (_) { /* 아래 확인이 알려 준다 */ }
  const db = new PGlite({ extensions });
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에서 안 도는 몇 파일 */ }
  }
  const bk = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'booking_slots' AND column_name = 'review_deadline'`)).rows;
  assert(bk.length === 1, 'migration 227(booking_slots.review_deadline) 적용 실패');
  return db;
}
function poolOf(db) {
  let chain = Promise.resolve();
  const raw = async (sql, params) => {
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  const connect = async () => {
    let release;
    const wait = chain;
    chain = new Promise(r => { release = r; });
    await wait;
    return { query: raw, release() { release(); } };
  };
  return { query: raw, connect, on() {}, end: async () => {} };
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
  assert(layer, '실제 처리기 경로: ' + method + ' ' + p);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function intranetBody(sid) {
  const place = {
    name: '가짜식당 마감점', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
    base: { pay: 25000, count: 6, daily: 0, review_type_mix: [] }, options: [],
    booking: { pay_mode: 'refund', dates: [{ date: D1, count: 2 }, { date: D2, count: 1 }, { date: D3, count: 3 }],
      review_deadline_days: 3, place_address: '서울 가짜구 가짜로 9' },
  };
  return {
    requester_id: 'u-fake-1', requester_username: 'fake-owner', requester_name: '가짜등록자',
    source_review_order_id: sid, source_revision: 1, workboard_schema_version: 2, idempotency_key: `${sid}:1`,
    work_series_id: sid, work_round: 1,
    intranet_advertiser_id: '', intranet_advertiser_name: '', intranet_advertiser_contact: '', intranet_advertiser_business_number: '',
    sales_id: '', quote_id: '', contract_number: '',
    title: '[가짜] 가짜식당 마감점 예약리뷰', ae_name: '가짜등록자', work_manager: '박세희', manager_name: '가짜담당',
    work_kind: 'booking', start_date: D1, recruit_count: 6, review_fee: 5000, pay_amount: 150000,
    product_option: `[매장/날짜/인원] 1. 가짜식당 마감점 - ${D1} 2명 / ${D2} 1명 / ${D3} 3명`,
    product_options_json: JSON.stringify([place]), product_url: 'https://booking.naver.com/booking/6/bizes/000000',
    review_guide: '맛·분위기 사진 3장 이상', special_notes: '가짜 특이사항',
  };
}

async function e2e() {
  console.log('\n1) 끝에서 끝까지 — 마감 지남 / 오늘 / 내일 / 모레 네 명');
  const db = await openDb();
  const pool = poolOf(db);
  poolImpl = pool;
  const q = (s, p) => pool.query(s, p);
  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);

  const orders = require('../src/routes/order.routes');
  const campaignRoutes = require('../src/routes/campaign.routes');
  const submitRoutes = require('../src/routes/submit.routes');
  const diagRoutes = require('../src/routes/diag.routes');
  const intakeH = handlerOf(orders, 'post', '/intake');
  const acceptH = orders.handlers.orderAdminAccept;
  const createH = handlerOf(campaignRoutes, 'post', '/admin/create');
  const applyH = handlerOf(campaignRoutes, 'post', '/:id/apply');
  const workDetailH = handlerOf(campaignRoutes, 'get', '/:id/work-detail');
  const bookingH = handlerOf(submitRoutes, 'post', '/booking');
  const reviewH = handlerOf(submitRoutes, 'post', '/review');
  const reviewUploadH = handlerOf(diagRoutes, 'post', '/review-upload');
  const ADMIN = { name: '가짜관리자', role: 'master', id: 1, username: 'fake-admin' };
  const adminJwt = jwt.sign({ role: 'master', name: ADMIN.name, id: 1, username: 'fake-admin' }, process.env.JWT_SECRET);
  const call = async (h, { body = {}, params = {}, query = {}, headers = {}, admin } = {}) => {
    const res = fakeRes(); let err = null;
    const req = { body, params, query, headers: { 'x-intake-key': process.env.ORDER_INTAKE_KEY, ...headers }, ip: '127.0.0.1', get: () => '',
      path: '/x', method: 'POST', ...(admin ? { admin } : {}) };
    await h(req, res, e => { err = e; });
    if (err) throw err;
    return res;
  };
  const drive = require('../src/services/drive.service');
  let upSeq = 0;
  drive.uploadFileBase64 = async (data, name) => ({ id: 'FAKEFILE' + (++upSeq) + '-0123456789abcdef', name, webViewLink: '' });
  drive.trashFiles = async () => ({ success: 0, failed: 0 });
  drive.getOrCreateSubFolder = async (parent, name) => ({ id: 'FOLDER-SUB-' + String(name).length + '-0123456789' });
  drive.ensureReviewFolderPath = async () => ({ id: 'FOLDER-FAKE-0123456789', url: 'https://drive.google.com/drive/folders/FOLDER-FAKE-0123456789' });
  const cf = require('../src/services/captureFolder.service');
  cf.resolveCaptureFolder = async () => ({ folderId: 'FOLDER-FAKE-0123456789', folderUrl: 'https://drive.google.com/drive/folders/FOLDER-FAKE-0123456789' });

  // 오더 → 접수 → 발행
  const SID = 'ro_bk_deadline_1';
  const ir = await call(intakeH, { body: intranetBody(SID) });
  t('  새 오더 접수 창구 통과', ir.statusCode < 300 && ir.body && ir.body.ok !== false, ir.body);
  let wo = (await q(`SELECT * FROM work_orders WHERE source_review_order_id = $1`, [SID])).rows[0];
  const ac = await call(acceptH, { body: { id: wo.id }, admin: ADMIN });
  t('  접수 성공(작업표 + 자리표)', ac.statusCode === 200 && ac.body && ac.body.ok === true, ac.body);
  wo = (await q(`SELECT * FROM work_orders WHERE id = $1`, [wo.id])).rows[0];
  const sheetId = wo.linked_tab_sheet_id, tab = wo.linked_tab_name, gid = wo.linked_tab_gid;
  const cr = await call(createH, { admin: ADMIN, headers: { authorization: 'Bearer ' + adminJwt }, body: {
    title: '가짜식당 마감점 방문 체험', participation_mode: true, status: 'active', work_kind: 'booking',
    linked_sheet_id: sheetId, linked_tab_name: tab, linked_tab_gid: gid, source_work_order_id: wo.id,
    recruit_total: 6, daily_limit: 6, max_slots: 6, hold_ttl_min: 20, review_fee: 5000,
    window_start: '00:00', window_end: '23:59', close_buffer_min: 0, skip_weekends: false, multi_account_mode: false,
    thumbnail_url: '', review_type: '', review_type_mix: [], delivery_type: '', channel: '네이버',
    transfer_bank: 'kbank', transfer_memo: '인애드', work_detail: { guide: '방문 후 솔직한 리뷰를 남겨 주세요.' },
    options: [{ optKey: '가짜식당 마감점', productName: '가짜식당 마감점', unitKind: 'product', payAmount: 25000, recruitTotal: 6, dailyLimit: 0,
      optionUrl: 'https://booking.naver.com/booking/6/bizes/000000' }] } });
  t('  공고 발행 성공', cr.statusCode === 200 && cr.body && cr.body.ok === true, cr.body);
  const campId = cr.body.data.id;

  // 네 명 — 신청 · 예약내역(리뷰는 아직)
  const people = {};
  let n = 0;
  for (const [who, date, deadline] of [['가짜지남', D1, YESTERDAY], ['가짜오늘', D1, TODAY], ['가짜내일', D2, TOMORROW], ['가짜모레', D3, LATER]]) {
    n++;
    const phone = '0107788' + String(1000 + n);
    const p8 = phone.slice(-8);
    await q(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder, address) VALUES ($1, $2, '국민은행', $3, $1, '서울 가짜구')`,
      [who, phone, '8100000000' + n]);
    const ap = await call(applyH, { params: { id: campId }, body: { name: who, phone, bookingDate: date, optionKey: '가짜식당 마감점' } });
    assert(ap.statusCode === 200 && ap.body.ok === true, who + ' 신청 실패 ' + JSON.stringify(ap.body));
    const appId = ap.body.applicationId;
    const rid = (await q(`SELECT id FROM reviewers WHERE phone8 = $1`, [p8])).rows[0].id;
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [appId, rid]);
    const tok = require('../src/services/reviewerSession.service').issueReviewerSession({ ownerReviewerId: rid, loginName: who, loginPhone8: p8 });
    const sub = await call(bookingH, { headers: { 'x-reviewer-token': tok },
      body: { campaignId: campId, campaignApplicationId: appId, holdToken: ap.body.holdToken, holdPhone8: p8, reservationNo: 'D' + (7000 + n), payAmount: '25,000' } });
    assert(sub.statusCode === 200 && sub.body.ok === true, who + ' 예약내역 실패 ' + JSON.stringify(sub.body));
    const rowIndex = Number(sub.body.target.rowIndex);
    // 시간이 흐른 것처럼 — 그 자리의 리뷰마감일(자리표 · 작업표 칸 함께)을 어제/오늘/내일/모레로 둔다
    const slot = (await q(`SELECT s.id FROM campaign_applications a JOIN booking_slots s ON s.id = a.booking_slot_id WHERE a.id = $1`, [appId])).rows[0];
    await q(`UPDATE booking_slots SET review_deadline = $2::date WHERE id = $1`, [slot.id, deadline]);
    await q(`UPDATE campaign_participants SET row_json = jsonb_set(row_json, '{리뷰마감일}', to_jsonb($4::text)) WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`,
      [sheetId, tab, rowIndex, deadline]);
    people[who] = { phone, p8, rid, tok, appId, holdToken: ap.body.holdToken, rowIndex, deadline };
  }
  t('  네 명 신청·예약내역 접수(리뷰는 아직)', Object.keys(people).length === 4);

  // 참여 상세(공고 리뷰 단계 띠의 재료)
  for (const [who, want, notice] of [['가짜지남', 'overdue', ''], ['가짜오늘', 'today', '오늘 마감'], ['가짜내일', 'tomorrow', '내일 마감'], ['가짜모레', 'later', '']]) {
    const p = people[who];
    const r = await call(workDetailH, { params: { id: campId }, query: { phone8: p.p8, holdToken: p.holdToken } });
    const b = r.body && r.body.bookingSlot;
    t(`★★ 참여 상세 ${who}: 마감 ${p.deadline} → ${want}${notice ? ' · 「' + notice + '」' : ' · 안내 없음'}`,
      r.statusCode === 200 && b && b.reviewDeadline === p.deadline && b.reviewDeadlineState === want && b.reviewDeadlineNotice === notice, b);
  }

  // 리뷰어 검색(리뷰어 홈 리뷰 내역 · 리뷰 제출 페이지가 같은 함수를 탄다)
  const search = require('../src/services/search.service');
  for (const [who, notice] of [['가짜지남', ''], ['가짜오늘', '오늘 마감'], ['가짜내일', '내일 마감'], ['가짜모레', '']]) {
    const p = people[who];
    const res = await search.searchByName('', p.p8, { includeSubmitted: true, ownerReviewerId: p.rid, ownerPhone8s: [p.p8], strictPhoneScope: true });
    const it = (res.results || []).find(x => x.sheetId === sheetId && x.tabName === tab && Number(x.rowIndex) === p.rowIndex);
    t(`★★ 리뷰어 검색 ${who}: 결과 줄에 마감일·안내 글자「${notice}」(서버 KST)`, it && it.workKind === 'booking' && it.reviewDeadline === p.deadline
      && it.reviewDeadlineNotice === notice, it && { wk: it.workKind, d: it.reviewDeadline, s: it.reviewDeadlineState, n: it.reviewDeadlineNotice });
  }

  // 작업보드(담당자)
  const trackB = require('../src/services/trackB.service');
  const board = async (role = 'master') => trackB.workdeskTab({ sheetId, tabName: tab, role, allowAllWorkdesk: true });
  const rowOf = (wd, who) => (wd.roster || []).find(r => Number(r.seq) === people[who].rowIndex);
  {
    const wd = await board();
    t('★★★ 작업보드: 마감 지난 줄(리뷰 없음)만 「마감 지남」 표시', rowOf(wd, '가짜지남') && rowOf(wd, '가짜지남').bookingReviewOverdue === true
      && ['가짜오늘', '가짜내일', '가짜모레'].every(w => rowOf(wd, w) && !rowOf(wd, w).bookingReviewOverdue), (wd.roster || []).map(r => [r.seq, r.name, r.bookingReviewOverdue]));
    t('★★ 표 위 건수 = 1명(서버가 센다)', wd.bookingReviewOverdue === 1, wd.bookingReviewOverdue);
    // 아무도 신청하지 않은 빈 자리도 마감이 지나면? — 사람이 없으니 표시하지 않는다
    await q(`UPDATE booking_slots SET review_deadline = $3::date WHERE sheet_id = $1 AND tab_name = $2 AND seq NOT IN (${Object.values(people).map(p => Number(p.rowIndex)).join(',')})`, [sheetId, tab, YESTERDAY]);
    const wd2 = await board();
    t('  빈 자리(신청 없음)는 마감이 지나도 표시하지 않는다', wd2.bookingReviewOverdue === 1
      && (wd2.roster || []).filter(r => r.bookingReviewOverdue).length === 1, (wd2.roster || []).map(r => [r.seq, r.filled, r.bookingReviewOverdue]));
    const adv = await board('advertiser');
    t('  업체 화면에는 싣지 않는다(내부 담당자 표시만)', (adv.roster || []).every(r => r.bookingReviewOverdue === undefined) && adv.bookingReviewOverdue === undefined,
      { n: adv.bookingReviewOverdue });
    // 자리표를 못 읽으면(표시만) 작업보드는 그대로 뜬다 — 「마감 지남」·건수 없이(꾸미지 않음)
    await q(`ALTER TABLE booking_slots RENAME TO booking_slots_gone`);
    let wd3 = null, err3 = null;
    try { wd3 = await board(); } catch (e) { err3 = e; }
    await q(`ALTER TABLE booking_slots_gone RENAME TO booking_slots`);
    t('★★ 리뷰마감일 조회 실패 = 작업보드는 그대로 뜬다 · 「마감 지남」·건수 없음', !err3 && wd3 && (wd3.roster || []).length === 6
      && (wd3.roster || []).every(r => !r.bookingReviewOverdue) && wd3.bookingReviewOverdue === undefined, err3 && err3.message);
  }

  // ★★★ 마감 지난 사람도 리뷰를 그대로 낼 수 있다(막지 않음)
  {
    const p = people['가짜지남'];
    const up = await call(reviewUploadH, { headers: { 'x-reviewer-token': p.tok },
      body: { sheetId, tabName: tab, gid, rowIndex: p.rowIndex, reviewerName: '가짜지남', campaignName: tab, slotKey: 'review',
        files: [{ data: Buffer.from('fake-late-review').toString('base64'), mimeType: 'image/jpeg', fileName: '가짜지남_리뷰.jpg', name: '가짜지남_리뷰.jpg' }] } });
    t('★★★ 마감 지난 리뷰 캡처 업로드 — 막지 않는다', up.body && up.body.ok === true, up.body);
    const fin = await call(reviewH, { headers: { 'x-reviewer-token': p.tok },
      body: { sheetId, gid, tabName: tab, rowIndex: p.rowIndex, value: '제출', phone8: p.p8, uploadBatchId: up.body.uploadBatchId || up.body.batchId } });
    t('★★★ 마감 지난 리뷰 제출 — 막지 않는다(200)', fin.statusCode === 200 && fin.body && !fin.body.error && fin.body.ok !== false, fin.body);
    const wd = await board();
    t('★★ 리뷰를 내면 「마감 지남」이 풀린다 · 건수 0', !rowOf(wd, '가짜지남').bookingReviewOverdue && wd.bookingReviewOverdue === 0,
      { row: rowOf(wd, '가짜지남'), n: wd.bookingReviewOverdue });
    const r = await call(workDetailH, { params: { id: campId }, query: { phone8: p.p8, holdToken: p.holdToken } });
    t('  참여 상세: 리뷰 제출됨(완료 화면으로)', r.body && r.body.bookingSlot && r.body.bookingSlot.reviewDone === true, r.body && r.body.bookingSlot);
    const pay = require('../src/services/payment.service');
    const { items } = await pay.listPaymentTargets({ includeFinished: true });
    const A = items.find(it => it.sheetId === sheetId && it.tabName === tab && Number(it.rowIndex) === p.rowIndex);
    t('★★ 늦게 낸 리뷰도 입금 대상 그대로(결제금액 25,000 + 리뷰비 5,000)', A && A.payable === true && A.amount === 30000, A && { a: A.amount, ok: A.payable, i: A.issues });
  }
  {
    // 리뷰를 낸 사람은 검색 결과에서 안내 글자를 받지 않는다(제출완료 줄)
    const p = people['가짜오늘'];
    const up = await call(reviewUploadH, { headers: { 'x-reviewer-token': p.tok },
      body: { sheetId, tabName: tab, gid, rowIndex: p.rowIndex, reviewerName: '가짜오늘', campaignName: tab, slotKey: 'review',
        files: [{ data: Buffer.from('fake-today-review').toString('base64'), mimeType: 'image/jpeg', fileName: '가짜오늘_리뷰.jpg', name: '가짜오늘_리뷰.jpg' }] } });
    await call(reviewH, { headers: { 'x-reviewer-token': p.tok },
      body: { sheetId, gid, tabName: tab, rowIndex: p.rowIndex, value: '제출', phone8: p.p8, uploadBatchId: up.body.uploadBatchId || up.body.batchId } });
    const res = await search.searchByName('', p.p8, { includeSubmitted: true, ownerReviewerId: p.rid, ownerPhone8s: [p.p8], strictPhoneScope: true });
    const it = (res.results || []).find(x => x.sheetId === sheetId && x.tabName === tab && Number(x.rowIndex) === p.rowIndex);
    t('  리뷰를 낸 줄 = 안내 글자 없음', it && it.isSubmitted === true && !it.reviewDeadlineNotice, it && { s: it.isSubmitted, n: it.reviewDeadlineNotice });
  }
  {
    // 자리표 조회가 실패하면(표시만) 안내를 꾸미지 않는다 — 검색은 그대로 돈다
    const bks = require('../src/services/bookingSlots.service');
    const m = await bks.reviewDeadlinesForRows({ query: async () => { throw new Error('boom'); } }, [{ sheetId, tabName: tab, rowIndex: 1 }]);
    t('  마감일 묶음 조회 실패 = null(호출부는 안내 없이 종전 화면)', m === null);
  }
  await db.close();
}

/* ── 2) 화면 — 실제 함수 vm 실행 ───────────────────────────────── */
function fnSlice(src, head) {
  const s = src.indexOf(head);
  assert(s >= 0, head + ' 를 찾지 못했습니다');
  const e = src.indexOf('\nfunction ', s + head.length);
  return src.slice(s, e < 0 ? undefined : e);
}
function screens() {
  console.log('\n2) 화면');
  const WD = fs.readFileSync(path.join(ROOT, 'frontend/workdesk.html'), 'utf8');
  {
    const sb = { esc: s => String(s == null ? '' : s).replace(/</g, '&lt;'), STATE: { role: 'admin' } };
    vm.createContext(sb);
    vm.runInContext([fnSlice(WD, 'function _bkOverdueCls('), fnSlice(WD, 'function _bkOverduePad('), fnSlice(WD, 'function _bkOverdueBar(')].join('\n'), sb);
    t('★★ 작업보드 칸: 「리뷰마감일」 칸 + 서버 표시 줄만 마감 지남 모양', sb._bkOverdueCls({ bookingReviewOverdue: true }, '리뷰마감일') === ' gbkover'
      && sb._bkOverdueCls({ bookingReviewOverdue: true }, '이용일자') === '' && sb._bkOverdueCls({}, '리뷰마감일') === '' && sb._bkOverdueCls(null, '리뷰마감일') === '');
    t('  열 너비가 글자 자리만큼 넓어진다(잘리지 않게)', sb._bkOverduePad({ bookingReviewOverdue: true }, '리뷰마감일') > 40 && sb._bkOverduePad({}, '리뷰마감일') === 0);
    const bar = sb._bkOverdueBar({ bookingReviewOverdue: 2 });
    t('★★ 표 위: 「리뷰 마감 지남 2명」 · 막지 않는다는 설명', /리뷰 마감 지남 <b>2<\/b>명/.test(bar) && /gsmsg show/.test(bar) && /막지 않/.test(bar), bar);
    t('  0명·건수 없음(예약 작업 아님 · 업체) = 그리지 않는다', sb._bkOverdueBar({ bookingReviewOverdue: 0 }) === '' && sb._bkOverdueBar({}) === '' && sb._bkOverdueBar(null) === '');
    t('★ 칸 글자는 화면에만(CSS) — 복사·내려받기·정렬 값(날짜)은 그대로', /td\.gbkover::after\{content:'마감 지남'/.test(WD));
    const grid = WD.slice(WD.indexOf('const rowHtml=(r)=>{'), WD.indexOf('// 본문 행 배열(청크 렌더용)'));
    t('  표 그리기가 그 판정을 탄다(시트 칸 갈래)', /typeof _bkOverdueCls==='function'\?_bkOverdueCls\(r,h\):''/.test(grid));
    t('  표 위 막대가 건수를 그린다', /typeof _bkOverdueBar==='function'\?_bkOverdueBar\(wd\):''/.test(WD));
    t('  자동 열 너비가 그 자리를 더한다', /typeof _bkOverduePad==='function'\?_bkOverduePad\(r,h\):0/.test(fnSlice(WD, 'function _gridAutoColumnWidths(')));
  }
  {
    const CP = fs.readFileSync(path.join(ROOT, 'frontend/campaign.html'), 'utf8');
    const src = fnSlice(CP, 'function renderBookingCard(j, h){');
    const run = (bookingSlot) => {
      const els = {};
      const bar = { cls: new Set(), classList: { toggle(c, on) { if (on) bar.cls.add(c); else bar.cls.delete(c); }, remove(c) { bar.cls.delete(c); }, contains(c) { return bar.cls.has(c); } } };
      const el = (id) => els[id] || (els[id] = { id, textContent: '', innerHTML: '', style: {}, dataset: {}, closest: () => bar });
      const sb = { $: el, _escAttr: s => String(s == null ? '' : s), _qnaDateLabel: s => String(s || ''), _bkShort: s => String(s || ''), _qnaHm: s => s,
        clearInterval() {}, startHoldCountdown() {}, _holdTick: 0, _bkResvB64: '', _bkReviewB64: '' };
      vm.createContext(sb);
      vm.runInContext(src, sb);
      sb.renderBookingCard({ bookingSlot, application: { status: 'submitted', expiresAt: null } }, null);
      return { label: els.holdLabel.textContent, cd: els.holdCd.textContent, soon: bar.cls.has('is-soon'), body: els.bookingBody.innerHTML };
    };
    const base = { date: '2026-11-30', reviewDeadline: '2026-12-03', place: { placeName: '가짜식당', payMode: 'refund' }, reservationNo: 'D1' };
    const a = run({ ...base, reviewDeadlineState: 'today', reviewDeadlineNotice: '오늘 마감' });
    t('★★★ 공고 리뷰 단계 띠: 「리뷰 마감 · 오늘 마감」 + 곧 마감 색(기존 is-soon)', a.label === '리뷰 마감 · 오늘 마감' && a.soon === true && a.cd === '2026-12-03', a);
    const b = run({ ...base, reviewDeadlineState: 'tomorrow', reviewDeadlineNotice: '내일 마감' });
    t('★★ 띠: 「리뷰 마감 · 내일 마감」', b.label === '리뷰 마감 · 내일 마감' && b.soon === true, b);
    const c = run({ ...base, reviewDeadlineState: 'overdue', reviewDeadlineNotice: '' });
    t('  지난 마감·모레 이후·옛 서버(글자 없음) = 종전 띠 그대로 · 제출 버튼 그대로', c.label === '리뷰 마감' && c.soon === false && /bkReviewBtn/.test(c.body)
      && run(base).label === '리뷰 마감', c);
  }
  {
    const home = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
    const made = [];
    const mk = (tag) => ({ tag, className: '', innerHTML: '', textContent: '', hidden: false, style: {}, listeners: {},
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, addEventListener(ev, fn) { this.listeners[ev] = fn; }, appendChild() {} });
    const byId = {};
    const ctx = (pending, done, subTab) => {
      made.length = 0;
      const c = { window: {}, document: { getElementById: (id) => byId[id] || (byId[id] = mk('#' + id)), createElement: (tag) => { const e = mk(tag); made.push(e); return e; }, addEventListener() {} },
        _reviewSubTab: subTab, _reviewDoneSort: 'recent', _historyCounts: null, _historyMode: 'legacy', _historyCursors: { pending: null, done: null }, _historyMoreBusy: false,
        _reviewListData: { pending, done }, _reviewListLoading: false, _reviewListError: '', _reviewListTruncated: false,
        escHtml: s => String(s == null ? '' : s).replace(/</g, '&lt;'), _escAttrX: s => String(s == null ? '' : s), _fnum: n => String(n),
        _hasPendingCashReceipt: () => false, _taskLabel: it => it.displayNameTC || '참여 작업', _fmtReviewDate: () => '', _fmtReviewDateMeta: () => '', _feeForItem: () => null,
        _reEditBtnHtml: () => '', _sortDoneHistory: l => l, _reviewSortBarEl: () => mk('sortbar'),
        openPartInfoSheet() {}, loadReviewList() {}, getSavedUser: () => ({}), loadMoreReviewHistory() {} };
      vm.createContext(c);
      vm.runInContext([fnSlice(home, 'function _partInfoParticipantName(it){'), fnSlice(home, 'function _pendingCardState(item)'), fnSlice(home, 'function _pendingBadgeText(item)'), fnSlice(home, 'function renderReviewSubTab()')].join('\n'), c);
      c.renderReviewSubTab();
      return made.filter(m => /result-card|result-group-card/.test(m.className)).map(m => m.innerHTML).join('\n');
    };
    const it = (x) => ({ displayName: '김가짜', displayNameTC: '가짜식당 방문', sheetId: 's', tabName: 't', rowIndex: 3, isSubmitted: false, workKind: 'booking', ...x });
    const one = ctx([it({ reviewDeadlineState: 'today', reviewDeadlineNotice: '오늘 마감' })], [], 'pending');
    t('★★★ 리뷰어 홈 리뷰 내역 카드: 「오늘 마감」', /오늘 마감/.test(one) && /리뷰 미제출/.test(one), one.slice(0, 400));
    const tm = ctx([it({ reviewDeadlineState: 'tomorrow', reviewDeadlineNotice: '내일 마감' })], [], 'pending');
    t('★★ 카드: 「내일 마감」', /내일 마감/.test(tm));
    const grp = ctx([it({ rowIndex: 3, reviewDeadlineState: 'today', reviewDeadlineNotice: '오늘 마감' }), it({ rowIndex: 4 })], [], 'pending');
    t('★★ 여러 건 묶음 카드: 그 줄에만 「오늘 마감」', (grp.match(/오늘 마감/g) || []).length === 1, grp.slice(0, 600));
    const none = ctx([it({})], [], 'pending');
    t('  안내 글자 없는 줄(일반 리뷰·지난 마감·옛 서버) = 종전 카드 그대로', !/마감/.test(none));
    const doneTab = ctx([], [it({ isSubmitted: true, reviewDeadlineNotice: '오늘 마감' })], 'done');
    t('  제출완료 탭에는 그리지 않는다', !/오늘 마감/.test(doneTab));
  }
  {
    const SA = fs.readFileSync(path.join(ROOT, 'frontend/js/search-app.js'), 'utf8');
    const made = [];
    const mk = (tag) => ({ tag, className: '', innerHTML: '', textContent: '', style: {}, addEventListener() {}, appendChild(e) { made.push(e); } });
    const byId = {};
    const run = (results) => {
      made.length = 0;
      const c = { document: { getElementById: (id) => byId[id] || (byId[id] = mk('#' + id)), createElement: (tag) => mk(tag) },
        escHtml: s => String(s == null ? '' : s).replace(/</g, '&lt;'), _isReceiptPendingItem: () => false, _showNoResult() {}, hide() {}, show() {}, openSubmitMulti() {} };
      vm.createContext(c);
      vm.runInContext(fnSlice(SA, 'function _dlChipHtml(item) {') + '\n' + fnSlice(SA, 'function renderResults(results) {'), c);
      c.renderResults(results);
      return made.map(m => m.innerHTML).join('\n');
    };
    const it = (x) => ({ displayName: '김가짜', tcDisplayName: '가짜식당 방문', sheetId: 's', tabName: 't', rowIndex: 3, isSubmitted: false, workKind: 'booking', ...x });
    const one = run([it({ reviewDeadlineState: 'today', reviewDeadlineNotice: '오늘 마감' })]);
    t('★★★ 리뷰 제출 페이지 결과 카드: 「오늘 마감」', /오늘 마감/.test(one) && /미제출/.test(one), one.slice(0, 400));
    const tm = run([it({ reviewDeadlineState: 'tomorrow', reviewDeadlineNotice: '내일 마감' })]);
    t('★★ 결과 카드: 「내일 마감」', /내일 마감/.test(tm));
    const grp = run([it({ rowIndex: 3, reviewDeadlineState: 'tomorrow', reviewDeadlineNotice: '내일 마감' }), it({ rowIndex: 4 })]);
    t('★★ 여러 건 묶음: 그 줄에만 「내일 마감」', (grp.match(/내일 마감/g) || []).length === 1, grp.slice(0, 600));
    t('  안내 글자 없는 줄 = 종전 카드 그대로', !/마감/.test(run([it({})])));
    // 제출 화면(홈 카드 → 참여 정보 창 → [리뷰제출하기]로 넘겨받은 줄) 맨 위 한 줄
    const notice = (items) => {
      const kids = [];
      const step1 = { firstChild: null, insertBefore(el) { kids.unshift(el); } };
      const c = { document: { getElementById: (id) => id === 'step1' ? step1 : (id === 'submitDeadlineNotice' ? (kids.find(k => k.id === id) || null) : null),
        createElement: () => ({ id: '', className: '', innerHTML: '', remove() {} }) }, escHtml: s => String(s == null ? '' : s).replace(/</g, '&lt;') };
      vm.createContext(c);
      vm.runInContext(fnSlice(SA, 'function _dlChipHtml(item) {') + '\n' + fnSlice(SA, 'function _renderDeadlineNotice(items) {'), c);
      c._renderDeadlineNotice(items);
      return kids.map(k => k.innerHTML).join('\n');
    };
    const n1 = notice([it({ reviewDeadline: '2026-12-03', reviewDeadlineState: 'today', reviewDeadlineNotice: '오늘 마감' })]);
    t('★★★ 리뷰 제출 화면 맨 위: 「오늘 마감 · 리뷰 마감 12/3 (목)」', /dl-chip today/.test(n1) && /오늘 마감/.test(n1) && /리뷰 마감 <b>12\/3 \(목\)<\/b>/.test(n1), n1);
    t('  안내 없는 줄(일반 리뷰·지난 마감·옛 서버)·제출한 줄 = 아무것도 그리지 않는다', notice([it({})]) === ''
      && notice([it({ isSubmitted: true, reviewDeadlineNotice: '오늘 마감' })]) === '');
    t('  제출 화면이 그 한 줄을 부른다(정보 확인 그리기 옆)', /typeof _renderDeadlineNotice === "function"\) _renderDeadlineNotice\(items\)/.test(fnSlice(SA, 'function openSubmitMulti(items) {')));
  }
  {
    const home = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
    const sheet = fnSlice(home, 'function openPartInfoSheet(items, opts){');
    t('★★ 리뷰어 홈 참여 정보 창(한 건)에도 같은 서버 글자', /\(!done && !many && it\.reviewDeadlineNotice\)/.test(sheet) && /escHtml\(it\.reviewDeadlineNotice\)/.test(sheet));
  }
}

(async () => {
  console.log('\n▶ 네이버예약리뷰 리뷰 마감 안내(결정 422)\n');
  await e2e();
  screens();
  console.log(`\n✅ ${pass}개 통과\n`);
})().catch(e => { console.error(e); process.exit(1); });
