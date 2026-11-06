'use strict';
// 결정 341 「출시(켜기)」 — 준비 상태가 열린 뒤에는 저장된 동시진행 공고를
// ① 상태 버튼으로 모집중으로 열 수 있고 ② 모집중 참여형 공고를 전체 수정으로 저장할 수 있어야 한다
// (막다른 길 금지). 닫힌 상태의 거부는 dualChannelCampaignGuard.test.js 가 그대로 지킨다.
const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db/pool');
const router = require('../src/routes/campaign.routes');
const runtime = require('../src/services/dualChannelRuntime.service');
const originalQuery = pool.query;
const originalConnect = pool.connect;
test.after(() => { pool.query = originalQuery; pool.connect = originalConnect; });

const p = { name: '로컬 시험 상품', option_schema_version: 2, product_mode: 'none', options: [], base: { pay: 19000, count: 3, daily: 3 },
  channels: { naver: { url: 'https://shop.example/naver', pay: 9000, inflow_type: 'link', guide: { text: '', images: [] } },
    coupang: { url: 'https://shop.example/coupang', pay: 10000, inflow_type: 'link', guide: { text: '', images: [] } } } };
const res = () => ({ statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } });

for (const participationMode of [false, true]) {
  test('출시 상태: 상태 버튼이 저장된 동시진행을 모집중으로 연다(쓰기까지 도달): 참여형=' + participationMode, async () => {
    assert.equal(runtime.isDualChannelReady('recruitment'), true);
    const writes = [];
    pool.query = async sql => {
      const s = String(sql);
      if (/\bUPDATE\b/i.test(s)) { writes.push(s); return { rows: [{ id: 'camp_dual_local', status: 'active' }] }; }
      return { rows: [{ id: 'camp_dual_local', status: 'draft', participation_mode: participationMode, channel: '네이버+쿠팡',
        daily_limit: 3, linked_sheet_id: '', linked_tab_name: '', linked_tab_gid: '', window_start: '', window_end: '',
        work_detail: { dualChannelProduct: p } }] };
    };
    pool.connect = async () => ({ query: pool.query, release() {} });
    const r = res(); let thrown;
    await router.handlers.adminStatus({ params: { id: 'camp_dual_local' }, body: { status: 'active' }, admin: { role: 'admin' }, query: {}, headers: {} }, r, e => { thrown = e; });
    assert.notEqual(r.statusCode, 409, JSON.stringify(r.body));
    assert.notEqual(r.statusCode, 400, JSON.stringify(r.body));
    assert.ok(writes.some(s => /recruit_campaigns/i.test(s)), 'status UPDATE 에 도달해야 한다: ' + (thrown && thrown.message));
  });
}

test('출시 상태: 모집중 참여형 동시진행의 전체 수정은 활성화 게이트에서 준비중으로 막히지 않는다', async () => {
  let connections = 0;
  const current = { id: 'camp_dual_local', title: '로컬 시험 공고', status: 'active', participation_mode: true, channel: '네이버+쿠팡',
    channel_custom: '', badges: [], daily_limit: 3, recruit_total: 3, linked_sheet_id: '', linked_tab_name: '', linked_tab_gid: '',
    window_start: '', window_end: '', work_detail: { dualChannelProduct: p } };
  pool.query = async sql => {
    if (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(String(sql))) throw new Error('대역: 쓰기 중단');
    return { rows: /FROM recruit_campaigns\b/i.test(String(sql)) ? [current] : [] };
  };
  pool.connect = async () => { connections++; throw new Error('대역: 연결 금지'); };
  const settings = require('../src/services/dualChannelSettings.service');
  const realSave = settings.saveCampaignSettings; const saves = [];
  settings.saveCampaignSettings = async args => { saves.push(args); return { status: 200, body: { ok: true, data: { ...current, title: args.body.title } } }; };
  const r = res(); let thrown;
  try {
  await router.handlers.adminUpdate({ params: { id: current.id }, admin: { role: 'admin', name: '로컬 검사' }, query: {}, headers: {},
    body: { title: '수정 제목', channel: '네이버+쿠팡', status: 'active', participation_mode: true, daily_limit: 3, recruit_total: 3,
      work_detail: { productLines: '', dualChannelProduct: p } } }, r, e => { thrown = e; });
  } finally { settings.saveCampaignSettings = realSave; }
  if (thrown) throw thrown;
  assert.notEqual(r.statusCode, 400, JSON.stringify(r.body));
  assert.notEqual(r.statusCode, 409, JSON.stringify(r.body));
  // 활성화 게이트를 지나 동시진행 전용 저장(saveCampaignSettings — 그 안의 검증·트랜잭션은 별도 시험)까지 도달했다.
  assert.equal(saves.length, 1);
  assert.equal(saves[0].body.status, 'active');
  assert.equal(r.statusCode, 200);
  assert.equal(connections, 0);
});
