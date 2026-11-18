'use strict';
/* 결정 379 — 조절 창 화면 시험·미리보기용 응답(tests/fixtures/qnaMoveOverview.json)을 **실제 서비스로** 만든다.
 *  PGlite(저장소 migrations) + 가상 자료(qnaExtraPgFixture) · 시계 = 2026-11-17(화) 14:00 KST 고정(이 프로세스 안에서만).
 *  운영 사례 「11/3더로우 Q/A 50건」 본뜸: 11/17 = 0명 계획 · 11/18 = 빈 자리 1(정규 일정이 11/18 까지라 일정 끝 팝업 대상 아님).
 *  실행(server/): node tests/helpers/qnaMoveFixtureGen.js   ★ 시험이 부르지 않는다(자료를 다시 만들 때만).
 */
const fs = require('fs');
const path = require('path');

const RealDate = Date;
const BASE = RealDate.parse(process.env.FAKE_NOW || '2026-11-17T14:00:00+09:00');
const T0 = RealDate.now();
global.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(BASE + (RealDate.now() - T0)); else super(...a); }
  static now() { return BASE + (RealDate.now() - T0); }
};

const F = require('./qnaExtraPgFixture');
(async () => {
  const PG = await F.openDb(); const pool = F.poolOf(PG.db); F.injectPool(pool);
  const cp = require('../../src/services/campaignPlan.service');
  const qs = require('../../src/services/qnaSlots.service');
  const md = d => require('../../src/utils/worktablePlan').businessDays({ count: 1, startDate: d, skipWeekends: false })[0].label;
  const admin = { name: '망고', role: 'admin' };
  await F.seed(pool, { plans: { '2026-11-17': 0 } });
  await pool.query(`UPDATE qna_slots SET slot_date='2026-11-18' WHERE sheet_id=$1 AND seq=$2`, [F.SHEET, F.UNFILLED_SEQ]);
  await pool.query(`UPDATE campaign_participants SET start_date=$3, row_json=jsonb_set(row_json,'{진행일자}',to_jsonb($3::text)) WHERE sheet_id=$1 AND seq=$2`,
    [F.SHEET, F.UNFILLED_SEQ, md('2026-11-18')]);
  // 시각 칸은 고정 값으로(다시 만들어도 같은 파일)
  const fix = o => { const j = JSON.parse(JSON.stringify(o)); (j.plans || []).forEach(p => { p.updatedAt = '2026-11-16T07:18:03.540Z'; }); (j.events || []).forEach(e => { e.at = '2026-11-17T05:00:00.000Z'; }); return j; };
  const qna = fix({ ok: true, ...(await cp.getPlanOverview(F.CAMP, { admin })) });
  const r = await qs.moveQnaSlots({ campaignId: F.CAMP, moves: [{ from: '2026-11-18', to: '2026-11-17', n: 1, fromOpen: 1 }], total: 50, actor: '망고' });
  const after = fix({ ok: true, ...(await cp.getPlanOverview(F.CAMP, { admin })), ...r, reload: false });
  const out = { note: '결정 379 — 실제 서비스(getPlanOverview · moveQnaSlots)로 만든 응답 · 가상 자료 · 오늘 2026-11-17(화) 14:00 KST · 만들기: tests/helpers/qnaMoveFixtureGen.js', qna, after };
  fs.writeFileSync(path.resolve(__dirname, '..', 'fixtures', 'qnaMoveOverview.json'), JSON.stringify(out, null, 1) + '\n');
  console.log('saved · move=' + JSON.stringify(qna.qna.move) + ' · moved=' + r.moved);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
