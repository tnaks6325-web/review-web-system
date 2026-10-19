/**
 * campaignSoldoutPause.test.js — 결정 259 (2026-10-19 · 사용자 확정)
 *
 * 옵션 없는 공고도 품절로 잠시 멈춘다 — 상품 이름 '' = 공고 전체(공고 행 recruit_campaigns.soldout_paused_*).
 *   [1] 멈추기·다시 열기(가짜 DB 실행) — 명시(whole:true)해야만 공고 전체 · 상품이 있는 공고는 공고 전체로 멈추지 않음
 *       · 다시 열기는 언제나 · 신고·알림 정리 · 어제 부족 팝업이 묻지 않게 규칙 변경 시각
 *   [2] 알림 — 공고 전체 알림도 종류별 버튼 · [확인했어요]는 옛 화면을 위해 계속 받음 · 목록 wholeCampaign
 *   [3] 작업조건 카드 재료 — 상품 없는 공고/공고 전체 멈춤 = 맨 앞에 공고 전체 줄
 *   [4] 배선 — 참여 게이트(상태 엔진 무접촉) · 공개 목록·상세 표시 · 필수 스키마 · 마이그레이션 · 화면
 * 실행: node tests/campaignSoldoutPause.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, n = 0;
const ok = (msg, cond) => { n++; if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const RF = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const svc = require('../src/services/campaignOptionPause.service');

/** 공고 하나·상품 목록·신고·알림을 가진 가짜 DB — 서비스가 보내는 SQL 만 흉내 낸다(모르는 SQL = 실패). */
function mkDb({ options = [], paused = false, reports = 0, alerts = [], participation = true, archived = false } = {}) {
  const st = { camp: { paused, reason: '', by: '', rulesChanged: 0, participation, archived }, options, reportsOpen: reports, alerts, events: [], sql: [] };
  const q = async (sql, p = []) => {
    const s = String(sql).trim();
    st.sql.push(s);
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(s)) return { rows: [] };
    if (/SELECT id FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: p[0] }] };
    if (/SELECT 1 FROM campaign_options WHERE campaign_id = \$1 AND COALESCE\(status,'active'\) <> 'closed' LIMIT 1/.test(s)) {
      return { rows: st.options.filter(o => o.status !== 'closed').length ? [{}] : [] };
    }
    if (/SELECT soldout_paused_at, participation_mode, archived_at FROM recruit_campaigns WHERE id = \$1/.test(s)) {
      return { rows: [{ soldout_paused_at: st.camp.paused ? new Date() : null, participation_mode: st.camp.participation, archived_at: st.camp.archived ? new Date() : null }] };
    }
    if (/^UPDATE recruit_campaigns SET soldout_paused_at = NOW\(\)/.test(s)) {
      if (!/participation_mode = TRUE AND archived_at IS NULL/.test(s)) throw new Error('멈춤 UPDATE 에 참여형·보관 조건이 없다');
      if (st.camp.paused || !st.camp.participation || st.camp.archived) return { rows: [] };
      Object.assign(st.camp, { paused: true, reason: p[1], by: p[2] }); st.camp.rulesChanged++; return { rows: [{ id: p[0] }] };
    }
    if (/^UPDATE recruit_campaigns SET soldout_paused_at = NULL/.test(s)) {
      if (!st.camp.paused) return { rows: [] };
      Object.assign(st.camp, { paused: false, reason: '', by: '' }); st.camp.rulesChanged++; return { rows: [{ id: p[0] }] };
    }
    if (/UPDATE campaign_option_soldout_reports SET cleared_at = NOW\(\) WHERE campaign_id = \$1 AND opt_key = '' /.test(s)) { st.reportsOpen = 0; return { rows: [], rowCount: 0 }; }
    if (/UPDATE campaign_option_alerts SET resolved_at = NOW\(\), resolved_by = \$2, resolution = \$3, updated_at = NOW\(\)\s+WHERE campaign_id = \$1 AND opt_key = ''/.test(s)) {
      const open = st.alerts.filter(a => a.opt === '' && !a.resolved); open.forEach(a => { a.resolved = p[2]; });
      return { rows: [], rowCount: open.length };
    }
    if (/INSERT INTO campaign_plan_events/.test(s)) { st.events.push(p[2]); return { rows: [] }; }
    // 알림 처리(resolveAlert)
    if (/SELECT campaign_id FROM campaign_option_alerts WHERE id = \$1/.test(s)) { const a = st.alerts.find(x => x.id === p[0]); return { rows: a ? [{ campaign_id: 'c1' }] : [] }; }
    if (/FROM campaign_option_alerts WHERE id = \$1 FOR UPDATE/.test(s)) {
      const a = st.alerts.find(x => x.id === p[0]);
      return { rows: a ? [{ id: a.id, campaign_id: 'c1', opt_key: a.opt, kind: a.kind, resolved_at: a.resolved ? new Date() : null, resolved_by: '', resolution: a.resolved || '' }] : [] };
    }
    if (/UPDATE campaign_option_alerts SET resolved_at = NOW\(\), resolved_by = \$2, resolution = \$3, updated_at = NOW\(\) WHERE id = \$1/.test(s)) {
      const a = st.alerts.find(x => x.id === p[0]); a.resolved = p[2]; return { rows: [] };
    }
    if (/UPDATE campaign_option_soldout_reports SET cleared_at = NOW\(\) WHERE campaign_id = \$1 AND opt_key = \$2/.test(s)) { if (p[1] === '') st.reportsOpen = 0; return { rows: [] }; }
    // 작업조건 카드 재료(optionSalesForCampaign)
    if (/FROM recruit_campaigns rc WHERE rc\.id = \$1/.test(s)) {
      return { rows: [{ soldout_paused_at: st.camp.paused ? new Date() : null, soldout_paused_reason: st.camp.reason, soldout_paused_by: st.camp.by, reports: st.reportsOpen,
        participation_mode: st.camp.participation, archived_at: st.camp.archived ? new Date() : null }] };
    }
    if (/FROM campaign_options co\s+WHERE co\.campaign_id = \$1 AND COALESCE\(co\.status,'active'\) <> 'closed'/.test(s)) {
      return { rows: st.options.filter(o => o.status !== 'closed').map(o => ({ opt_key: o.opt_key, paused_at: null, paused_reason: '', paused_by: '', reports: 0 })) };
    }
    throw new Error('예상 못 한 SQL: ' + s.slice(0, 90));
  };
  return { st, query: q, connect: async () => ({ query: q, release() {} }) };
}

