/**
 * campaignPlanRelayTriggers.test.js — 날짜별 예상 인원 미리보기 + 작업표 날짜 맞추기 트리거 (결정 182 · 2026-09-26)
 *
 * ① 미리보기(previewPlanProjection)는 **쓰기 0건** — 바꾼 날(set)·지운 날(remove)을 얹어 계산만 한다.
 * ② relayCampaignWorktable 은 **절대 throw 하지 않는다**(설정 저장은 이미 끝났다) · 무시트가 아니면 건너뛴다 ·
 *    맞췄으면 기록(worktable_relay)을 남기고 커밋 **뒤** 번호·장부를 다시 만든다 · ledgers:false 면 장부는 건너뛴다.
 * ③ 총 인원·일건수·주말·이월 방식이 바뀌는 모든 길에서 날짜 맞추기를 부른다(빠지면 다음 새벽까지 옛 날짜).
 * 실행: node tests/campaignPlanRelayTriggers.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' :: ' + extra : '')); passed++; console.log('  ✓ ' + name); };
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\u0000/g, '');

const poolMod = require('../src/db/pool');
const cp = require('../src/services/campaignPlan.service');
const { kstTodayStr } = require('../src/services/campaignState.service');
const TODAY = kstTodayStr();
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const CAMP = { id: 'c1', title: 'T', participation_mode: true, status: 'active', archived_at: null,
  linked_sheet_id: 'wt', linked_tab_name: 'T', recruit_total: 30, daily_limit: 5, start_date: addDays(TODAY, -3),
  skip_weekends: false, carry_strategy: 'next', carry_mode: 'auto' };

const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

(async () => {
  const origQuery = poolMod.query, origConnect = poolMod.connect;
  const sls = require('../src/utils/sheetlessScope');
  const sdp = require('../src/services/sheetlessDailyPlan.service');
  const rn = require('../src/services/rowNumbering.service');
  const led = require('../src/services/sheetlessLedger.service');
  const orig = { isSheetless: sls.isSheetless, relay: sdp.relayWorktableToProjection, renumber: rn.renumberTab, rebuild: led.rebuildLedgers };
  try {
    console.log('\n[1] 미리보기 — 쓰기 0 · 바꾼 날을 얹어 계산');
    {
      const sqls = [];
      poolMod.query = async (sql) => {
        sqls.push(String(sql));
        if (/FROM recruit_campaigns/.test(sql)) return { rows: [CAMP] };
        return { rows: [] };
      };
      const D2 = addDays(TODAY, 2), D3 = addDays(TODAY, 3);
      const r = await cp.previewPlanProjection('c1', { set: [{ date: D2, count: 0 }, { date: 'bad', count: 3 }, { date: D3, count: -1 }], remove: [] });
      const p = r.projection;
      ok('예상 인원을 돌려준다', p && Array.isArray(p.days) && p.days.length > 0, JSON.stringify(r).slice(0, 200));
      const day = d => p.days.find(x => x.date === d);
      ok('바꾼 날(0명)이 반영된다', day(D2) && day(D2).quota === 0);
      ok('형식이 틀린 값(날짜·음수)은 무시한다', day(D3) && day(D3).quota === 5);
      ok('★★ 쓰기 0건', !sqls.some(s => WRITE.test(s)), sqls.filter(s => WRITE.test(s)).join(' | '));
      const base = (await cp.previewPlanProjection('c1', {})).projection;
      ok('하루를 0명으로 줄이면 예상 종료일이 늦어진다(총 인원은 그대로)', p.endDate > base.endDate, p.endDate + ' vs ' + base.endDate);

      poolMod.query = async (sql) => (/FROM recruit_campaigns/.test(sql) ? { rows: [{ ...CAMP, participation_mode: false }] } : { rows: [] });
      let err = null;
      try { await cp.previewPlanProjection('c1', {}); } catch (e) { err = e; }
      ok('참여형이 아니면 거절한다', err && err.code === 'not_participation');
    }

    console.log('\n[2] relayCampaignWorktable — 절대 throw 없음 · 건너뛰기 · 기록 · 커밋 뒤 번호·장부');
    {
      poolMod.connect = async () => { throw new Error('pool exhausted'); };
      const r0 = await cp.relayCampaignWorktable('c1');
      ok('★★ 연결 실패도 throw 하지 않고 사유를 돌려준다', r0 && r0.ok === false && r0.reason === 'relay_failed');

      const mkClient = (log) => ({
        query: async (sql, params) => {
          log.push(String(sql).trim());
          if (/FROM recruit_campaigns/.test(sql)) return { rows: [CAMP] };
          return { rows: [], rowCount: 0 };
        },
        release() { log.push('RELEASE'); },
      });
      let log = [];
      poolMod.connect = async () => mkClient(log);
      sls.isSheetless = async () => false;
      const r1 = await cp.relayCampaignWorktable('c1');
      ok('무시트가 아니면 건너뛴다(ROLLBACK · 기록 없음)', r1.skipped === true && r1.reason === 'not_sheetless'
        && log.includes('ROLLBACK') && !log.some(s => /campaign_plan_events/.test(s)));
      ok('연결은 반드시 반납한다', log[log.length - 1] === 'RELEASE');

      log = [];
      sls.isSheetless = async () => true;
      let relayArgs = null;
      sdp.relayWorktableToProjection = async (a) => { relayArgs = a; return { ok: true, moved: 2, cleared: 1, shortage: 0 }; };
      const after = [];
      rn.renumberTab = async (a) => { after.push(['renumber', a, log.includes('COMMIT')]); return { ok: true }; };
      led.rebuildLedgers = async (a) => { after.push(['ledger', a, log.includes('COMMIT')]); return { ok: true }; };
      const r2 = await cp.relayCampaignWorktable('c1', { by: 'tester' });
      ok('맞춘 결과를 돌려준다', r2.ok === true && r2.moved === 2 && r2.cleared === 1, JSON.stringify(r2));
      ok('★ 탭 잠금(구매 기록과 같은 이름)을 잡고 맞춘다',
        log.some(s => /pg_advisory_xact_lock/.test(s)) && log.findIndex(s => /pg_advisory_xact_lock/.test(s)) < log.indexOf('COMMIT'));
      ok('예상 인원(오늘 이후 날짜들)을 넘긴다', relayArgs && Array.isArray(relayArgs.days) && relayArgs.days.length > 0
        && relayArgs.sheetId === 'wt' && relayArgs.tabName === 'T');
      ok('기록(worktable_relay)을 남긴다', log.some(s => /INSERT INTO campaign_plan_events/.test(s) && /worktable_relay/.test(s)));
      ok('★ 번호·장부는 커밋 뒤에', after.length === 2 && after.every(x => x[2] === true) && after[0][0] === 'renumber');
      ok('번호 정리는 장부를 따로 만들지 않는다(rebuild:false)', after[0][1].rebuild === false);

      log = []; after.length = 0;
      await cp.relayCampaignWorktable('c1', { by: 'tester', ledgers: false });
      ok('ledgers:false 면 번호만 정리하고 장부는 건너뛴다', after.length === 1 && after[0][0] === 'renumber');

      log = []; after.length = 0;
      sdp.relayWorktableToProjection = async () => ({ ok: true, moved: 0, cleared: 0, shortage: 0 });
      await cp.relayCampaignWorktable('c1');
      ok('바뀐 게 없으면 번호·장부를 건드리지 않는다', after.length === 0);

      log = [];
      sdp.relayWorktableToProjection = async () => { throw new Error('boom'); };
      const r3 = await cp.relayCampaignWorktable('c1');
      ok('★★ 맞추기 중 오류도 throw 없이 되돌린다(ROLLBACK)', r3.ok === false && log.includes('ROLLBACK'));

      poolMod.connect = async () => mkClient(log);
      sdp.relayWorktableToProjection = async () => ({ ok: true, moved: 1, cleared: 0, shortage: 0 });
      rn.renumberTab = async () => { throw new Error('renumber down'); };
      const r4 = await cp.relayCampaignWorktable('c1');
      ok('번호·장부 실패는 날짜 반영을 되돌리지 않고 사유만 싣는다', r4.ok === true && /renumber down/.test(r4.ledgerError || ''));
    }
  } finally {
    poolMod.query = origQuery; poolMod.connect = origConnect;
    sls.isSheetless = orig.isSheetless; sdp.relayWorktableToProjection = orig.relay;
    rn.renumberTab = orig.renumber; led.rebuildLedgers = orig.rebuild;
  }

  console.log('\n[3] 트리거 배선 — 인원이 바뀌는 모든 길');
  {
    const tb = rd('src/routes/trackB.routes.js');
    ok('미리보기 경로는 로그인 + 내부 직원 전용',
      /router\.post\('\/campaigns\/:id\/daily-plan\/preview', authMiddleware, internalMiddleware/.test(tb));
    ok('이월 방식 변경 → 날짜 맞추기', /carry-strategy[\s\S]{0,1500}relayCampaignWorktable\(campaignId/.test(tb));
    ok('차수 추가·삭제 → 날짜 맞추기', (tb.match(/out\.worktableRelay = await require\('\.\.\/services\/campaignPlan\.service'\)\.relayCampaignWorktable/g) || []).length === 2);
    const cr = rd('src/routes/campaign.routes.js');
    ok('공고 수정(일건수·주말·시작일·총 인원) → 날짜 맞추기', /const worktableRelay = rows\[0\]\.participation_mode\s*\n\s*\? await require\('\.\.\/services\/campaignPlan\.service'\)\.relayCampaignWorktable\(id/.test(cr));
    ok('리뷰어 범위 수정 → 날짜 맞추기', /relayCampaignWorktable\(id, \{ by: 'reviewer-scoped-edit' \}\)/.test(cr));
    ok('공고 발행 → 오더 휴무일 저장 → 날짜 맞추기', /saveOrderHolidayZeros\(rows\[0\], by\)[\s\S]{0,200}relayCampaignWorktable\(rows\[0\]\.id/.test(cr));
    const lq = rd('src/services/linkedRecruitQuota.service.js');
    ok('인트라넷 오더 총 인원 변경 → 커밋 뒤 날짜 맞추기',
      /COMMIT'\);[\s\S]{0,600}relayCampaignWorktable\(campaign\.id, \{ by: 'workorder-quota-sync' \}\)/.test(lq));
    const tbs = rd('src/services/trackB.service.js');
    ok('행 삭제 → 커밋 뒤 날짜 맞추기', /relayCampaignWorktable\(result\.campaignId/.test(tbs));
    const cron = rd('src/jobs/cron.js');
    ok('매일 새벽 한 번(이월·종료일은 하루가 지나며 바뀐다) · 끄는 스위치 · 겹침 잠금 · 한국 시간',
      /CAMPAIGN_WORKTABLE_RELAY_CRON !== '0'/.test(cron) && /'20 4 \* \* \*'/.test(cron)
      && /withJobLock\('campaign_worktable_relay'/.test(cron)
      && /relayAllCampaignWorktables\(\{ by: 'cron' \}\)[\s\S]{0,600}timezone: 'Asia\/Seoul'/.test(cron));
  }

  console.log(`\ncampaignPlanRelayTriggers: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
