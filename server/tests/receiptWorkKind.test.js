/**
 * receiptWorkKind.test.js — 영수증리뷰 1단계 회귀가드 (작업유형 축 `work_kind` 다섯 번째 값 `receipt`, 결정 418)
 * 실행: node tests/receiptWorkKind.test.js
 *
 * 이 변경의 위험은 여섯이다.
 *  ① **기존 데이터 재분류** — 운영 저장값은 `''`·`review`·`blog`·`qna`·`booking` 이다. 이 다섯과 사람이 적은 리뷰·블로그·
 *     Q&A·예약리뷰 표기의 판정이 한 글자도 바뀌면 안 된다 — receipt 는 「모르면 리뷰」로 떨어지던 자리에서만 가져온다.
 *  ② ★★ **현금영수증과 섞임** — 「현금영수증」은 상품 리뷰 작업의 **이미 있는 다른 기능**(발행 안내·선택 캡처 칸 · 결정 114/115/122)이다.
 *     `현금영수증 리뷰`·`리뷰+현금영수증`·`영수증 캡처` 같은 글이 영수증리뷰로 읽히면 상품 리뷰 작업이 「준비 중」으로 거절되거나
 *     (개방 뒤엔) 매장 방문 작업으로 바뀐다. 거꾸로 현금영수증 칸·안내가 영수증리뷰 작업에 붙는 판정도 work_kind 를 보지 않아야 한다.
 *  ③ **조용한 강등** — receipt 가 어디선가 review 로 접히면 매장 방문 작업에 구매양식·상품 리뷰 검수가 붙는다.
 *  ④ **반쪽 접수** — 2~5단계(영수증 묶음·리뷰어 화면·검수·입금)가 없는 동안 receipt 오더·공고가 저장되면 상품 리뷰 작업보드가 깔린다.
 *     저장 입구 5곳 + 신청은 **아무것도 쓰기 전에** `work_kind_not_ready` 로 거절한다(fail-closed · **배포 그대로의 목록으로** 본다).
 *  ⑤ **검수 차단** — 결과물이 네이버 영수증 리뷰(매장 방문 리뷰)라 상품 리뷰 화면 판정이 정상 제출을 잠그면 안 된다.
 *  ⑥ **판정 사본** — 서버 `isReceiptKind` 와 프론트 `_woIsReceiptKind` 가 같은 표기에 다른 답을 내면 갈라진다.
 *
 * ★ 순수함수·라우트 처리기는 실제로 실행해 검증한다(문자열 존재만 보는 grep 은 실행경로를 못 본다).
 *   라우트는 DB 를 메모리 대역으로 바꾸고, 쓰기를 시도하면 그 자체로 실패로 센다(실제 접속 0).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.ORDER_INTAKE_KEY = process.env.ORDER_INTAKE_KEY || 'receipt-local-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'receipt-local-jwt';

const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
const t = (name, cond, detail) => {
  if (!cond) { console.error('  ✗ ' + name + (detail !== undefined ? '\n    ' + JSON.stringify(detail) : '')); }
  assert(cond, name); pass++; console.log('  ✓ ' + name);
};

/** 결정 418 이전의 판정 규칙(결정 404·414 뒤 — 글자 그대로 얼려 둔 사본) — 기존 답이 안 바뀌었는지 대조하는 기준. */
function legacyNormalize(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'review';
  if (['review', 'blog', 'qna', 'booking'].includes(s)) return s;
  if (/블로그|blog/i.test(s)) return 'blog';
  if (/q\s*[&\/]\s*a|\bqna\b|큐앤에이|문의\s*등록/i.test(s)) return 'qna';
  if (/네이버\s*예약\s*리뷰|예약자\s*리뷰|예약리뷰|\bbooking\b/i.test(s)) return 'booking';
  return 'review';
}

/** 영수증리뷰로 읽혀야 하는 표기 */
const RECEIPT_SAMPLES = ['receipt', 'RECEIPT', 'Receipt', ' receipt ', '영수증리뷰', '영수증 리뷰', '영수증  리뷰', '영수증리뷰체험단',
  '영수증 리뷰 체험단', '영수증인증 리뷰', '영수증 인증 리뷰', '영수증인증리뷰', '네이버 영수증 리뷰', '네이버영수증리뷰', '[영수증리뷰]',
  '영수증리뷰(매장)', 'naver receipt review', 'receipt review', '영수증리뷰 + 현금영수증 없음'];

