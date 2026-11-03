/**
 * qnaReviewerFlow.test.js — Q&A체험단 3단계 회귀가드: 신청 때 자리 묶기·1시간/자정 기한·캡처 제출·일정 끝(결정 321)
 * 실행: node tests/qnaReviewerFlow.test.js
 *
 *  ① 기한 계산 — 신청 + 1시간과 그날 자정 중 빠른 쪽 · 23:50 부터 새 신청 막음(확정 7)
 *  ② 오늘 정원 = 자리표의 오늘 자리 수(공고·상품별) — 이월·순차진행 없음
 *  ③ 신청 분기 — 자리 묶기는 모든 게이트 뒤·INSERT 직후 UPDATE · 개수 단계·재구매 기간 건너뜀 · 같은 공고 재신청 막음(확정 3)
 *  ④ 인기 참여권 — Q&A 제출은 세지 않는다(확정 4) · 상품 바꾸기 막음
 *  ⑤ 제출 창구 — 기한 확인 뒤에만 장부를 쓰고, 그 자리 줄 번호로만 작업표에 쓴다
 *  ⑥ 일정 끝 — 순차진행 끝 창에 함께 뜨고, 추가 모집은 같은 공개 여부·문구 그대로 줄의 날짜만 옮긴다(확정 5)
 *  ⑦ 리뷰어 화면 — 캡처를 내기 전에는 완료 화면으로 넘어가지 않는다(홀드 보존)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const qna = require('../src/services/qnaSlots.service');
const st = require('../src/services/campaignState.service');

(async () => {
  console.log('\n▶ Q&A체험단 3단계 — 리뷰어 신청·제출\n');

  /* ── ① 기한 ─────────────────────────────────────────── */
  console.log('① 기한');
  const kst = s => new Date(Date.parse(s + '+09:00'));
  t('15:00 신청 → 16:00 마감', qna.qnaHoldExpiry(kst('2026-11-03T15:00:00')).toISOString() === kst('2026-11-03T16:00:00').toISOString());
  t('23:40 신청 → 그날 자정(00:00) 마감', qna.qnaHoldExpiry(kst('2026-11-03T23:40:00')).toISOString() === kst('2026-11-04T00:00:00').toISOString());
  t('23:49 는 아직 신청 가능', qna.qnaApplyClosed(kst('2026-11-03T23:49:59')) === false);
  t('23:50 부터 새 신청 막음', qna.qnaApplyClosed(kst('2026-11-03T23:50:00')) === true);
  t('00:00 이면 다시 열림(다음 날)', qna.qnaApplyClosed(kst('2026-11-04T00:00:00')) === false);
  t('마감 시각 = 그날 23:50', qna.qnaApplyCutoffAt(kst('2026-11-03T10:00:00')).toISOString() === kst('2026-11-03T23:50:00').toISOString());
  t('KST 날짜(UTC 자정 넘김 무관)', qna.kstDateStr(kst('2026-11-04T08:30:00')) === '2026-11-04');

  /* ── ② 오늘 정원 ─────────────────────────────────────────── */
  console.log('② 오늘 정원');
  const CAMP = { participation_mode: true, status: 'active', daily_limit: 20, recruit_total: 50, start_date: null,
    window_start: null, window_end: null, close_buffer_min: 10 };
  const base = { activeHolds: 0, todayActiveHolds: 0, submittedAll: 3, todaySubmitted: 0, submittedBeforeToday: 3 };
  const noon = kst('2026-11-03T12:00:00');
  const s1 = st.computeCampaignState(CAMP, { ...base, qnaToday: 8 }, noon);
  t('오늘 자리 8칸 → 오늘 정원 8(하루 인원 20 무시)', s1.dailyQuota === 8 && s1.state === 'open');
  t('이월 없음(carryAdded 0)', s1.carryAdded === 0);
  const s0 = st.computeCampaignState(CAMP, { ...base, qnaToday: 0 }, noon);
  t('오늘 자리 0칸 → 오늘 마감(daily_done)', s0.state === 'daily_done');
  const sLate = st.computeCampaignState(CAMP, { ...base, qnaToday: 8 }, kst('2026-11-03T23:55:00'));
  t('23:55 → 신청 마감(cutoff) · 사유 qna_day_closing', sLate.state === 'cutoff' && sLate.stateReason === 'qna_day_closing');
  const sPlain = st.computeCampaignState(CAMP, base, noon);
  t('★ Q&A 아님(qnaToday 없음) = 종전 정원 그대로', sPlain.dailyQuota === 20 && sPlain.state === 'open');
  const v = st.computeOptionView({ opt_key: 'A', recruit_total: 10, daily_limit: 5, status: 'active' }, { submitted: 1, todaySubmitted: 1 }, { state: 'open' }, { qnaTodaySlots: 2 });
  t('상품별: 오늘 자리 2칸 · 1명 사용 → 오늘 남은 1', v.todayRemaining === 1 && v.dailyLimit === 2);
  const v0 = st.computeOptionView({ opt_key: 'A', recruit_total: 10, daily_limit: 5, status: 'active' }, {}, { state: 'open' }, { qnaTodaySlots: 0 });
  t('오늘 자리 없는 상품 = 오늘 마감(today_done)', v0.status === 'today_done');
  const camp = S('src/services/campaignState.service.js');
  t('공고 정원 재료는 깔때기 맨 뒤에서 싣는다(066 쿼리 순서 계약 유지)',
    /_loadOptionDayCaps\(pool, ids, now\);[\s\S]{0,600}loadTodayByCampaign\(pool, ids, now\)[\s\S]{0,300}return out;/.test(camp));
  t('상품별 재료도 같은 단일 출처(loadTodayByCampaign)', /fetchOptionCountsBatch[\s\S]*loadTodayByCampaign\(db, ids, now\)/.test(camp));
  t('Q&A 는 순차진행 규칙을 쓰지 않는다', /if \(qnaToday\) return views;/.test(camp));

  // 선택지 키 ↔ 자리 단위(옵션 상품 = product_mode 'opt' — 자리표와 같은 기준 · ⑨)
  const wo = { product_options_json: JSON.stringify([
    { name: '벨벳틴 상품1', base: { count: 2, daily: 1 }, options: [] },
    { name: '양말', product_mode: 'opt', base: { count: 2 }, options: [{ label: '검정', option_1: { value: '검정' }, count: 1 }, { label: '흰색', option_1: { value: '흰색' }, count: 1 }] },
    { name: '모자', product_mode: 'opt', base: { count: 1 }, options: [{ label: '검정', option_1: { value: '검정' }, count: 1 }] },
  ]) };
  const m = qna.qnaOptKeyMap(wo);
  t('옵션 없는 상품 = 상품 이름 키', m.get('벨벳틴 상품1') === '벨벳틴 상품1');
  t('옵션 = 「상품 · 옵션」 단위', m.get('흰색') === '양말 · 흰색');
  t('다른 상품의 같은 옵션 이름은 상품 이름을 붙여 구분', m.get('양말 검정') === '양말 · 검정' && m.get('모자 검정') === '모자 · 검정');

  /* ── ③ 신청 분기 ─────────────────────────────────────────── */
  console.log('③ 신청 분기');
  const routes = S('src/routes/campaign.routes.js');
  const ap = routes.slice(routes.indexOf('async function _applyParticipation('), routes.indexOf("router.post('/:id/apply'"));
  t('23:50 확인은 잠금(pool.connect) 앞', ap.indexOf('qnaApplyClosed') > 0 && ap.indexOf('qnaApplyClosed') < ap.indexOf('pool.connect()'));
  t('개수 단계 건너뜀', /if \(!blogApply && !qnaApply\)/.test(ap));
  t('같은 공고 제출완료 = 막음(one_per_person) · 재구매 기간은 건너뜀',
    /if \(qnaApply && sameCampaignSubmittedAt\)[\s\S]{0,200}one_per_person/.test(ap) && /if \(!qnaApply\) try \{/.test(ap));
  const iBind = ap.indexOf('bindSlotForApply'), iIns = ap.indexOf('INSERT INTO campaign_applications');
  t('자리 묶기는 모든 게이트 뒤(인기 참여권 판정 뒤)·INSERT 앞', iBind > ap.indexOf('canUsePopularCredit') && iBind < iIns);
  t('작업표 잠금(camp_tab_daily) 뒤에서 묶는다', ap.indexOf('camp_tab_daily') < iBind);
  t('자리 없으면 막는다(fail-closed · qna_no_slot)', /if \(!qnaBind\)[\s\S]{0,120}qna_no_slot/.test(ap));
  t('INSERT 칸 목록은 그대로 — 뒤이은 UPDATE 로 qna_slot_id', /SET qna_slot_id = \$2 WHERE id = \$1/.test(ap)
    && !/INSERT INTO campaign_applications\s*\([^)]*qna_slot_id/.test(ap));
  t('기한 = qnaHoldExpiry(공고 TTL 대신)', /qnaApply \? qnaSlots\.qnaHoldExpiry\(now\)/.test(ap));
  t('한 자리에 둘 = 부분 유일 색인이 받친다(migration 211)',
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_apps_qna_slot[\s\S]*status IN \('applied', 'submitted'\)/.test(S('migrations/211_qna_applications.sql')));
  t('기동 필수 칸에 qna_slot_id', /\['campaign_applications', 'qna_slot_id'\]/.test(S('index.js')));
  // 자리 고르기 — 지난 홀드 정리 후 오늘 열린 빈 자리 앞부터, 잠금
  const calls = [];
  const fake = { query: async (sql, p) => { calls.push(sql); return /SELECT s\.id/.test(sql) ? { rows: [{ id: 7, seq: 3, unit_seq: 1, visibility: 'public', question_text: 'Q' }] } : { rows: [] }; } };
  const picked = await qna.pickSlotInTx(fake, { sheetId: 's', tabName: 't', unitKey: 'u', now: noon });
  t('지난 홀드를 먼저 expired 로(유일 색인이 살아 있다고 보지 않게)', /SET status = 'expired'/.test(calls[0]));
  t('오늘 · 열린 · 묶이지 않은 자리 · 공개 먼저 · unit_seq 순 · FOR UPDATE',
    /s\.slot_date = \$4::date AND s\.status = 'open'[\s\S]*NOT EXISTS[\s\S]*ORDER BY \(s\.visibility <> 'public'\), s\.unit_seq[\s\S]*FOR UPDATE OF s/.test(calls[1]) && picked.id === 7);
  t('공개 자리는 문구를, 비공개는 빈 문구를 내보낸다',
    qna.publicSlotView({ visibility: 'public', question_text: 'Q', slot_date: '2026-11-03' }).questionText === 'Q'
    && qna.publicSlotView({ visibility: 'private', question_text: 'X' }).questionText === '');

  /* ── ④ 인기 참여권 · 상품 바꾸기 ─────────────────────────── */
  console.log('④ 인기 참여권 · 상품 바꾸기');
  t('일반 참여 적립에서 Q&A 제외', /ca\.status = 'submitted'\s*\n\s*AND ca\.qna_slot_id IS NULL/.test(S('src/services/popularCredit.service.js')));
  t('상품 바꾸기 요청은 qna_option_locked', /qna_slot_id != null\)[\s\S]{0,200}qna_option_locked/.test(routes));
  t('참여 상세 — 자리 정보·캡처 여부를 싣고 상품 바꾸기 버튼 숨김', /qnaSlot = qnaSlots\.publicSlotView\(slot, app\.expires_at\)/.test(routes)
    && /qnaSlot\.captureDone = /.test(routes) && /options\.length >= 2 && !qnaSlot/.test(routes));

  /* ── ⑤ 제출 창구 ─────────────────────────────────────────── */
  console.log('⑤ 제출 창구');
  const sub = S('src/routes/submit.routes.js');
  const q = sub.slice(sub.indexOf("router.post('/qna'"), sub.indexOf("router.post('/order'"));
  t('리뷰어 세션 필수', /verifyReviewerSession\(req\.headers\['x-reviewer-token'\]\)/.test(q));
  t('기한(+30초 여유) 확인이 장부 쓰기보다 앞', q.indexOf("app.status !== 'applied' || !app.in_time") > 0
    && q.indexOf("app.status !== 'applied' || !app.in_time") < q.indexOf('createOrderLedgerEntry('));
  t('홀드 확정 실패(late)면 장부 줄 취소 · 기한 지남으로 응답', /holdResult !== 'confirmed'[\s\S]{0,300}deleted_at = NOW\(\)[\s\S]{0,1200}QNA_EXPIRED/.test(q));
  t('작업표는 그 자리 줄 번호로만(sheetRow: target.rowIndex)', /sheetRow: target\.rowIndex/.test(q));
  t('다른 주문이 앉은 줄은 덮지 않는다', /qna_row_taken/.test(q));
  t('다시 눌러도 같은 줄(이미 확정 = 줄만 다시 맞춤)', /holdCtx\.doneKind === 'confirmed'[\s\S]{0,1200}alreadySubmitted: true/.test(q));
  t('★ 구매양식(/order) 경로는 손대지 않는다 — 원장 변수 이름 겹침 없음(기존 순서 가드 보호)', !/const ledger = /.test(q));

  /* ── ⑥ 일정 끝 ─────────────────────────────────────────── */
  console.log('⑥ 일정 끝');
  const seqEnd = S('src/services/campaignSequentialEnd.service.js');
  t('순차진행 끝 창에 Q&A 항목을 합친다(kind: qna)', /_listQnaEnds\(admin, opts\)/.test(seqEnd) && /kind: 'qna'/.test(seqEnd));
  t('반영은 자리표 단일 출처(applyQnaEnd)로', /it\.kind === 'qna'[\s\S]{0,200}applyQnaEnd/.test(seqEnd));
  const qs = S('src/services/qnaSlots.service.js');
  t('추가 모집 = 그 줄의 진행일자만 옮긴다(새 줄·새 자리 없음 · 주문 붙은 줄 제외)',
    /UPDATE qna_slots SET slot_date = \$2::date, round = round \+ 1/.test(qs) && /order_submission_id IS NULL`/.test(qs) && !/appendSlot/.test(qs));
  t('같은 하루 건수 · 다음 영업일부터', /MAX\(n\)::int AS per/.test(qs) && /startDate: tomorrow/.test(qs));
  t('끝내기 = 못 채운 자리 닫음 + 공고 마감', /SET status = 'lapsed'/.test(qs) && /UPDATE recruit_campaigns SET status = 'closed'/.test(qs));
  t('작업표 기록과 같은 잠금 안에서 옮긴다(공고 잠금보다 먼저 잡는다 — ⑨)', /sheetless_worktable:\$\{pre\[0\]\.linked_sheet_id\}:\$\{pre\[0\]\.linked_tab_name\}/.test(qs));
  t('같은 일정 끝 추가 모집은 한 번만', /action = \$2 AND detail->>'end' = \$3/.test(qs));

  /* ── ⑦ 리뷰어 화면 ─────────────────────────────────────────── */
  console.log('⑦ 리뷰어 화면');
  const ch = F('campaign.html');
  t('Q&A 공고는 구매양식 대신 Q&A 카드', /\$\('qnaBox'\)\.style\.display = _qna \? '' : 'none'/.test(ch) && /\$\('orderBox'\)\.style\.display = _qna \? 'none' : ''/.test(ch));
  t('캡처 전에는 완료 화면으로 넘어가지 않는다(진입·폴링 둘 다)',
    (ch.match(/if\(_isDoneDetail\(j\)\)\{ renderDone\(\);/g) || []).length === 2
    && !/status === 'submitted' && !\(j\.qnaSlot && j\.qnaSlot\.captureDone === false\)/.test(ch));
  t('제출 순서 = 줄 기록 → 캡처 업로드 → 제출 완료', ch.indexOf("'/api/submit/qna'") < ch.indexOf("action:'uploadReviewImage'")
    && ch.indexOf("action:'uploadReviewImage'") < ch.indexOf("action:'submitReview'"));
  t('링크에 대각선 화살표 없음', !/[↗⬈]/.test(ch.slice(ch.indexOf('function renderQnaCard'), ch.indexOf('function startHoldCountdown'))));
  const cards = F('js/campaign-cards.js');
  t('모집 카드 Q&A 배지', /c\.work_kind === 'qna' \? `<span class="pt-badge"/.test(cards));
  t('모집 목록 Q&A 탭(첫 화면·모집 화면)', /data-kind="qna"/.test(F('index.html')) && /data-kind="qna"/.test(F('recruit.html')));

  /* ── ⑧ 목록·색인 ─────────────────────────────────────────── */
  console.log('⑧ 목록·색인');
  t('공개 목록 SELECT 에 work_kind(종류 탭·배지 재료 — 빠지면 늘 리뷰로 접힌다)',
    /router\.get\('\/list'[\s\S]{0,1600}soldout_paused_at,[^\n]*\n\s*work_kind/.test(routes));
  const cr = require('../src/services/columnResolver');
  const colSrc = S('src/services/columnResolver.js');
  t('색인 날짜 칸: 진행일자는 다른 날짜 칸이 없을 때만', /if \(startDateIdx < 0\) startDateIdx = headers\.findIndex\(h => h\.includes\('진행일자'\)\)/.test(colSrc));
  void cr;

  /* ── ⑨ 검토 반영(2026-11-03) ─────────────────────────────────────────── */
  console.log('⑨ 검토 반영');
  const qs9 = S('src/services/qnaSlots.service.js');
  const sub9 = S('src/routes/submit.routes.js');
  const so9 = S('src/services/sheetlessOrder.service.js');
  const camp9 = S('src/routes/campaign.routes.js');
  const cron9 = S('src/jobs/cron.js');
  const page9 = F('campaign.html');
  t('자리 고르기: 공개 자리 먼저(추가 모집으로 순서가 섞여도)', /ORDER BY \(s\.visibility <> 'public'\), s\.unit_seq/.test(qs9));
  t('자리 고르기 유예 = 신청 홀드 유예(단일 출처)', /graceSec == null\) graceSec = require\('\.\/campaignHold\.service'\)\.HOLD_GRACE_SEC/.test(qs9));
  {
    const body = qs9.slice(qs9.indexOf('async function applyQnaEnd'));
    const iTab = body.indexOf('pg_advisory_xact_lock'), iCamp = body.indexOf('FOR UPDATE');
    t('일정 끝 반영: 작업표 잠금 → 공고 잠금 순서(교착 방지)', iTab > 0 && iCamp > iTab);
    t('일정 끝 반영: 작업표 잠금은 한 번만', body.split('pg_advisory_xact_lock').length === 2);
    t('일정 끝 반영: 잠근 뒤 공고의 작업표 연결 재확인', /lock\[0\]\.linked_sheet_id !== pre\[0\]\.linked_sheet_id/.test(body));
    t('추가 모집: 줄이 안 움직이면 전부 되돌림', /mv\.rowCount !== 1\) throw/.test(body));
  }
  t('못 채운 자리 = 빈 줄이 살아 있는 자리', /cp2\.deleted_at IS NULL AND cp2\.order_submission_id IS NULL/.test(qs9));
  t('캡처 기한 넘김: 줄 삭제 길(주문 취소·같은 자리 보충)로 푼다', /hideWorkdeskRow\(\{[\s\S]{0,200}by: 'qna-capture-timeout', expectedRevision: r\.revision/.test(qs9));
  t('캡처 기한 넘김: 판정 = 그 줄 캡처 제출 여부', /NOT EXISTS \(SELECT 1 FROM review_index ri[\s\S]{0,200}ri\.is_submitted = TRUE/.test(qs9));
  t('캡처 기한 넘김: 작업표 줄(진실원본)의 캡처 제출도 본다', /cp\.is_submitted IS NOT TRUE/.test(qs9));
  t('리뷰어 화면 캡처 여부도 작업표 줄 + 색인', /cp\.is_submitted FROM campaign_participants cp[\s\S]{0,700}ri\.is_submitted = TRUE\)\) AS done/.test(camp9));
  t('캡처 기한 넘김: 유예 + 여유 2분 뒤', qna.QNA_CAPTURE_SWEEP_BUFFER_SEC === 120 && /\[grace \+ QNA_CAPTURE_SWEEP_BUFFER_SEC/.test(qs9));
  t('캡처 기한 넘김: 끄는 스위치', /QNA_CAPTURE_SWEEP === '0'/.test(qs9));
  t('캡처 기한 넘김: 매분 스윕에 걸림(따로 잠금)', /withJobLock\('qna_capture_sweep'/.test(cron9));
  {
    process.env.QNA_CAPTURE_SWEEP = '0';
    const off = await qna.sweepQnaCaptureTimeouts();
    delete process.env.QNA_CAPTURE_SWEEP;
    t('스위치 끄면 아무것도 안 함', off.off === true && off.released === 0);
    const calls = [];
    const fakeDb = { query: async (sql, params) => { calls.push(params); return { rows: [] }; } };
    const r = await qna.sweepQnaCaptureTimeouts({ db: fakeDb, limit: 5 });
    t('대상 없으면 0건(결과에 skipped 없음 — 잠금 양보 표식과 겹치지 않게)', r.released === 0 && r.failed === 0 && !('skipped' in r));
    t('대상 조회 인자 = [유예+120, 한도]', calls[0][0] === require('../src/services/campaignHold.service').HOLD_GRACE_SEC + 120 && calls[0][1] === 5);
  }
  t('구매양식 창구는 Q&A 자리 신청을 받지 않는다', /holdCtx\.verified && holdCtx\.qnaSlotId\) \{\s*return res\.status\(409\)\.json\(\{ ok: false, reason: 'qna_use_capture'/.test(sub9));
  t('홀드 조회가 qna_slot_id 를 같은 왕복에 읽는다', /ca\.purchase_qty, ca\.qty_tier_amount, ca\.qna_slot_id,/.test(sub9));
  t('Q&A 제출: 로그인 번호는 세션 먼저', /String\(session\.loginPhone8 \|\| b\.loginPhone8/.test(sub9));
  t('Q&A 제출: 줄 잠금 안에서 남의 줄 덮기 막음', /requireEmptyOrSame: true/.test(sub9)
    && /requireEmptyOrSame && cur\.length && cur\[0\]\.order_submission_id[\s\S]{0,120}!== String\(orderSubmissionId\)\)[\s\S]{0,200}reason: 'row_taken'/.test(so9));
  t('Q&A 제출: 두 번 눌러 먼저 확정됐으면 그 결과를 돌려줌', /alreadySubmitted: true, orderSubmissionId: done\[0\]\.order_submission_id/.test(sub9));
  t('신청 종류 판정: 공고의 작업표 칸 이름(linked_sheet_id)', /tabWorkKind\(\{ sheetId: campPre\.linked_sheet_id/.test(camp9) && !/campPre\.linked_tab_sheet_id/.test(camp9));
  t('신청: 잠근 공고로 종류 재확인(갈리면 막음)', /isQnaKind\(_lockedKind\) !== qnaApply/.test(camp9));
  t('신청: 자리 이중 묶기 충돌 = 자리 찼음 안내', /err\.constraint === 'uq_campaign_apps_qna_slot'[\s\S]{0,120}reason: 'qna_no_slot'/.test(camp9));
  t('1인 1회 공고: 다른 명의로 제출한 Q&A 도 기간 없이 막는다', /if \(!blocked && qnaApply\) \{\s*blocked = true;/.test(camp9));
  {
    const { qnaUnitsFromWorkOrder } = require('../src/utils/qnaCalendar');
    const wo = { daily_count: 1, product_options_json: JSON.stringify([
      { name: '상품', product_mode: 'opt', options: [{ label: '단일', option_1: { value: '단일' } }] },
      { name: 'B', product_mode: 'opt', options: [{ label: '빨강', option_1: { value: '빨강' } }, { label: '파랑', option_1: { value: '파랑' } }] },
      { name: 'C', product_mode: 'base', options: [] }]) };
    const cal = qnaUnitsFromWorkOrder(wo).units.map(u => u.unitKey);
    const map = [...qna.qnaOptKeyMap(wo).values()];
    t('선택지 → 자리 단위가 자리표와 같은 기준(「단일」 옵션도 자리표에 있는 단위)', map.length === cal.length && map.every(u => cal.includes(u)));
  }
  t('참여 후 화면: Q&A 는 상품·결제금액 카드를 숨긴다(구매 없음)', /showProduct: !j\.qnaSlot/.test(page9) && /if \(o\.showProduct !== false\)/.test(F('js/campaign-workdetail.js')));
  t('공개 목록: 선택지별 오늘 자리 수를 다시 만든 맵에도 싣는다', /_cntMap\.qnaToday = opts\[0\]\.qnaToday/.test(camp9));
  t('리뷰어 화면: Q&A 는 캡처 확인 전 완료 아님(자리 정보 못 받으면 다시 불러옴)',
    /function _isDoneDetail\(j\)[\s\S]{0,260}return !!\(j\.qnaSlot && j\.qnaSlot\.captureDone === true\)/.test(page9) && /_qnaSlotRetry\+\+/.test(page9));

  /* ── ⑩ 4단계 입금(사용자 확정 2026-11-03 — 참여비만 보내되 「리뷰비만 보낸 건」 판정에서 뺀다) ─────── */
  console.log('⑩ 4단계 입금');
  const pay = require('../src/services/payment.service');
  const ps = S('src/services/payment.service.js');
  t('Q&A 판정 = 공고 > 탭 종류(resolveWorkKind 단일 출처)', /const isQna = resolveWorkKind\(\{ campaignKind: camp && camp\.workKind, tabKind: tab && tab\.workKind \}\) === 'qna';/.test(ps));
  t('Q&A 금액 = 참여비만', /const amount = \(goodsByAdvertiser \|\| isQna\) \? fee : productPrice \+ fee;/.test(ps));
  t('Q&A 는 금액 없음(no_price)으로 막지 않는다', /if \(!productPrice && !isQna\) issues\.push/.test(ps));
  t('회차 항목에 is_qna 박제 · 제품비 0', /\(it\.goodsByAdvertiser \|\| it\.isQna\) \? 0 : it\.productPrice, it\.reviewFee, it\.amount, it\.transferMemo, it\.isQna === true/.test(ps));
  t('「리뷰비만」(JS): Q&A 항목은 아님', pay.isFeeOnlyItem({ product_price: 0, review_fee: 2000, amount: 2000, is_qna: true }) === false
    && pay.isFeeOnlyItem({ productPrice: 0, reviewFee: 2000, amount: 2000, isQna: true }) === false);
  t('「리뷰비만」(JS): 같은 모양 split 건은 종전대로', pay.isFeeOnlyItem({ product_price: 0, review_fee: 2000, amount: 2000 }) === true);
  t('「리뷰비만」(SQL): is_qna 면 빠진다', /AND NOT COALESCE\(i\.is_qna, FALSE\)\)$/.test(pay.feeOnlyItemSql('i')));
  t('결과 반영 항목 보기에 isQna', /isQna: r\.is_qna === true/.test(S('src/services/paymentResult.service.js')));
  t('입금일 다시 쓰기 조회에 is_qna', /i\.amount, i\.is_qna,/.test(S('src/services/paymentResult.service.js')));
  t('부팅 필수 칸 payment_batch_items.is_qna(212)', /\['payment_batch_items', 'is_qna'\]/.test(S('index.js')) && /ADD COLUMN IF NOT EXISTS is_qna BOOLEAN NOT NULL DEFAULT FALSE/.test(S('migrations/212_payment_item_qna.sql')));

  console.log(`\n✅ ${pass}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
