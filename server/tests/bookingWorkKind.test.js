/**
 * bookingWorkKind.test.js — 네이버예약리뷰 1단계 회귀가드 (작업유형 축 `work_kind` 네 번째 값 `booking`, 결정 404)
 * 실행: node tests/bookingWorkKind.test.js
 *
 * 이 변경의 위험은 다섯이다.
 *  ① **기존 데이터 재분류** — 운영 저장값은 `''`·`review`·`blog`·`qna` 뿐이다(2026-11-23 읽기 조회).
 *     이 넷과 사람이 적은 리뷰·블로그·Q&A 표기의 판정이 한 글자도 바뀌면 안 된다 — booking 은 「모르면 리뷰」로
 *     떨어지던 자리에서만 가져온다(블로그·Q&A 답은 절대 안 뺏는다).
 *  ② **조용한 강등** — booking 이 어디선가 review 로 접히면 매장 방문 작업에 구매양식·상품 리뷰 검수가 붙는다.
 *  ③ **반쪽 접수** — 2~5단계(날짜 자리표·리뷰어 화면·검수·입금)가 없는 동안 booking 오더·공고가 저장되면
 *     상품 리뷰 작업보드가 깔린다. 저장 입구 5곳은 **아무것도 쓰기 전에** `work_kind_not_ready` 로 거절한다(fail-closed).
 *  ④ **검수 차단** — 결과물이 상품 리뷰 화면이 아니라 AI 상품 리뷰 판정이 정상 제출을 잠그면 안 된다.
 *  ⑤ **판정 사본** — 서버 `isBookingKind` 와 프론트 `_woIsBookingKind` 가 같은 표기에 다른 답을 내면 갈라진다.
 *
 * ★ 순수함수·라우트 처리기는 실제로 실행해 검증한다(문자열 존재만 보는 grep 은 실행경로를 못 본다).
 *   라우트는 DB 를 메모리 대역으로 바꾸고, 쓰기를 시도하면 그 자체로 실패로 센다(실제 접속 0).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.ORDER_INTAKE_KEY = process.env.ORDER_INTAKE_KEY || 'booking-local-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'booking-local-jwt';

const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

/** 결정 404 이전의 판정 규칙(글자 그대로 얼려 둔 사본) — 기존 답이 안 바뀌었는지 대조하는 기준. */
function legacyNormalize(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'review';
  if (['review', 'blog', 'qna'].includes(s)) return s;
  if (/블로그|blog/i.test(s)) return 'blog';
  if (/q\s*[&\/]\s*a|\bqna\b|큐앤에이|문의\s*등록/i.test(s)) return 'qna';
  return 'review';
}

