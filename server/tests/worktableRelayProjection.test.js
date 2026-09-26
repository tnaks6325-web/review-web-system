/**
 * 작업표가 날짜별 예상 인원을 따라간다 — relayWorktableToProjection 회귀가드 (결정 182 · 2026-09-26)
 *
 * 사용자 확정: 날짜별 모집 인원은 **규칙**이 정하고(campaignState.projectDailyQuotas) 작업표는 **따라간다**.
 * 이 파일은 옛 가드(planShortfallTrim · planWorktableSeqReuse — 지운 sync/rebuildAdjustedPlansToWorktable
 * 를 검사하던 것)의 **여전히 유효한 약속**을 새 함수로 옮겨 실제로 돌려 본다.
 *
 * ① ★★ 줄을 새로 만들지 않는다(INSERT 0) — 모자라면 모자란 수(shortage)를 말한다.
 *    종전 재구성은 줄을 새로 만들어, 전체 날짜로 돌리면 총 인원보다 줄이 늘었다.
 * ② ★★ 참여·주문이 있는 줄은 절대 옮기지 않는다(빈 줄 판정 = rowNumbering.isFilledRow 단일 출처).
 * ③ ★ 채워진 줄도 그날 인원에 센다 — 확정 3명 있는 날에 5명이면 빈 줄은 2개만 둔다(표 = 계획).
 * ④ ★ 이미 맞는 날짜의 빈 줄은 그대로(바뀌는 줄 최소) · 남는 빈 줄은 날짜를 비운다.
 * ⑤ ★ 옮길 줄 순서: 날짜 없음 → 지난 날 → 앞날 — 가까운 앞날 줄을 흔들지 않는다.
 * ⑥ 표기는 작업표를 만든 함수와 같은 `8 / 19 (수)`(worktablePlan.sheetDateStr) — 한 열에 두 표기 금지.
 * ⑦ 조회 기준은 active = TRUE(그리드·조절 창 기준선과 같다).
 * ⑧ 화면·서버 배선: 무시트가 아니면 경고로 올리고, 재구성 버튼은 비활성 + 사유, 확인창은 실제 동작을 말한다.
 *
 * 실행: node tests/worktableRelayProjection.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' :: ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const svc = require('../src/services/sheetlessDailyPlan.service');
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const src = rd('src/services/sheetlessDailyPlan.service.js');
const planSrc = rd('src/services/campaignPlan.service.js');
const front = rd('../frontend/js/campaign-daily-plan.js');

const E = (id, seq, date, extra) => ({ id, seq, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null,
  row_json: { '번호': String(seq), '구매일자': date }, ...(extra || {}) });
const F = (id, seq, date) => E(id, seq, date, { reviewer_name: '참여', recipient_name: '참여', phone8: '12345678', order_submission_id: 'o-' + id });

/** 스텁 client 로 relay 를 실제로 돌린다. updates = [{id, value}] */
async function run(rows, days, today = '2026-09-26') {
  const sqls = [];
  const updates = [];
  const client = { query: async (sql, params) => {
    sqls.push(String(sql));
    if (/SELECT[\s\S]*FROM campaign_participants/.test(sql)) return { rows };
    if (/UPDATE campaign_participants/.test(sql)) {
      const n = (params.length - 2) / 2;
      for (let i = 0; i < n; i++) updates.push({ id: params[i * 2], value: params[i * 2 + 1] });
      return { rowCount: n };
    }
    throw new Error('unexpected sql: ' + sql.slice(0, 60));
  } };
  const r = await svc.relayWorktableToProjection({ client, sheetId: 'wt', tabName: 'T', days, today, by: 't' });
  return { r, sqls, updates, map: new Map(updates.map(u => [u.id, u.value])) };
}

