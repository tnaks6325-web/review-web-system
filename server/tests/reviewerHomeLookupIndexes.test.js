'use strict';
// 리뷰어 홈 「리뷰 미작성 경고」·「받을 예정 금액」 후보 조회가 표 전체를 읽지 않게 (decision 190).
// "계정ID 또는 전화번호"를 한 조건(OR)으로 합치면 인덱스를 못 타 1.5초 제한에 걸린다(운영 실측).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0; const t = (n, f) => { f(); passed++; console.log('PASS ' + n); };

const route = read('src/routes/reviewer.routes.js');
const overdue = route.slice(route.indexOf('warning_candidate_ids AS MATERIALIZED ('), route.indexOf('), warning_participants AS MATERIALIZED'));
const { earningsCandidates } = require('../src/services/reviewEarningsCandidates.service');
const earnings = earningsCandidates('$1', '$2');
const mig = read('migrations/168_reviewer_home_lookup_indexes.sql');

t('후보 조회는 계정ID·전화번호를 OR 로 합치지 않는다(갈래별 UNION)', () => {
  for (const [name, sql] of [['overdue', overdue], ['earnings', earnings.slice(0, earnings.indexOf('earnings_rows AS'))]]) {
    const noComment = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    assert.ok(!/\bOR\b/i.test(noComment), name + ' 후보 조회에 OR 이 남아 있다');
    assert.ok((noComment.match(/\bUNION\b/g) || []).length >= 5, name);
  }
});
t('주문은 후보 ID 로만 읽는다(표 전체를 읽고 합치지 않는다)', () => {
  assert.match(route, /WHERE os\.id IN \(SELECT id FROM warning_candidate_ids WHERE id IS NOT NULL\)/);
  assert.match(earnings, /WHERE o\.id IN \(SELECT id FROM earnings_order_ids WHERE id IS NOT NULL\)/);
});
t('조건을 좁히지 않았다 — 후보 단계에 삭제 여부 조건이 없다(결과 동일)', () => {
  const cand = overdue.slice(0, overdue.indexOf('), warning_orders AS'));
  assert.ok(cand.length > 100 && !/deleted_at/.test(cand.replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.ok(!/deleted_at/.test(earnings.slice(0, earnings.indexOf('earnings_orders AS'))));
});
t('각 갈래가 탈 인덱스가 있다(migration 168)', () => {
  for (const ix of ['idx_os_phone8_all', 'idx_os_owner_reviewer', 'idx_cp_owner_reviewer', 'idx_cp_phone8_all',
    'idx_cp_participant_identity', 'idx_ca_owner_phone8', 'idx_pl_owner_reviewer']) assert.match(mig, new RegExp('INDEX IF NOT EXISTS ' + ix));
  // 전화번호 정리식은 조회식과 글자 그대로 같아야 인덱스가 쓰인다.
  const expr = "RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 8)";
  assert.ok(mig.includes('(' + expr + ')'));
  assert.ok(overdue.includes(expr));
  assert.ok(earnings.includes("RIGHT(regexp_replace(COALESCE(o.phone,''),'[^0-9]','','g'),8)"));
  assert.ok(!/CONCURRENTLY/.test(mig.replace(/--[^\n]*/g, '')), 'migrate.js 는 파일을 한 번에 실행한다');
});
console.log(`${passed} lookup index tests passed`);
