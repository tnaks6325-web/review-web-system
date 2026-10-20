/**
 * campaignOptionPause.test.js — 결정 229 (2026-10-12 · 사용자 확정)
 *
 * 상품 품절 일시 멈춤 + 리뷰어 품절 신고 + 관리자 전원 알림.
 *   [1] 선택지 뷰(순수) — 멈춤 = 고를 수 없음 · 마감/정원 소진이 먼저 · liveOptions 는 멈춘 상품을 살아 있는 것으로 본다
 *       · 순차진행: 오늘 상품이 멈추면 오늘 안 받음 · 다른 상품 날짜는 그대로 · 하루 몫 재료(칸 없음)는 종전 그대로
 *   [2] 신고 세기(가짜 DB 실행) — 1명 = 알림만 · 같은 사람 = 1명 · 다른 2명 = 자동 멈춤 · 같은 주문 두 번 = 무시
 *       · 상품을 모르면 멈추지 않는다 · 상품 없는 공고 = 알림만
 *   [3] 배선 — 취소 사유 soldout 일 때만 신고 · 참여·상품변경 거절 문구 · 이름 바꾸기 · 필수 스키마 · 실시간 통로 대상
 *       · 업체 렌즈 · 화면(리뷰어·관리자 카드·공고 수정·수동 주문·작업 조건 카드·팝업 두 화면)
 * 실행: node tests/campaignOptionPause.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, n = 0;
const ok = (msg, cond) => { n++; if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const RF = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const CS = require('../src/services/campaignState.service');
const { buildSequentialSchedule } = require('../src/utils/sequentialSchedule');

(async () => {
  console.log('[1] 선택지 뷰');
  {
    const base = { opt_key: 'A', recruit_total: 10, daily_limit: 3, status: 'active' };
    const v0 = CS.computeOptionView(base, { submitted: 1 }, { state: 'open' });
    ok('멈춤 없음 = 종전 그대로(open · paused 필드 없음)', v0.status === 'open' && v0.selectable && !('paused' in v0));
    const v1 = CS.computeOptionView({ ...base, paused_at: new Date() }, { submitted: 1 }, { state: 'open' });
    ok('멈춤 = paused · 고를 수 없음', v1.status === 'paused' && v1.selectable === false && v1.paused === true);
    const v2 = CS.computeOptionView({ ...base, paused_at: new Date() }, { submitted: 10 }, { state: 'open' });
    ok('정원 소진이 멈춤보다 먼저 보인다(soldout)', v2.status === 'soldout' && v2.selectable === false);
    const v3 = CS.computeOptionView({ ...base, status: 'closed', paused_at: new Date() }, {}, { state: 'open' });
    ok('마감이 멈춤보다 먼저(closed · paused 아님)', v3.status === 'closed' && !v3.paused);
    const v4 = CS.computeOptionView({ ...base, paused_at: new Date() }, { todaySubmitted: 3, submitted: 3 }, { state: 'open' });
    ok('오늘 몫을 다 받았어도 멈춤으로 보인다(다시 열기 전엔 내일도 안 열림)', v4.status === 'paused');
    const views = CS.computeOptionViews([{ ...base, paused_at: new Date() }, { ...base, opt_key: 'B', paused_at: new Date() }], new Map(), { state: 'open' });
    ok('★ 전부 멈춰도 상품을 고르는 공고다(liveOptions 2개 — 상품 없이 참여되는 구멍 없음)', CS.liveOptions(views).length === 2 && views.every(v => !v.selectable));

    // 순차진행(결정 228 일정표): 오늘 상품이 멈추면 오늘은 받지 않고, 다른 상품 날짜는 당겨지지 않는다
    const OPTS = [{ optKey: '은갈치', recruitTotal: 10, dailyLimit: 5 }, { optKey: '옥돔', recruitTotal: 5, dailyLimit: 5 }];
    const sch = buildSequentialSchedule({ startDate: '2026-10-08', options: OPTS, isClosedDay: () => false });
    const rows = [
      { opt_key: '은갈치', recruit_total: 10, daily_limit: 5, status: 'active' },
      { opt_key: '옥돔', recruit_total: 5, daily_limit: 5, status: 'active' },
    ];
    const cm = new Map([['은갈치', { submitted: 5 }]]);
    const plain = CS.computeOptionViews(rows, cm, { state: 'open' }, { sequential: sch, today: '2026-10-09' });
    const paused = CS.computeOptionViews([{ ...rows[0], paused_at: new Date() }, rows[1]], cm, { state: 'open' }, { sequential: sch, today: '2026-10-09' });
    ok('순차: 평소 오늘 상품(은갈치) open', plain[0].status === 'open' && plain[0].sequenceCurrent);
    ok('순차: 멈추면 오늘 상품 = paused · 고를 수 없음 · 여전히 오늘 차례(날짜 차지)', paused[0].status === 'paused' && !paused[0].selectable && paused[0].sequenceCurrent);
    ok('순차: 옥돔은 원래 날짜 그대로(당겨지지 않음)', paused[1].status === 'waiting' && paused[1].opensOn === plain[1].opensOn);
    // 하루 몫 재료(_loadOptionDayCaps)는 paused_at 칸을 조회하지 않는다 → 오늘 인원·앞날 예상·작업표 무접촉
    const capsSrc = R('src/services/campaignState.service.js');
    const capSel = /async function _loadOptionDayCaps[\s\S]*?FROM campaign_options WHERE campaign_id = ANY\(\$1\)/.exec(capsSrc);
    ok('★ 하루 몫 재료 조회에 paused_at 이 없다(일시 멈춤은 인원·예상·작업표를 바꾸지 않는다)', capSel && !/paused_at/.test(capSel[0]));
    ok('status 칸에 paused 를 쓰지 않는다(공고 수정 창 저장이 멈춤을 풀지 않게)', !/status\s*=\s*'paused'/.test(R('src/services/campaignOptionPause.service.js')));
  }

  console.log('[2] 신고 세기(가짜 DB)');
  {
    const svc = require('../src/services/campaignOptionPause.service');
    const mkDb = ({ orders, options }) => {
      const st = { reports: [], paused: new Set(), alerts: [], events: [] };
      const q = async (sql, p = []) => {
        const s = String(sql);
        if (/FROM order_submissions os/.test(s)) { const o = orders[p[0]]; return { rows: o ? [o] : [] }; }
        if (/SELECT opt_key, status FROM campaign_options WHERE campaign_id = \$1/.test(s)) return { rows: (options[p[0]] || []).map(k => typeof k === 'string' ? { opt_key: k, status: 'active' } : k) };
        if (/SELECT 1 FROM campaign_options WHERE campaign_id = \$1 AND opt_key = \$2 AND paused_at IS NOT NULL/.test(s)) return { rows: st.paused.has(p[0] + '|' + p[1]) ? [{}] : [] };
        // 결정 259: 상품을 나누지 않은 공고 = 공고 행의 멈춤 칸(키 'camp|')
        if (/SELECT 1 FROM recruit_campaigns WHERE id = \$1 AND soldout_paused_at IS NOT NULL/.test(s)) return { rows: st.paused.has(p[0] + '|') ? [{}] : [] };
        if (/UPDATE recruit_campaigns SET soldout_paused_at = NOW\(\)/.test(s)) {
          const k = p[0] + '|'; if (st.paused.has(k)) return { rows: [] }; st.paused.add(k); st.wholeBy = p[2]; st.wholeReason = p[1]; return { rows: [{ id: p[0] }] };
        }
        if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/.test(s.trim())) return { rows: [] };
        if (/INSERT INTO campaign_plan_events/.test(s)) { st.events.push({ camp: p[0], actor: p[1], action: p[2] }); return { rows: [] }; }
        if (/SELECT id FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: p[0] }] };
        if (/INSERT INTO campaign_option_soldout_reports/.test(s)) {
          if (st.reports.some(r => r.order === p[2])) return { rows: [] };
          st.reports.push({ camp: p[0], opt: p[1], order: p[2], who: p[3] }); return { rows: [{ id: st.reports.length }] };
        }
        if (/COUNT\(DISTINCT COALESCE\(NULLIF\(reporter/.test(s)) {
          const set = new Set(st.reports.filter(r => r.camp === p[0] && r.opt === p[1]).map(r => r.who || ('order:' + r.order)));
          return { rows: [{ who: set.size }] };
        }
        if (/UPDATE campaign_options SET paused_at = NOW\(\), paused_reason = 'auto_soldout'/.test(s)) {
          const k = p[0] + '|' + p[1]; if (st.paused.has(k)) return { rows: [] }; st.paused.add(k); return { rows: [{ id: 1 }] };
        }
        if (/INSERT INTO campaign_option_alerts/.test(s)) {
          let a = st.alerts.find(x => x.camp === p[0] && x.opt === p[1]);
          if (!a) { a = { id: st.alerts.length + 1, camp: p[0], opt: p[1], kind: p[2], count: p[3] }; st.alerts.push(a); }
          else { a.kind = a.kind === 'auto_paused' ? 'auto_paused' : p[2]; a.count = Math.max(a.count, p[3]); }
          return { rows: [{ id: a.id, kind: a.kind }] };
        }
        throw new Error('예상 못 한 SQL: ' + s.slice(0, 80));
      };
      return { st, query: q, connect: async () => ({ query: q, release() {} }) };
    };
    const db = mkDb({
      orders: {
        o1: { campaign_id: 'c1', app_key: 'A', sel_key: null }, o2: { campaign_id: 'c1', app_key: 'A', sel_key: null },
        o3: { campaign_id: 'c1', app_key: 'A', sel_key: null }, o4: { campaign_id: 'c1', app_key: null, sel_key: '옛 이름' },
        o5: { campaign_id: 'c2', app_key: null, sel_key: null }, o6: { campaign_id: 'c3', app_key: null, sel_key: null },
        o7: { campaign_id: 'c4', app_key: '마감A', sel_key: null }, o8: { campaign_id: 'c4', app_key: '마감A', sel_key: null },
        o9: { campaign_id: 'c3', app_key: '없는 이름', sel_key: null },
        o10: { campaign_id: 'c1', app_key: 'B', sel_key: null },
        o11: { campaign_id: 'c2', app_key: null, sel_key: null }, o12: { campaign_id: 'c2', app_key: null, sel_key: null },
        o13: { campaign_id: 'c5', app_key: '옛 상품', sel_key: null },
      },
      options: { c1: ['A', 'B'], c2: [], c3: ['단일'], c4: [{ opt_key: '마감A', status: 'closed' }, { opt_key: '진행B', status: 'active' }],
        c5: [{ opt_key: '옛 상품', status: 'closed' }] },
    });
    let r = await svc.recordSoldoutReport({ orderSubmissionId: 'o1', phone8: '11110000', pool: db });
    ok('1번째 신고 = 알림만(멈추지 않음)', r.action === 'reported' && r.reporters === 1 && db.st.paused.size === 0 && db.st.alerts[0].kind === 'soldout_report');
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o1', phone8: '11110000', pool: db });
    ok('같은 주문 두 번 = 무시', r.action === 'duplicate');
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o3', phone8: '11110000', pool: db });
    ok('같은 리뷰어의 다른 주문 = 여전히 1명(멈추지 않음)', r.reporters === 1 && db.st.paused.size === 0);
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o2', phone8: '22220000', pool: db });
    ok('★ 다른 리뷰어 2명 = 자동 멈춤 · 알림은 하나로 올라감', r.action === 'auto_paused' && db.st.paused.has('c1|A') && db.st.alerts.length === 1 && db.st.alerts[0].kind === 'auto_paused' && db.st.alerts[0].count === 2);
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o4', phone8: '44440000', pool: db });
    ok('★ 어느 상품인지 모르면 멈추지 않는다(짐작 금지)', r.action === 'unknown_option' && db.st.reports.length === 3);
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o5', phone8: '55550000', pool: db });
    ok('상품을 나누지 않은 공고 — 신고 1명 = 알림만(결정 259 이후에도 1명은 멈추지 않음)', r.action === 'reported' && !db.st.paused.has('c2|') && db.st.alerts.some(a => a.camp === 'c2' && a.opt === ''));
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o6', phone8: '66660000', pool: db });
    ok('상품이 하나뿐이면 그 상품으로 센다', r.action === 'reported' && db.st.reports.some(x => x.camp === 'c3' && x.opt === '단일'));
    ok('신고 2명 기준 = 2(사용자 확정 (나))', svc.AUTO_PAUSE_REPORTERS === 2);
    await svc.recordSoldoutReport({ orderSubmissionId: 'o7', phone8: '77770000', pool: db });
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o8', phone8: '88880000', pool: db });
    ok('★ 리뷰어 상품이 마감이면 남은 다른 상품을 멈추지 않는다(코드리뷰 P1)', r.action === 'unknown_option' && !db.st.paused.has('c4|진행B'));
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o9', phone8: '99990000', pool: db });
    ok('상품 이름이 적혀 있는데 없는 이름이면 "하나뿐" 규칙을 쓰지 않는다', r.action === 'unknown_option');
    db.st.paused.add('c1|B');
    const nAlerts = db.st.alerts.length;
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o10', phone8: '10100000', pool: db });
    ok('이미 멈춘 상품(손으로 멈춤)에 온 첫 신고 = 알림 없음(코드리뷰 P2)', r.action === 'already_paused' && db.st.alerts.length === nAlerts);
    // ★ 결정 259: 상품을 나누지 않은 공고도 다른 리뷰어 2명이면 **공고 전체**를 자동으로 멈춘다(사용자 확정 2026-10-19 "똑같이 적용")
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o11', phone8: '55550000', pool: db });
    ok('공고 전체: 같은 리뷰어의 두 번째 주문 = 여전히 1명', r.action === 'reported' && r.reporters === 1 && !db.st.paused.has('c2|'));
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o12', phone8: '12120000', pool: db });
    ok('★ 공고 전체: 다른 리뷰어 2명 = 자동 멈춤(공고 행) · 알림은 하나로 올라감', r.action === 'auto_paused' && db.st.paused.has('c2|')
      && db.st.wholeReason === 'auto_soldout' && db.st.alerts.filter(a => a.camp === 'c2').length === 1 && db.st.alerts.find(a => a.camp === 'c2').kind === 'auto_paused');
    ok('★ 공고 전체 자동 멈춤 = 활동 기록 campaign_paused(system:soldout-report — Codex P2)', db.st.events.some(e => e.camp === 'c2' && e.action === 'campaign_paused' && e.actor === 'system:soldout-report'));
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o13', phone8: '13130000', pool: db });
    ok('★ 상품이 전부 마감인 공고 = 공고 전체로 센다(옵션 없이 참여되는 공고 — Codex P1)', r.action === 'reported' && db.st.reports.some(x => x.camp === 'c5' && x.opt === ''));
    const bad = { query: async () => { throw new Error('db down'); }, connect: async () => { throw new Error('db down'); } };
    r = await svc.recordSoldoutReport({ orderSubmissionId: 'o1', pool: bad });
    ok('DB 오류 = 예외 없이 error(취소는 그대로 유효)', r.ok === false && r.action === 'error');
  }

  console.log('[3] 배선');
  {
    const cancel = R('src/services/reviewerOrderCancel.service.js');
    ok('취소 사유가 soldout 일 때만 신고로 센다(커밋 뒤 후처리)', /String\(reasonKey \|\| ''\) === 'soldout'[\s\S]{0,200}recordSoldoutReport\(\{ orderSubmissionId: gate\.orderSubmissionId/.test(cancel)
      && cancel.indexOf('recordSoldoutReport') > cancel.indexOf('trackB.hideWorkdeskRow('));
    ok('취소 사유 선택지는 그대로 3개(판매자 취소 사유는 넣지 않음 — 사용자 확정)', (cancel.match(/\{ key: '/g) || []).length === 3);
    const routes = R('src/routes/campaign.routes.js');
    ok('참여·상품변경 둘 다 option_paused 로 거절', (routes.match(/reason: 'option_paused'/g) || []).length === 2);
    ok('참여 게이트·공개 상세·목록·상품변경 조회에 paused_at', (routes.match(/thumbnail_url, paused_at\n|status, paused_at\n|sort_order, paused_at\n/g) || []).length >= 4);
    // 이름 바꾸기 단일 출처 = services/campaignOptionRename(결정 263 7단계-④ ③ 에서 라우트에서 옮김 · 검사 의미 불변) — 한 단계 함수가 신고·알림을 옮기고 두 단계 모두 그 함수를 탄다
    const ren = R('src/services/campaignOptionRename.service.js');
    ok('이름 바꾸기가 신고·알림도 옮긴다(두 단계 모두)', /UPDATE campaign_option_soldout_reports SET opt_key=\$3/.test(ren) && /UPDATE campaign_option_alerts SET opt_key=\$3/.test(ren)
      && /await step\(plan\[i\]\.from, tmp\[i\]\)/.test(ren) && /await step\(tmp\[i\], plan\[i\]\.to\)/.test(ren)
      && /require\('\.\.\/services\/campaignOptionRename\.service'\)\.applyOptionRenames/.test(routes));
    const idx = R('index.js');
    ok('필수 스키마(칸 3 · 표 2)', /\['campaign_options', 'paused_at'\]/.test(idx) && /'campaign_option_soldout_reports'/.test(idx) && /'campaign_option_alerts'/.test(idx));
    const mig = R('migrations/184_campaign_option_pause.sql');
    ok('184: 열린 알림은 상품마다 하나 · 신고는 주문마다 하나', /uq_option_alerts_open[\s\S]*WHERE resolved_at IS NULL/.test(mig) && /uq_option_soldout_reports_order ON campaign_option_soldout_reports \(order_submission_id\)/.test(mig));
    ok('184: 어제 부족 팝업 트리거에 멈춤 포함(180 조건 유지)', /AFTER UPDATE OF status, daily_limit, recruit_total, opt_key, paused_at/.test(mig) && /OLD\.paused_at IS DISTINCT FROM NEW\.paused_at/.test(mig));
    const svcSrc = R('src/services/campaignOptionPause.service.js');
    ok('실시간 알림 대상 = 관리자 대시보드·리뷰웹시스템 연결만(리뷰어 제외)', /role === 'admin' \|\| role === 'workdesk'/.test(svcSrc));
    ok('잠금 순서 = 공고 행 → 상품 행(신고·멈춤·알림 처리 셋 다)', (svcSrc.match(/SELECT id FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/g) || []).length === 3);
    ok('★ 알림 처리: 버튼이 지금 알림 종류와 맞아야 한다(늦은 화면의 [품절 아님]이 자동 멈춤을 덮지 않게 — 코드리뷰 P1)',
      /const ACTIONS_BY_KIND = \{ soldout_report: \['pause', 'not_soldout'\], auto_paused: \['reopen', 'keep'\] \}/.test(svcSrc)
      && /FROM campaign_option_alerts WHERE id = \$1 FOR UPDATE/.test(svcSrc) && /stale: true/.test(svcSrc));
    ok('끄는 스위치: 판정도 같은 환경변수(꺼지면 전부 열림) · 다시 열기는 꺼져도 허용', /OPTION_PAUSE_ENABLED && !!opt\.paused_at/.test(R('src/services/campaignState.service.js'))
      && /if \(!ENABLED && op !== 'resume'\)/.test(svcSrc));
    ok('공고 저장(앞·뒤)·상품 합치기가 지운·마감 상품의 신고·알림을 정리', (routes.match(/closeStaleForCampaign\(client, (campaignId|id)\)/g) || []).length === 3);
    ok('정규 일정 끝 팝업: 멈춘 상품 표시', /paused_at FROM campaign_options/.test(R('src/services/campaignSequentialEnd.service.js')) && /품절 멈춤/.test(RF('frontend/js/sequential-end-prompt.js')));
    const tb = R('src/routes/trackB.routes.js');
    ok('알림·멈춤 경로 3개 모두 내부 직원 전용', /router\.get\('\/option-alerts', authMiddleware, internalMiddleware/.test(tb)
      && /router\.post\('\/option-alerts\/:id\/resolve', authMiddleware, internalMiddleware/.test(tb)
      && /router\.post\('\/campaigns\/:id\/option-pause', authMiddleware, internalMiddleware/.test(tb));
    const tbs = R('src/services/trackB.service.js');
    const lens = /function _condAdvertiserLens[\s\S]*?\n\}/.exec(tbs);
    ok('작업 조건 optionSales 는 업체 렌즈에 없다(내부 이름 미노출)', /optionSales: c \?/.test(tbs) && lens && !/optionSales/.test(lens[0]));

    const camp = RF('frontend/campaign.html');
    ok('리뷰어 화면: 일시 멈춤 문구·배지·거절 안내', /o\.status === 'paused'\) return '품절로 잠시 멈춤'/.test(camp) && /obadge soldout">일시 멈춤/.test(camp) && (camp.match(/option_paused/g) || []).length >= 3);
    ok('관리자 공고 카드: 멈춤을 마감으로 세지 않는다', /o\.status !== 'paused'\)\.length/.test(RF('frontend/js/campaign-cards.js')));
    const rec = RF('frontend/js/index-recruit.js');
    ok('관리자 현황표·공고 수정 창에 일시 멈춤 표시', /paused: \["일시 멈춤 · 품절"/.test(rec) && /d\.pausedAt \|\| d\.paused_at/.test(rec));
    ok('수동 주문: 안내만(막지 않음)', /o\.status === 'paused' \? ' · 품절로 일시 멈춤'/.test(RF('frontend/js/manual-order.js')));
    const wd = RF('frontend/workdesk.html');
    ok('작업 조건 카드: 상품 판매 줄 + 확인창 + 다시 그리기', /\$\{rows\}\$\{_cndSalesRow\(cd\)\}/.test(wd) && /async function _cndSale\(i\)[\s\S]{0,900}confirm\([\s\S]{0,900}option-pause[\s\S]{0,300}reloadWorkdesk\(\)/.test(wd));
    ok('리뷰웹시스템: 팝업 시작·종료(로그아웃 2곳)·실시간 이벤트·스크립트', /OptionAlertPrompt\.start\(_sp\)/.test(wd) && (wd.match(/OptionAlertPrompt\.stop\(\)/g) || []).length === 2
      && /addEventListener\('option_alert'/.test(wd) && /js\/option-alert-prompt\.js\?v=/.test(wd));
    const adm = RF('frontend/admin.html'), app = RF('frontend/js/index-app.js'), pay = RF('frontend/js/index-payment.js');
    ok('관리자 대시보드: 스크립트·시작·종료·실시간 이벤트', /js\/option-alert-prompt\.js\?v=/.test(adm) && /OptionAlertPrompt\.start\(_oaSp\)/.test(app)
      && /OptionAlertPrompt\.stop\(\)/.test(app) && /'option_alert'\]\.forEach/.test(pay) && /OptionAlertPrompt\.refresh\(\)/.test(pay));
    const pr = RF('frontend/js/option-alert-prompt.js');
    ok('팝업: 판정 사본 없음(서버 목록 그대로) · 버튼 5종 · 컴퓨터 알림 · 같은 알림은 한 번만', /\/api\/trackb\/option-alerts/.test(pr)
      && ['reopen', 'keep', 'pause', 'not_soldout', 'ack'].every(a => pr.includes('data-a="' + a + '"'))
      && /new Notification\(/.test(pr) && /notifiedKey\(\)/.test(pr) && /requestPermission/.test(pr));
    ok('팝업: onclick 문자열 보간 없음(이벤트 위임)', !/onclick="[^"]*\$\{|onclick=\\?"[^"]*' \+/.test(pr.replace(/onerror="this\.remove\(\)"/g, '')));
  }

  console.log(`\n${n - failed}/${n} 통과`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