(async () => {
  console.log('[1] 공고 전체 멈추기·다시 열기');
  {
    let db = mkDb();
    let r = await svc.setOptionPaused({ campaignId: 'c1', optKey: '', op: 'pause', by: 'kim', pool: db });
    ok('★ 이름 없는 요청은 공고 전체가 아니다 — 명시(whole:true) 없으면 종전처럼 거절', r.ok === false && r.code === 400 && !db.st.camp.paused);
    r = await svc.setOptionPaused({ campaignId: 'c1', optKey: undefined, op: 'pause', by: 'kim', pool: db });
    ok('이름이 아예 빠진 요청도 거절', r.ok === false && !db.st.camp.paused);
    r = await svc.setOptionPaused({ campaignId: 'c1', whole: true, op: 'pause', by: 'kim', pool: db });
    ok('★ whole:true = 공고 전체 멈춤(손으로 · 누른 사람 기록)', r.ok && r.changed && db.st.camp.paused && db.st.camp.reason === 'manual' && db.st.camp.by === 'kim');
    ok('멈추면 인원 규칙 변경 시각을 남긴다(어제 부족 팝업이 묻지 않게)', db.st.camp.rulesChanged === 1);
    ok('활동 기록 = campaign_paused', db.st.events.includes('campaign_paused'));
    ok('잠금 순서 = 공고 행 먼저(FOR UPDATE)', /FOR UPDATE/.test(db.st.sql[1]));
    r = await svc.setOptionPaused({ campaignId: 'c1', whole: true, op: 'pause', by: 'kim', pool: db });
    ok('이미 멈춘 공고 = 바뀐 것 없음(기록·규칙 시각 그대로)', r.ok && r.changed === false && db.st.camp.rulesChanged === 1);

    db = mkDb({ paused: true, reports: 3, alerts: [{ id: 9, opt: '', kind: 'auto_paused' }] });
    r = await svc.setOptionPaused({ campaignId: 'c1', whole: true, op: 'resume', by: 'lee', pool: db });
    ok('★ 다시 열기 = 멈춤 풀림 · 쌓인 신고 정리 · 열린 알림 닫힘(reopened)', r.ok && r.changed && !db.st.camp.paused && db.st.reportsOpen === 0 && db.st.alerts[0].resolved === 'reopened');
    ok('활동 기록 = campaign_resumed', db.st.events.includes('campaign_resumed'));

    db = mkDb({ options: [{ opt_key: 'A', status: 'active' }] });
    r = await svc.setOptionPaused({ campaignId: 'c1', whole: true, op: 'pause', by: 'kim', pool: db });
    ok('★ 상품이 있는 공고는 공고 전체로 멈추지 않는다(상품별로) — 409', r.ok === false && r.code === 409 && !db.st.camp.paused);
    db = mkDb({ options: [{ opt_key: 'A', status: 'closed' }] });
    r = await svc.setOptionPaused({ campaignId: 'c1', whole: true, op: 'pause', by: 'kim', pool: db });
    ok('상품이 전부 마감인 공고 = 옵션 없이 참여되는 공고 → 공고 전체로 멈춘다', r.ok && db.st.camp.paused);
    db = mkDb({ options: [{ opt_key: 'A', status: 'active' }], paused: true });
    r = await svc.setOptionPaused({ campaignId: 'c1', whole: true, op: 'resume', by: 'kim', pool: db });
    ok('★ 멈춘 뒤 상품이 생겨도 다시 열기는 된다(막다른 길 없음)', r.ok && r.changed && !db.st.camp.paused);
    db = mkDb({ paused: true });
    r = await svc.setOptionPaused({ campaignId: 'c1', optKey: '', op: 'resume', by: 'kim', pool: db });
    ok('★ 옛 카드(배포 순간)의 이름 빈 [다시 열기]도 공고 전체로 받는다', r.ok && r.changed && !db.st.camp.paused);
    db = mkDb({ participation: false });
    r = await svc.setOptionPaused({ campaignId: 'c1', whole: true, op: 'pause', by: 'kim', pool: db });
    ok('★ 옛 방식(참여형 아님) 공고는 멈추지 않는다 — 신청 경로에 게이트가 없어 거짓 멈춤이 된다(409)', r.ok === false && r.code === 409 && !db.st.camp.paused);
    db = mkDb({ archived: true });
    r = await svc.setOptionPaused({ campaignId: 'c1', whole: true, op: 'pause', by: 'kim', pool: db });
    ok('보관한 공고도 멈추지 않는다(409)', r.ok === false && r.code === 409 && !db.st.camp.paused);
  }

  console.log('[2] 알림');
  {
    let db = mkDb({ alerts: [{ id: 1, opt: '', kind: 'soldout_report' }] });
    let r = await svc.resolveAlert({ id: 1, action: 'pause', by: 'kim', pool: db });
    ok('★ 공고 전체 신고 알림 → [품절로 멈추기] = 공고 전체 멈춤', r.ok && db.st.camp.paused && db.st.alerts[0].resolved === 'paused');
    db = mkDb({ alerts: [{ id: 2, opt: '', kind: 'soldout_report' }], reports: 1 });
    r = await svc.resolveAlert({ id: 2, action: 'not_soldout', by: 'kim', pool: db });
    ok('공고 전체 신고 알림 → [품절 아님] = 신고 정리 · 멈추지 않음', r.ok && !db.st.camp.paused && db.st.reportsOpen === 0 && db.st.alerts[0].resolved === 'not_soldout');
    db = mkDb({ alerts: [{ id: 3, opt: '', kind: 'auto_paused' }], paused: true });
    r = await svc.resolveAlert({ id: 3, action: 'reopen', by: 'kim', pool: db });
    ok('공고 전체 자동 멈춤 알림 → [다시 열기]', r.ok && !db.st.camp.paused);
    db = mkDb({ alerts: [{ id: 4, opt: '', kind: 'soldout_report' }] });
    r = await svc.resolveAlert({ id: 4, action: 'ack', by: 'kim', pool: db });
    ok('★ [확인했어요]는 계속 받는다(배포 순간 옛 화면)', r.ok && db.st.alerts[0].resolved === 'ack' && !db.st.camp.paused);
    db = mkDb({ alerts: [{ id: 5, opt: '', kind: 'auto_paused' }], paused: true });
    r = await svc.resolveAlert({ id: 5, action: 'not_soldout', by: 'kim', pool: db });
    ok('★ 종류가 안 맞는 버튼(늦은 화면) = stale 거절 — 자동 멈춤을 조용히 덮지 않는다', r.ok === false && r.stale === true && db.st.camp.paused);
    const src = R('src/services/campaignOptionPause.service.js');
    ok('알림 목록: 공고 전체 알림의 멈춤 = 공고 행 칸 · wholeCampaign = 멈춰 있으면 언제나 / 아니면 참여형 && 상품 없음', /paused: r\.opt_key === '' \? !!r\.soldout_paused_at : !!r\.paused_at/.test(src)
      && /wholeCampaign: r\.opt_key === '' && \(!!r\.soldout_paused_at \|\| \(r\.participation_mode === true && !r\.whole_has_live\)\)/.test(src));
  }

  console.log('[3] 작업조건 카드 재료');
  {
    let list = await svc.optionSalesForCampaign(mkDb(), 'c1');
    ok('★ 상품 없는 공고 = 공고 전체 줄 하나(whole · 이름 \'\')', list.length === 1 && list[0].whole === true && list[0].optKey === '' && list[0].paused === false);
    list = await svc.optionSalesForCampaign(mkDb({ paused: true, reports: 2 }), 'c1');
    ok('멈춘 공고 = paused · 신고 수', list[0].paused === true && list[0].reports === 2);
    list = await svc.optionSalesForCampaign(mkDb({ options: [{ opt_key: 'A', status: 'active' }, { opt_key: 'B', status: 'active' }] }), 'c1');
    ok('상품 있는 공고 = 종전 그대로(공고 전체 줄 없음)', list.length === 2 && !list.some(o => o.whole));
    list = await svc.optionSalesForCampaign(mkDb({ options: [{ opt_key: 'A', status: 'active' }], paused: true }), 'c1');
    ok('★ 멈춘 뒤 상품이 생긴 공고 = 공고 전체 줄을 맨 앞에 남긴다([다시 열기]가 사라지지 않게)', list.length === 2 && list[0].whole === true && list[0].paused === true);
    list = await svc.optionSalesForCampaign(mkDb({ participation: false }), 'c1');
    ok('★ 옛 방식 공고 = 공고 전체 줄 없음(멈출 수 없는 버튼을 보이지 않는다)', list.length === 0);
    list = await svc.optionSalesForCampaign(mkDb({ archived: true }), 'c1');
    ok('보관한 공고 = 공고 전체 줄 없음', list.length === 0);
    const bad = { query: async () => { throw new Error('db down'); } };
    ok('조회 실패 = null(카드는 줄을 그리지 않는다 — 종전 규율)', (await svc.optionSalesForCampaign(bad, 'c1')) === null);
  }

  console.log('[4] 배선');
  {
    const routes = R('src/routes/campaign.routes.js');
    const gate = /const st = computeCampaignState\(camp, stateCounts, now, activeSchedule\);[\s\S]{0,400}?reason: st\.state[\s\S]{0,700}?camp\.soldout_paused_at && _optionPause\(\)\.ENABLED[\s\S]{0,200}?reason: 'campaign_paused'/.exec(routes);
    ok('★ 참여 게이트: 상태 판정 뒤 공고 전체 멈춤이면 campaign_paused 로 거절(새 신청만)', !!gate);
    ok('★ 상태 엔진은 멈춤을 모른다(하루 인원·앞날 예상·작업표 무접촉)', !/soldout_paused/.test(R('src/services/campaignState.service.js')));
    ok('공개 목록 SELECT 에 멈춤 칸(목록 카드 = apply 게이트와 같은 칸)', /cash_receipt_required,[^\n]*\n\s+soldout_paused_at/.test(routes));
    ok('공개 뷰: soldoutPaused = 칸 && 스위치', /soldoutPaused: !!row\.soldout_paused_at && _optionPause\(\)\.ENABLED/.test(routes));
    ok('상품변경(이미 참여한 사람)은 공고 전체 멈춤으로 막지 않는다', (routes.match(/reason: 'campaign_paused'/g) || []).length === 1);
    const tb = R('src/routes/trackB.routes.js');
    ok('멈춤 경로: whole 은 true 를 명시했을 때만', /whole: b\.whole === true/.test(tb));
    const idx = R('index.js');
    ok('필수 스키마: 공고 전체 멈춤 칸 3개', ['at', 'by', 'reason'].every(k => idx.includes(`['recruit_campaigns', 'soldout_paused_${k}']`)));
    const mig = R('migrations/193_campaign_soldout_pause.sql');
    ok('193: 추가만(ADD COLUMN IF NOT EXISTS 3개 · 다른 문장 없음)', (mig.match(/ADD COLUMN IF NOT EXISTS soldout_paused_/g) || []).length === 3
      && !/^\s*(UPDATE|DELETE|DROP|CREATE)/im.test(mig));
    ok('status 칸에 paused 를 쓰지 않는다(공고 수정 저장이 멈춤을 풀지 않게)', !/status\s*=\s*'paused'/.test(R('src/services/campaignOptionPause.service.js')));
    ok('멈춤이 공고 updated_at 을 건드리지 않는다(공고 수정 충돌 판정 무접촉)', !/soldout_paused_at = (NOW\(\)|NULL)[^`]*updated_at/.test(R('src/services/campaignOptionPause.service.js')));

    const wd = RF('frontend/workdesk.html');
    ok('작업조건 카드(B안): 줄 이름 품절유무 · 판매 중·멈춤 배지 없음 · 버튼 [멈추기]/[열기] · 공고 전체 줄은 이름 없이 · whole:true 로 보냄',
      /<dt>품절유무<\/dt>/.test(wd) && !/판매 중<\/span>/.test(wd) && !/class="cndsale /.test(wd)
      && /\$\{o\.paused\?'열기':'멈추기'\}<\/button>/.test(wd)
      && /const nm=o\.whole\?'':/.test(wd) && /o\.whole\?\{whole:true,paused:pause\}:\{optKey:o\.optKey,paused:pause\}/.test(wd));
    ok('작업조건 카드(B안): 상품마다 버튼까지 한 줄(줄바꿈 없음 · 긴 이름은 …)', /\.cndsalerow\{[^}]*flex-wrap:nowrap/.test(wd) && /\.cndsalenm\{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/.test(wd)
      && /\.cndsalebtn\{flex:none;white-space:nowrap/.test(wd));
    const pr = RF('frontend/js/option-alert-prompt.js');
    ok('알림 창: 공고 전체 알림은 멈춤 버튼 · 상품 생긴 공고만 [확인했어요]', /if \(!it\.hasOptions && !it\.wholeCampaign\)/.test(pr));
    const camp = RF('frontend/campaign.html');
    ok('리뷰어 상세: 참여 버튼 = 품절로 잠시 멈춤 · 거절 문구 · 거절 뒤에도 표시 유지', /c\.soldoutPaused === true\)\{ jb\.disabled = true; jb\.textContent = '품절로 잠시 멈춤'/.test(camp) && /campaign_paused:'/.test(camp)
      && /finally\{[^\n]*\n\s+if\(c && c\.state==='open' && c\.soldoutPaused === true\)/.test(camp));
    const cc = RF('frontend/js/campaign-cards.js');
    ok('카드: 멈춤 표시 · 참여 버튼 끔 · 참여 가능 공고보다 뒤로', /function _soldoutPaused\(c\)/.test(cc) && /c\.state === 'open' && _soldoutPaused\(c\)\) \{/.test(cc)
      && /c\.state === 'open' && _soldoutPaused\(c\)\) \? 2/.test(cc));
  }

  console.log(`\n${n - failed}/${n} 통과`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