/** ★★ 현금영수증(상품 리뷰 작업의 다른 기능)·그 밖의 「영수증」 글 — 종전 답 그대로여야 한다 */
const CASH_RECEIPT_SAMPLES = ['현금영수증', '현금 영수증', '현금영수증 리뷰', '현금영수증리뷰', '현금 영수증 리뷰', '현금 영수증리뷰',
  '현금영수증 리뷰체험단', '현금영수증 리뷰 체험단', '리뷰+현금영수증', '리뷰 + 현금영수증', '리뷰체험단(현금영수증)', '현금영수증 발행',
  '현금영수증(지출증빙)', '현금영수증 지출증빙 리뷰', '지출증빙 현금영수증 리뷰', '지출증빙 영수증 리뷰', '지출증빙영수증 리뷰', '지출증빙용 영수증 리뷰',
  '현금영수증 캡처', '현금영수증 캡처 리뷰', '네이버 현금영수증', '쿠팡 현금영수증', '네이버 현금영수증 리뷰', '현영', '현영 리뷰', '현영건 리뷰체험단',
  '영수증', '영수증 발행', '영수증 캡처', '영수증 캡처 리뷰', '영수증 첨부', '영수증 첨부 리뷰', '영수증 제출', '구매 영수증', '리뷰 영수증',
  '간이영수증 리뷰', '카드영수증리뷰', '현금영수증 블로그', '현금영수증 Q&A', '현금영수증 예약리뷰',
  'cash receipt', 'Cash Receipt', 'cash receipt review', 'cash-receipt review', 'cash_receipt', 'cashreceipt', 'receipt_validation', 'receipts',
  'receipt2', 'receipt_tab', 'cash receipts'];

