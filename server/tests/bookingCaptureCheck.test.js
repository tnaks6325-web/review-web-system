/**
 * bookingCaptureCheck.test.js — 네이버예약리뷰 4단계 회귀가드: 예약내역·리뷰 캡처 자동 검사 (결정 412)
 * 실행: node tests/bookingCaptureCheck.test.js
 *
 * 위험:
 *  ① 예약내역 캡처의 매장·이용일·예약번호·결제금액이 리뷰어가 적은 값/고른 날/공고 매장과 달라도 아무도 모른다.
 *  ② AI 가 못 읽었는데 「일치」로 보인다(모르는 것을 맞다고 꾸민다) — 못 읽음은 「확인 못 함」으로 보여야 한다.
 *  ③ 검사가 리뷰어를 막는다(업로드 실패·제출 거절) — 담당자 표시만 해야 한다(fail-open).
 *  ④ 예약 리뷰 캡처에 상품 리뷰 판정(형식·상품명·본문겹침)이 다시 붙는다 — 1단계 격리 유지, 같은 파일 검사는 유지.
 *  ⑤ AI 호출이 늘어난다 — 예약 리뷰 캡처는 종전처럼 1번, 예약내역 캡처는 1번(같은 사진은 캐시).
 *  ⑥ 준비 중 목록(NOT_READY_WORK_KINDS)이 시험 뒤 배포 그대로가 아니다(결정 414 개방 뒤 = 빈 목록).
 * ★ 실제 처리기(신청·예약내역 제출·구매캡처 업로드·리뷰 1차 필터·2차 검수·작업보드 조회)를 PGlite(저장소 migrations 그대로)에서 돌린다.
 *   AI 는 가짜 전송(@google/generative-ai 자리에 가짜 모듈)으로만 답한다 — 외부 호출 0 · 운영 DB 0 · 가짜 이름·가짜 매장.
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
const TAB = '12월 가짜식당 예약리뷰 4단계';
const WO = 'wo_booking_step4';
const CAMP = 'camp_booking_step4';
const OPT = '가짜식당 강남점';
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'] };
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booking-step4-secret';
process.env.GEMINI_API_KEY = 'fake-key-for-test';   // 가짜 전송만 쓴다(아래 require.cache)
process.env.AI_REVIEW_FOLDER_ID = 'ROOT-FAKE';
delete process.env.GEMINI_API_KEYS;
delete process.env.BOOKING_CAPTURE_CHECK;

const DAY = 86400000;
const kstYmd = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const NOW = Date.now();
const T1 = kstYmd(NOW + DAY), T2 = kstYmd(NOW + 2 * DAY);
const md = ymd => `${Number(ymd.slice(5, 7))}.${Number(ymd.slice(8, 10))}`;

/* ── 가짜 AI 전송 — 판독 대상 이미지(base64)마다 정한 답을 돌려준다. 프롬프트 종류도 센다. ── */
const AI = { calls: [], answers: new Map(), fail: new Set() };
function _kindOfPrompt(parts) {
  const txt = (Array.isArray(parts) ? parts : [parts]).filter(p => typeof p === 'string').join('\n');
  if (/\[네이버 예약내역 판독\]/.test(txt)) return 'booking_reservation';
  if (/\[네이버 플레이스 방문자 리뷰 판독\]/.test(txt)) return 'booking_review';
  if (/이 이미지가 무엇인지 판별해/.test(txt)) return 'classify';
  return 'other';
}
class FakeGenAI {
  constructor(key) { this.key = key; }
  getGenerativeModel() {
    return {
      generateContent: async (req) => {
        const parts = Array.isArray(req) ? req : (req.contents ? req.contents[0].parts : [req]);
        const img = parts.find(p => p && typeof p === 'object' && p.inlineData);
        const data = img ? img.inlineData.data : '';
        const kind = _kindOfPrompt(parts);
        AI.calls.push({ kind, data });
        if (AI.fail.has(data)) { const e = new Error('fake model error 400'); e.status = 400; throw e; }
        const ans = AI.answers.get(kind + ':' + data) || AI.answers.get('*:' + data);
        return { response: { text: () => JSON.stringify(ans || { kind: 'other', confidence: 0.2 }) } };
      },
    };
  }
}
const genPath = require.resolve('@google/generative-ai');
require.cache[genPath] = { id: genPath, filename: genPath, loaded: true, exports: { GoogleGenerativeAI: FakeGenAI } };
const b64 = s => Buffer.from(s).toString('base64');

