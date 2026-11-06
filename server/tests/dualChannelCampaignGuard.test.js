'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db/pool');
const router = require('../src/routes/campaign.routes');
const originalQuery = pool.query;
const originalConnect = pool.connect;
test.after(() => { pool.query = originalQuery; pool.connect = originalConnect; });

const p = { name: '로컬 시험 상품', product_mode: 'none', options: [], base: { pay: 19000, count: 3 },
  channels: { naver: { url: 'https://shop.example/naver', pay: 9000, inflow_type: 'link' },
    coupang: { url: 'https://shop.example/coupang', pay: 10000, inflow_type: 'link' } } };
const variants = [
  ['채널 표기', { channel: '네이버+쿠팡' }],
  ['상품 본문', { work_detail: { dualChannelProduct: p } }],
  ['깨진 설정도 조용히 버리지 않음', { work_detail: { dualChannelProduct: null } }],
  ['선택지에 숨긴 구매처', { options: [{ optKey: '시험 상품', channels: p.channels }] }],
  ['문자열 작업내용', { work_detail: JSON.stringify({ dualChannelProduct: p }) }],
  ['빈 전용 객체', { work_detail: { dualChannelProduct: {} } }],
  ['직접입력 채널', { channel: '직접입력', channel_custom: '네이버+쿠팡' }],
];

async function blocked(handler, body, admin = { name: '로컬 검사', role: 'admin' }) {
  const writes = [];
  pool.query = async sql => {
    const s = String(sql);
    if (/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i.test(s)) {
      writes.push(s);
      throw new Error('준비중 차단 전에 저장을 시도했습니다');
    }
    return { rows: [] };
  };
  pool.connect = async () => { throw new Error('준비중 요청은 쓰기 연결을 열 수 없습니다'); };
  const req = { body: { title: '로컬 시험 공고', status: 'draft', ...body }, params: { id: 'camp_dual_local' }, admin, query: {}, headers: {} };
  const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
  let thrown;
  await handler(req, res, e => { thrown = e; });
  assert.equal(res.statusCode, 409, JSON.stringify(res.body) + (thrown ? ' / ' + thrown.message : ''));
  assert.equal(res.body.code, 'dual_channel_not_ready');
  assert.equal(writes.length, 0);
}

for (const [name, body] of variants) {
  test('신규 공고: ' + name + '는 저장 전에 거부', () => blocked(router.handlers.adminCreate, body));
  test('공고 수정: ' + name + '는 저장 전에 거부', () => blocked(router.handlers.adminUpdate, body));
  test('리뷰어 앱 수정: ' + name + '도 우회 불가', () => blocked(router.handlers.adminUpdate, body, { via: 'reviewer_campaign' }));
}

test('본문의 허용 표시만으로 공고 저장을 열지 않는다', () => blocked(router.handlers.adminCreate, {
  channel: '네이버+쿠팡', allowDualChannels: true, bidir: { dual_channel: 1 },
}));

async function blockedStored(body, participationMode, scoped = false, stored = { work_detail: { dualChannelProduct: p } }, expectBlocked = true) {
  let writes = 0;
  let connections = 0;
  const current = { id: 'camp_dual_local', title: '로컬 시험 공고', status: 'draft',
    participation_mode: participationMode, channel: '쿠팡', badges: [], daily_limit: 1,
    linked_sheet_id: 'local', linked_tab_name: 'local', linked_tab_gid: 'local', ...stored };
  pool.query = async sql => {
    const s = String(sql);
    if (/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i.test(s)) {
      writes++;
      throw new Error('저장된 동시진행을 쓰려고 했습니다');
    }
    return { rows: /FROM recruit_campaigns\b/i.test(s) ? [current] : [] };
  };
  pool.connect = async () => { connections++; throw new Error('쓰기 연결을 열려고 했습니다'); };
  const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
  let thrown;
  await router.handlers.adminUpdate({ params: { id: current.id }, body,
    admin: scoped ? { role: 'admin', via: 'reviewer_campaign', ia: true, iu: 'local' } : { role: 'admin' },
    query: {}, headers: {} }, res, e => { thrown = e; });
  if (!expectBlocked) {
    // 기존 단일구매는 종전 UPDATE까지 도달하며 대역에서 실제 쓰기를 중단한다.
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(thrown?.message, '저장된 동시진행을 쓰려고 했습니다');
    assert.equal(writes, 1);
    return;
  }
  assert.equal(res.statusCode, 409, JSON.stringify(res.body) + (thrown ? ' / ' + thrown.message : ''));
  assert.equal(res.body.code, 'dual_channel_not_ready');
  assert.equal(writes, 0);
  assert.equal(connections, 0);
}

for (const participationMode of [false, true]) {
  test('전체 수정은 본문에서 빠진 저장본 동시진행을 지우지 않는다: 참여형=' + participationMode,
    () => blockedStored({ channel: '쿠팡', status: 'draft', work_detail: { productLines: '기존상품' } }, participationMode));
  test('전체 수정 active도 저장본 동시진행이면 준비중으로 거부: 참여형=' + participationMode,
    () => blockedStored({ status: 'active' }, participationMode));
}
for (const status of ['draft', 'active']) {
  test('스코프 수정도 본문에 없는 저장본 동시진행을 쓰기 전에 거부: ' + status,
    () => blockedStored({ title: '변경 제목', status }, true, true));
}
for (const stored of [{ channel: '네이버+쿠팡' }, { work_detail: { dualChannelProduct: null } }]) {
  test('저장본 채널 표기와 깨진 전용 설정도 전체 수정으로 지울 수 없다: ' + JSON.stringify(stored),
    () => blockedStored({ title: '변경 제목' }, false, false, stored));
}

for (const scoped of [false, true]) {
  test('기존 단일구매 공고는 종전 수정 쓰기 경로를 유지한다: 스코프=' + scoped,
    () => blockedStored({ title: '변경 제목', status: 'draft' }, true, scoped, { work_detail: { productLines: '기존상품' } }, false));
}

for (const participationMode of [false, true]) {
  test('상태 버튼은 저장된 동시진행을 모집중으로 열지 않는다: 참여형=' + participationMode, async () => {
    let writes = 0;
    pool.query = async sql => {
      if (/UPDATE|INSERT|DELETE/.test(String(sql))) { writes++; throw new Error('미완성 모집을 열려고 했습니다'); }
      return { rows: [{ id: 'camp_dual_local', status: 'draft', participation_mode: participationMode,
        daily_limit: 1, work_detail: { dualChannelProduct: p } }] };
    };
    const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
    let thrown;
    await router.handlers.adminStatus({ params: { id: 'camp_dual_local' }, body: { status: 'active' }, admin: { role: 'admin' } }, res, e => { thrown = e; });
    if (thrown) throw thrown;
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'dual_channel_not_ready'); assert.equal(writes, 0);
  });
}
