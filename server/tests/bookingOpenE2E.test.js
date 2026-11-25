/**
 * bookingOpenE2E.test.js — 네이버예약리뷰 개방(결정 414) 끝에서 끝까지 회귀가드.
 * 실행: node tests/bookingOpenE2E.test.js
 *
 * ★★★ 준비 중 목록(NOT_READY_WORK_KINDS)을 **배포 그대로** 둔 채 실제 처리기를 운영 순서대로 돈다(시험 안에서 비우지 않는다):
 *   인트라넷 새 오더(POST /api/order/intake · 인트라넷이 실제로 보내는 본문 모양) → 접수(orderAdminAccept)
 *   → 작업표 줄 + 날짜별 자리표 → 공고 발행(POST /api/campaign/admin/create) → 리뷰어 날짜 골라 신청(POST /:id/apply)
 *   → 예약내역 제출(POST /api/submit/booking) → 리뷰 캡처 업로드(POST /api/image/review-upload) → 리뷰 제출(POST /api/submit/review)
 *   → 입금 대상(listPaymentTargets: 환급형 결제금액 + 리뷰비 · 무료체험형 리뷰비만).
 *   그 사이 인트라넷 원본 수정(PUT /intake/source/:id)이 접수 뒤 잠금에 걸리는 수정 · 통과하는 수정을 함께 확인한다.
 * ★ PGlite(저장소 migrations 그대로) · 가짜 이름·가짜 매장·가짜 계좌 · 사진 저장(구글 드라이브)만 흉내 · 외부 호출 0.
 * ★ 날짜는 「오늘(KST)」 기준 상대값(인트라넷 예시 12/4·12/5·12/7 = 오늘 + 9·10·12일과 같은 모양) — 운영 DB 시각(NOW())과
 *   맞추려고 시계를 가짜로 돌리지 않는다(홀드 만료를 SQL NOW() 가 판정한다). 당일 예약 금지는 오늘 날짜로 신청해 확인한다.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 600) : '')); pass++; console.log('  ✓ ' + name); };

const SERVER = path.join(__dirname, '..');
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booking-open-secret';
process.env.ORDER_INTAKE_KEY = 'test-intake-key-booking-open';
process.env.REVIEW_INSPECT = '0';           // 리뷰 2차 검수 AI 끔(이 시험은 흐름만 — 검수는 bookingCaptureCheck 가 본다)
process.env.BOOKING_CAPTURE_CHECK = '0';    // 예약내역 판독 AI 끔(같은 이유)
process.env.AI_REVIEW_FOLDER_ID = 'FOLDER-ROOT-FAKE-0123456789';   // 사진 저장은 흉내(아래 drive 대역) — 뿌리 폴더 이름만
process.env.WORKBOARD_V2_ENABLED = '1';     // 새 작업표 규격(v2) 켬 — 예약리뷰·Q&A 는 v2 로만 접수된다(운영 설정값은 이 시험이 확인하지 못한다)

const DAY = 86400000;
const kstYmd = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const NOW = Date.now();
const TODAY = kstYmd(NOW);
const D1 = kstYmd(NOW + 9 * DAY), D2 = kstYmd(NOW + 10 * DAY), D3 = kstYmd(NOW + 12 * DAY);

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
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에서 안 도는 몇 파일 — 아래에서 필요한 칸을 확인 */ }
  }
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'payment_batch_items'`)).rows.map(r => r.column_name);
  for (const c of ['account_snapshot_fingerprint', 'zero_price_purchase']) assert(cols.includes(c), 'PGlite 회차 표에 ' + c + ' 칸이 없다(마이그레이션 적용 실패)');
  const bk = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'campaign_applications' AND column_name = 'booking_slot_id'`)).rows;
  assert(bk.length === 1, 'migration 228(booking_slot_id) 적용 실패');
  return db;
}
function poolOf(db) {
  // ★ PGlite 는 연결이 하나다 — 트랜잭션(BEGIN~COMMIT) 동안 다른 쿼리가 끼지 않게 연결 단위 차례를 둔다.
  let chain = Promise.resolve();
  const raw = async (sql, params) => {
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  let holder = null;
  const query = (sql, params) => (holder ? raw(sql, params) : raw(sql, params));
  const connect = async () => {
    let release;
    const wait = chain;
    chain = new Promise(r => { release = r; });
    await wait;
    holder = true;
    return { query: raw, release() { holder = null; release(); } };
  };
  return { query, connect, on() {}, end: async () => {} };
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

/** 인트라넷 새 오더 본문 — `buildReviewOrderSourcePayload` + `reviewOrderApplyBookingRule` 뒤 모양 그대로(구매 칸 없음). */
function intranetBody({ sid, rev, mode, over = {}, productsOver = null }) {
  const free = mode === 'free';
  const place = {
    name: '가짜식당 강남점', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
    base: { pay: free ? 0 : 25000, count: 6, daily: 0, review_type_mix: [] }, options: [],
    booking: { pay_mode: free ? 'free' : 'refund', dates: [{ date: D1, count: 2 }, { date: D2, count: 1 }, { date: D3, count: 3 }],
      review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1' },
  };
  const products = productsOver ? productsOver(JSON.parse(JSON.stringify(place))) : [place];
  return {
    requester_id: 'u-fake-1', requester_username: 'fake-owner', requester_name: '가짜등록자',
    source_review_order_id: sid, source_revision: rev, workboard_schema_version: 2, idempotency_key: `${sid}:${rev}`,
    work_series_id: sid, work_round: 1,
    intranet_advertiser_id: '', intranet_advertiser_name: '', intranet_advertiser_contact: '', intranet_advertiser_business_number: '',
    sales_id: '', quote_id: '', contract_number: '',
    title: `[가짜] 가짜식당 예약리뷰 ${free ? '무료' : '환급'}`, ae_name: '가짜등록자', work_manager: free ? '박은비' : '박세희', manager_name: '가짜담당',
    work_kind: 'booking', start_date: D1, recruit_count: 6, review_fee: free ? 3000 : 5000, pay_amount: free ? 0 : 150000,
    product_option: `[매장/날짜/인원] 1. 가짜식당 강남점 - ${D1} 2명 / ${D2} 1명 / ${D3} 3명`,
    product_options_json: JSON.stringify(products), product_url: 'https://booking.naver.com/booking/6/bizes/000000',
    review_guide: '맛·분위기 사진 3장 이상', special_notes: '가짜 특이사항',
    ...over,
  };
}

(async () => {
  console.log('\n▶ 네이버예약리뷰 개방 — 끝에서 끝까지(배포 그대로의 준비 중 목록 · 실제 처리기)\n');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);
  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);

  const wk = require('../src/utils/workKind');
  const shipped = wk.NOT_READY_WORK_KINDS.slice();
  /* ── 0) 배포 그대로의 안전핀 ─────────────────────────────── */
  console.log('0) 준비 중 목록(배포 그대로)');
  t('★★★ 준비 중 목록에 booking 이 없다(개방) · 목록·판정 장치는 그대로 남아 있다(다음 종류용)', Array.isArray(wk.NOT_READY_WORK_KINDS)
    && !wk.NOT_READY_WORK_KINDS.includes('booking') && wk.isWorkKindReady('booking') === true && typeof wk.workKindNotReadyBody === 'function', shipped);

  const orders = require('../src/routes/order.routes');
  const campaignRoutes = require('../src/routes/campaign.routes');
  const submitRoutes = require('../src/routes/submit.routes');
  const diagRoutes = require('../src/routes/diag.routes');
  const intakeH = handlerOf(orders, 'post', '/intake');
  const revisionH = handlerOf(orders, 'put', '/intake/source/:sourceReviewOrderId');
  const acceptH = orders.handlers.orderAdminAccept;
  const createH = handlerOf(campaignRoutes, 'post', '/admin/create');
  const detailH = handlerOf(campaignRoutes, 'get', '/:id');
  const applyH = handlerOf(campaignRoutes, 'post', '/:id/apply');
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

  // 사진 저장(구글 드라이브)만 흉내 — 업로드 처리기의 세션·연결·기록은 실제
  const drive = require('../src/services/drive.service');
  let upSeq = 0;
  drive.uploadFileBase64 = async (data, name) => ({ id: 'FAKEFILE' + (++upSeq) + '-0123456789abcdef', name, webViewLink: '' });
  drive.trashFiles = async () => ({ success: 0, failed: 0 });
  drive.getOrCreateSubFolder = async (parent, name) => ({ id: 'FOLDER-SUB-' + String(name).length + '-0123456789' });
  drive.ensureReviewFolderPath = async () => ({ id: 'FOLDER-FAKE-0123456789', url: 'https://drive.google.com/drive/folders/FOLDER-FAKE-0123456789' });
  const cf = require('../src/services/captureFolder.service');
  cf.resolveCaptureFolder = async () => ({ folderId: 'FOLDER-FAKE-0123456789', folderUrl: 'https://drive.google.com/drive/folders/FOLDER-FAKE-0123456789' });

  /* ── 1) 인트라넷 새 오더(실제 접수 창구) ───────────────────── */
  console.log('\n1) 인트라넷 새 오더 → POST /api/order/intake');
  const R = { sid: 'ro_bk_e2e_refund', mode: 'refund' }, F = { sid: 'ro_bk_e2e_free', mode: 'free' };
  for (const o of [R, F]) {
    const r = await call(intakeH, { body: intranetBody({ sid: o.sid, rev: 1, mode: o.mode }) });
    t(`★★★ ${o.mode === 'free' ? '무료체험형' : '환급형'} 새 오더 접수 창구 통과(배포 그대로 · work_kind_not_ready 아님)`, r.statusCode < 300 && r.body && r.body.ok !== false, r.body);
    const { rows } = await q(`SELECT * FROM work_orders WHERE source_review_order_id = $1`, [o.sid]);
    o.wo = rows[0];
    t(`  저장된 오더: 종류 booking · v2 · 총 6명 · 결제합계 ${o.mode === 'free' ? 0 : 150000}`, o.wo && o.wo.work_kind === 'booking'
      && Number(o.wo.workboard_schema_version) === 2 && Number(o.wo.recruit_count) === 6 && Number(o.wo.pay_amount) === (o.mode === 'free' ? 0 : 150000), o.wo);
  }

  /* ── 2) 접수(실제 접수 처리기) → 작업표 줄 + 날짜별 자리표 ───── */
  console.log('\n2) 접수 → 작업표 + 자리표');
  for (const o of [R, F]) {
    const r = await call(acceptH, { body: { id: o.wo.id }, admin: ADMIN });
    t(`★★★ ${o.mode} 접수 성공(실제 처리기)`, r.statusCode === 200 && r.body && r.body.ok === true, r.body);
    o.wo = (await q(`SELECT * FROM work_orders WHERE id = $1`, [o.wo.id])).rows[0];
    o.sheetId = o.wo.linked_tab_sheet_id; o.tab = o.wo.linked_tab_name; o.gid = o.wo.linked_tab_gid;
    const slots = (await q(`SELECT slot_date::text AS d, COUNT(*)::int AS n FROM booking_slots WHERE work_order_id = $1 GROUP BY 1 ORDER BY 1`, [o.wo.id])).rows;
    t(`  자리표 = 업체가 정한 날짜·인원 그대로(${D1} 2 · ${D2} 1 · ${D3} 3)`, JSON.stringify(slots) === JSON.stringify([{ d: D1, n: 2 }, { d: D2, n: 1 }, { d: D3, n: 3 }]), slots);
    const rows = (await q(`SELECT seq, row_json FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 ORDER BY seq`, [o.sheetId, o.tab])).rows;
    t('  작업표 6줄 · 이용일자·리뷰마감일 칸', rows.length === 6 && rows.every(x => x.row_json && x.row_json['이용일자'] && x.row_json['리뷰마감일']), rows.slice(0, 2));
    t(`  ${o.mode === 'free' ? '무료체험형 = 결제금액 칸 없음' : '환급형 = 결제금액 칸 있음'}`, o.mode === 'free' ? !('결제금액' in rows[0].row_json) : ('결제금액' in rows[0].row_json));
    const tc = (await q(`SELECT work_kind FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2`, [o.sheetId, o.tab])).rows[0];
    t('  작업 종류 = booking', tc && tc.work_kind === 'booking', tc);
  }

  /* ── 3) 접수 뒤 원본 수정 — 잠금 / 통과 ─────────────────────── */
  console.log('\n3) 접수 뒤 인트라넷 원본 수정(PUT /intake/source/:id)');
  const rev = (o, n, body) => call(revisionH, { params: { sourceReviewOrderId: o.sid }, body });
  const snap = async (o) => (await q(`SELECT source_revision, recruit_count, pay_amount, product_options_json, special_notes FROM work_orders WHERE id = $1`, [o.wo.id])).rows[0];
  const lockedRes = r => r.statusCode === 409 && r.body && r.body.code === 'booking_calendar_locked' && /새 리뷰오더로 접수/.test(r.body.error || '');
  {
    const before = await snap(R);
    const r1 = await rev(R, 2, intranetBody({ sid: R.sid, rev: 2, mode: 'refund', productsOver: p => { p.booking.dates[1].date = kstYmd(NOW + 11 * DAY); return [p]; } }));
    t('★★★ 날짜를 바꾸면 409 booking_calendar_locked(무엇을 하면 되는지 · 새 리뷰오더 안내)', lockedRes(r1), r1.body);
    t('  잠금 사유 = 날짜·날짜별 인원', r1.body && Array.isArray(r1.body.booking_locked) && r1.body.booking_locked.includes('dates'), r1.body);
    const r2 = await rev(R, 2, intranetBody({ sid: R.sid, rev: 2, mode: 'free' }));
    t('★★ 환급형 → 무료체험형(진행 방식)도 잠금', lockedRes(r2) && r2.body.booking_locked.includes('pay_mode'), r2.body);
    const r3 = await rev(R, 2, intranetBody({ sid: R.sid, rev: 2, mode: 'refund', over: { recruit_count: 7 },
      productsOver: p => { p.booking.dates[2].count = 4; p.base.count = 7; return [p]; } }));
    t('★★ 인원 늘리기(총 모집 + 날짜별 인원)도 잠금 — 새 리뷰오더 안내(「추가 모집」이라는 말은 쓰지 않는다 · 인트라넷이 Q&A 안내로 바꿔 보여 준다)',
      lockedRes(r3) && r3.body.booking_locked.includes('dates') && /인원 늘리기·차수가 없습니다/.test(r3.body.error) && !/추가 모집/.test(r3.body.error), r3.body);
    const r4 = await rev(R, 2, intranetBody({ sid: R.sid, rev: 2, mode: 'refund', productsOver: p => { p.prev_name = p.name; p.name = '가짜식당 역삼점'; return [p]; } }));
    t('★★ 매장 이름 바꾸기도 잠금', lockedRes(r4) && r4.body.booking_locked.includes('place_name'), r4.body);
    const r5 = await rev(R, 2, intranetBody({ sid: R.sid, rev: 2, mode: 'refund', productsOver: p => { p.booking.review_deadline_days = 5; return [p]; } }));
    t('★★ 리뷰 마감 N일 바꾸기도 잠금', lockedRes(r5) && r5.body.booking_locked.includes('review_deadline_days'), r5.body);
    const r6 = await rev(F, 2, intranetBody({ sid: F.sid, rev: 2, mode: 'free', over: { pay_amount: 6000 }, productsOver: p => { p.base.pay = 1000; return [p]; } }));
    t('★★ 무료체험형에 결제금액을 넣으면(열린 칸이라도 계약이 깨짐) 409 — 리뷰어 신청·입금이 멈추지 않게', r6.statusCode === 409 && r6.body.code === 'booking_calendar_locked' && /무료체험형/.test(r6.body.error), r6.body);
    const after = await snap(R);
    t('★★★ 막힌 수정은 아무것도 쓰지 않았다(원본 번호·인원·상품 구성 그대로)', JSON.stringify(after) === JSON.stringify(before), { before, after });
    // 통과 — 매장 주소·예약 링크·1인 결제금액·특이사항
    const ok1 = await rev(R, 2, intranetBody({ sid: R.sid, rev: 2, mode: 'refund', over: { special_notes: '주차 가능', pay_amount: 156000,
      product_url: 'https://booking.naver.com/booking/6/bizes/111111' },
    productsOver: p => { p.booking.place_address = '서울 가짜구 가짜로 2, 3층'; p.url = 'https://booking.naver.com/booking/6/bizes/111111'; p.base.pay = 26000; return [p]; } }));
    t('★★★ 매장 주소·예약 링크·1인 결제금액·특이사항 수정은 통과(번호 +1)', ok1.statusCode === 200 && ok1.body.ok !== false, ok1.body);
    const s2 = await snap(R);
    const p2 = JSON.parse(s2.product_options_json)[0];
    t('  저장됨: 번호 2 · 주소·링크·결제금액·특이사항 · 날짜는 그대로', Number(s2.source_revision) === 2 && p2.booking.place_address === '서울 가짜구 가짜로 2, 3층'
      && p2.url.endsWith('111111') && Number(p2.base.pay) === 26000 && s2.special_notes === '주차 가능'
      && JSON.stringify(p2.booking.dates.map(d => d.date)) === JSON.stringify([D1, D2, D3]), s2);
    const bs = require('../src/services/bookingSlots.service');
    const place = await bs.placeInfoForTab(pool, R.sheetId, R.tab);
    t('  리뷰어 매장 안내가 고친 주소·링크·금액을 바로 읽는다(오더 단일 출처)', place && place.placeAddress === '서울 가짜구 가짜로 2, 3층' && place.pay === 26000 && /111111$/.test(place.bookingUrl), place);
    const again = await rev(R, 3, intranetBody({ sid: R.sid, rev: 3, mode: 'free' }));
    t('★ 통과한 뒤에도 잠금 그대로(번호 3 · 진행 방식)', lockedRes(again), again.body);
    // 이후 흐름을 위해 1인 결제금액을 25,000 으로 되돌린다(번호 3 · 열린 칸)
    const back = await rev(R, 3, intranetBody({ sid: R.sid, rev: 3, mode: 'refund', over: { special_notes: '주차 가능' },
      productsOver: p => { p.booking.place_address = '서울 가짜구 가짜로 2, 3층'; return [p]; } }));
    t('  되돌리기(번호 3) 통과', back.statusCode === 200, back.body);
  }

  {
    // 같은 판정 — 옛 수정 경로(POST /intake/:id/update) · 관리자 작업오더 수정 창(orderAdminEdit)
    const legacyH = handlerOf(orders, 'post', '/intake/:id/update');
    const before = await snap(R);
    const lg = await call(legacyH, { params: { id: R.wo.id }, body: { title: before.title || '[가짜] 가짜식당 예약리뷰 환급', recruit_count: 7 } });
    t('★★ 옛 수정 경로도 총 모집 바꾸기 = booking_calendar_locked', lg.statusCode === 409 && lg.body.code === 'booking_calendar_locked', lg.body);
    const ae = await call(orders.handlers.orderAdminEdit, { body: { id: R.wo.id, recruit_count: 9 }, admin: ADMIN });
    t('★★ 관리자 작업오더 수정 창도 총 모집 바꾸기 = booking_calendar_locked', ae.statusCode === 409 && ae.body.code === 'booking_calendar_locked', ae.body);
    const ae2 = await call(orders.handlers.orderAdminEdit, { body: { id: R.wo.id, special_notes: '주차 가능' }, admin: ADMIN });
    t('  관리자 수정 창: 글 칸(특이사항)은 통과', ae2.statusCode === 200 && ae2.body && ae2.body.ok !== false, ae2.body);
    t('  막힌 두 수정은 아무것도 쓰지 않았다', Number((await snap(R)).recruit_count) === 6);
  }

  /* ── 4) 공고 발행(실제 발행 처리기) ─────────────────────────── */
  console.log('\n4) 공고 발행 → POST /api/campaign/admin/create');
  for (const o of [R, F]) {
    const body = {
      title: `가짜식당 강남점 방문 체험(${o.mode})`, participation_mode: true, status: 'active', work_kind: 'booking',
      linked_sheet_id: o.sheetId, linked_tab_name: o.tab, linked_tab_gid: o.gid, source_work_order_id: o.wo.id,
      recruit_total: 6, daily_limit: 6, max_slots: 6, hold_ttl_min: 20, review_fee: o.mode === 'free' ? 3000 : 5000,
      window_start: '00:00', window_end: '23:59', close_buffer_min: 0, skip_weekends: false, multi_account_mode: false,
      thumbnail_url: '', review_type: '', review_type_mix: [], delivery_type: '', channel: '네이버',   // 발행 폼 프리필 = 예약 주소 호스트(_woChannel) · 화면에는 숨김
      transfer_bank: 'kbank', transfer_memo: '인애드', work_detail: { guide: '방문 후 솔직한 리뷰를 남겨 주세요.' },   // 이체은행 = 직원이 고른 값(예약 오더는 물건비 칸이 없어 [자동]이면 「이체은행 없음」 보류 — 다른 종류와 같은 규칙)
      options: [{ optKey: '가짜식당 강남점', productName: '가짜식당 강남점', unitKind: 'product', payAmount: o.mode === 'free' ? 0 : 25000, recruitTotal: 6, dailyLimit: 0,
        optionUrl: o.wo.product_url || 'https://booking.naver.com/booking/6/bizes/000000' }],
    };
    const r = await call(createH, { body, admin: ADMIN, headers: { authorization: 'Bearer ' + adminJwt } });
    t(`★★★ ${o.mode} 공고 발행 성공(work_kind_not_ready 아님)`, r.statusCode === 200 && r.body && r.body.ok === true, r.body);
    o.campId = r.body && r.body.data && r.body.data.id;
    const camp = (await q(`SELECT id, work_kind, linked_tab_name, status, skip_weekends FROM recruit_campaigns WHERE id = $1`, [o.campId])).rows[0];
    t('  공고 = 예약리뷰 · 그 작업표에 연결 · 주말 신청 차단 없음', camp && camp.work_kind === 'booking' && camp.linked_tab_name === o.tab && camp.skip_weekends !== true, camp);
    const d = await call(detailH, { params: { id: o.campId }, headers: { authorization: 'Bearer ' + adminJwt } });
    t('★★ 공고 수정 창(관리자 상세)에 예약 안내(bookingSpec — 오더 계약 단일 출처)가 실린다', d.body && d.body.bookingSpec && d.body.bookingSpec.placeName === '가짜식당 강남점'
      && d.body.bookingSpec.total === 6 && d.body.bookingSpec.payMode === o.mode, d.body && d.body.bookingSpec);
  }
  {
    // 발행 뒤(공고 연결 = 종전 잠금) — 매장 주소는 통과 · 날짜는 예약 잠금 문구로 막힘
    const cur = Number((await snap(R)).source_revision);
    const lk = await rev(R, cur + 1, intranetBody({ sid: R.sid, rev: cur + 1, mode: 'refund', over: { special_notes: '주차 가능' },
      productsOver: p => { p.booking.place_address = '서울 가짜구 가짜로 2, 3층'; p.booking.dates[0].count = 1; p.booking.dates[1].count = 2; return [p]; } }));
    t('★★ 발행 뒤에도 날짜별 인원 바꾸기 = booking_calendar_locked', lockedRes(lk), lk.body);
    const ok = await rev(R, cur + 1, intranetBody({ sid: R.sid, rev: cur + 1, mode: 'refund', over: { special_notes: '주차 가능' },
      productsOver: p => { p.booking.place_address = '서울 가짜구 가짜로 3'; return [p]; } }));
    t('★★ 발행 뒤 매장 주소 수정은 통과(종전 상품 구성 잠금이 주소를 막지 않는다)', ok.statusCode === 200 && ok.body.ok !== false, ok.body);
    t('  저장됨', JSON.parse((await snap(R)).product_options_json)[0].booking.place_address === '서울 가짜구 가짜로 3');
  }

  /* ── 5) 리뷰어 신청 → 예약내역 → 리뷰 캡처 → 리뷰 제출 ──────── */
  console.log('\n5) 리뷰어 — 날짜 골라 신청 · 예약내역 · 리뷰');
  const people = {};
  let n = 0;
  async function journey(who, o, date, payAmount) {
    n++;
    const phone = '0107777' + String(1000 + n);
    const p8 = phone.slice(-8);
    await q(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder, address) VALUES ($1, $2, '국민은행', $3, $1, '서울 가짜구')`,
      [who, phone, '8000000000' + n]);
    const ap = await call(applyH, { params: { id: o.campId }, body: { name: who, phone, bookingDate: date, optionKey: '가짜식당 강남점' } });
    t(`★★★ ${who}: ${date} 신청(실제 처리기 · 안전벨트 통과)`, ap.statusCode === 200 && ap.body.ok === true, ap.body);
    const appId = ap.body.applicationId;
    const slot = (await q(`SELECT s.slot_date::text AS d FROM campaign_applications a JOIN booking_slots s ON s.id = a.booking_slot_id WHERE a.id = $1`, [appId])).rows[0];
    t('  고른 날 자리 하나가 묶였다', slot && slot.d === date, slot);
    const rid = (await q(`SELECT id FROM reviewers WHERE phone8 = $1`, [p8])).rows[0].id;
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [appId, rid]);
    const tok = require('../src/services/reviewerSession.service').issueReviewerSession({ ownerReviewerId: rid, loginName: who, loginPhone8: p8 });
    const sub = await call(bookingH, { headers: { 'x-reviewer-token': tok },
      body: { campaignId: o.campId, campaignApplicationId: appId, holdToken: ap.body.holdToken, holdPhone8: p8, reservationNo: 'R' + (5000 + n), ...(payAmount != null ? { payAmount } : {}) } });
    t(`★★★ ${who}: 예약내역 제출(실제 처리기)`, sub.statusCode === 200 && sub.body.ok === true, sub.body);
    const rowIndex = Number(sub.body.target.rowIndex);
    const up = await call(reviewUploadH, { headers: { 'x-reviewer-token': tok },
      body: { sheetId: o.sheetId, tabName: o.tab, gid: o.gid, rowIndex, reviewerName: who, campaignName: o.tab, slotKey: 'review',
        files: [{ data: Buffer.from('fake-review-capture-' + who).toString('base64'), mimeType: 'image/jpeg', fileName: who + '_리뷰.jpg', name: who + '_리뷰.jpg' }] } });
    t(`★★ ${who}: 리뷰 캡처 업로드(실제 처리기 · 사진 저장만 흉내)`, up.body && up.body.ok === true, up.body);
    const fin = await call(reviewH, { headers: { 'x-reviewer-token': tok },
      body: { sheetId: o.sheetId, gid: o.gid, tabName: o.tab, rowIndex, value: '제출', phone8: p8, uploadBatchId: up.body.uploadBatchId || up.body.batchId } });
    t(`★★★ ${who}: 리뷰 제출(실제 처리기)`, fin.statusCode === 200 && fin.body && !fin.body.error && fin.body.ok !== false, fin.body);
    people[who] = { o, rowIndex };
  }
  {
    // 당일 예약 금지(내일부터) — 오늘 날짜로 신청하면 잠금 전에 거절
    const ap0 = await call(applyH, { params: { id: R.campId }, body: { name: '가짜당일', phone: '01077770000', bookingDate: TODAY, optionKey: '가짜식당 강남점' } });
    t('★ 오늘 날짜는 고를 수 없다(booking_date_closed — 자리 미점유)', ap0.statusCode === 409 && ap0.body.reason === 'booking_date_closed', ap0.body);
  }
  await journey('가짜환급', R, D1, '25,000');
  await journey('가짜무료', F, D2, null);

  /* ── 6) 입금 대상 ───────────────────────────────────────────── */
  console.log('\n6) 입금 대상(실제 listPaymentTargets)');
  const pay = require('../src/services/payment.service');
  const { items } = await pay.listPaymentTargets({ includeFinished: true });
  const of = who => items.find(it => it.sheetId === people[who].o.sheetId && it.tabName === people[who].o.tab && Number(it.rowIndex) === people[who].rowIndex);
  const A = of('가짜환급'), FR = of('가짜무료');
  t('★★★ 환급형 = 결제금액 25,000 + 리뷰비 5,000 = 30,000 · 지급 대상', A && A.payable === true && A.productPrice === 25000 && A.reviewFee === 5000 && A.amount === 30000, A && { p: A.productPrice, f: A.reviewFee, a: A.amount, i: A.issues, w: A.warnings, ok: A.payable });
  t('★★★ 무료체험형 = 리뷰비 3,000 만 · 지급 대상', FR && FR.payable === true && FR.productPrice === 0 && FR.amount === 3000, FR);

  /* ── 7) 검색 색인 · 끝 ──────────────────────────────────────── */
  console.log('\n7) 검색 색인(이용일자)');
  for (const who of ['가짜환급', '가짜무료']) {
    const { o, rowIndex } = people[who];
    const ri = (await q(`SELECT start_date, end_date FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`, [o.sheetId, o.tab, rowIndex])).rows[0];
    const cell = (await q(`SELECT row_json FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`, [o.sheetId, o.tab, rowIndex])).rows[0].row_json;
    t(`★★ ${who}: 검색 색인 시작일 = 작업표 「이용일자」(리뷰어·담당자 검색·입금 목록의 날짜 칸이 비지 않는다)`, ri && ri.start_date && ri.start_date === cell['이용일자'], { ri, cell: cell['이용일자'] });
    t(`  ${who}: 색인 마감일 = 「리뷰마감일」(종전 그대로)`, ri && ri.end_date === cell['리뷰마감일'], { ri, cell: cell['리뷰마감일'] });
  }
  {
    const { items: again } = await pay.listPaymentTargets({ includeFinished: true });
    const A2 = again.find(it => it.sheetId === R.sheetId && Number(it.rowIndex) === people['가짜환급'].rowIndex);
    t('  입금 목록 날짜 칸 = 이용일자', A2 && A2.startDate && A2.startDate.length > 0, A2 && A2.startDate);
  }
  /* ── 8) 양방향 연결 오더(공유 저장) — 같은 잠금 · 주소는 통과 ───── */
  console.log('\n8) 양방향 연결(공유 저장)');
  {
    await q(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ in2rw: 'apply', push: 'off', campaign_edit: 'on', publish_reconcile: 'off' })]);
    require('../src/utils/bidirSwitch')._resetBidirSwitchCacheForTest();   // 스위치 읽기 캐시(시험용 초기화)
    const sp = require('../src/services/sharedPatch.service');
    const lk = await sp.linkSharedOrder({ workOrderId: R.wo.id, actor: '가짜관리자' });
    console.log('    연결 판정', JSON.stringify(lk.body).slice(0, 300));
    // 발행 맞추기(publish_reconcile on 인 운영 발행과 같은 함수) — 오더를 공고 값(주말 포함·채널·상품 주소)으로 맞추고 연결
    const ar = await require('../src/services/sharedReconcile.service').reconcileOnPublish({ workOrderId: R.wo.id, campaignId: R.campId, actor: '가짜관리자' });
    t('★★ 예약 오더도 발행 맞추기로 연결된다(예약 잠금이 주말 제외·채널 맞추기를 막지 않는다)', ar && ar.ok === true, ar);
    const wo1 = (await q(`SELECT bidir_state, sync_version, source_revision, product_options_json FROM work_orders WHERE id = $1`, [R.wo.id])).rows[0];
    t('  연결 상태 on', wo1.bidir_state === 'on', wo1.bidir_state);
    const base = Number(wo1.sync_version);
    let srev = Number(wo1.source_revision);
    const bidirBody = (mut, over = {}) => intranetBody({ sid: R.sid, rev: srev + 1, mode: 'refund',
      over: { special_notes: '주차 가능', bidir: { inflow: 1, dual_channel: 1, base_sync_version: base, money: 1, guide: 1 }, ...over },
      productsOver: p => { p.booking.place_address = '서울 가짜구 가짜로 3'; mut && mut(p); return [p]; } });
    const l1 = await rev(R, srev + 1, bidirBody(p => { p.booking.dates[0].date = kstYmd(NOW + 8 * DAY); }));
    t('★★★ 연결 오더: 날짜 바꾸기 = booking_calendar_locked(공유 저장보다 먼저 · 쓰기 0)', lockedRes(l1), l1.body);
    const v1 = (await q(`SELECT sync_version FROM work_orders WHERE id = $1`, [R.wo.id])).rows[0];
    t('  버전 그대로(아무것도 쓰지 않음)', Number(v1.sync_version) === base, v1);
    const ok2 = await rev(R, srev + 1, bidirBody(p => { p.booking.place_address = '서울 가짜구 가짜로 4, 1층'; }));
    t('★★★ 연결 오더: 매장 주소 수정은 공유 저장으로 통과', ok2.statusCode === 200 && ok2.body && ok2.body.ok !== false, ok2.body);
    const wo2 = (await q(`SELECT sync_version, product_options_json FROM work_orders WHERE id = $1`, [R.wo.id])).rows[0];
    t('  저장됨(주소 · 날짜 그대로 · 버전 올라감)', JSON.parse(wo2.product_options_json)[0].booking.place_address === '서울 가짜구 가짜로 4, 1층'
      && JSON.stringify(JSON.parse(wo2.product_options_json)[0].booking.dates.map(d => d.date)) === JSON.stringify([D1, D2, D3]) && Number(wo2.sync_version) > base, wo2);
    // 리뷰웹 쪽(공고 창) 출처로 총 모집을 바꾸는 공유 저장 — 같은 판정이 막는다(직접 호출)
    const st = sp.readSharedState((await q(`SELECT * FROM work_orders WHERE id = $1`, [R.wo.id])).rows[0]);
    const r3 = await sp.applySharedPatch({ workOrderId: R.wo.id, baseVersion: Number(wo2.sync_version), origin: 'campaign', actor: '가짜관리자',
      mine: { recruit_count: 7, product_options_json: (() => { const a = JSON.parse(st.product_options_json); a[0].base.count = 7; return JSON.stringify(a); })() } });
    t('★★ 공고 창 출처로 총 모집 바꾸기도 booking_calendar_locked(같은 판정 · 다른 출처)', r3 && r3.status === 409 && r3.body.code === 'booking_calendar_locked', r3 && r3.body);
  }
  t('★★★ 끝까지 준비 중 목록은 배포 그대로(시험이 손대지 않았다)', JSON.stringify(wk.NOT_READY_WORK_KINDS) === JSON.stringify(shipped));

  console.log(`\n✅ ${pass}개 통과\n`);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