(async () => {
  console.log('\n▶ 네이버예약리뷰 1단계 — 작업유형 축(work_kind=booking) 회귀가드\n');

  const WK = require('../src/utils/workKind');

  /* ── 1) 판정 단일 출처 ─────────────────────────────────────────── */
  console.log('1) 판정 단일 출처');
  t('표준 목록에 booking = 네이버예약리뷰 (기존 셋은 순서·라벨 그대로)', WK.WORK_KINDS.some(k => k.key === 'booking' && k.label === '네이버예약리뷰')
    && JSON.stringify(WK.WORK_KINDS.slice(0, 3)) === JSON.stringify([
      { key: 'review', label: '리뷰체험단' }, { key: 'blog', label: '블로그체험단' }, { key: 'qna', label: 'Q&A체험단' }]));
  t('라벨 조회', WK.workKindLabel('booking') === '네이버예약리뷰');
  t('★★ 운영 저장값 4종의 판정 불변', ['', 'review', 'blog', 'qna'].every(v => WK.normalizeWorkKind(v) === legacyNormalize(v)
    && WK.workKindForStore(v) === v && !WK.isBookingKind(v)));
  for (const v of ['booking', 'BOOKING', '네이버예약리뷰', '네이버 예약 리뷰', '네이버예약 리뷰', '예약자 리뷰', '예약자리뷰', '예약리뷰', '네이버  예약리뷰', 'naver booking review']) {
    t(`예약리뷰 표기 → booking: ${v}`, WK.normalizeWorkKind(v) === 'booking' && WK.workKindForStore(v) === 'booking' && WK.isBookingKind(v));
  }
  for (const v of ['예약', '예약구매', '사전예약', '예약 리뷰', '사전예약 리뷰체험단', '예약 구매 리뷰', '예약판매 상품 리뷰', 'rebooking', 'bookings', '리뷰체험단', '리뷰', '영수증리뷰', '방문리뷰', null, undefined, '']) {
    t(`예약리뷰 아님 → 종전 판정: ${v}`, !WK.isBookingKind(v) && WK.normalizeWorkKind(v) === legacyNormalize(v));
  }
  t('★ 블로그를 먼저 본다(블로그 표기에 예약리뷰가 섞여도 blog)', WK.normalizeWorkKind('네이버 블로그 예약리뷰') === 'blog');
  t('★ Q&A 다음에 본다(Q&A 표기에 예약리뷰가 섞여도 qna)', WK.normalizeWorkKind('Q&A 예약리뷰') === 'qna');
  // ★★ 넓은 표본 대조 — booking 은 「모르면 리뷰」 자리에서만 가져온다(블로그·Q&A 답을 뺏으면 실패)
  const wide = ['', ' ', 'review', 'blog', 'qna', '리뷰체험단', '블로그체험단', 'Q&A체험단', '블로그', 'BLOG', '네이버 블로그 체험단', 'Q/A등록작업',
    'QnA', 'Q & A', '문의 등록', '큐앤에이', 'quality', 'aqua', 'QA', '포토', '아무거나', '예약', '사전예약 리뷰체험단', '블로그 예약리뷰',
    'Q&A 예약자 리뷰', '네이버예약리뷰', 'booking', '예약리뷰 블로그', '문의등록 booking', 'x'];
  t('★★ 넓은 표본: 종전 답과 같거나, 종전 review → booking 만', wide.every(v => {
    const now = WK.normalizeWorkKind(v), old = legacyNormalize(v);
    return now === old || (old === 'review' && now === 'booking');
  }));
  t('공고 > 탭 우선순위에 booking 도 그대로', WK.resolveWorkKind({ campaignKind: 'booking', tabKind: 'review' }) === 'booking'
    && WK.resolveWorkKind({ campaignKind: '', tabKind: 'booking' }) === 'booking'
    && WK.resolveWorkKind({ campaignKind: 'review', tabKind: 'booking' }) === 'review');
  t('★ 공유필드 정규화(CANON)도 booking 을 지킨다', require('../src/utils/sharedFields').CANON.workKind('booking') === 'booking');
  t('★ 예약리뷰 표기 규칙은 확실한 표기만(맨 「예약」 금지)', (() => {
    const m = S('src/utils/workKind.js').match(/const BOOKING_PATTERN = (\/.*\/i);/);
    return !!m && !new RegExp(m[1].slice(1, -2), 'i').test('예약') && !new RegExp(m[1].slice(1, -2), 'i').test('예약구매');
  })());

  /* ── 2) 아직 준비 안 됨 — 저장 입구 fail-closed ─────────────────── */
  console.log('\n2) 아직 준비 안 됨 — 저장 입구에서 거절(아무것도 쓰지 않음)');
  t('준비 판정: booking 만 막고 나머지는 연다', !WK.isWorkKindReady('booking') && !WK.isWorkKindReady('네이버예약리뷰')
    && ['', null, undefined, 'review', 'blog', 'qna', '리뷰체험단', '아무거나'].every(v => WK.isWorkKindReady(v)));
  const nr = WK.workKindNotReadyBody('booking');
  t('거절 본문: 코드 work_kind_not_ready · 칸 work_kind · 한국어 안내(무엇을 하면 되는지)', nr.ok === false && nr.code === 'work_kind_not_ready'
    && JSON.stringify(nr.blocked_fields) === '["work_kind"]' && /네이버예약리뷰/.test(nr.error) && /저장하지 않았/.test(nr.error) && /바꿔/.test(nr.error));
  t('인트라넷이 거절 코드를 그대로 받는 모양(소문자·숫자·밑줄 64자 이하)', /^[a-z0-9_]{1,64}$/.test(nr.code));

  const pool = require('../src/db/pool');
  const origQuery = pool.query, origConnect = pool.connect;
  const orders = require('../src/routes/order.routes');
  const campaigns = require('../src/routes/campaign.routes');
  const route = (router, method, p) => {
    const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    assert.ok(layer, '실제 처리기 경로: ' + p);
    return layer.route.stack.at(-1).handle;
  };
  const current = { id: 'wo-booking-local', title: '가짜 오더', status: 'submitted', deleted_at: null, work_kind: '',
    product_options_json: '', linked_campaign_id: '', linked_tab_name: '', linked_tab_gid: '', source_review_order_id: 'ro_booking_local',
    recruit_count: 3, daily_count: 1, pay_amount: 0, memo_log: '[]', workboard_schema_version: 1, bidir_state: 'off' };
  const source = { source_system: 'inadd_intranet', source_review_order_id: 'ro_booking_local', source_revision: 2,
    idempotency_key: 'ro_booking_local:2:test' };
  async function call(handler, body, params = {}) {
    const writes = [];
    pool.query = async (sql) => {
      const s = String(sql);
      if (/^\s*(CREATE|ALTER)\b/i.test(s)) return { rows: [] };           // 런타임 스키마 보강은 실제로 하지 않는다
      if (/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(s)) { writes.push(s); throw new Error('업무 데이터를 쓰려고 했습니다'); }
      if (/FROM work_orders/i.test(s)) return { rows: [{ ...current }] };
      return { rows: [] };
    };
    pool.connect = async () => { writes.push('connect'); throw new Error('쓰기 연결을 열려고 했습니다'); };
    const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
    let thrown = null;
    try {
      await handler({ body: { title: '가짜 오더', ...body }, params: { id: current.id, sourceReviewOrderId: 'ro_booking_local', ...params }, query: {},
        headers: { 'x-intake-key': process.env.ORDER_INTAKE_KEY }, admin: { name: '로컬 검사', role: 'admin' } }, res, e => { thrown = e; });
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
  try {
    for (const kind of ['booking', '네이버예약리뷰']) {
      t(`★★ 인트라넷 새 오더(${kind}) → 409 work_kind_not_ready · 쓰기 0`, refused(await call(intake, { ...source, source_revision: 1, idempotency_key: 'ro_booking_local:1:t', work_kind: kind })));
      t(`★★ 출처 계약 없는 옛 새 오더(${kind}) → 거절 · 쓰기 0`, refused(await call(intake, { work_kind: kind })));
      t(`★★ 인트라넷 원본 수정(${kind}로 바꾸기) → 거절 · 쓰기 0(종류 바꾸기 접수 되돌리기보다 먼저)`, refused(await call(revision, { ...source, work_kind: kind })));
      t(`★ 옛 수정 두 경로(${kind}) → 거절 · 쓰기 0`, refused(await call(legacyUpdate, { work_kind: kind })) && refused(await call(legacyPut, { work_kind: kind })));
      t(`★★ 관리자 공고 만들기(${kind}) → 거절 · 쓰기 0`, refused(await call(campCreate, { title: '가짜 공고', work_kind: kind })));
      t(`★★ 관리자 공고 고치기(${kind}로 바꾸기) → 거절 · 쓰기 0`, refused(await call(campUpdate, { work_kind: kind }, { id: 'camp-local' })));
    }
    // 대조군 — 막는 문이 다른 종류까지 막지 않는다(게이트를 지나 다음 단계로 간다)
    const passIntake = await call(intake, { work_kind: 'review' });
    t('대조군: 리뷰 새 오더는 문을 지나 저장까지 간다(쓰기 시도 = 게이트 통과)', passIntake.writes.some(w => /INSERT INTO work_orders/.test(w)));
    const passIntakeQna = await call(intake, { work_kind: 'qna' });
    t('대조군: Q&A·빈 값 새 오더도 문을 지난다', passIntakeQna.writes.some(w => /INSERT INTO work_orders/.test(w))
      && (await call(intake, {})).writes.some(w => /INSERT INTO work_orders/.test(w)));
    const passUpd = await call(campUpdate, { title: '가짜 공고' }, { id: 'camp-local' });
    t('대조군: 종류를 안 보낸 공고 고치기는 이 문에 안 걸린다', !(passUpd.res.body && passUpd.res.body.code === 'work_kind_not_ready'));
    const passCreate = await call(campCreate, { title: '가짜 공고', work_kind: 'blog' });
    t('대조군: 블로그 공고 만들기는 이 문에 안 걸린다', !(passCreate.res.body && passCreate.res.body.code === 'work_kind_not_ready'));
  } finally {
    pool.query = origQuery; pool.connect = origConnect;
  }
  const ord = S('src/routes/order.routes.js');
  t('★ 원본 수정의 거절은 종류 바꾸기(결정 332 — 작업표 삭제)보다 앞', ord.indexOf('workKindNotReadyBody(b.work_kind)', ord.indexOf('async function _intakeSourceRevisionHandler'))
    < ord.indexOf('결정 332 — 접수된 리뷰↔블로그 오더의 종류 바꾸기'));
  const cr = S('src/routes/campaign.routes.js').split(String.fromCharCode(0)).join('');
  t('★ 신청(참여) 문도 잠금·자리 잡기 전에 거절(안전벨트 — 1단계엔 booking 공고가 생길 수 없다)',
    /if \(!isWorkKindReady\(_kind\)\) \{\s*return res\.status\(409\)\.json\(\{ ok: false, reason: 'work_kind_not_ready'/.test(cr)
    && cr.indexOf("reason: 'work_kind_not_ready'") < cr.indexOf('const client = await pool.connect();', cr.indexOf("reason: 'work_kind_not_ready'") - 4000)
    && cr.indexOf("reason: 'work_kind_not_ready'") > cr.indexOf('let qnaApply = false;'));

  /* ── 3) 검수 격리 ──────────────────────────────────────────────── */
  console.log('\n3) 검수 격리');
  const inspect = require('../src/services/reviewInspect.service');
  const otherShot = { kind: 'other', confidence: 0.95 };
  t('★★ 1차 필터: booking 은 잠그지 않는다(skip booking_tab)', (() => {
    const v = inspect.precheckPolicy({ classified: otherShot, slotKey: 'review', workKind: 'booking' });
    return v.verdict === 'skip' && v.code === 'booking_tab' && v.blockable === false;
  })());
  t('블로그·Q&A 안전핀은 그대로', inspect.precheckPolicy({ classified: otherShot, workKind: 'blog' }).code === 'blog_tab'
    && inspect.precheckPolicy({ classified: otherShot, workKind: 'qna' }).code === 'qna_tab');
  t('미지정·리뷰는 종전 경로(skip 아님 — 잠글 수 있다)', inspect.precheckPolicy({ classified: otherShot, workKind: null }).verdict === 'block'
    && inspect.precheckPolicy({ classified: otherShot, workKind: 'review' }).verdict === 'block');
  const isrc = S('src/services/reviewInspect.service.js');
  t('2차: 형식·상품명·본문겹침 skip 갈래에 booking 포함 · 같은 파일 검사는 갈래 밖',
    /const _isBlogTab = exp\.workKind === 'blog' \|\| exp\.workKind === 'qna' \|\| exp\.workKind === 'booking';/.test(isrc)
    && /reason: exp\.workKind === 'qna' \? 'qna_tab' : exp\.workKind === 'booking' \? 'booking_tab' : 'blog_tab'/.test(isrc)
    && /checks\.duplicate = await classifyDuplicateContext\(\{\n\s*dup: await findDuplicate\(/.test(isrc));
  const dg = S('src/routes/diag.routes.js');
  t('★★ 업로드 검수: booking 탭의 리뷰 칸도 형식 판정·자동 이동·불일치 알림을 만들지 않는다',
    /_isBookingUpload = _wk\.isBookingKind\(_wkUp\);/.test(dg)
    && /if \(!\(\(_isQnaUpload \|\| _isBookingUpload\) && _slotRole === 'review'\)\) verdict = await verifyCapture\(\{/.test(dg)
    && /\} catch \(_\) \{ _isQnaUpload = false; _isBookingUpload = false; \}/.test(dg));

  /* ── 4) 프론트 사본 ≡ 서버 ─────────────────────────────────────── */
  console.log('\n4) 프론트 사본 ≡ 서버');
  const P = require('../src/utils/woCampaignPrefill.generated');
  const samples = ['', 'review', 'blog', 'qna', 'booking', '네이버예약리뷰', '네이버 예약 리뷰', '예약자 리뷰', '예약리뷰', 'BOOKING',
    '예약', '예약구매', 'rebooking', '네이버 블로그 예약리뷰', 'Q&A 예약리뷰', '리뷰체험단', 'Q&A체험단'];
  for (const v of samples) {
    t(`★★ 판정 일치: ${JSON.stringify(v)}`, P._woIsBookingKind(v) === WK.isBookingKind(v) && P._woIsQnaKind(v) === WK.isQnaKind(v)
      && P._woIsBlogKind(v) === (v !== '' && WK.isBlogKind(v)));
  }
  t('★★ 프론트 사본의 예약리뷰 표기 규칙 = 서버 BOOKING_PATTERN 글자 그대로(표본에 없는 갈래까지 잠금)', (() => {
    const src = S('src/utils/workKind.js').match(/const BOOKING_PATTERN = (\/.*\/i);/);
    return !!src && P._woIsBookingKind.toString().includes(src[1] + '.test(v)')
      && F('js/work-order-detail.js').includes(src[1] + '.test(v)');
  })());
  t('★★ 예약리뷰 오더는 리뷰타입을 프리필하지 않고 종류를 지킨다', (() => {
    const out = P._woCampaignPrefill({ work_kind: 'booking', review_type: '포토', review_type_mix: [{ type: 'photo', count: 3 }] });
    return out.review_type === '' && Array.isArray(out.review_type_mix) && out.review_type_mix.length === 0 && out.work_kind === 'booking';
  })());
  t('리뷰 오더는 종전대로 리뷰타입을 넘긴다', P._woCampaignPrefill({ work_kind: 'review', review_type: '포토' }).review_type === '포토');

  const wodSrc = F('js/work-order-detail.js');
  const wodCtx = {};
  vm.createContext(wodCtx);
  const grab = (src, name) => { const i = src.indexOf('function ' + name + '('); assert(i >= 0, name); let d = 0, j = src.indexOf('{', i);
    for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
  vm.runInContext(wodSrc.match(/const WO_KIND_LABELS = \{[^}]*\};/)[0].replace('const ', 'var ')
    + grab(wodSrc, '_woIsBlogKind') + grab(wodSrc, '_woIsQnaKind') + grab(wodSrc, '_woIsBookingKind') + grab(wodSrc, '_woWorkKindLabel'), wodCtx);
  t('상세 라벨: booking → 네이버예약리뷰 · 나머지 불변', wodCtx._woWorkKindLabel('booking') === '네이버예약리뷰'
    && wodCtx._woWorkKindLabel('예약자 리뷰') === '네이버예약리뷰' && wodCtx._woWorkKindLabel('qna') === 'Q&A체험단'
    && wodCtx._woWorkKindLabel('') === '' && wodCtx._woWorkKindLabel('blog') === '블로그체험단' && wodCtx._woWorkKindLabel('review') === '리뷰체험단');
  t('★ 판정을 전역에 노출(사본 대신 이것을 쓰게)', /_woIsBookingKind: _woIsBookingKind/.test(wodSrc));

  /* ── 5) 발행 폼 — booking 을 리뷰로 접지 않는다 ─────────────────── */
  console.log('\n5) 발행 폼 프리필');
  const ir = F('js/index-recruit.js');
  const irCtx = {};
  vm.createContext(irCtx);
  vm.runInContext(grab(ir, '_rfPrefillWorkKind'), irCtx);
  t('★★ 프리필: booking·qna·blog 는 그대로, 나머지는 리뷰(빈 값)', irCtx._rfPrefillWorkKind('booking') === 'booking'
    && irCtx._rfPrefillWorkKind('qna') === 'qna' && irCtx._rfPrefillWorkKind('blog') === 'blog'
    && irCtx._rfPrefillWorkKind('review') === '' && irCtx._rfPrefillWorkKind('') === '' && irCtx._rfPrefillWorkKind(undefined) === '');
  t('★ 발행 폼: booking 은 리뷰타입 카드를 숨기고 저장 때 비운다', /const noReviewType = isBlog \|\| _kind === "qna" \|\| _kind === "booking";/.test(ir)
    && /if \(payload\.work_kind === "blog" \|\| payload\.work_kind === "qna" \|\| payload\.work_kind === "booking"\) \{\s*payload\.review_type = "";/.test(ir));

  /* ── 6) 구매·배송 전제 기능 제외 · 막다른 길 ─────────────────── */
  console.log('\n6) 구매 전제 기능 제외 · 막다른 길');
  const qtSvc = require('../src/services/campaignQtyTiers.service');
  t('인당 구매수량 단계 복사 제외(실행 — 판정 단일 출처 copiesFor)', qtSvc.copiesFor('booking') === false && qtSvc.copiesFor('네이버예약리뷰') === false
    && qtSvc.copiesFor('qna') === false && qtSvc.copiesFor('blog') === false && qtSvc.copiesFor('review') === qtSvc.copiesFor(''));
  const sh = S('src/services/campaignShortage.service.js');
  t('미달 연장 팝업 제외(후보 SQL 1곳 + 잠금 재확인·공고>탭 판정 includes 2곳)', /NOT IN \('blog','qna','booking'\)/.test(sh)
    && /const NO_DAILY_CARRY_KINDS = \['blog', 'qna', 'booking'\];/.test(sh)
    && (sh.match(/NO_DAILY_CARRY_KINDS\.includes\(/g) || []).length === 2);
  t('작업보드 「＋ 블로거 추가」: booking 작업에는 안 보인다(서버가 blog 아님으로 거부하는 버튼)',
    /\['review', 'qna', 'booking'\]\.includes\(String\(t\.workKind \|\| ''\)\)\) return false;/.test(F('workdesk.html')));
  t('광고주 포털 작업 종류: 네이버예약리뷰 체험단', /order\.work_kind === 'booking' \? '네이버예약리뷰 체험단'/.test(S('src/services/advertiserProjection.service.js')));
  t('동시진행 설정은 일반 리뷰 작업만 받는다(허용 목록에 booking 없음 — 종전 규칙 그대로)',
    /if \(state\.work_kind !== undefined && !\['', 'review', '리뷰'\]\.includes\(state\.work_kind\)\) fail\(/.test(S('src/services/dualChannelSettings.service.js')));
  t('입금: booking 은 Q&A 참여비 갈래에 들어가지 않는다(5단계 전까지 종전 = 상품값 없으면 no_price 로 멈춤)',
    WK.resolveWorkKind({ campaignKind: 'booking' }) !== 'qna'
    && /const isQna = resolveWorkKind\(\{ campaignKind: camp && camp\.workKind, tabKind: tab && tab\.workKind \}\) === 'qna';/.test(S('src/services/payment.service.js')));

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch(e => { console.error('\n❌ ' + (e && e.stack || e)); process.exit(1); });
