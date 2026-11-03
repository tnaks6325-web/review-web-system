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

  // 선택지 키 ↔ 자리 단위
  const wo = { product_options_json: JSON.stringify([
    { name: '벨벳틴 상품1', base: { count: 2, daily: 1 }, options: [] },
    { name: '양말', base: { count: 2 }, options: [{ label: '검정', option_1: { value: '검정' }, count: 1 }, { label: '흰색', option_1: { value: '흰색' }, count: 1 }] },
    { name: '모자', base: { count: 1 }, options: [{ label: '검정', option_1: { value: '검정' }, count: 1 }] },
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
  t('오늘 · 열린 · 묶이지 않은 자리 · unit_seq 순 · FOR UPDATE',
    /s\.slot_date = \$4::date AND s\.status = 'open'[\s\S]*NOT EXISTS[\s\S]*ORDER BY s\.unit_seq[\s\S]*FOR UPDATE OF s/.test(calls[1]) && picked.id === 7);
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
  t('홀드 확정 실패(late)면 장부 줄 취소 · 기한 지남으로 응답', /holdResult !== 'confirmed'[\s\S]{0,300}deleted_at = NOW\(\)[\s\S]{0,600}QNA_EXPIRED/.test(q));
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
  t('작업표 기록과 같은 잠금 안에서 옮긴다', /sheetless_worktable:\$\{it\.sheetId\}:\$\{it\.tabName\}/.test(qs));
  t('같은 일정 끝 추가 모집은 한 번만', /action = \$2 AND detail->>'end' = \$3/.test(qs));

  /* ── ⑦ 리뷰어 화면 ─────────────────────────────────────────── */
  console.log('⑦ 리뷰어 화면');
  const ch = F('campaign.html');
  t('Q&A 공고는 구매양식 대신 Q&A 카드', /\$\('qnaBox'\)\.style\.display = _qna \? '' : 'none'/.test(ch) && /\$\('orderBox'\)\.style\.display = _qna \? 'none' : ''/.test(ch));
  t('캡처 전에는 완료 화면으로 넘어가지 않는다(진입·폴링 둘 다)',
    (ch.match(/status === 'submitted' && !\(j\.qnaSlot && j\.qnaSlot\.captureDone === false\)/g) || []).length === 2);
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

  console.log(`\n✅ ${pass}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
