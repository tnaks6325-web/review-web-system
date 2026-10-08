/**
 * campaignSequentialOptions.test.js — 순차진행 공고의 선택지 순서 잠금 회귀가드 (결정 212 · 사용자 확정 2026-10-08)
 * 실행: node tests/campaignSequentialOptions.test.js
 *
 * 규칙(권장안 가): 인트라넷 투입방식이 '순차진행'인 오더의 공고는
 *  ① 앞 선택지에 자리가 남아 있는 동안 뒤 선택지는 waiting(고를 수 없음)
 *  ② 선택지 일건수는 쓰지 않는다 — 하루 몫은 공고 일건수를 앞 선택지부터 채운다
 *  ③ 순서를 걸 수 없는 공고(선택지 1개 · 정원 무제한 섞임)는 종전 그대로
 *  ④ 순차진행 판정 조회 실패 = 종전(전부 열림) — 막는 기능의 오류로 참여를 막지 않는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  computeOptionViews, fetchSequentialCampaignIds, optionDayCapacity, optionCapsFromViews, withoutOwnHold,
} = require('../src/services/campaignState.service');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// 실제 운영 오더(10/8 제주도아 선물세트 3종 30건) 모양 — 상품별 일건수 5 · 공고 일건수 15
const rows = [
  { opt_key: '1. 은갈치', recruit_total: 10, daily_limit: 5, status: 'active', sort_order: 0 },
  { opt_key: '2. 옥돔', recruit_total: 5, daily_limit: 5, status: 'active', sort_order: 1 },
  { opt_key: '3. 고등어살', recruit_total: 15, daily_limit: 5, status: 'active', sort_order: 2 },
];
const counts = (a = 0, b = 0, c = 0, extra = {}) => new Map([
  ['1. 은갈치', { submitted: a, todaySubmitted: a, activeHolds: 0, todayActiveHolds: 0, ...(extra.a || {}) }],
  ['2. 옥돔', { submitted: b, todaySubmitted: b, activeHolds: 0, todayActiveHolds: 0, ...(extra.b || {}) }],
  ['3. 고등어살', { submitted: c, todaySubmitted: c, activeHolds: 0, todayActiveHolds: 0, ...(extra.c || {}) }],
]);
const OPEN = { state: 'open' };
const st = vs => vs.map(v => v.status).join('/');

console.log('\n[1] 순차진행 — 하루 흐름');
let v = computeOptionViews(rows, counts(), OPEN, { sequential: true });
ok('모집 시작: 은갈치만 열림, 옥돔·고등어 대기', st(v) === 'open/waiting/waiting');
ok('은갈치 = 지금 모집 중 표시', v[0].sequenceCurrent === true && !v[1].sequenceCurrent);
ok('대기 선택지는 고를 수 없다', !v[1].selectable && !v[2].selectable && v[0].selectable);
ok('선택지 일건수(5)를 쓰지 않는다 — 은갈치 오늘 남은 자리 제한 없음', v[0].todayRemaining === null && v[0].dailyLimit === 0);

v = computeOptionViews(rows, counts(5), OPEN, { sequential: true });
ok('은갈치 5명(일건수 도달) 뒤에도 오늘 마감이 아니다 — 하루 15명을 앞부터 채움', st(v) === 'open/waiting/waiting');

v = computeOptionViews(rows, counts(10), OPEN, { sequential: true });
ok('은갈치 10명 다 참 → 옥돔이 열림', st(v) === 'soldout/open/waiting' && v[1].sequenceCurrent);

v = computeOptionViews(rows, counts(10, 5), OPEN, { sequential: true });
ok('옥돔까지 다 참 → 고등어살 열림', st(v) === 'soldout/soldout/open' && v[2].selectable);

v = computeOptionViews(rows, counts(10, 5, 15), OPEN, { sequential: true });
ok('전부 참 → 전부 마감, 지금 모집 중 없음', st(v) === 'soldout/soldout/soldout' && !v.some(x => x.sequenceCurrent));

console.log('\n[2] 예외 — 앞 선택지 자리가 다시 남(홀드 만료)');
v = computeOptionViews(rows, counts(9, 2), OPEN, { sequential: true });
ok('은갈치 1자리 다시 남 → 은갈치가 지금 모집 중, 옥돔은 새 신청자에게 다시 대기', st(v) === 'open/waiting/waiting' && v[0].remaining === 1);
ok('대기 중 옥돔도 남은 자리 수는 그대로 알려준다', v[1].remaining === 3);

console.log('\n[3] 결제 중(홀드)도 앞 선택지 자리를 차지한다');
v = computeOptionViews(rows, counts(8, 0, 0, { a: { activeHolds: 2, todayActiveHolds: 2 } }), OPEN, { sequential: true });
ok('은갈치 확정 8 + 결제 중 2 = 정원 → 옥돔 열림', st(v) === 'soldout/open/waiting');

console.log('\n[4] 순서를 걸지 않는 경우 = 종전 그대로');
v = computeOptionViews(rows, counts(), OPEN, { sequential: false });
ok('균등분산: 셋 다 열림 + 일건수 5 그대로', st(v) === 'open/open/open' && v[0].todayRemaining === 5 && !v[0].sequential);
v = computeOptionViews(rows, counts(5), OPEN, { sequential: false });
ok('균등분산: 일건수 도달 시 오늘 마감(종전)', v[0].status === 'today_done');
const unlimited = rows.map((r, i) => (i === 0 ? { ...r, recruit_total: 0 } : r));
v = computeOptionViews(unlimited, counts(), OPEN, { sequential: true });
ok('정원 무제한 선택지가 섞이면 잠그지 않는다(뒤가 영원히 안 열리는 것 방지)', st(v) === 'open/open/open' && !v[0].sequential);
v = computeOptionViews([rows[0]], counts(), OPEN, { sequential: true });
ok('선택지 1개면 잠글 것이 없다(종전)', st(v) === 'open' && v[0].todayRemaining === 5);

console.log('\n[5] 마감(closed) 선택지는 순서에서 빠진다');
const withClosed = [rows[1], rows[2], { ...rows[0], status: 'closed' }];   // 조회 정렬 = closed 맨 뒤
v = computeOptionViews(withClosed, counts(), OPEN, { sequential: true });
ok('관리자가 은갈치를 닫으면 옥돔이 지금 모집 중, 은갈치는 closed 유지', st(v) === 'open/waiting/closed' && v[0].sequenceCurrent);
v = computeOptionViews([rows[0], { ...rows[1], status: 'closed' }, rows[2]], counts(10), OPEN, { sequential: true });
ok('중간 선택지가 닫혀 있으면 건너뛰고 다음이 열림', st(v) === 'soldout/closed/open');

console.log('\n[6] 뒤 선택지가 이미 차 있으면 soldout 유지');
v = computeOptionViews(rows, counts(0, 5), OPEN, { sequential: true });
ok('옥돔이 (이전 참여로) 이미 찼으면 대기가 아니라 마감', st(v) === 'open/soldout/waiting');

console.log('\n[7] 공고가 닫혀 있으면 지금 모집 중 선택지도 못 고른다');
v = computeOptionViews(rows, counts(), { state: 'daily_done' }, { sequential: true });
ok('공고 오늘 마감: 은갈치 status open 이지만 selectable false', v[0].status === 'open' && !v[0].selectable && v[1].status === 'waiting');

console.log('\n[8] 공고 하루 몫 상한(결정 210)과의 연결');
const capsOf = vs => optionCapsFromViews(vs);
ok('순차진행: 선택지 일건수 대신 남은 정원 전부 — 상한 Σ 남은 정원 30(공고 일건수 15가 실제 몫을 정함)',
  optionDayCapacity(capsOf(computeOptionViews(rows, counts(), null, { sequential: true }))) === 30);
ok('순차진행 상한은 유한하다 — 관리자가 은갈치를 닫으면 남은 두 선택지 정원 합 20 (Codex P1: null 이면 고를 것 없는데 열림)',
  optionDayCapacity(capsOf(computeOptionViews([rows[1], rows[2], { ...rows[0], status: 'closed' }], counts(), null, { sequential: true }))) === 20);
ok('순차진행 상한: 이미 찬 선택지는 0 — 옥돔·고등어만 남으면 20',
  optionDayCapacity(capsOf(computeOptionViews(rows, new Map([['1. 은갈치', { submitted: 10, todaySubmitted: 0 }]]), null, { sequential: true }))) === 20);
ok('균등분산: 종전대로 Σ min(일건수, 남은 정원) = 15',
  optionDayCapacity(capsOf(computeOptionViews(rows, counts(), null, { sequential: false }))) === 15);

console.log('\n[8-2] 옵션 변경 — 내 홀드를 원래 선택지에서 빼고 판정 (Codex P1)');
// 은갈치 확정 9 + 내 홀드 1 = 10(가득) → 내 홀드를 빼면 은갈치 1자리가 남는다 → 옥돔으로 바꾸면 순서가 깨진다
const mine = counts(9, 0, 0, { a: { activeHolds: 1, todayActiveHolds: 1 } });
v = computeOptionViews(rows, mine, OPEN, { sequential: true });
ok('그대로 보면 은갈치 가득 → 옥돔이 열린 것처럼 보인다(이게 우회 경로)', v[1].status === 'open');
v = computeOptionViews(rows, withoutOwnHold(mine, '1. 은갈치', true), OPEN, { sequential: true });
ok('내 홀드를 빼면 은갈치 1자리 남음 → 옥돔은 대기 = 변경 거절', v[0].status === 'open' && v[1].status === 'waiting');
const w = withoutOwnHold(mine, '1. 은갈치', false);
ok('withoutOwnHold: 원본을 바꾸지 않고, 오늘 신청이 아니면 오늘 홀드는 그대로', mine.get('1. 은갈치').activeHolds === 1
  && w.get('1. 은갈치').activeHolds === 0 && w.get('1. 은갈치').todayActiveHolds === 1);
ok('withoutOwnHold: 0 아래로 내려가지 않고, 모르는 선택지면 그대로', withoutOwnHold(counts(), '1. 은갈치', true).get('1. 은갈치').activeHolds === 0
  && withoutOwnHold(mine, '없는키', true).get('1. 은갈치').activeHolds === 1);

(async () => {
  console.log('\n[9] 순차진행 판정 조회 — 연결 작업오더 투입방식');
  const mkDb = (impl, client = false) => {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push(String(sql)); return impl(String(sql), params); } };
    if (client) db.release = () => {};
    return { db, calls };
  };
  let { db, calls } = mkDb(sql => (/work_orders/.test(sql)
    ? { rows: [{ campaign_id: 'c1', product_distribution_mode: 'sequential' }, { campaign_id: 'c2', product_distribution_mode: 'balanced' }] }
    : { rows: [] }));
  let set = await fetchSequentialCampaignIds(db, ['c1', 'c2', 'c3']);
  ok('sequential 인 공고만 담긴다', set.has('c1') && !set.has('c2') && !set.has('c3'));
  ok('짝짓기는 공유 조각(linkedWorkOrdersForCampaigns) — 역방향·정방향 링크 둘 다 본다',
    calls.some(s => /linked_campaign_id/.test(s) && /source_work_order_id/.test(s) && /deleted_at IS NULL/.test(s)));

  ({ db, calls } = mkDb(sql => { if (/work_orders/.test(sql)) throw new Error('boom'); return { rows: [] }; }, true));
  set = await fetchSequentialCampaignIds(db, ['c1']);
  ok('조회 실패 = 빈 판정(종전 동작 · fail-open)', set.size === 0);
  ok('잠금 트랜잭션 안에서는 SAVEPOINT 로 격리하고 실패 시 되돌린다',
    calls[0] === 'SAVEPOINT seq_options' && calls.includes('ROLLBACK TO SAVEPOINT seq_options'));

  ({ db, calls } = mkDb(() => ({ rows: [] })));
  set = await fetchSequentialCampaignIds(db, []);
  ok('공고가 없으면 DB 를 열지 않는다', set.size === 0 && calls.length === 0);

  console.log('\n[10] 끄는 스위치 CAMPAIGN_SEQUENTIAL_OPTIONS=0 → 즉시 종전');
  const out = execFileSync(process.execPath, ['-e', `
    const { computeOptionViews } = require(${JSON.stringify(path.join(__dirname, '../src/services/campaignState.service'))});
    const rows = ${JSON.stringify(rows)};
    process.stdout.write(computeOptionViews(rows, new Map(), { state: 'open' }, { sequential: true }).map(v => v.status).join('/'));
  `], { env: { ...process.env, CAMPAIGN_SEQUENTIAL_OPTIONS: '0' }, cwd: path.join(__dirname, '..') }).toString().trim().split('\n').pop();
  ok('스위치를 끄면 셋 다 열림', out === 'open/open/open');

  console.log('\n[11] 배선 — 참여·옵션 변경·목록·상세가 같은 판정을 쓴다');
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
  ok('라우트에 선택지 하나만 보는 computeOptionView( 호출이 남아 있지 않다(순서 판정 누락 방지)',
    !/[^.\w]computeOptionView\(/.test(routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  ok('목록 뷰 단일 출처 computeOptionViews 를 4곳(상세 공용·목록·옵션 변경·참여)에서 쓴다',
    (routes.match(/computeOptionViews\(/g) || []).length >= 4);
  ok('참여는 잠금 트랜잭션의 client 로 순차진행을 판정한다',
    (routes.match(/fetchSequentialCampaignIds\(client, \[id\]\)/g) || []).length === 1);
  ok('옵션 변경은 _optionChangeViews(잠금 client · 내 홀드 제외) 단일 출처', /_optionChangeViews\(client, id, app, now\)/.test(routes)
    && /withoutOwnHold\(await fetchOptionCounts\(db, campaignId, now\), app && app\.option_key, appliedToday\)/.test(routes)
    && /SELECT id, status, expires_at, option_key, applied_at FROM campaign_applications/.test(routes));
  ok('[옵션 변경] 버튼은 실제로 옮겨 갈 선택지가 있을 때만(같은 판정) — Codex P2',
    /_optionChangeViews\(pool, id, app, now\)[\s\S]{0,120}canChangeOption = views\.some\(v => v\.optKey !== app\.option_key && v\.status === 'open'\)/.test(routes));
  const manual = fs.readFileSync(path.join(__dirname, '../src/services/manualOrder.service.js'), 'utf8');
  ok('관리자 수기 주문 상품 목록도 같은 목록 뷰를 쓴다(선택지 하나씩 판정 0)',
    /computeOptionViews\(opts, counts, null, \{ sequential \}\)/.test(manual) && !/[^.\w]computeOptionView\(/.test(manual.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  ok('대기 선택지 참여·변경 거절 사유 option_waiting', (routes.match(/reason: 'option_waiting'/g) || []).length === 2);
  const state = fs.readFileSync(path.join(__dirname, '../src/services/campaignState.service.js'), 'utf8');
  ok('하루 몫 상한 재료(_loadOptionDayCaps)도 같은 판정을 쓴다',
    /_loadOptionDayCaps[\s\S]*?fetchSequentialCampaignIds\(db,[\s\S]*?optionCapsFromViews\(computeOptionViews\(opts, cm, null, \{ sequential/.test(state));

  console.log('\n[12] 화면 — 대기 상태·거절 사유를 처리한다');
  const camp = fs.readFileSync(path.join(__dirname, '../../frontend/campaign.html'), 'utf8');
  ok('리뷰어 화면: 대기 문구 "앞 상품 마감 후 열림" + 대기 배지', /status === 'waiting'\) return [^\n]*앞 상품 마감 후 열림/.test(camp) && /obadge wait/.test(camp));
  ok('리뷰어 화면: 참여·옵션 변경에서 option_waiting 을 처리한다', (camp.match(/option_waiting/g) || []).length >= 3);
  const cards = fs.readFileSync(path.join(__dirname, '../../frontend/js/campaign-cards.js'), 'utf8');
  ok('공고 카드: 대기 선택지를 "N종 마감"에 세지 않는다', /o\.status !== 'open' && o\.status !== 'waiting'/.test(cards));
  const admin = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-recruit.js'), 'utf8');
  ok('관리자 옵션별 현황: 대기 상태 표기', /waiting: \["대기 · 앞 상품 마감 후"/.test(admin));

  console.log(`\n✅ campaignSequentialOptions — ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
