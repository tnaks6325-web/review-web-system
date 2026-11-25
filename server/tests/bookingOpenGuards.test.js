/**
 * bookingOpenGuards.test.js — 네이버예약리뷰 개방(결정 414) 작은 회귀가드들.
 * 실행: node tests/bookingOpenGuards.test.js
 *
 *  ① 접수 뒤 잠금 판정(bookingLockedChanges) 표 — 무엇이 잠기고 무엇이 열리나 · 고친 결과가 계약을 깨면 막힘 · 이미 있던 사유로 영영 막지 않음.
 *  ② 잠금 판정 조회 실패 = 잠금(fail-closed) — 실제 원본 수정 처리기(자리표 조회가 터짐 → 409 · 쓰기 0).
 *  ③ 준비 중 장치는 다음 종류를 위해 그대로 — 목록에 넣으면 같은 거절 본문.
 *  ④ 구매수량 단계 거절 문구에 네이버예약리뷰.
 *  ⑤ 작업 카드 [공고 발행](실제 함수 실행) — 예약 오더면 원본 행(예약 안내 포함)으로 프리필 · 다른 종류는 종전 그대로.
 *  ⑥ 공고 수정 창 — 서버가 준 예약 안내(bookingSpec)를 종류 복원 **전에** 받아 카드가 「불러오지 못했습니다」가 되지 않는다.
 *  ⑦ 검색 색인 시작일 — 「이용일자」는 다른 날짜 칸이 없을 때만 · 정확한 이름만(기존 탭 판정 불변).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : '')); pass++; console.log('  ✓ ' + name); };
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const place = (over = {}) => ({ name: '가짜식당 강남점', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
  base: { pay: 25000, count: 6, daily: 0, review_type_mix: [] }, options: [],
  booking: { pay_mode: 'refund', dates: [{ date: '2026-12-04', count: 2 }, { date: '2026-12-05', count: 1 }, { date: '2026-12-07', count: 3 }], review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1' },
  ...over });
const WO = (mut, top = {}) => { const p = place(); if (mut) mut(p); return { id: 'wo1', work_kind: 'booking', workboard_schema_version: 2, recruit_count: 6, pay_amount: 150000, product_options_json: JSON.stringify([p]), ...top }; };

(async () => {
  console.log('\n▶ 네이버예약리뷰 개방 — 작은 회귀가드\n');
  /* ① 판정 표 */
  console.log('① 접수 뒤 잠금 판정 표');
  {
    const bc = require('../src/utils/bookingCalendar');
    const cur = WO();
    const L = (next) => bc.bookingLockedChanges(cur, next);
    const same = L(WO());
    t('같은 값 재전송 = 통과', same.locked.length === 0 && same.invalid.length === 0, same);
    const rev = v => (Array.isArray(v) ? v.map(rev) : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, rev(v[k])])) : v));
    t('키 순서만 다른 같은 값 = 통과', L({ ...cur, product_options_json: JSON.stringify([rev(place())]) }).locked.length === 0);
    t('★ 매장 주소만 바꿈 = 통과', L(WO(p => { p.booking.place_address = '다른 주소'; })).locked.length === 0);
    t('★ 예약 링크만 바꿈 = 통과', L(WO(p => { p.url = 'https://booking.naver.com/booking/6/bizes/1'; })).locked.length === 0);
    const payUp = L(WO(p => { p.base.pay = 27000; }, { pay_amount: 162000 }));
    t('★ 환급형 1인 결제금액·결제합계 바꿈 = 통과', payUp.locked.length === 0 && payUp.invalid.length === 0, payUp);
    t('★★ 날짜 바꿈 = dates', L(WO(p => { p.booking.dates[0].date = '2026-12-03'; })).locked.includes('dates'));
    t('★★ 날짜별 인원 옮김(합 그대로) = dates', L(WO(p => { p.booking.dates[0].count = 1; p.booking.dates[1].count = 2; })).locked.includes('dates'));
    const grow = L(WO(p => { p.booking.dates.push({ date: '2026-12-08', count: 1 }); p.base.count = 7; }, { recruit_count: 7 }));
    t('★★ 날짜 더하고 인원 늘림 = dates + total', grow.locked.includes('dates') && grow.locked.includes('total'), grow);
    t('★★ 진행 방식 바꿈 = pay_mode', L(WO(p => { p.booking.pay_mode = 'free'; p.base.pay = 0; }, { pay_amount: 0 })).locked.includes('pay_mode'));
    t('★★ 리뷰 마감 N일 바꿈 = review_deadline_days', L(WO(p => { p.booking.review_deadline_days = 7; })).locked.includes('review_deadline_days'));
    t('★★ 매장 이름 바꿈 = place_name', L(WO(p => { p.name = '가짜식당 역삼점'; })).locked.includes('place_name'));
    const two = L({ ...cur, product_options_json: JSON.stringify([place(), place({ name: '둘째 매장' })]) });
    t('★★ 매장 하나 더함 = place_shape(계약을 못 읽음 → 잠금)', two.locked.includes('place_shape'), two);
    t('★★ 총 모집만 바꿈 = total + 계약 깨짐(합 불일치)', (() => { const r = L({ ...cur, recruit_count: 7 }); return r.locked.includes('total') && r.invalid.length > 0; })());
    const freeCur = WO(p => { p.booking.pay_mode = 'free'; p.base.pay = 0; }, { pay_amount: 0 });
    const freePay = bc.bookingLockedChanges(freeCur, WO(p => { p.booking.pay_mode = 'free'; p.base.pay = 1000; }, { pay_amount: 6000 }));
    t('★★ 무료체험형에 결제금액 = 잠금 칸은 아니지만 계약이 깨짐(invalid)', freePay.locked.length === 0 && freePay.invalid.some(m => /무료체험형/.test(m)), freePay);
    const refundZero = L(WO(p => { p.base.pay = 0; }, { pay_amount: 0 }));
    t('★★ 환급형 1인 금액 0 = invalid(환급형은 금액 필요)', refundZero.invalid.some(m => /환급형/.test(m)), refundZero);
    const brokenCur = WO(p => { p.booking.review_deadline_days = 99; });
    const textOnly = bc.bookingLockedChanges(brokenCur, { ...brokenCur, special_notes: 'x' });
    t('★ 이미 있던 사유로는 글 칸 수정까지 막지 않는다(새로 깨진 사유만)', textOnly.invalid.length === 0 && textOnly.locked.length === 0, textOnly);
    t('열린 칸 목록 = 매장 주소 하나(넓히지 않는다)', JSON.stringify(bc.BOOKING_EDITABLE_AFTER_ACCEPT_KEYS) === JSON.stringify(['place_address']));
    const msg = bc.bookingLockMessage({ locked: ['dates', 'pay_mode'] });
    t('★ 문구: 무엇이 잠겼나 · 되돌려 저장 · 새 리뷰오더 · 추가 모집 없음 · 열린 칸', /날짜·날짜별 인원/.test(msg) && /진행 방식/.test(msg) && /되돌려 저장/.test(msg)
      && /새 리뷰오더로 접수/.test(msg) && /인원 늘리기·차수가 없습니다/.test(msg) && /매장 주소·네이버 예약 링크·1인 결제금액/.test(msg), msg);
    t('★★ 문구에 「추가 모집」이 없다(인트라넷이 그 말을 보면 Q&A 안내로 바꿔 보여 준다 — 예약리뷰엔 그 길이 없다)',
      !/추가 모집/.test(msg) && !/추가 모집/.test(bc.bookingLockMessage({ invalid: ['x'] })));
    t('문구(계약만 깨짐): 사유 + 고쳐서 다시 + 새 리뷰오더(인트라넷이 「작업보드에서 고쳐라」로 잘못 안내하지 않게)',
      /맞지 않아 저장하지 않았습니다/.test(bc.bookingLockMessage({ invalid: ['무료체험형은 결제금액이 0이어야 합니다.'] }))
      && /새 리뷰오더로 접수/.test(bc.bookingLockMessage({ invalid: ['x'] })));
    t('화면용 계약: 예약 아님 = 없음 · 예약 = 매장·날짜·잠금 사유 글', bc.bookingSpecForScreen({ work_kind: 'review' }) === undefined
      && bc.bookingSpecForScreen(cur).placeName === '가짜식당 강남점' && Array.isArray(bc.bookingSpecForScreen(cur).blockers));
  }

  /* ② 조회 실패 = 잠금(실제 원본 수정 처리기) */
  console.log('\n② 자리표 조회 실패 = 잠금(fail-closed)');
  {
    process.env.ORDER_INTAKE_KEY = 'k-test';
    const pool = require('../src/db/pool');
    const origQ = pool.query, origC = pool.connect;
    const orders = require('../src/routes/order.routes');
    const layer = orders.stack.find(l => l.route && l.route.path === '/intake/source/:sourceReviewOrderId' && l.route.methods.put);
    const handler = layer.route.stack.at(-1).handle;
    const cur = { ...WO(), id: 'wo-bk-g', title: '가짜', status: 'submitted', deleted_at: null, linked_campaign_id: '', linked_tab_name: '', linked_tab_gid: '',
      source_review_order_id: 'ro_bk_g', source_revision: 1, workboard_schema_version: 2, work_series_id: 'ro_bk_g', work_round: 1, bidir_state: 'off', memo_log: '[]' };
    const writes = [];
    pool.query = async (sql) => {
      const s = String(sql);
      if (/^\s*(CREATE|ALTER)\b/i.test(s)) return { rows: [] };
      if (/FROM booking_slots/i.test(s)) throw Object.assign(new Error('db down'), { code: '57P01' });
      if (/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(s)) { writes.push(s); throw new Error('쓰면 안 된다'); }
      if (/FROM work_orders/i.test(s)) return { rows: [{ ...cur }] };
      return { rows: [] };
    };
    pool.connect = async () => { writes.push('connect'); throw new Error('연결하면 안 된다'); };
    try {
      const p = place(); p.booking.dates[0].date = '2026-12-03';
      const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
      let thrown = null;
      await handler({ body: { title: '가짜', work_kind: 'booking', source_system: 'inadd_intranet', source_review_order_id: 'ro_bk_g', source_revision: 2,
        idempotency_key: 'ro_bk_g:2', workboard_schema_version: 2, work_series_id: 'ro_bk_g', work_round: 1, recruit_count: 6, pay_amount: 150000,
        product_options_json: JSON.stringify([p]) }, params: { sourceReviewOrderId: 'ro_bk_g' }, query: {}, headers: { 'x-intake-key': 'k-test' } }, res, e => { thrown = e; });
      t('★★ 접수 전(작업표 연결 없음)인데 자리표 조회가 터지면 = 잠금 409(모르는 채로 날짜를 바꾸지 않는다) · 쓰기 0',
        !thrown && res.statusCode === 409 && res.body && res.body.code === 'booking_calendar_locked' && writes.length === 0, { thrown: thrown && thrown.message, status: res.statusCode, body: res.body, writes });
    } finally { pool.query = origQ; pool.connect = origC; }
  }

  /* ③ 준비 중 장치 유지 */
  console.log('\n③ 준비 중 장치(다음 종류용)');
  {
    const wk = require('../src/utils/workKind');
    // 결정 418 — 목록에 영수증리뷰(receipt)가 들어갔다: 「booking 개방」 = 목록에 booking 없음(의미 불변)
    const shipped = wk.NOT_READY_WORK_KINDS.slice();
    t('★ 지금 목록에 booking 이 없다(booking 개방)', Array.isArray(wk.NOT_READY_WORK_KINDS) && !wk.NOT_READY_WORK_KINDS.includes('booking') && wk.isWorkKindReady('booking'));
    wk.NOT_READY_WORK_KINDS.push('booking');
    try {
      const body = wk.workKindNotReadyBody('booking');
      t('★ 목록에 넣으면 장치가 그대로 거절한다(판정 · 409 본문 · 한국어 안내)', wk.isWorkKindReady('booking') === false && body.code === 'work_kind_not_ready'
        && /네이버예약리뷰는 아직 리뷰웹에서 진행할 수 없습니다/.test(body.error));
    } finally { wk.NOT_READY_WORK_KINDS.length = 0; wk.NOT_READY_WORK_KINDS.push(...shipped); }
    const src = S('src/utils/workKind.js');
    const decl = src.match(/const NOT_READY_WORK_KINDS = \[([^\]]*)\];/);
    t('목록 선언은 배열 그대로 · booking 은 없다(장치 삭제 금지 · 결정 418 영수증리뷰는 들어갈 수 있다)', !!decl && !/booking/.test(decl[1]));
  }

  /* ④ 구매수량 단계 문구 */
  console.log('\n④ 구매수량 단계 거절 문구');
  {
    const { tierRejectText } = require('../src/services/qtyTiersEdit.service');
    t('★ kind_no_tiers 문구에 네이버예약리뷰(블로그·Q&A 그대로)', /블로그·Q&A·네이버예약리뷰 체험단은 구매수량 단계를 쓰지 않습니다/.test(tierRejectText('kind_no_tiers')), tierRejectText('kind_no_tiers'));
  }

  /* ⑤ 작업 카드 [공고 발행] — 실제 함수 실행 */
  console.log('\n⑤ 작업 카드 [공고 발행]');
  {
    const wd = F('workdesk.html');
    const cut = (name) => { const i = wd.indexOf('async function ' + name + '(') >= 0 ? wd.indexOf('async function ' + name + '(') : wd.indexOf('function ' + name + '(');
      assert(i >= 0, name + ' 없음'); return wd.slice(i, wd.indexOf('\n}\n', i) + 2); };
    const names = ['_cndPublish', '_cndPublishFullRow'];
    const code = names.filter(n => wd.includes('function ' + n + '(')).map(cut).join('\n');
    const calls = [];
    const summary = [
      { id: 'woB', title: '예약', recruitCount: 6, work_kind: 'booking' },
      { id: 'woR', title: '리뷰', recruitCount: 3, work_kind: '' },
    ];
    const full = [{ id: 'woB', title: '예약', recruit_count: 6, work_kind: 'booking', linked_tab_sheet_id: 's', linked_tab_name: '예약', booking_spec: { placeName: '가짜식당 강남점', total: 6 } }];
    const ctx = {
      STATE: { cur: { sheetId: 's', tabName: '예약', tabGid: '1' } },
      openRecruitModal: (id, prefill, woId) => { calls.push({ id, prefill: JSON.parse(JSON.stringify(prefill)), woId }); },
      _loadCampPerm: async () => true, _toast: () => {},
      _woIsBookingKind: v => String(v || '') === 'booking',
      _woCampaignPrefill: o => ({ work_kind: String(o.work_kind || ''), recruit_total: o.recruit_count || 0, linked_tab_name: o.linked_tab_name || '', ...(o.booking_spec ? { booking: o.booking_spec } : {}) }),
      api: async (p) => { if (p.startsWith('/api/trackb/work-orders/list')) { ctx.listCalls = (ctx.listCalls || 0) + 1; return { ok: true, data: full }; } return { ok: true, items: summary }; },
      encodeURIComponent,
    };
    vm.createContext(ctx);
    vm.runInContext(code + '\nthis._cndPublish = _cndPublish;', ctx);
    await ctx._cndPublish({ workOrderId: 'woB' });
    const b = calls.pop();
    t('★★ 예약 오더 = 원본 행으로 프리필(종류 booking · 예약 안내 · 총 모집 · 연결 작업)', b && b.prefill.work_kind === 'booking' && b.prefill.booking && b.prefill.booking.placeName === '가짜식당 강남점'
      && b.prefill.recruit_total === 6 && b.prefill.linked_tab_name === '예약' && b.woId === 'woB', b);
    const n0 = ctx.listCalls || 0;
    await ctx._cndPublish({ workOrderId: 'woR' });
    const r = calls.pop();
    t('★ 다른 종류 = 종전 그대로(요약 행 프리필 · 목록 API 안 부름)', r && r.prefill.work_kind === '' && r.prefill.recruit_total === 0 && !r.prefill.booking && (ctx.listCalls || 0) === n0, r);
    ctx.STATE.wo = null;
    ctx.api = async (p) => (p.startsWith('/api/trackb/work-orders/list') ? null : { ok: true, items: summary });
    ctx.STATE.wo = null;
    await ctx._cndPublish({ workOrderId: 'woB' });
    const f2 = calls.pop();
    t('★ 원본 행을 못 받으면 요약 행으로라도 예약 종류는 지킨다(리뷰 공고로 조용히 접히지 않음 · 카드는 「불러오지 못했습니다」)', f2 && f2.prefill.work_kind === 'booking' && !f2.prefill.booking, f2);
    t('서버 요약 행에 work_kind(값만)', /work_kind: r\.workKind \|\| ''/.test(S('src/services/trackB.service.js')));
  }

  /* ⑥ 공고 수정 창 */
  console.log('\n⑥ 공고 수정 창 예약 안내');
  {
    const ir = F('js/index-recruit.js');
    const at = ir.indexOf('window._rfBookingSpec = (json && json.bookingSpec');
    const kindRestore = ir.indexOf('{ const _wk = document.getElementById("rf_work_kind"); if (_wk) _wk.value = (c.work_kind === "blog")');
    t('★★ 편집 로드가 서버 예약 안내를 받는다 · 종류 복원(카드 그리기)보다 앞', at > 0 && kindRestore > at && kindRestore - at < 600, { at, kindRestore });
    const cr = S('src/routes/campaign.routes.js');
    t('서버: 관리자 상세에 bookingSpec(bookingSpecForScreen 단일 출처 · 연결 오더 조회는 그대로 한 번)', /bookingSpec = require\('\.\.\/utils\/bookingCalendar'\)\.bookingSpecForScreen\(wo\)/.test(cr)
      && /\.\.\.\(bookingSpec \? \{ bookingSpec \} : \{\}\)/.test(cr) && (cr.match(/linkedWorkOrderForCampaign\(rows\[0\]/g) || []).length === 1);
    t('목록 프리필도 같은 함수(사본 0)', /bookingSpecForScreen\(row\)/.test(S('src/routes/trackB.routes.js')));
  }

  /* ⑦ 검색 색인 시작일 */
  console.log('\n⑦ 검색 색인 시작일');
  {
    const { parseTabRows } = require('../src/services/columnResolver');
    const kw = { NAME_KEYWORDS: ['수취인', '이름'], SUBMIT_KEYWORDS: ['리뷰'], DATA_TAB_KEYWORDS: ['번호', '수취인'], SUBMITTED_VALUES: ['제출'] };
    const run = (headers, row) => { const meta = {}; parseTabRows([headers, row], 's', 't', '1', 'c', kw, null, meta); return meta.fields && meta.fields.start_date; };
    const bk = run(['번호', '이용일자', '상품', '예약번호', '리뷰마감일', '수취인', '리뷰'], ['1', '12 / 4 (금)', '가짜식당', 'R1', '12 / 7 (월)', '가짜', '']);
    t('★ 예약 작업표: 시작일 = 「이용일자」', bk && bk.header === '이용일자', bk);
    const rv = run(['번호', '구매일자', '이용일자', '수취인', '리뷰'], ['1', '8 / 7 (금)', '8 / 9 (일)', '가짜', '']);
    t('★ 구매일 칸이 있으면 그것이 이긴다(종전 그대로)', rv && rv.header === '구매일자', rv);
    const part = run(['번호', '이용일자메모', '수취인', '리뷰'], ['1', 'x', '가짜', '']);
    t('★ 이름이 정확히 「이용일자」일 때만(부분 일치 아님)', part && part.col === -1, part);
    const qna = run(['번호', '진행일자', '이용일자', '수취인', '리뷰'], ['1', '8 / 7 (금)', '8 / 9 (일)', '가짜', '']);
    t('Q&A 진행일자가 먼저(종전 그대로)', qna && qna.header === '진행일자', qna);
  }

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch(e => { console.error(e); process.exit(1); });
