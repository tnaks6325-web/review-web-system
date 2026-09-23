/**
 * 모집인원 조절 — 총건수보다 "부족하게" 저장 + 작업표 축소 반영 회귀가드 (2026-08-19)
 *
 * 사용자 확정: "총건수를 넘을 순 없지만, 총건수보다 부족하게는 저장되고 작업보드에서도 줄어듦이 반영되도록".
 *
 * ① 부족(diff<0)은 **저장 가능** — 막는 것은 초과(총량 초과)뿐이다.
 * ② 계획을 줄여 비게 된 빈 준비 줄은 작업표에서 **내린다**(소프트 삭제). 안 내리면
 *    "100명으로 줄였는데 표는 그대로 200줄"이라 조절이 표에 반영되지 않는다.
 * ③ ★ 그날 **이미 채워진 줄(참여·주문)** 도 그날 계획에 포함해 센다 — 빈 줄만 세면
 *    확정 3명 있는 날에 12줄을 더 만들어 표가 계획보다 3줄 많아진다(실측).
 * ④ ★ 다른 날짜의 빈 줄을 당겨올 때 **그 날짜의 계획을 깨뜨리지 않는다** — 종전엔
 *    미래의 빈 줄을 무조건 가져와 뺏긴 날짜가 계획 20인데 18줄이 됐다(실측).
 * ⑤ 날짜 표기는 작업표를 만든 함수와 같은 것을 쓴다(한 열에 두 표기 금지).
 *
 * 실행: node tests/planShortfallTrim.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };

const svc = require('../src/services/sheetlessDailyPlan.service');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sheetlessDailyPlan.service.js'), 'utf8');
const planSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'campaignPlan.service.js'), 'utf8');
const front = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-daily-plan.js'), 'utf8');

/** 스텁 pool 로 syncAdjustedPlansToWorktable 을 실제로 실행한다. */
async function run({ rows, set, planned = null, today = '2026-08-19' }) {
  const inserts = [], updates = [], trims = [];
  const client = {
    query: async (sql, params) => {
      const q = String(sql);
      if (q.includes('workdesk_participant_deletions')) return { rows: [{ max_seq: 100 }] };
      if (q.includes('FROM campaign_participants') && q.includes('FOR UPDATE')) return { rows };
      if (q.includes('INSERT INTO campaign_participants')) { inserts.push(params); return { rows: [] }; }
      if (q.includes('deleted_at = NOW()')) { trims.push(params[0]); return { rows: [] }; }
      if (q.includes('UPDATE campaign_participants')) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const r = await svc.syncAdjustedPlansToWorktable({ client, sheetId: 'S1', tabName: 'T1', today, set, planned, by: 'tester' });
  return { r, inserts, updates, trims };
}

const empty = (id, seq, date) => ({ id, seq, tab_gid: '1', reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null, row_json: { '구매일자': date } });
const filled = (id, seq, date) => ({ id, seq, tab_gid: '1', reviewer_name: '참여자', recipient_name: '참여자', phone8: '12345678', order_submission_id: 'o' + id, row_json: { '구매일자': date } });

(async () => {
  /* ── ② 축소하면 남는 빈 줄을 표에서 내린다 ── */
  {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id, i) => empty(id, i + 1, '8 / 19 (수)'));
    const { r, trims } = await run({ rows, set: [{ date: '2026-08-19', count: 2 }] });
    ok('★ 계획을 5→2 로 줄이면 남는 빈 줄 3개가 표에서 내려간다(작업표에 축소 반영)',
      r.cleared === 3 && r.trimmed === 3 && trims.length === 1 && trims[0].length === 3);
    ok('내림은 소프트 삭제 + 비활성(되돌릴 수 있다)',
      /SET deleted_at = NOW\(\), active = FALSE/.test(src));
    ok('★ 주문이 붙은 줄은 SQL 조건으로도 한 번 더 막는다(fail-closed)',
      /id = ANY\(\$1::uuid\[\]\) AND order_submission_id IS NULL/.test(src));
  }
  /* ── ③ 확정 줄을 계획에 포함해 센다 ── */
  {
    const rows = [filled('f1', 1, '8 / 19 (수)'), filled('f2', 2, '8 / 19 (수)'), filled('f3', 3, '8 / 19 (수)')];
    const { r, inserts } = await run({ rows, set: [{ date: '2026-08-19', count: 5 }] });
    ok('★ 확정 3명 있는 날에 5명 계획 → 새 줄은 2개(5개가 아니다 — 표 = 계획)',
      r.created === 2 && inserts.length === 2);
    const rows2 = [filled('f1', 1, '8 / 19 (수)'), empty('e1', 2, '8 / 19 (수)'), empty('e2', 3, '8 / 19 (수)')];
    const { r: r2, trims: t2 } = await run({ rows: rows2, set: [{ date: '2026-08-19', count: 2 }] });
    ok('★ 확정분이 먼저 자리를 차지한다 — 3줄→2명이면 빈 줄 1개만 내려간다',
      r2.cleared === 1 && r2.trimmed === 1 && t2[0].length === 1);
    ok('확정 줄은 절대 이동·삭제 대상이 아니다', !/f1/.test(JSON.stringify(t2)));
  }
  /* ── ④ 도너 제한: 다른 날짜의 계획을 깨지 않는다 ── */
  {
    // 8/26 은 계획 2명이고 빈 줄이 정확히 2개 = 여분 없음. 8/19 를 2명으로 늘려도 뺏으면 안 된다.
    const rows = [empty('x1', 1, '8 / 26 (수)'), empty('x2', 2, '8 / 26 (수)')];
    const { r, updates, inserts } = await run({
      rows, set: [{ date: '2026-08-19', count: 2 }], planned: { '2026-08-26': 2 },
    });
    ok('★ 계획이 지켜져야 하는 날짜의 빈 줄은 뺏지 않고 새 줄을 만든다',
      r.moved === 2 && r.created === 2 && updates.length === 0 && inserts.length === 2);
    // 반대로 계획이 없는(또는 잉여인) 날짜의 빈 줄은 당겨 쓴다 — 불필요한 줄 증식 방지.
    const { r: r2, updates: u2 } = await run({ rows: rows.map(x => ({ ...x })), set: [{ date: '2026-08-19', count: 2 }] });
    ok('계획 없는 날짜의 빈 줄은 그대로 당겨 쓴다(줄 증식 없음)', r2.moved === 2 && r2.created === 0 && u2.length === 2);
    ok('★ 서버가 기존 미래 계획을 실어 보낸다(안 보내면 도너 판정이 늘 "여분")',
      /planned: plannedMap/.test(planSrc) && /FROM campaign_daily_plans/.test(planSrc));
  }
  /* ── ⑤ 날짜 표기 단일 출처 ── */
  {
    const { updates } = await run({ rows: [empty('a', 1, '')], set: [{ date: '2026-08-19', count: 1 }] });
    ok('★ 표기는 작업표 생성과 같은 `8 / 19 (수)` 형식(한 열에 두 표기 금지)',
      updates.length === 1 && updates[0][2] === '8 / 19 (수)');
    ok('표기 사본을 두지 않는다(worktablePlan.sheetDateStr 위임)',
      /require\('\.\.\/utils\/worktablePlan'\)\.sheetDateStr|sheetDateStr\(/.test(src));
  }
  /* ── ① 부족은 저장 가능, 초과만 막는다 ── */
  {
    ok('★ 저장 잠금은 초과(diff > 0)일 때만 — 부족은 저장 가능',
      /save\.disabled = killOff \|\| S\.saving \|\| diff > 0/.test(front) && !/diff !== 0/.test(front));
    ok('균형 바가 부족을 "저장가능"이라고 말한다(저장불가 문구 금지)',
      /건 적게 모집합니다\.[\s\S]{0,80}저장가능/.test(front));
    ok('★ 저장 안내가 표도 함께 줄어든다는 사실을 말한다(조용한 축소 금지)',
      /적게 모집합니다[\s\S]{0,120}저장하면 작업표도 그 수로 줄어듭니다/.test(front));
    ok('총량 초과는 서버가 최종 방어(화면만 믿지 않는다)',
      /code = 'over_total'/.test(planSrc) && /over_total: 422/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8')));
  }

  console.log(`\nplanShortfallTrim: ${passed} passed`);
  process.exit(0);
})();