(async () => {
  console.log('\n[A] 실제 실행 — 빈 줄 날짜만 옮긴다');
  {
    // 오늘 9/26(토) — 9/28 2명, 9/29 2명 필요. 빈 줄 4개가 모두 9/28 에 몰려 있다.
    const rows = [E('a', 1, '9 / 28 (월)'), E('b', 2, '9 / 28 (월)'), E('c', 3, '9 / 28 (월)'), E('d', 4, '9 / 28 (월)')];
    const { r, sqls, map } = await run(rows, [{ date: '2026-09-28', quota: 2 }, { date: '2026-09-29', quota: 2 }]);
    ok('성공', r.ok === true, JSON.stringify(r));
    ok('★ 이미 맞는 날짜의 빈 줄 2개는 그대로 둔다(바뀌는 줄 최소)', !map.has('a') && !map.has('b'));
    ok('남는 2줄이 9/29 로 옮겨진다', map.get('c') === '9 / 29 (화)' && map.get('d') === '9 / 29 (화)');
    ok('★ 표기는 작업표 생성과 같은 `M / D (요일)`', [...map.values()].every(v => /^\d+ \/ \d+ \(.\)$/.test(v)));
    ok('★★ 줄을 새로 만들지 않는다(INSERT 0)', !sqls.some(s => /INSERT/i.test(s)));
    ok('moved/cleared/shortage 를 사실대로 센다', r.moved === 2 && r.cleared === 0 && r.shortage === 0);
  }
  {
    // ③ 확정 3명 있는 날에 5명 → 빈 줄은 2개만 그날에 둔다, 나머지는 날짜 비움
    const rows = [F('f1', 1, '9 / 28 (월)'), F('f2', 2, '9 / 28 (월)'), F('f3', 3, '9 / 28 (월)'),
      E('e1', 4, '9 / 28 (월)'), E('e2', 5, '9 / 28 (월)'), E('e3', 6, '9 / 28 (월)'), E('e4', 7, '9 / 28 (월)')];
    const { r, map } = await run(rows, [{ date: '2026-09-28', quota: 5 }]);
    ok('★ 채워진 줄도 그날 인원에 센다 — 빈 줄 2개만 남고 2개는 날짜를 비운다',
      !map.has('e1') && !map.has('e2') && map.get('e3') === '' && map.get('e4') === '' && r.cleared === 2);
    ok('★★ 채워진 줄은 절대 옮기거나 비우지 않는다', !['f1', 'f2', 'f3'].some(id => map.has(id)));
  }
  {
    // ① 모자라면 줄을 만들지 않고 모자란 수를 말한다
    const rows = [E('a', 1, ''), F('f', 2, '9 / 28 (월)')];
    const { r, sqls, map } = await run(rows, [{ date: '2026-09-28', quota: 2 }, { date: '2026-09-29', quota: 3 }]);
    ok('날짜 없는 빈 줄이 가장 이른 필요 날로 간다', map.get('a') === '9 / 28 (월)');
    ok('★★ 모자란 3명은 shortage 로 알린다(줄 생성 없음)', r.shortage === 3 && !sqls.some(s => /INSERT/i.test(s)));
  }
  {
    // ⑤ 옮길 순서: 날짜 없음 → 지난 날 → 앞날 (앞날 줄을 흔들지 않는다)
    const rows = [E('fut', 1, '10 / 5 (월)'), E('past', 2, '9 / 20 (일)'), E('none', 3, '')];
    const { map } = await run(rows, [{ date: '2026-09-28', quota: 2 }]);
    ok('★ 날짜 없음·지난 날 줄이 먼저 쓰인다', map.get('none') === '9 / 28 (월)' && map.get('past') === '9 / 28 (월)');
    ok('★ 필요 없는 앞날 줄은 날짜를 비운다(어느 날에도 필요 없음)', map.get('fut') === '');
  }
  {
    // 오늘 이전 날짜·0명 날은 목표에 넣지 않는다 / 쉬는 날(0명)의 빈 줄은 비운다
    const rows = [E('a', 1, '9 / 27 (일)'), E('b', 2, '9 / 25 (금)')];
    const { r, map } = await run(rows, [{ date: '2026-09-25', quota: 5 }, { date: '2026-09-27', quota: 0 }]);
    ok('지난 날(9/25)은 목표가 아니다 — 줄을 과거로 옮기지 않는다', ![...map.values()].includes('9 / 25 (금)'));
    ok('쉬는 날(0명)에 있던 빈 줄은 날짜를 비운다', map.get('a') === '' && r.shortage === 0);
  }
  {
    // 바뀔 게 없으면 UPDATE 도 없다
    const rows = [E('a', 1, '9 / 28 (월)')];
    const { r, sqls } = await run(rows, [{ date: '2026-09-28', quota: 1 }]);
    ok('이미 맞으면 UPDATE 0', r.ok && !sqls.some(s => /UPDATE campaign_participants/.test(s)));
  }
  {
    const { r } = await run([], [{ date: '2026-09-28', quota: 1 }]);
    ok('줄이 없으면 사유를 말한다', r.ok === false && r.reason === 'no_worktable_rows');
    const { r: r2 } = await run([{ id: 'x', seq: 1, row_json: { '이름': '' } }], [{ date: '2026-09-28', quota: 1 }]);
    ok('날짜 칸이 없으면 사유를 말한다', r2.ok === false && r2.reason === 'no_date_column');
    const r3 = await svc.relayWorktableToProjection({ client: null, sheetId: 'wt', tabName: 'T' });
    ok('연결 없으면 사유를 말한다', r3.ok === false && r3.reason === 'worktable_not_linked');
  }

  console.log('\n[B] 단일 출처 · 기준');
  {
    ok('★ 빈 줄 판정은 rowNumbering.isFilledRow(게이지·번호 정리와 같은 네 칸)',
      /empty: !isFilledRow\(r\)/.test(src));
    ok('표기 사본 없음(worktablePlan.sheetDateStr 위임)', /sheetDateStr\(/.test(src));
    ok('날짜 칸 찾기·파싱은 기존 함수', /findDateColumnIndex/.test(src) && /parseDateColumn/.test(src));
    ok('★ relay 는 active = TRUE 줄만 잠그고 본다', /deleted_at IS NULL AND active=TRUE\s*\n\s*ORDER BY seq FOR UPDATE/.test(src));
    ok('★ 조절 창 기준선(readWorktableDates)도 active = TRUE',
      /FROM campaign_participants\s*\n\s*WHERE sheet_id = \$1 AND tab_name = \$2 AND deleted_at IS NULL AND active = TRUE/.test(src));
    ok('★★ 이 파일에 INSERT 가 없다(줄 생성 경로 부활 금지)', !/INSERT INTO/.test(src));
    ok('옛 함수가 되살아나지 않았다',
      !/function (prefillFromWorktable|syncAdjustedPlansToWorktable|rebuildAdjustedPlansToWorktable)\b/.test(src));
  }

  console.log('\n[C] 서버·화면 배선');
  {
    ok('서버가 not_sheetless 를 경고 신호로 올린다', /reason: 'not_sheetless', warn: true/.test(planSrc));
    ok('★ 화면이 그 경우를 "저장 완료"로 뭉뚱그리지 않는다', /j\.worktableSync && j\.worktableSync\.warn/.test(front));
    ok('조절 화면이 전환 누락을 알린다', /무시트 작업표로 전환되지 않은 상태/.test(front));
    ok('연결 상태는 서버가 판정해 내려준다(모르면 null)',
      /worktableLinked: sheetlessLinked/.test(planSrc) && /sheetlessLinked = null;/.test(planSrc));
    ok('★ [작업표 재구성]은 무시트가 아니면 비활성 + 사유(죽은 버튼 금지)',
      /function syncRebuildBtn\(\)[\s\S]{0,500}btn\.disabled = \(linked === false\)/.test(front));
    ok('★ 툴팁·확인창이 실제 동작(날짜 이동·비우기·줄 안 만듦·보호 대상)을 말한다',
      /줄은 새로 만들지 않음/.test(front)
      && /빈 줄의 구매일자를 필요한 날짜로 옮깁니다/.test(front)
      && /줄은 새로 만들지 않습니다/.test(front)
      && /어느 날에도 필요 없는 빈 줄은 구매일자를 비웁니다/.test(front)
      && /참여자·연락처·주문이 있는 줄은 건드리지 않습니다/.test(front));
    ok('★ 옛 문구(줄을 새로 만든다)가 남아 있지 않다', !/빈 줄을 새로 만듭니다/.test(front));
    const rb = planSrc.slice(planSrc.indexOf('async function rebuildWorktableFromPlans'));
    ok('재구성은 relay(_relayInTx)를 쓴다', /await _relayInTx\(client, camp, today/.test(rb));
    ok('재구성은 장부 재생성 전에 화면 번호를 정리한다',
      rb.indexOf('renumberTab({') > 0 && rb.indexOf('renumberTab({') < rb.indexOf('rebuildLedgers({ ...target'));
    ok('총량 초과는 서버가 최종 방어', /code = 'over_total'/.test(planSrc)
      && /over_total: 422/.test(rd('src/routes/trackB.routes.js')));
  }

  console.log(`\nworktableRelayProjection: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