async function openDb() {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  const dir = path.join(SERVER, 'migrations');
  // PGlite 에는 pg_trgm·pgcrypto 확장이 없다 — 확장 선언과 trgm 색인만 걷어 내고 같은 파일을 그대로 적용한다
  //   (리뷰검수 표 review_inspections(081)와 그 뒤 칸들(092·148·155·156)이 이 시험의 대상이라 건너뛸 수 없다).
  const strip = sql => sql.replace(/CREATE EXTENSION[^;]*;/gi, '').replace(/CREATE INDEX[^;]*gin_trgm_ops[^;]*;/gi, '');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    try { await db.exec(sql); } catch (_) {
      try { await db.exec(strip(sql)); } catch (_) { /* 이 시험의 표와 무관한 파일 */ }
    }
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
  console.log('\n▶ 네이버예약리뷰 4단계 — 예약내역·리뷰 캡처 자동 검사\n');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (s, p) => pool.query(s, p);

  /* ── 0) 순수 판정 ─────────────────────────────────────────── */
  console.log('0) 순수 판정(매장 이름 · 이용일 · 예약번호 · 결제금액)');
  const bc = require('../src/services/bookingCaptureCheck.service');
  t('매장 이름: 띄어쓰기·대소문자·지점 생략은 같다', bc.placeNameMatches('가짜식당 강남점', '가짜식당강남점') === 'match'
    && bc.placeNameMatches('가짜식당 강남점', '가짜식당') === 'match' && bc.placeNameMatches('Fake Cafe', 'fake cafe 1호점') === 'match');
  t('★ 매장 이름: 다른 지점·다른 매장 = 다름', bc.placeNameMatches('가짜식당 강남점', '가짜식당 역삼점') === 'mismatch'
    && bc.placeNameMatches('가짜식당 강남점', '진짜분식') === 'mismatch');
  t('★ 매장 이름: 못 읽음·한 글자 = 모름(맞다고 꾸미지 않는다)', bc.placeNameMatches('가짜식당', '') === 'unknown'
    && bc.placeNameMatches('', '가짜식당') === 'unknown' && bc.placeNameMatches('가짜식당', '가') === 'unknown');
  t('이용일: 여러 표기(2026-12-07 · 2026.12.7 · 12.7(월) · 12월 7일)를 같은 날로 읽는다',
    bc.sameVisitDate('2026-12-07', '2026-12-07') === 'match' && bc.sameVisitDate('2026-12-07', '2026.12.7') === 'match'
    && bc.sameVisitDate('2026-12-07', '12.7(월)') === 'match' && bc.sameVisitDate('2026-12-07', '12월 7일 (월) 오후 6:00') === 'match');
  t('★ 이용일: 다른 날 = 다름 · 못 읽음 = 모름', bc.sameVisitDate('2026-12-07', '12.8') === 'mismatch'
    && bc.sameVisitDate('2026-12-07', '2025-12-07') === 'mismatch' && bc.sameVisitDate('2026-12-07', '') === 'unknown'
    && bc.sameVisitDate('2026-12-07', '오후 6시') === 'unknown');
  const exp = { placeName: '가짜식당 강남점', slotDate: '2026-12-07', reservationNo: 'R777', payMode: 'refund', payAmount: 25000 };
  const goodRead = { screen: 'naver_booking', confidence: 0.95, cancelled: false, placeName: '가짜식당 강남점', visitDate: '2026.12.7', reservationNo: 'r-777', amount: 25000 };
  const j1 = bc.judgeReservation({ read: goodRead, expected: exp });
  t('★★ 다 같으면 match(예약번호 하이픈·대소문자는 무시)', j1.status === 'match' && j1.reasons.length === 0);
  const j2 = bc.judgeReservation({ read: { ...goodRead, visitDate: '12.8', amount: 30000, reservationNo: 'R778' }, expected: exp });
  t('★★ 다르면 mismatch + 이유(이용일·예약번호·결제금액 각각 값까지)', j2.status === 'mismatch'
    && ['date_differs', 'resv_differs', 'amount_differs'].every(c => j2.reasons.some(r => r.code === c))
    && j2.reasons.find(r => r.code === 'amount_differs').captured === 30000 && j2.reasons.find(r => r.code === 'amount_differs').expected === 25000);
  const j3 = bc.judgeReservation({ read: { ...goodRead, amount: 0, reservationNo: '' }, expected: exp });
  t('★★ 못 읽은 칸이 있으면 unknown(나머지가 맞아도 「일치」로 꾸미지 않는다)', j3.status === 'unknown'
    && j3.reasons.some(r => r.code === 'amount_unread') && j3.reasons.some(r => r.code === 'resv_unread'));
  const j4 = bc.judgeReservation({ read: { ...goodRead, amount: 0 }, expected: { ...exp, payMode: 'free', payAmount: null } });
  t('무료체험형은 결제금액을 비교하지 않는다', j4.status === 'match');
  t('★ AI 실패(read 없음) = unknown(ai_failed)', bc.judgeReservation({ read: null, expected: exp }).status === 'unknown'
    && bc.judgeReservation({ read: null, expected: exp }).reasons[0].code === 'ai_failed');
  t('★ 예약내역 화면이 아님(확신) = mismatch · 확신 낮음 = unknown',
    bc.judgeReservation({ read: { screen: 'other', confidence: 0.9 }, expected: exp }).status === 'mismatch'
    && bc.judgeReservation({ read: { screen: 'other', confidence: 0.9 }, expected: exp }).reasons[0].code === 'not_booking_screen'
    && bc.judgeReservation({ read: { ...goodRead, confidence: 0.4 }, expected: exp }).status === 'unknown');
  t('★ 예약 취소 화면 = mismatch(cancelled)', bc.judgeReservation({ read: { ...goodRead, cancelled: true }, expected: exp }).reasons.some(r => r.code === 'cancelled'));
  const rv1 = bc.judgeReview({ read: { screen: 'naver_place_review', confidence: 0.95, placeName: '가짜식당 강남점' }, expected: { placeName: '가짜식당 강남점' } });
  t('★ 리뷰 캡처: 네이버 플레이스 방문자 리뷰 + 같은 매장 = pass', rv1.verdict === 'pass');
  const rv2 = bc.judgeReview({ read: { screen: 'naver_place_review', confidence: 0.95, placeName: '진짜분식' }, expected: { placeName: '가짜식당 강남점' } });
  t('★ 리뷰 캡처: 다른 매장 = warn(place_differs · 막지 않음)', rv2.verdict === 'warn' && rv2.reason === 'place_differs' && rv2.ocr === '진짜분식');
  const rv3 = bc.judgeReview({ read: { screen: 'other_review', confidence: 0.92, placeName: '' }, expected: { placeName: '가짜식당 강남점' } });
  t('★ 리뷰 캡처: 상품 리뷰 등 다른 화면(확신) = warn(not_place_review)', rv3.verdict === 'warn' && rv3.reason === 'not_place_review');
  const rv4 = bc.judgeReview({ read: null, expected: { placeName: '가짜식당 강남점' } });
  t('★★ 리뷰 캡처: AI 실패 = skip + evidence unknown(판정 불가로 보인다 · 통과 아님)', rv4.verdict === 'skip' && rv4.evidence === 'unknown');
  t('리뷰 캡처: 매장 이름을 못 읽음 = unknown', bc.judgeReview({ read: { screen: 'naver_place_review', confidence: 0.95, placeName: '' }, expected: { placeName: '가짜식당' } }).evidence === 'unknown');

  /* ── 1) 가짜 AI 전송으로 실제 판독 함수 ─────────────────────── */
  console.log('\n1) 판독 함수(기존 Gemini 길 · 같은 모델 설정 · 캐시)');
  const gem = require('../src/services/gemini.service');
  const IMG_R1 = b64('reservation-capture-good');
  AI.answers.set('booking_reservation:' + IMG_R1, { screen: 'naver_booking', confidence: 0.96, cancelled: false,
    placeName: '가짜식당 강남점', visitDate: `${T2.slice(0, 4)}.${md(T2)}`, reservationNo: 'R 777', amount: '25,000원', reason: '예약 상세' });
  AI.calls.length = 0;
  const rd1 = await gem.readBookingCapture(IMG_R1, 'image/jpeg', { purpose: 'reservation' });
  t('판독: 기존 Gemini 호출 길(_runModel) 한 번 · 예약내역 프롬프트', AI.calls.length === 1 && AI.calls[0].kind === 'booking_reservation');
  t('판독 결과 정리(금액 숫자 · 예약번호 그대로 · 화면 종류)', rd1.screen === 'naver_booking' && rd1.amount === 25000 && rd1.reservationNo === 'R 777' && rd1.placeName === '가짜식당 강남점');
  await gem.readBookingCapture(IMG_R1, 'image/jpeg', { purpose: 'reservation' });
  t('★ 같은 사진은 캐시(AI 호출 0)', AI.calls.length === 1);
  const gsrc = S('src/services/gemini.service.js');
  const fnSrc = gsrc.slice(gsrc.indexOf('async function readBookingCapture('), gsrc.indexOf('module.exports'));
  t('★★ 새 모델·새 제공자 없음 — 판독은 _runModel(같은 MODEL_NAME·GEN_CONFIG·키 라운드로빈·시간 제한)', /_runModel\(/.test(fnSrc)
    && !/getGenerativeModel|new GoogleGenerativeAI|MODEL_NAME\s*=|gemini-\d/.test(fnSrc) && (gsrc.match(/new GoogleGenerativeAI\(/g) || []).length === 1);
  t('★ 캐시 접두는 용도별(예약내역·리뷰 분리 · 상품 리뷰 판별 캐시와 분리)', /booking\d+-\$\{purpose\}:/.test(fnSrc) || /BOOKING_CACHE_VERSION/.test(fnSrc));

  /* ── 2) 예약 작업표 + 공고 + 신청 + 예약내역 제출(3단계 실제 처리기) ── */
  console.log('\n2) 준비 — 예약내역 제출까지(3단계 처리기 그대로)');
  await q(`INSERT INTO app_settings (key, value) VALUES ('worktable_template', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TEMPLATE)]);
  const DATES = [{ date: T1, count: 2 }, { date: T2, count: 2 }];
  const place = { name: '가짜식당 강남점', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
    base: { pay: 25000, count: 4, daily: 0, review_type_mix: [] }, options: [],
    booking: { pay_mode: 'refund', dates: DATES, review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1' } };
  const wo = { id: WO, title: TAB, work_kind: 'booking', workboard_schema_version: 2, recruit_count: 4, review_fee: 5000, pay_amount: 100000, start_date: null,
    product_options_json: JSON.stringify([place]) };
  await q(`INSERT INTO work_orders (id, title, work_kind, workboard_schema_version, recruit_count, review_fee, pay_amount, product_options_json, status)
           VALUES ($1, $2, 'booking', 2, 4, 5000, 100000, $3, 'published')`, [WO, TAB, wo.product_options_json]);
  const acc = require('../src/services/sheetlessAccept.service');
  const made = await acc.createSheetlessWorktable({ workOrder: wo, tabName: TAB, by: 'test' });
  const sheetId = made.sheetId;
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, work_kind, sheetless, workboard_schema_version) VALUES ($1, $2, $3, 'booking', TRUE, 2)`, [sheetId, TAB, made.gid]);
  await made.persist();
  await q(`UPDATE work_orders SET linked_tab_sheet_id = $2, linked_tab_name = $3 WHERE id = $1`, [WO, sheetId, TAB]);
  await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, linked_tab_gid, work_kind,
             recruit_total, daily_limit, hold_ttl_min, multi_account_mode, review_fee)
           VALUES ($1, '가짜식당 강남점', 'active', TRUE, $2, $3, $4, 'booking', 4, 4, 20, FALSE, 5000)`, [CAMP, sheetId, TAB, made.gid]);
  await q(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, pay_amount, recruit_total, daily_limit, status, sort_order)
           VALUES ($1, $2, $2, 'product', 25000, 4, 0, 'active', 0)`, [CAMP, OPT]);
  await q(`INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder, address)
           VALUES ('가짜하나', '01011112222', '가짜은행', '000-0000-0001', '가짜하나', '서울 가짜구')`);
  const wk = require('../src/utils/workKind');
  t('★★★ 배포 그대로: booking 개방(준비 중 목록에 booking 없음 · 결정 414 · 418 영수증리뷰는 준비 중)', !wk.NOT_READY_WORK_KINDS.includes('booking') && wk.isWorkKindReady('booking') === true);
  const campaignRoutes = require('../src/routes/campaign.routes');
  const submitRoutes = require('../src/routes/submit.routes');
  const diagRoutes = require('../src/routes/diag.routes');
  const apply = handlerOf(campaignRoutes, 'post', '/:id/apply');
  const subH = handlerOf(submitRoutes, 'post', '/booking');
  const uploadH = handlerOf(diagRoutes, 'post', '/image-upload');
  const precheckH = handlerOf(diagRoutes, 'post', '/review-precheck');
  const call = async (h, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    const res = fakeRes(); let err = null;
    await h({ body, params, query, headers, ip: '127.0.0.1', get: () => '', path: '/x', method: 'POST' }, res, e => { err = e; });
    if (err) throw err;
    return res;
  };
  // 사진 저장(구글 드라이브)만 흉내 — 업로드 처리기의 세션·연결은 실제
  const drive = require('../src/services/drive.service');
  let upSeq = 0;
  const driveOrig = { up: drive.uploadFileBase64, trash: drive.trashFiles };
  drive.uploadFileBase64 = async (data, name) => ({ id: 'FAKEFILE' + (++upSeq) + '-0123456789abcdef', name, webViewLink: '' });
  drive.trashFiles = async () => ({ success: 0, failed: 0 });
  const cf = require('../src/services/captureFolder.service');
  const cfOrig = cf.resolveCaptureFolder;
  cf.resolveCaptureFolder = async () => ({ folderId: 'FOLDER-FAKE', folderUrl: 'https://drive.google.com/drive/folders/FOLDER-FAKE' });

  const saved = wk.NOT_READY_WORK_KINDS.slice();
  wk.NOT_READY_WORK_KINDS.length = 0;   // ★ 시험 안에서만 — 실제 처리기로 흐름을 돌리기 위해(운영 코드는 그대로 막힘)
  let osId = null, appId = null, capSession = null, seq = null;
  try {
    const ok1 = await call(apply, { params: { id: CAMP }, body: { name: '가짜하나', phone: '01011112222', bookingDate: T2, optionKey: OPT } });
    t('신청(고른 날 자리 묶기)', ok1.statusCode === 200 && ok1.body.ok === true);
    appId = ok1.body.applicationId;
    const rid = (await q(`SELECT id FROM reviewers WHERE phone8 = '11112222'`)).rows[0].id;
    await q('UPDATE campaign_applications SET owner_reviewer_id = $2 WHERE id = $1', [appId, rid]);
    const tok = require('../src/services/reviewerSession.service').issueReviewerSession({ ownerReviewerId: rid, loginName: '가짜하나', loginPhone8: '11112222' });
    const okSub = await call(subH, { headers: { 'x-reviewer-token': tok },
      body: { campaignId: CAMP, campaignApplicationId: appId, holdToken: ok1.body.holdToken, holdPhone8: '11112222', reservationNo: 'R777', payAmount: '25000' } });
    t('예약내역 제출(예약번호 R777 · 결제금액 25,000원)', okSub.statusCode === 200 && okSub.body.ok === true && okSub.body.captureSession);
    osId = okSub.body.orderSubmissionId; capSession = okSub.body.captureSession; seq = Number(okSub.body.target.rowIndex);
  } finally {
    wk.NOT_READY_WORK_KINDS.length = 0; wk.NOT_READY_WORK_KINDS.push(...saved);
  }
  t('★★ 시험 뒤 준비 중 목록 원상 복귀(배포 그대로)', JSON.stringify(wk.NOT_READY_WORK_KINDS) === JSON.stringify(saved) && !wk.NOT_READY_WORK_KINDS.includes('booking'));

  /* ── 3) 예약내역 캡처 업로드 → 자동 검사(실제 업로드 처리기) ─────── */
  console.log('\n3) 예약내역 캡처 업로드 → 자동 검사');
  AI.calls.length = 0;
  const IMG_U = b64('reservation-upload-good');
  AI.answers.set('booking_reservation:' + IMG_U, AI.answers.get('booking_reservation:' + IMG_R1));
  const up = await call(uploadH, { body: { imageBase64: IMG_U, mimeType: 'image/jpeg', fileName: '가짜하나_예약내역.jpg',
    orderSubmissionId: osId, captureSessionId: capSession.id, captureSessionToken: capSession.token } });
  // 업로드 응답은 검사를 기다리지 않는다
  t('★★ 업로드 응답은 검사와 무관하게 성공(리뷰어를 기다리게·막지 않는다)', up.body && up.body.ok === true && up.body.fileId);
  await bc.flushPending();
  const os1 = (await q('SELECT capture_file_id, capture_flags FROM order_submissions WHERE id = $1', [osId])).rows[0];
  const rec1 = os1.capture_flags && os1.capture_flags.booking;
  t('★★★ 검사 결과가 주문에 남는다(match · 그 사진 번호 · 읽은 값)', rec1 && rec1.status === 'match' && rec1.fileId === os1.capture_file_id
    && rec1.read && rec1.read.reservationNo === 'R 777');
  t('★ 예약내역 캡처 1장 = AI 1번(예약내역 판독만 · 상품 리뷰 판별 0)', AI.calls.length === 1 && AI.calls[0].kind === 'booking_reservation');
  t('주문의 다른 캡처 확인(결정 319 flags)은 건드리지 않는다', !os1.capture_flags.flags);

  // 다른 값 — 같은 처리 함수를 직접(그 사진 번호 그대로)
  const IMG_R2 = b64('reservation-capture-bad');
  AI.answers.set('booking_reservation:' + IMG_R2, { screen: 'naver_booking', confidence: 0.95, cancelled: false,
    placeName: '가짜식당 역삼점', visitDate: md(T1), reservationNo: 'R999', amount: 30000 });
  await bc.checkReservationCapture({ orderSubmissionId: osId, fileId: os1.capture_file_id, base64: IMG_R2, mimeType: 'image/jpeg' });
  const rec2 = (await q('SELECT capture_flags FROM order_submissions WHERE id = $1', [osId])).rows[0].capture_flags.booking;
  t('★★ 다른 매장·다른 날·다른 예약번호·다른 금액 = mismatch + 이유 4개', rec2.status === 'mismatch'
    && ['place_differs', 'date_differs', 'resv_differs', 'amount_differs'].every(c => rec2.reasons.some(r => r.code === c)));
  const IMG_R3 = b64('reservation-capture-ai-down');
  AI.fail.add(IMG_R3);
  await bc.checkReservationCapture({ orderSubmissionId: osId, fileId: os1.capture_file_id, base64: IMG_R3, mimeType: 'image/jpeg' });
  const rec3 = (await q('SELECT capture_flags FROM order_submissions WHERE id = $1', [osId])).rows[0].capture_flags.booking;
  t('★★ AI 오류 = unknown(ai_failed)로 남긴다 — 「일치」로 꾸미지 않는다', rec3.status === 'unknown' && rec3.reasons[0].code === 'ai_failed');
  await bc.checkReservationCapture({ orderSubmissionId: osId, fileId: 'OTHER-FILE-ID-0000000000', base64: IMG_R1, mimeType: 'image/jpeg' });
  const rec4 = (await q('SELECT capture_flags FROM order_submissions WHERE id = $1', [osId])).rows[0].capture_flags.booking;
  t('★ 그사이 사진이 바뀌었으면(다른 사진 번호) 결과를 덮지 않는다', rec4.status === 'unknown' && rec4.fileId === os1.capture_file_id);
  t('★ 예약 주문이 아니면 아무것도 하지 않는다(AI 0 · 쓰기 0)', await (async () => {
    const { rows } = await q(`INSERT INTO order_submissions (sheet_id, tab_name, orderer, source, capture_file_id) VALUES ($1, $2, '가짜둘', 'order_submit', 'PLAIN-FILE-0000000000000') RETURNING id`, [sheetId, TAB]);
    const n0 = AI.calls.length;
    const r = await bc.checkReservationCapture({ orderSubmissionId: rows[0].id, fileId: 'PLAIN-FILE-0000000000000', base64: IMG_R1, mimeType: 'image/jpeg' });
    const cfl = (await q('SELECT capture_flags FROM order_submissions WHERE id = $1', [rows[0].id])).rows[0].capture_flags;
    return r && r.skipped === 'not_booking' && AI.calls.length === n0 && cfl == null;
  })());
  t('★ 검사는 어떤 오류에도 던지지 않는다(scheduleReservationCheck → 실패해도 조용히 기록만)', await (async () => {
    const p = bc.scheduleReservationCheck({ orderSubmissionId: 'not-a-uuid', fileId: 'x', base64: 'x' });
    await bc.flushPending(); return p && typeof p.then === 'function';
  })());
  process.env.BOOKING_CAPTURE_CHECK = '0';
  t('끄는 스위치 BOOKING_CAPTURE_CHECK=0 → AI 0', await (async () => {
    const n0 = AI.calls.length;
    const r = await bc.checkReservationCapture({ orderSubmissionId: osId, fileId: os1.capture_file_id, base64: b64('switch-off'), mimeType: 'image/jpeg' });
    return r && r.skipped === 'disabled' && AI.calls.length === n0;
  })());
  delete process.env.BOOKING_CAPTURE_CHECK;
  // 정상으로 되돌려 둔다(작업보드 확인용)
  await bc.checkReservationCapture({ orderSubmissionId: osId, fileId: os1.capture_file_id, base64: IMG_R2, mimeType: 'image/jpeg' });

  /* ── 4) 작업보드(내부만) ───────────────────────────────────── */
  console.log('\n4) 작업보드 표시(내부 담당자만)');
  const tb = require('../src/services/trackB.service');
  const v = bc.reservationCheckView;
  t('보기 재료: 예약 주문 아님 = 표시 없음', v(null, null) === null && v({ booking: { status: 'match' } }, null) === null);
  t('★ 보기 재료: 캡처 없음 = 표시 없음(사진 없음은 다른 경고가 말한다)', v(null, { fileId: null }) === null);
  t('★★ 보기 재료: 캡처는 있는데 검사 기록 없음 = unknown(not_checked)', v(null, { fileId: 'F1' }).status === 'unknown' && /자동 확인/.test(v(null, { fileId: 'F1' }).lines.join('')));
  t('★★ 보기 재료: 사진이 바뀐 뒤 = unknown(capture_changed · 옛 결과로 「일치」라 하지 않는다)', v({ booking: { status: 'match', fileId: 'F0', reasons: [] } }, { fileId: 'F1' }).status === 'unknown');
  const vw = await tb.workdeskTab({ sheetId, tabName: TAB, role: 'master' });
  const row = (vw.roster || []).find(r => Number(r.seq) === seq);
  t('★★★ 작업보드(내부): 그 줄에 예약내역 검사 결과(mismatch · 사람이 읽는 이유)', row && row.bookingCheck && row.bookingCheck.status === 'mismatch'
    && row.bookingCheck.lines.some(l => /매장 이름이 다름/.test(l)) && row.bookingCheck.lines.some(l => /결제금액이 다름/.test(l) && /30,000원/.test(l)));
  const otherRows = (vw.roster || []).filter(r => Number(r.seq) !== seq);
  t('예약내역을 안 낸 빈 줄에는 표시 없음', otherRows.every(r => !r.bookingCheck));
  const vwAdv = await tb.workdeskTab({ sheetId, tabName: TAB, role: 'advertiser', allowAllWorkdesk: true });
  t('★★ 업체 화면에는 싣지 않는다(내부만 — 결정 319 🚩 와 같은 규율)', !(vwAdv.roster || []).some(r => r.bookingCheck));

  /* ── 5) 리뷰 캡처 — 1차 필터(첨부 즉시) ─────────────────────── */
  console.log('\n5) 리뷰 캡처 1차 필터 — 예약 탭은 그대로 건너뜀(AI 0)');
  AI.calls.length = 0;
  const IMG_V1 = b64('place-review-good');
  const pre = await call(precheckH, { body: { base64: IMG_V1, mimeType: 'image/jpeg', sheetId, tabName: TAB, slotKey: 'review' } });
  t('★★ 1차 필터: 예약 탭 = skip(booking_tab) · 잠그지 않음', pre.body.ok === true && pre.body.verdict === 'skip' && pre.body.code === 'booking_tab' && pre.body.blocked === false);
  t('★ 1차 필터: 예약 탭은 AI 를 부르지 않는다(결과를 쓰지 않는 판별 호출 제거 — 비용 순감)', AI.calls.length === 0);

  /* ── 6) 리뷰 캡처 — 2차 검수(예약 전용 판정) ───────────────── */
  console.log('\n6) 리뷰 캡처 2차 검수 — 네이버 플레이스 방문자 리뷰 + 같은 매장');
  const inspect = require('../src/services/reviewInspect.service');
  AI.answers.set('booking_review:' + IMG_V1, { screen: 'naver_place_review', confidence: 0.95, placeName: '가짜식당 강남점', authorMask: '가짜**', visitDate: md(T2) });
  const ins1 = await inspect.inspectSubmission({ base64: IMG_V1, mimeType: 'image/jpeg', fileId: 'REVIEWFILE-1-000000000000', sheetId, tabName: TAB, rowIndex: seq, reviewerName: '가짜하나', slotKey: 'review' });
  t('★★ 같은 매장 방문자 리뷰 = place pass · 전체 pass', ins1 && ins1.checks.place && ins1.checks.place.verdict === 'pass' && ins1.status === 'pass');
  t('★★ 상품 리뷰 판정 격리 그대로(형식·상품명·본문겹침 skip · booking_tab)', ins1.checks.format.verdict === 'skip' && ins1.checks.format.reason === 'booking_tab'
    && ins1.checks.product.verdict === 'skip' && ins1.checks.similarity.verdict === 'skip');
  t('★★ 같은 파일 검사는 그대로 돈다', ins1.checks.duplicate && ['pass', 'warn', 'fail'].includes(ins1.checks.duplicate.verdict));
  t('★ 리뷰 캡처 1장 = AI 1번(예약 리뷰 판독만 · 상품 리뷰 판별 0)', AI.calls.length === 1 && AI.calls[0].kind === 'booking_review');
  const IMG_V2 = b64('place-review-other-store');
  AI.answers.set('booking_review:' + IMG_V2, { screen: 'naver_place_review', confidence: 0.95, placeName: '진짜분식', authorMask: '가짜**' });
  const ins2 = await inspect.inspectSubmission({ base64: IMG_V2, mimeType: 'image/jpeg', fileId: 'REVIEWFILE-2-000000000000', sheetId, tabName: TAB, rowIndex: seq, reviewerName: '가짜하나', slotKey: 'review' });
  t('★★ 다른 매장 리뷰 = place warn → 의심(suspect · 리뷰검수에 뜬다 · 막지 않음)', ins2.checks.place.verdict === 'warn' && ins2.status === 'suspect');
  const IMG_V3 = b64('place-review-ai-down');
  AI.fail.add(IMG_V3);
  const ins3 = await inspect.inspectSubmission({ base64: IMG_V3, mimeType: 'image/jpeg', fileId: 'REVIEWFILE-3-000000000000', sheetId, tabName: TAB, rowIndex: seq, reviewerName: '가짜하나', slotKey: 'review' });
  t('★★ AI 오류 = 판정 불가(unverifiable) — 통과로 꾸미지 않는다', ins3.checks.place.evidence === 'unknown' && ins3.status === 'unverifiable');
  const stored = (await q(`SELECT status, checks FROM review_inspections WHERE file_id = 'REVIEWFILE-2-000000000000'`)).rows[0];
  t('검수 기록(review_inspections)에 저장 — 리뷰검수 화면이 읽는 자리', stored && stored.status === 'suspect' && stored.checks.place.reason === 'place_differs');
  const IIT = require('../src/utils/inspectIssueTypes');
  t('★ 리뷰검수 오류유형: 「매장 리뷰」 유형(서버 단일 출처)', IIT.ISSUE_KEYS.includes('place') && IIT.issueTypesOf({ checks: stored.checks }).includes('place'));
  // 비예약 탭은 종전(상품 리뷰 판별) 그대로
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind) VALUES ('plain-sheet', '일반 리뷰 탭', 'review')`);
  AI.calls.length = 0;
  const IMG_P = b64('plain-review');
  AI.answers.set('classify:' + IMG_P, { kind: 'review', confidence: 0.95, channel: 'naver' });
  const ins4 = await inspect.inspectSubmission({ base64: IMG_P, mimeType: 'image/jpeg', fileId: 'REVIEWFILE-4-000000000000', sheetId: 'plain-sheet', tabName: '일반 리뷰 탭', rowIndex: 1, reviewerName: '가짜셋', slotKey: 'review' });
  t('★ 비예약 탭은 종전 판별(classify) 그대로 · 매장 판정 없음', AI.calls.length === 1 && AI.calls[0].kind === 'classify' && ins4 && !ins4.checks.place && ins4.checks.format.verdict === 'pass');

  /* ── 7) 화면(작업보드·리뷰검수) — 실제 실행 ───────────────────── */
  console.log('\n7) 화면');
  const wd = F('workdesk.html');
  const bkFn = wd.slice(wd.indexOf('function _bkCheckBadge('), wd.indexOf('\n}\n', wd.indexOf('function _bkCheckLines(')) + 3);
  const ctx = { esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  vm.createContext(ctx);
  vm.runInContext(bkFn + '\nthis.b = _bkCheckBadge; this.l = _bkCheckLines; this.m = _bkCheckMark;', ctx);
  t('★ 배지: mismatch = 🚩 예약내역 확인 필요(빨강)', /🚩 예약내역 확인 필요/.test(ctx.b({ bookingCheck: { status: 'mismatch', lines: ['매장 이름이 다름'] } })));
  t('★★ 배지: unknown = 「예약내역 자동 확인 못 함」(일치로 보이지 않는다)', /예약내역 자동 확인 못 함/.test(ctx.b({ bookingCheck: { status: 'unknown', lines: ['AI가 사진을 읽지 못함'] } }))
    && !/일치/.test(ctx.b({ bookingCheck: { status: 'unknown', lines: ['x'] } })));
  t('배지: match = 「예약내역 일치」', /예약내역 일치/.test(ctx.b({ bookingCheck: { status: 'match', lines: [] } })));
  t('배지: 재료 없음 = 빈 글자(옛 서버·예약 아님)', ctx.b({}) === '' && ctx.l({}) === '' && ctx.m({}) === '');
  t('미리보기 줄: 이유를 그대로(이름 안전 표기)', /&lt;b&gt;/.test(ctx.l({ bookingCheck: { status: 'mismatch', lines: ['<b>'] } })));
  t('★ 이름 앞 표시(그리드는 이름 뒤 배지가 잘린다): 다름 = 🚩 · 확인 못 함 = ❔ · 일치 = 없음', /🚩/.test(ctx.m({ bookingCheck: { status: 'mismatch', lines: ['x'] } }))
    && /❔/.test(ctx.m({ bookingCheck: { status: 'unknown', lines: ['x'] } })) && ctx.m({ bookingCheck: { status: 'match', lines: [] } }) === '');
  t('★ 세 자리(기본 표·시트 그리드·제출물 미리보기)에서 부른다 — 함수가 없을 때(옛 가드 모형)도 터지지 않게',
    (wd.match(/typeof _bkCheckBadge==='function'\?_bkCheckBadge\(r\):''/g) || []).length === 2
    && /typeof _bkCheckLines==='function'\?_bkCheckLines\(r\):''/.test(wd) && /typeof _bkCheckMark==='function'\?_bkCheckMark\(r\):''/.test(wd));
  t('★ 리뷰검수 칩·근거 문장에 「매장 리뷰」', /\['place','🏪 매장 리뷰 확인'\]/.test(wd) && /c\.place&&c\.place\.verdict==='warn'/.test(wd) && /function _riReasons\(c, opt\)\{[\s\S]{0,3000}c\.place/.test(wd));

  /* ── 8) 배선 계약 ─────────────────────────────────────────── */
  console.log('\n8) 배선');
  const dg = S('src/routes/diag.routes.js');
  const upSeg = dg.slice(dg.indexOf("router.post('/image-upload'"), dg.indexOf("router.post('/review-precheck'"));
  t('★★ 구매캡처 업로드: 연결이 끝난 뒤 예약 주문만 검사 예약(기다리지 않음 · 첫 장만)', /uploadCtx\.orderSource === 'booking_submit'/.test(upSeg)
    && upSeg.indexOf('scheduleReservationCheck(') > upSeg.indexOf("purchaseSessions[second ? 'completeCapture2' : 'completeCapture']")
    && !/await [^\n]*scheduleReservationCheck\(/.test(upSeg) && /!second && uploadCtx\.orderSource/.test(upSeg));
  t('★ 업로드 세션 조회가 주문 출처를 같은 왕복에 읽는다(추가 조회 0)', /os\.source AS "orderSource"/.test(S('src/services/purchaseSubmissionSession.service.js')));
  t('★★ 업로드 검수(verifyCapture)의 예약 탭 건너뜀은 그대로(결정 404)', /if \(!\(\(_isQnaUpload \|\| _isBookingUpload( \|\| _isReceiptReviewUpload)?\) && _slotRole === 'review'\)\) verdict = await verifyCapture\(\{/.test(dg));   // 결정 418 영수증리뷰 추가(의미 불변)
  const isrc = S('src/services/reviewInspect.service.js');
  t('★★ 1차 필터 정책의 예약 skip 은 그대로(precheckPolicy)', /if \(workKind === 'booking'\) return skip\('booking_tab'\);/.test(isrc));
  t('★ 예약 검사 판정은 한 곳(bookingCaptureCheck) — 검수 서비스는 그것을 부른다(사본 0)', /bookingCaptureCheck\.service'\)\.judgeReview\(/.test(isrc)
    && !/function placeNameMatches/.test(isrc));

  drive.uploadFileBase64 = driveOrig.up; drive.trashFiles = driveOrig.trash; cf.resolveCaptureFolder = cfOrig;
  console.log(`\n✅ ${pass}개 통과\n`);
  await db.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