(async () => {
  console.log('\n▶ 영수증리뷰 1단계 — 작업유형 축(work_kind=receipt) 회귀가드\n');

  const WK = require('../src/utils/workKind');

  /* ── 1) 판정 단일 출처 ─────────────────────────────────────────── */
  console.log('1) 판정 단일 출처');
  t('표준 목록 맨 뒤에 receipt = 영수증리뷰 (기존 넷은 순서·라벨 그대로)', JSON.stringify(WK.WORK_KINDS) === JSON.stringify([
    { key: 'review', label: '리뷰체험단' }, { key: 'blog', label: '블로그체험단' }, { key: 'qna', label: 'Q&A체험단' },
    { key: 'booking', label: '네이버예약리뷰' }, { key: 'receipt', label: '영수증리뷰' }]), WK.WORK_KINDS);
  t('라벨 조회', WK.workKindLabel('receipt') === '영수증리뷰');
  t('★★ 운영 저장값 5종의 판정 불변', ['', 'review', 'blog', 'qna', 'booking'].every(v => WK.normalizeWorkKind(v) === legacyNormalize(v)
    && WK.workKindForStore(v) === v && !WK.isReceiptKind(v)));
  for (const v of RECEIPT_SAMPLES) {
    t(`영수증리뷰 표기 → receipt: ${JSON.stringify(v)}`, WK.normalizeWorkKind(v) === 'receipt' && WK.workKindForStore(v) === 'receipt' && WK.isReceiptKind(v),
      WK.normalizeWorkKind(v));
  }
  for (const v of CASH_RECEIPT_SAMPLES) {
    t(`★★ 현금영수증·그 밖의 영수증 글 → 종전 판정 그대로: ${JSON.stringify(v)}`, !WK.isReceiptKind(v) && WK.normalizeWorkKind(v) === legacyNormalize(v),
      { now: WK.normalizeWorkKind(v), old: legacyNormalize(v) });
  }
  for (const v of ['리뷰체험단', '리뷰', '방문리뷰', '매장 리뷰', '플레이스 리뷰', null, undefined, '', ' ']) {
    t(`영수증리뷰 아님 → 종전 판정: ${JSON.stringify(v)}`, !WK.isReceiptKind(v) && WK.normalizeWorkKind(v) === legacyNormalize(v));
  }
  t('★ 블로그를 먼저 본다(블로그 표기에 영수증리뷰가 섞여도 blog)', WK.normalizeWorkKind('네이버 블로그 영수증리뷰') === 'blog' && WK.normalizeWorkKind('receipt blog') === 'blog');
  t('★ Q&A 다음에 본다(Q&A 표기에 영수증리뷰가 섞여도 qna)', WK.normalizeWorkKind('Q&A 영수증리뷰') === 'qna' && WK.normalizeWorkKind('문의등록 receipt') === 'qna');
  t('★ 예약리뷰 다음에 본다(예약리뷰 표기에 영수증리뷰가 섞여도 booking)', WK.normalizeWorkKind('네이버예약리뷰 영수증리뷰') === 'booking'
    && WK.normalizeWorkKind('booking receipt') === 'booking' && WK.normalizeWorkKind('예약 영수증리뷰') === 'receipt');
  // ★★ 넓은 표본 대조 — receipt 는 「모르면 리뷰」 자리에서만 가져온다(블로그·Q&A·예약리뷰 답을 뺏으면 실패)
  const wide = ['', ' ', 'review', 'blog', 'qna', 'booking', '리뷰체험단', '블로그체험단', 'Q&A체험단', '네이버예약리뷰', '블로그', 'BLOG',
    '네이버 블로그 체험단', 'Q/A등록작업', 'QnA', 'Q & A', '문의 등록', '큐앤에이', 'quality', 'aqua', 'QA', '포토', '아무거나', '예약',
    '사전예약 리뷰체험단', '예약자 리뷰', '블로그 영수증리뷰', 'Q&A 영수증 리뷰', '예약리뷰 영수증리뷰', '영수증리뷰 블로그', 'receipt qna',
    'receipt booking', 'x', ...RECEIPT_SAMPLES, ...CASH_RECEIPT_SAMPLES];
  t('★★ 넓은 표본: 종전 답과 같거나, 종전 review → receipt 만', wide.every(v => {
    const now = WK.normalizeWorkKind(v), old = legacyNormalize(v);
    return now === old || (old === 'review' && now === 'receipt');
  }), wide.filter(v => { const now = WK.normalizeWorkKind(v), old = legacyNormalize(v); return !(now === old || (old === 'review' && now === 'receipt')); }));
  t('★ 다른 종류 판정은 receipt 를 자기 것으로 보지 않는다', RECEIPT_SAMPLES.every(v => !WK.isBlogKind(v) && !WK.isQnaKind(v) && !WK.isBookingKind(v)));
  t('공고 > 탭 우선순위에 receipt 도 그대로', WK.resolveWorkKind({ campaignKind: 'receipt', tabKind: 'review' }) === 'receipt'
    && WK.resolveWorkKind({ campaignKind: '', tabKind: 'receipt' }) === 'receipt'
    && WK.resolveWorkKind({ campaignKind: 'review', tabKind: 'receipt' }) === 'review');
  t('★ 공유필드 정규화(CANON)도 receipt 를 지킨다', require('../src/utils/sharedFields').CANON.workKind('receipt') === 'receipt');
  const wkSrc = S('src/utils/workKind.js');
  const mPat = wkSrc.match(/const RECEIPT_PATTERN = (\/.*\/i);/);
  const mCash = wkSrc.match(/const CASH_RECEIPT_WORDS = (\/.*\/gi);/);
  t('★ 영수증리뷰 표기 규칙은 확실한 표기만(맨 「영수증」·「현금영수증」 금지) — 규칙 원문 실행', !!mPat && !!mCash && (() => {
    const re = new RegExp(mPat[1].slice(1, -2), 'i');
    return !re.test('영수증') && !re.test('현금영수증리뷰') && !re.test('영수증 발행') && re.test('영수증리뷰');
  })());
  t('★ 현금영수증 지우개(/g)는 replace 에만 쓴다(.test 에 쓰면 lastIndex 로 답이 번갈아 바뀐다)', !/CASH_RECEIPT_WORDS\.test\(/.test(wkSrc)
    && /\.replace\(CASH_RECEIPT_WORDS, ' '\)/.test(wkSrc));
  t('★ 같은 값을 거듭 물어도 같은 답(전역 정규식 상태 없음)', [1, 2, 3, 4].every(() => WK.normalizeWorkKind('현금영수증 리뷰') === 'review'
    && WK.normalizeWorkKind('영수증리뷰') === 'receipt'));

  /* ── 2) 현금영수증 기능은 work_kind 를 보지 않는다(영수증리뷰 작업에 붙지 않는 근거) ─── */
  console.log('\n2) 현금영수증 기능과 영수증리뷰는 다른 축');
  const cs = require('../src/utils/captureSlots');
  t('★★ 현금영수증 칸 판정(effectiveCaptureSlots)은 탭 칸 설정·진행방식(현영)·공고 현금영수증 설정만 본다 — 체험단 종류 인자 없음',
    !/work_?kind/i.test(cs.effectiveCaptureSlots.toString())
    && !/work_?kind/i.test(cs.isCashReceiptIncome.toString()) && !/work_?kind/i.test(cs.cashReceiptSlotInfo.toString()));
  const plain = cs.effectiveCaptureSlots(null, '', null, false);
  t('★ 설정이 없으면 현금영수증 칸 없음(영수증리뷰 작업도 같은 답 — 종류로 칸이 생기지 않는다)', Array.isArray(plain) ? !plain.some(s => s && s.key === 'receipt') : plain == null,
    plain);
  t('★ 「영수증리뷰」라는 칸·라벨은 현금영수증 칸으로 읽히지 않는다(라벨 규칙 /현금영수증|현영|지출증빙/)',
    !cs.isCashReceiptSlot([{ key: 'review', label: '영수증리뷰' }], '', 'review')
    && !cs.hasCashReceiptSlot([{ key: 'review', label: '영수증리뷰 캡처' }], '', false));
  t('★ 공고 현금영수증 설정 조회는 cash_receipt_required 칸만 읽는다(체험단 종류 무관)',
    !/work_kind/.test(S('src/services/cashReceiptContext.service.js')) && /cash_receipt_required/.test(S('src/services/cashReceiptContext.service.js')));
  const inspect = require('../src/services/reviewInspect.service');
  t('★ 1차 필터: 현금영수증 칸(slotKey receipt)은 종류와 무관하게 종전대로(not_review_slot) — 종류 키와 칸 키가 섞이지 않는다',
    inspect.precheckPolicy({ classified: { kind: 'receipt', confidence: 0.99 }, slotKey: 'receipt', workKind: 'review' }).code === 'not_review_slot'
    && inspect.precheckPolicy({ classified: { kind: 'receipt', confidence: 0.99 }, slotKey: 'receipt', workKind: 'receipt' }).code === 'not_review_slot');

  /* ── 3) 준비 중 장치 — 저장 입구 fail-closed (배포 그대로의 목록) ───── */
  console.log('\n3) 준비 중 — 저장 입구·신청에서 거절(아무것도 쓰지 않음 · 배포 그대로의 목록)');
  t('★★★ 배포 그대로: 준비 중 목록 = [receipt] (booking 은 개방 그대로)', JSON.stringify(WK.NOT_READY_WORK_KINDS) === '["receipt"]'
    && WK.isWorkKindReady('booking'), WK.NOT_READY_WORK_KINDS);
  t('준비 판정: receipt 표기만 막고 나머지는 연다', RECEIPT_SAMPLES.every(v => !WK.isWorkKindReady(v))
    && ['', null, undefined, 'review', 'blog', 'qna', 'booking', '리뷰체험단', '네이버예약리뷰', '아무거나', ...CASH_RECEIPT_SAMPLES].every(v => WK.isWorkKindReady(v)));
  const nr = WK.workKindNotReadyBody('receipt');
  t('거절 본문: 코드 work_kind_not_ready · 칸 work_kind · 한국어 안내(무엇을 하면 되는지)', nr.ok === false && nr.code === 'work_kind_not_ready'
    && JSON.stringify(nr.blocked_fields) === '["work_kind"]' && /^영수증리뷰는 아직 리뷰웹에서 진행할 수 없습니다/.test(nr.error)
    && /저장하지 않았/.test(nr.error) && /바꿔/.test(nr.error) && !/추가 모집/.test(nr.error), nr);

  const pool = require('../src/db/pool');
  const origQuery = pool.query, origConnect = pool.connect;
  const orders = require('../src/routes/order.routes');
  const campaigns = require('../src/routes/campaign.routes');
  const route = (router, method, p) => {
    const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    assert.ok(layer, '실제 처리기 경로: ' + p);
    return layer.route.stack.at(-1).handle;
  };
  const current = { id: 'wo-receipt-local', title: '가짜 오더', status: 'submitted', deleted_at: null, work_kind: '',
    product_options_json: '', linked_campaign_id: '', linked_tab_name: '', linked_tab_gid: '', source_review_order_id: 'ro_receipt_local',
    recruit_count: 3, daily_count: 1, pay_amount: 0, memo_log: '[]', workboard_schema_version: 1, bidir_state: 'off' };
  const source = { source_system: 'inadd_intranet', source_review_order_id: 'ro_receipt_local', source_revision: 2,
    idempotency_key: 'ro_receipt_local:2:test' };
  const campRow = { id: 'camp-receipt-local', title: '가짜 영수증 공고', status: 'active', participation_mode: true, archived_at: null,
    work_kind: 'receipt', linked_sheet_id: 'sheet-local', linked_tab_name: '가짜탭', daily_limit: 3, recruit_total: 3 };
  async function call(handler, body, params = {}, { camp = null, writeOk = false } = {}) {
    const writes = [];
    pool.query = async (sql) => {
      const s = String(sql);
      if (/^\s*(CREATE|ALTER)\b/i.test(s)) return { rows: [] };           // 런타임 스키마 보강은 실제로 하지 않는다
      if (/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(s)) { writes.push(s); if (!writeOk) throw new Error('업무 데이터를 쓰려고 했습니다'); return { rows: [] }; }
      if (/FROM work_orders/i.test(s)) return { rows: [{ ...current }] };
      if (camp && /FROM recruit_campaigns/i.test(s)) return { rows: [{ ...camp }] };
      return { rows: [] };
    };
    pool.connect = async () => { writes.push('connect'); throw new Error('쓰기 연결을 열려고 했습니다'); };
    const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
    let thrown = null;
    try {
      await handler({ body: { title: '가짜 오더', ...body }, params: { id: current.id, sourceReviewOrderId: 'ro_receipt_local', ...params }, query: {},
        headers: { 'x-intake-key': process.env.ORDER_INTAKE_KEY }, admin: { name: '로컬 검사', role: 'admin' }, ip: '127.0.0.1', get: () => '' },
      res, e => { thrown = e; });
    } catch (e) { thrown = e; }
    return { res, writes, thrown };
  }
  const refused = r => !r.thrown && r.res.statusCode === 409 && r.res.body && r.res.body.code === 'work_kind_not_ready' && r.writes.length === 0;

  const intake = route(orders, 'post', '/intake');
  const revision = route(orders, 'put', '/intake/source/:sourceReviewOrderId');
  const legacyUpdate = route(orders, 'post', '/intake/:id/update');
  const legacyPut = route(orders, 'put', '/intake/:id');
  const campCreate = route(campaigns, 'post', '/admin/create');
  const campUpdate = route(campaigns, 'put', '/admin/:id');
  const apply = route(campaigns, 'post', '/:id/apply');
  try {
    for (const kind of ['receipt', '영수증리뷰', '영수증 인증 리뷰']) {
      t(`★★ 인트라넷 새 오더(${kind}) → 409 work_kind_not_ready · 쓰기 0`, refused(await call(intake, { ...source, source_revision: 1, idempotency_key: 'ro_receipt_local:1:t', work_kind: kind })));
      t(`★★ v2 계약 새 오더(${kind} · 영수증 사진 칸이 붙어 와도) → 거절 · 쓰기 0`, refused(await call(intake, { ...source, source_revision: 1,
        idempotency_key: 'ro_receipt_local:1:v2', work_kind: kind, workboard_schema_version: 2, work_series_id: 'ro_receipt_local', work_round: 1,
        recruit_count: 3, product_options_json: JSON.stringify([{ name: '가짜식당', url: 'https://example.invalid/p', receipt: { images: ['a', 'b', 'c'] } }]) })));
      t(`★★ 출처 계약 없는 옛 새 오더(${kind}) → 거절 · 쓰기 0`, refused(await call(intake, { work_kind: kind })));
      t(`★★ 인트라넷 원본 수정(${kind}로 바꾸기) → 거절 · 쓰기 0(종류 바꾸기 접수 되돌리기보다 먼저)`, refused(await call(revision, { ...source, work_kind: kind })));
      t(`★ 옛 수정 두 경로(${kind}) → 거절 · 쓰기 0`, refused(await call(legacyUpdate, { work_kind: kind })) && refused(await call(legacyPut, { work_kind: kind })));
      t(`★★ 관리자 공고 만들기(${kind}) → 거절 · 쓰기 0`, refused(await call(campCreate, { title: '가짜 공고', work_kind: kind })));
      t(`★★ 관리자 공고 고치기(${kind}로 바꾸기) → 거절 · 쓰기 0`, refused(await call(campUpdate, { work_kind: kind }, { id: 'camp-local' })));
    }
    // 신청(참여) 안전벨트 — 실제 신청 처리기 · 공고 종류 receipt · 잠금(pool.connect)·쓰기 전에 거절
    const ap = await call(apply, { name: '가짜하나', phone: '01011112222' }, { id: campRow.id }, { camp: campRow });
    t('★★ 영수증리뷰 공고 신청 → 409 work_kind_not_ready · 잠금·쓰기 0(안전벨트 — 1단계엔 그런 공고가 생길 수 없다)',
      !ap.thrown && ap.res.statusCode === 409 && ap.res.body && ap.res.body.reason === 'work_kind_not_ready' && ap.writes.length === 0,
      { status: ap.res.statusCode, body: ap.res.body, writes: ap.writes, thrown: ap.thrown && ap.thrown.message });
    require('../src/services/workKindContext.service').__setPoolForTest && require('../src/services/workKindContext.service').__setPoolForTest(null);
    const apTab = await call(apply, { name: '가짜하나', phone: '01011112222' }, { id: campRow.id },
      { camp: { ...campRow, id: 'camp-receipt-tab', work_kind: '', linked_tab_name: '가짜탭2' } });
    t('대조군: 공고 종류가 비고 탭도 모르면 이 문에 안 걸린다(종전 경로로 간다)', !(apTab.res.body && apTab.res.body.reason === 'work_kind_not_ready'));

    // 대조군 — 막는 문이 다른 종류까지 막지 않는다(게이트를 지나 다음 단계로 간다)
    for (const k of ['review', 'qna', '', '현금영수증 리뷰', '리뷰+현금영수증']) {
      const r = await call(intake, k ? { work_kind: k } : {});
      t(`★ 대조군: ${JSON.stringify(k)} 새 오더는 문을 지나 저장까지 간다(쓰기 시도 = 게이트 통과)`, r.writes.some(w => /INSERT INTO work_orders/.test(w)));
    }
    const passUpd = await call(campUpdate, { title: '가짜 공고' }, { id: 'camp-local' });
    t('대조군: 종류를 안 보낸 공고 고치기는 이 문에 안 걸린다', !(passUpd.res.body && passUpd.res.body.code === 'work_kind_not_ready'));
    const passCreate = await call(campCreate, { title: '가짜 공고', work_kind: 'booking' });
    t('대조군: 예약리뷰 공고 만들기는 이 문에 안 걸린다(개방 그대로)', !(passCreate.res.body && passCreate.res.body.code === 'work_kind_not_ready'));
  } finally {
    pool.query = origQuery; pool.connect = origConnect;
  }
  t('★ 시험 뒤 준비 중 목록은 배포 그대로', JSON.stringify(WK.NOT_READY_WORK_KINDS) === '["receipt"]');
  const ord = S('src/routes/order.routes.js');
  t('★ 원본 수정의 거절은 종류 바꾸기(결정 332 — 작업표 삭제)보다 앞', ord.indexOf('workKindNotReadyBody(b.work_kind)', ord.indexOf('async function _intakeSourceRevisionHandler'))
    < ord.indexOf('결정 332 — 접수된 리뷰↔블로그 오더의 종류 바꾸기'));
  const sb = S('src/routes/submit.routes.js');
  t('★ 예약내역·Q&A 제출 창구는 자기 자리표에 묶인 신청만 받는다(영수증리뷰 신청은 자리표가 없어 쓰기 전에 거절)',
    /const slot = await bookingSlots\.slotForApplication\(pool, holdCtx\.applicationId\);\s*if \(!slot\) return res\.status\(409\)\.json\(\{ ok: false, code: 'BOOKING_NOT_BOUND'/.test(sb)
    && /const slot = await qnaSlots\.slotForApplication\(pool, holdCtx\.applicationId\);\s*if \(!slot\) return res\.status\(409\)\.json\(\{ ok: false, code: 'QNA_NOT_BOUND'/.test(sb)
    && sb.indexOf("code: 'BOOKING_NOT_BOUND'") < sb.indexOf('const writeResvCell'));
  const bc = S('src/utils/bookingCalendar.js');
  t('★ 예약 자리표는 예약리뷰 오더에서만 깐다(isBookingKind — receipt 아님)', /if \(!row \|\| !require\('\.\/workKind'\)\.isBookingKind\(row\.work_kind\)\) return undefined;/.test(bc)
    && !WK.isBookingKind('receipt'));

  /* ── 4) 검수 격리 ──────────────────────────────────────────────── */
  console.log('\n4) 검수 격리');
  const otherShot = { kind: 'other', confidence: 0.95 };
  t('★★ 1차 필터: receipt 는 잠그지 않는다(skip receipt_review_tab)', (() => {
    const v = inspect.precheckPolicy({ classified: otherShot, slotKey: 'review', workKind: 'receipt' });
    return v.verdict === 'skip' && v.code === 'receipt_review_tab' && v.blockable === false;
  })());
  t('블로그·Q&A·예약리뷰 안전핀은 그대로', inspect.precheckPolicy({ classified: otherShot, workKind: 'blog' }).code === 'blog_tab'
    && inspect.precheckPolicy({ classified: otherShot, workKind: 'qna' }).code === 'qna_tab'
    && inspect.precheckPolicy({ classified: otherShot, workKind: 'booking' }).code === 'booking_tab');
  t('미지정·리뷰는 종전 경로(skip 아님 — 잠글 수 있다)', inspect.precheckPolicy({ classified: otherShot, workKind: null }).verdict === 'block'
    && inspect.precheckPolicy({ classified: otherShot, workKind: 'review' }).verdict === 'block');
  const isrc = S('src/services/reviewInspect.service.js');
  t('2차: 형식·상품명·본문겹침 skip 갈래에 receipt 포함 · 같은 파일 검사는 갈래 밖',
    /const _isBlogTab = exp\.workKind === 'blog' \|\| exp\.workKind === 'qna' \|\| exp\.workKind === 'booking' \|\| exp\.workKind === 'receipt';/.test(isrc)
    && /exp\.workKind === 'receipt' \? 'receipt_review_tab'/.test(isrc)
    && /checks\.duplicate = await classifyDuplicateContext\(\{\n\s*dup: await findDuplicate\(/.test(isrc));
  t('★ 2차: 예약 리뷰 판독(결정 412)은 예약리뷰만 — receipt 는 상품 리뷰 판별도 예약 판독도 아닌 skip 갈래',
    /const _bookingReview = isReview && exp\.workKind === 'booking';/.test(isrc));
  const dg = S('src/routes/diag.routes.js');
  t('★★ 업로드 검수: receipt 탭의 리뷰 칸도 형식 판정·자동 이동·불일치 알림을 만들지 않는다(현금영수증 칸은 종전대로 검사)',
    /_isReceiptReviewUpload = _wk\.isReceiptKind\(_wkUp\);/.test(dg)
    && /if \(!\(\(_isQnaUpload \|\| _isBookingUpload \|\| _isReceiptReviewUpload\) && _slotRole === 'review'\)\) verdict = await verifyCapture\(\{/.test(dg)
    && /\} catch \(_\) \{ _isQnaUpload = false; _isBookingUpload = false; _isReceiptReviewUpload = false; \}/.test(dg));
  t('★★ 이름 축 분리: 업로드의 `_isReceiptUpload` 는 그대로 **현금영수증 칸** 판정(isCashReceiptSlot) · 종류 판정은 다른 이름',
    /const _isReceiptUpload = isCashReceiptSlot\(/.test(dg) && (dg.match(/_isReceiptUpload = /g) || []).length === 1
    && /const _slotRole = _isReceiptUpload \? 'receipt' : slot;/.test(dg));
  t('★★ 업로드 검수 파일이 실제로 읽힌다(같은 이름 두 번 선언 같은 문법 오류 없음 — 문자열 검사만으로는 못 잡는다)', (() => {
    delete require.cache[require.resolve('../src/routes/diag.routes')];
    const p0 = require('../src/db/pool'), q0 = p0.query;
    p0.query = async () => ({ rows: [] });   // 파일을 읽을 때 도는 칸 보강(ALTER)이 실제 DB 로 가지 않게
    let r;
    try { r = require('../src/routes/diag.routes'); } finally { setTimeout(() => { p0.query = q0; }, 50); }
    return !!(r && r.stack && r.stack.some(l => l.route && l.route.path === '/review-upload'));
  })());

  /* ── 5) 프론트 사본 ≡ 서버 ─────────────────────────────────────── */
  console.log('\n5) 프론트 사본 ≡ 서버');
  const P = require('../src/utils/woCampaignPrefill.generated');
  const samples = ['', 'review', 'blog', 'qna', 'booking', '네이버예약리뷰', '예약리뷰', 'BOOKING', '네이버 블로그 영수증리뷰', 'Q&A 영수증리뷰',
    '예약리뷰 영수증리뷰', '리뷰체험단', 'Q&A체험단', ...RECEIPT_SAMPLES, ...CASH_RECEIPT_SAMPLES];
  for (const v of samples) {
    t(`★★ 판정 일치: ${JSON.stringify(v)}`, P._woIsReceiptKind(v) === WK.isReceiptKind(v) && P._woIsBookingKind(v) === WK.isBookingKind(v)
      && P._woIsQnaKind(v) === WK.isQnaKind(v) && P._woIsBlogKind(v) === (String(v).trim() !== '' && WK.isBlogKind(v)));
  }
  t('★★ 프론트 사본의 영수증리뷰 표기 규칙 = 서버 RECEIPT_PATTERN·CASH_RECEIPT_WORDS 글자 그대로(표본에 없는 갈래까지 잠금)', (() => {
    const lit = mPat[1] + '.test(v.replace(' + mCash[1] + ", ' '))";
    return P._woIsReceiptKind.toString().includes(lit) && F('js/work-order-detail.js').includes(lit);
  })());
  t('★★ 영수증리뷰 오더는 리뷰타입을 프리필하지 않고 종류를 지킨다', (() => {
    const out = P._woCampaignPrefill({ work_kind: 'receipt', review_type: '포토', review_type_mix: [{ type: 'photo', count: 3 }] });
    return out.review_type === '' && Array.isArray(out.review_type_mix) && out.review_type_mix.length === 0 && out.work_kind === 'receipt';
  })());
  t('리뷰·현금영수증 리뷰 오더는 종전대로 리뷰타입을 넘긴다', P._woCampaignPrefill({ work_kind: 'review', review_type: '포토' }).review_type === '포토'
    && P._woCampaignPrefill({ work_kind: '현금영수증 리뷰', review_type: '포토' }).review_type === '포토');

  const wodSrc = F('js/work-order-detail.js');
  const wodCtx = {};
  vm.createContext(wodCtx);
  const grab = (src, name) => { const i = src.indexOf('function ' + name + '('); assert(i >= 0, name); let d = 0, j = src.indexOf('{', i);
    for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
  vm.runInContext(wodSrc.match(/const WO_KIND_LABELS = \{[^}]*\};/)[0].replace('const ', 'var ')
    + grab(wodSrc, '_woIsBlogKind') + grab(wodSrc, '_woIsQnaKind') + grab(wodSrc, '_woIsBookingKind') + grab(wodSrc, '_woIsReceiptKind')
    + grab(wodSrc, '_woHasNoReviewType') + grab(wodSrc, '_woWorkKindLabel'), wodCtx);
  t('상세 라벨: receipt → 영수증리뷰 · 현금영수증 리뷰 → 리뷰체험단 · 나머지 불변', wodCtx._woWorkKindLabel('receipt') === '영수증리뷰'
    && wodCtx._woWorkKindLabel('영수증 인증 리뷰') === '영수증리뷰' && wodCtx._woWorkKindLabel('현금영수증 리뷰') === '리뷰체험단'
    && wodCtx._woWorkKindLabel('booking') === '네이버예약리뷰' && wodCtx._woWorkKindLabel('qna') === 'Q&A체험단'
    && wodCtx._woWorkKindLabel('') === '' && wodCtx._woWorkKindLabel('blog') === '블로그체험단' && wodCtx._woWorkKindLabel('review') === '리뷰체험단');
  t('리뷰타입 없는 종류에 receipt 포함(블로그·Q&A·예약리뷰 그대로) · 현금영수증 리뷰는 리뷰타입 있음', wodCtx._woHasNoReviewType('receipt')
    && wodCtx._woHasNoReviewType('blog') && wodCtx._woHasNoReviewType('qna') && wodCtx._woHasNoReviewType('booking')
    && !wodCtx._woHasNoReviewType('review') && !wodCtx._woHasNoReviewType('') && !wodCtx._woHasNoReviewType('현금영수증 리뷰'));
  t('★ 라벨 표 = 서버 WORK_KINDS(키·라벨 전부)', WK.WORK_KINDS.every(k => wodCtx.WO_KIND_LABELS[k.key] === k.label)
    && Object.keys(wodCtx.WO_KIND_LABELS).length === WK.WORK_KINDS.length);
  t('★ 판정을 전역에 노출(사본 대신 이것을 쓰게)', /_woIsReceiptKind: _woIsReceiptKind/.test(wodSrc));

  /* ── 6) 발행 폼 — receipt 를 리뷰로 접지 않는다 ─────────────────── */
  console.log('\n6) 발행 폼 프리필');
  const ir = F('js/index-recruit.js');
  const irCtx = {};
  vm.createContext(irCtx);
  vm.runInContext(grab(ir, '_rfPrefillWorkKind'), irCtx);
  t('★★ 프리필: receipt·booking·qna·blog 는 그대로, 나머지는 리뷰(빈 값)', irCtx._rfPrefillWorkKind('receipt') === 'receipt'
    && irCtx._rfPrefillWorkKind('booking') === 'booking' && irCtx._rfPrefillWorkKind('qna') === 'qna' && irCtx._rfPrefillWorkKind('blog') === 'blog'
    && irCtx._rfPrefillWorkKind('review') === '' && irCtx._rfPrefillWorkKind('') === '' && irCtx._rfPrefillWorkKind(undefined) === '');
  t('★ 발행 폼: receipt 는 리뷰타입 카드를 숨기고 저장 때 비운다',
    /const noReviewType = isBlog \|\| _kind === "qna" \|\| _kind === "booking" \|\| _kind === "receipt";/.test(ir)
    && /if \(payload\.work_kind === "blog" \|\| payload\.work_kind === "qna" \|\| payload\.work_kind === "booking" \|\| payload\.work_kind === "receipt"\) \{\s*payload\.review_type = "";/.test(ir));

  /* ── 7) 구매·배송 전제 기능 제외 · 막다른 길 ─────────────────── */
  console.log('\n7) 구매 전제 기능 제외 · 막다른 길');
  const qtSvc = require('../src/services/campaignQtyTiers.service');
  t('인당 구매수량 단계 복사 제외(실행 — 판정 단일 출처 copiesFor)', qtSvc.copiesFor('receipt') === false && qtSvc.copiesFor('영수증리뷰') === false
    && qtSvc.copiesFor('booking') === false && qtSvc.copiesFor('qna') === false && qtSvc.copiesFor('blog') === false
    && qtSvc.copiesFor('review') === qtSvc.copiesFor('') && qtSvc.copiesFor('현금영수증 리뷰') === qtSvc.copiesFor(''));
  const sh = S('src/services/campaignShortage.service.js');
  t('미달 연장 팝업 제외(후보 SQL 1곳 + 잠금 재확인·공고>탭 판정 includes 2곳)', /NOT IN \('blog','qna','booking','receipt'\)/.test(sh)
    && /const NO_DAILY_CARRY_KINDS = \['blog', 'qna', 'booking', 'receipt'\];/.test(sh)
    && (sh.match(/NO_DAILY_CARRY_KINDS\.includes\(/g) || []).length === 2);
  t('작업보드 「＋ 블로거 추가」: receipt 작업에는 안 보인다(서버가 blog 아님으로 거부하는 버튼)',
    /\['review', 'qna', 'booking', 'receipt'\]\.includes\(String\(t\.workKind \|\| ''\)\)\) return false;/.test(F('workdesk.html')));
  t('광고주 포털 작업 종류: 영수증리뷰 체험단', /order\.work_kind === 'receipt' \? '영수증리뷰 체험단'/.test(S('src/services/advertiserProjection.service.js')));
  t('동시진행 설정은 일반 리뷰 작업만 받는다(허용 목록에 receipt 없음 — 종전 규칙 그대로)',
    /if \(state\.work_kind !== undefined && !\['', 'review', '리뷰'\]\.includes\(state\.work_kind\)\) fail\(/.test(S('src/services/dualChannelSettings.service.js')));
  const pay = S('src/services/payment.service.js');
  t('입금: receipt 는 Q&A 참여비·예약리뷰 갈래에 들어가지 않는다(5단계 전까지 종전 = 상품값 없으면 no_price 로 멈춤 · 터지지 않음)',
    WK.resolveWorkKind({ campaignKind: 'receipt' }) !== 'qna' && WK.resolveWorkKind({ campaignKind: 'receipt' }) !== 'booking'
    && /const isQna = resolveWorkKind\(\{ campaignKind: camp && camp\.workKind, tabKind: tab && tab\.workKind \}\) === 'qna';/.test(pay)
    && /resolveWorkKind\(\{ campaignKind: camp && camp\.workKind, tabKind: tab && tab\.workKind \}\) === 'booking'/.test(pay));
  t('예약리뷰 입금 판정은 예약 오더만(receipt 를 bookingPayoutOf 에 넣지 않는다)', (() => {
    const { bookingPayoutOf } = require('../src/services/payment.service');
    return typeof bookingPayoutOf === 'function' && bookingPayoutOf({ isBooking: false, place: null, payoutMode: '', productPrice: 0, reservationNo: '' }) === null;
  })());

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch(e => { console.error('\n❌ ' + (e && e.stack || e)); process.exit(1); });
