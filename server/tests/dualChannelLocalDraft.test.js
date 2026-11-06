'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const scriptPath = path.resolve(__dirname, '../scripts/dual-channel-local-preview.cjs');
const product = () => ({ name: '로컬 시험 상품', option_schema_version: 2, product_mode: 'none',
  base: { pay: 19000, count: 3, daily: 1 }, url: 'https://shop.example/naver', options: [],
  channels: {
    naver: { url: 'https://shop.example/naver', pay: 9000, inflow_type: 'guide',
      guide: { text: '검색 → 상품 확인\n네이버 전용 안내', images: ['https://img.example/naver.png'] } },
    coupang: { url: 'https://shop.example/coupang', pay: 10000, inflow_type: 'link',
      guide: { text: '쿠팡 전용 안내', images: ['https://img.example/coupang.png'] } },
  } });
const payload = () => ({ title: '가짜 임시저장', status: 'draft', channel: '네이버+쿠팡',
  recruit_total: 3, daily_limit: 1,
  work_detail: { productLines: '원래 상품 안내', notesText: '보존할 안내',
    opaqueMetadata: { revision: 7 }, dualChannelProduct: product() } });

function request(origin, route, method = 'GET', body, headers = {}) {
  const text = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(origin + route, { method, headers: {
      ...(text === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(raw); } catch (_) { /* static response */ }
        resolve({ status: res.statusCode, json, text: raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

// Deliberate feature assertion, not a MODULE_NOT_FOUND setup error, on the RED run.
test('개발 전용 진입점이 실제 HTTP와 PGlite 저장·재조회 기능을 제공한다', async t => {
  assert.ok(fs.existsSync(scriptPath), '로컬 전용 HTTP 저장 서버가 아직 구현되지 않았습니다');
  const { startLocalPreview } = require(scriptPath);
  const app = await startLocalPreview({ port: 0 });
  t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  const status = await request(app.origin, '/__dual-preview/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.localOnly, true);
  assert.equal(status.json.storage, 'pglite');
  assert.equal(status.json.productionReady, false);
  const sent = payload();
  const saved = await request(app.origin, '/__dual-preview/drafts', 'POST', sent);
  assert.equal(saved.status, 201, saved.text);
  const id = saved.json.data.id;
  const read = await request(app.origin, '/__dual-preview/drafts/' + id);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.json.data.work_detail, sent.work_detail);
  assert.equal(read.json.data.recruit_total, 3);
  const sql = await app.store.db.query('SELECT work_detail, recruit_total, status FROM recruit_campaigns WHERE id=$1', [id]);
  assert.deepEqual(sql.rows[0].work_detail.dualChannelProduct, sent.work_detail.dualChannelProduct);
  assert.equal(sql.rows[0].status, 'draft');
});

test('같은 id 수정·옛 화면 미전송 보존·없는 id 거부·SQL 실패 되돌림', async t => {
  const { startLocalPreview } = require(scriptPath);
  const app = await startLocalPreview({ port: 0 });
  t.after(() => app.close());
  const first = await request(app.origin, '/__dual-preview/drafts', 'POST', payload());
  const other = await request(app.origin, '/__dual-preview/drafts', 'POST', { ...payload(), title: '다른 초안' });
  const id = first.json.data.id;
  const route = '/__dual-preview/drafts/' + id;
  const p = product();
  p.channels.naver.pay = '11000';
  p.channels.coupang.pay = '12000';
  p.channels.naver.guide.text = '새 네이버 안내';
  p.channels.coupang.guide.images.push('https://img.example/coupang-2.png');
  p.base = { pay: '23000', count: '4', daily: '2' };
  const updated = await request(app.origin, route, 'PUT', { title: '수정 초안', recruit_total: 4, daily_limit: 2,
    work_detail: { dualChannelProduct: p } });
  assert.equal(updated.status, 200, updated.text);
  const reloaded = await request(app.origin, route);
  assert.equal(reloaded.json.data.id, id);
  assert.equal(reloaded.json.data.work_detail.dualChannelProduct.base.pay, 23000);
  assert.equal(reloaded.json.data.work_detail.dualChannelProduct.base.count, 4);
  assert.equal(reloaded.json.data.work_detail.dualChannelProduct.base.daily, 2);
  assert.equal(reloaded.json.data.work_detail.dualChannelProduct.channels.naver.pay, 11000);
  assert.deepEqual(reloaded.json.data.work_detail.opaqueMetadata, { revision: 7 });
  assert.equal(reloaded.json.data.work_detail.notesText, '보존할 안내');
  const storedProduct = reloaded.json.data.work_detail.dualChannelProduct;
  for (const oldBody of [{ title: '옛 화면 제목만 변경' }, { work_detail: { notesText: '다른 안내 변경' } }]) {
    const oldSave = await request(app.origin, route, 'PUT', oldBody);
    assert.equal(oldSave.status, 200, oldSave.text);
    assert.deepEqual(oldSave.json.data.work_detail.dualChannelProduct, storedProduct);
    assert.deepEqual((await request(app.origin, route)).json.data.work_detail.dualChannelProduct, storedProduct);
  }
  assert.deepEqual((await request(app.origin, '/__dual-preview/drafts/' + other.json.data.id)).json, other.json);
  assert.equal((await app.store.db.query('SELECT COUNT(*)::integer AS n FROM recruit_campaigns')).rows[0].n, 2);
  const snapshot = async () => (await app.store.db.query('SELECT * FROM recruit_campaigns ORDER BY id')).rows;
  const before = await snapshot();
  for (const body of [{ work_detail: null }, { work_detail: { dualChannelProduct: null } },
    { recruit_total: 999 }, { daily_limit: 999 }, { status: 'active' }, { source_work_order_id: 'wo' }]) {
    const denied = await request(app.origin, route, 'PUT', body);
    assert.equal(denied.status, 400, denied.text);
    assert.deepEqual(await snapshot(), before);
  }
  const missing = '/__dual-preview/drafts/local-dual-00000000-0000-0000-0000-000000000000';
  for (const method of ['GET', 'PUT']) {
    const absent = await request(app.origin, missing, method, method === 'PUT' ? payload() : undefined);
    assert.equal(absent.status, 404, absent.text);
    assert.equal(absent.json.code, 'draft_not_found');
  }
  // The first write really succeeds, then a second real SQL statement fails.
  // A mere failed UPDATE (statement rollback) would not prove transaction rollback.
  const transaction = app.store.db.transaction.bind(app.store.db);
  app.store.db.transaction = fn => transaction(tx => fn({ query: async (sql, params) => {
    const result = await tx.query(sql, params);
    if (/^\s*(INSERT|UPDATE)\b/i.test(sql) && params[1] === '강제실패') {
      await tx.query('SELECT * FROM local_preview_deliberately_missing_table');
    }
    return result;
  } }));
  for (const [endpoint, method, body] of [
    [route, 'PUT', { title: '강제실패' }],
    ['/__dual-preview/drafts', 'POST', { ...payload(), title: '강제실패' }],
  ]) {
    const failed = await request(app.origin, endpoint, method, body);
    assert.equal(failed.status, 500, failed.text);
    assert.equal(failed.json.code, 'local_storage_failed');
    assert.ok(!failed.text.includes('local_preview_deliberately_missing_table'));
    assert.deepEqual(await snapshot(), before, 'INSERT/UPDATE 뒤 실패해도 기존 두 초안 전부 불변');
  }
  assert.equal((await request(app.origin, route, 'PUT', { title: '실패 뒤 다시 정상 저장' })).status, 200);
});

test('구매처·사진 내부 제어문자 PUT 거부는 모든 DB 행과 재조회 초안을 보존한다', async t => {
  const { startLocalPreview } = require(scriptPath);
  const app = await startLocalPreview({ port: 0 });
  t.after(() => app.close());
  const sent = payload();
  const url = 'HTTPS://Short.Example:443/a%0Ab%09c%00d%7f?q=%2f#Part';
  for (const channel of Object.values(sent.work_detail.dualChannelProduct.channels)) {
    channel.url = '\n\t ' + url + ' \r\n';
    channel.guide.images = ['\n\t ' + url + ' \r\n'];
  }
  const first = await request(app.origin, '/__dual-preview/drafts', 'POST', sent);
  assert.equal(first.status, 201, first.text);
  for (const channel of Object.values(first.json.data.work_detail.dualChannelProduct.channels)) {
    assert.equal(channel.url, url);
    assert.deepEqual(channel.guide.images, [url]);
  }
  const other = await request(app.origin, '/__dual-preview/drafts', 'POST', payload());
  assert.equal(other.status, 201, other.text);
  const route = '/__dual-preview/drafts/' + first.json.data.id;
  const snapshot = async () => (await app.store.db.query('SELECT * FROM recruit_campaigns ORDER BY id')).rows;
  const before = await snapshot();
  let writes = 0;
  const transaction = app.store.db.transaction.bind(app.store.db);
  app.store.db.transaction = fn => transaction(tx => fn({ query: (sql, params) => {
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes++;
    return tx.query(sql, params);
  } }));
  for (const channel of ['naver', 'coupang']) for (const field of ['url', 'image']) {
    for (const code of [10, 9, 13, ...[...Array(32).keys()].filter(n => ![10, 9, 13].includes(n)), 127]) {
      const p = product();
      const badUrl = 'https://shop.example/private-url-marker' + String.fromCharCode(code) + 'item';
      if (field === 'url') p.channels[channel].url = badUrl;
      else p.channels[channel].guide.images = [badUrl];
      const denied = await request(app.origin, route, 'PUT', {
        title: '잘못된 주소와 함께 바꾸려던 제목', work_detail: { dualChannelProduct: p },
      });
      assert.equal(denied.status, 400, `${channel} ${field} control ${code}`);
      assert.equal(denied.json.code, 'invalid_dual_channel');
      assert.doesNotMatch(denied.text, /private-url-marker/);
      assert.deepEqual(await snapshot(), before, '시각·제목·설정 포함 두 행 전체 불변');
      assert.deepEqual((await request(app.origin, route)).json, first.json);
      assert.equal(writes, 0);
    }
  }
  const recovered = await request(app.origin, route, 'PUT', { title: '거부 후 정상 수정' });
  assert.equal(recovered.status, 200, recovered.text);
  assert.deepEqual(recovered.json.data.work_detail, first.json.data.work_detail);
});

test('루프백 동일출처·요청 제한·프론트 파일 격리·운영 API 차단', async t => {
  const { startLocalPreview, BODY_LIMIT } = require(scriptPath);
  const app = await startLocalPreview({ port: 0 });
  t.after(() => app.close());
  const statusRoute = '/__dual-preview/status';
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' },
    { Origin: 'null' }, { Origin: app.origin.replace('127.0.0.1', 'localhost') }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(app.origin, statusRoute, 'GET', undefined, headers)).status, 403);
  }
  for (const headers of [{ Origin: '' }, { Origin: 'https://evil.example' },
    { Origin: app.origin + '/extra' }, { Host: 'localhost:1' }]) {
    assert.equal((await request(app.origin, '/__dual-preview/drafts', 'POST', payload(), headers)).status, 403);
  }
  assert.equal((await request(app.origin, '/__dual-preview/drafts', 'POST', payload(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request(app.origin, '/__dual-preview/drafts', 'POST', '{bad json')).status, 400);
  const big = await request(app.origin, '/__dual-preview/drafts', 'POST', JSON.stringify({ title: 'x'.repeat(BODY_LIMIT) }));
  assert.equal(big.status, 413, big.text);
  for (const route of ['/api/campaign/admin/create', '/api/admin/login', '/api/order/intake/source/fake']) {
    for (const method of ['GET', 'POST', 'PUT']) {
      assert.equal((await request(app.origin, route, method, method === 'GET' ? undefined : payload())).status, 404);
    }
  }
  for (const route of ['/../AGENTS.md', '/%2e%2e/AGENTS.md', '/%2e%2e/server/package.json',
    '/..%5cserver/package.json', '/.env', '/.git/config', '/server/package.json', '/%00.js', '/%zz']) {
    assert.notEqual((await request(app.origin, route)).status, 200, route);
  }
  const frontend = await request(app.origin, '/js/recruit-modal.js');
  assert.equal(frontend.status, 200);
  assert.equal(frontend.text, fs.readFileSync(path.resolve(__dirname, '../../frontend/js/recruit-modal.js'), 'utf8'));
  assert.match(frontend.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal(frontend.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(app.origin, '/js/recruit-modal.js', 'HEAD')).text, '');
  assert.equal((await request(app.origin, '/__dual-preview/drafts', 'DELETE')).status, 405);
  assert.equal((await app.store.db.query('SELECT COUNT(*)::integer AS n FROM recruit_campaigns')).rows[0].n, 0);
});

test('활성화·연결·인원 불일치·잘못된 자료는 HTTP 쓰기를 한 건도 남기지 않는다', async t => {
  const { startLocalPreview } = require(scriptPath);
  const app = await startLocalPreview({ port: 0 });
  t.after(() => app.close());
  // Observe SQL, but every allowed query still executes against the real PGlite.
  let writes = 0;
  const transaction = app.store.db.transaction.bind(app.store.db);
  app.store.db.transaction = fn => transaction(tx => fn({ query: (sql, params) => {
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes++;
    return tx.query(sql, params);
  } }));
  const invalid = [
    ['활성화', p => { p.status = 'active'; }],
    ['닫힘 상태', p => { p.status = 'closed'; }],
    ['다른 채널', p => { p.channel = '네이버'; }],
    ['원본 연결', p => { p.source_work_order_id = 'actual-work'; }],
    ['빈 원본 연결 필드도 거부', p => { p.source_work_order_id = ''; }],
    ['작업표 연결', p => { p.linked_sheet_id = 'actual-sheet'; }],
    ['이름 연결', p => { p.linked_tab_name = 'actual-tab'; }],
    ['gid 연결', p => { p.linked_tab_gid = '123'; }],
    ['중첩 연결 위장', p => { p.work_detail.source_work_order_id = 'actual-work'; }],
    ['내부 정규화 위장', p => { p._normalized_work_detail = p.work_detail; }],
    ['합계 불일치', p => { p.work_detail.dualChannelProduct.base.pay = 1; }],
    ['인원 불일치', p => { p.recruit_total = 4; }],
    ['일일 인원 불일치', p => { p.daily_limit = 2; }],
    ['null 전체 안내', p => { p.work_detail = null; }],
    ['null 상품', p => { p.work_detail.dualChannelProduct = null; }],
    ['null 제목', p => { p.title = null; }],
    ['빈 제목', p => { p.title = ' '; }],
    ['null 인원', p => { p.recruit_total = null; }],
    ['불리언 인원', p => { p.recruit_total = true; }],
    ['null 일일 인원', p => { p.daily_limit = null; }],
    ['null 기본 일일 인원', p => { p.work_detail.dualChannelProduct.base.daily = null; }],
    ['음수 기본 일일 인원', p => { p.work_detail.dualChannelProduct.base.daily = -1; }],
    ['문자 스키마', p => { p.work_detail.dualChannelProduct.option_schema_version = '2'; }],
    ['잘못된 부모 주소', p => { p.work_detail.dualChannelProduct.url = 'javascript:alert(1)'; }],
    ['잘못된 구매처 주소', p => { p.work_detail.dualChannelProduct.channels.naver.url = 'javascript:alert(1)'; }],
    ['가이드 누락', p => { p.work_detail.dualChannelProduct.channels.naver.guide = null; }],
    ['옵션 끼우기', p => { p.work_detail.dualChannelProduct.options = [{ name: '추가' }]; }],
    ['배열 본문', () => []], ['null 본문', () => null],
  ];
  for (const [label, mutate] of invalid) await t.test(label, async () => {
    const body = payload();
    const changed = mutate(body);
    const before = (await app.store.db.query('SELECT * FROM recruit_campaigns ORDER BY id')).rows;
    const res = await request(app.origin, '/__dual-preview/drafts', 'POST', changed === undefined ? body : changed);
    assert.equal(res.status, 400, res.text);
    assert.deepEqual((await app.store.db.query('SELECT * FROM recruit_campaigns ORDER BY id')).rows, before);
    assert.equal(writes, 0, '검증 실패는 INSERT/UPDATE/DELETE 실행 자체가 없어야 한다');
  });
});

test('동시 수정도 미전송 메타데이터를 잃지 않고 서버 재시작은 새 가짜 DB를 만든다', async t => {
  const { startLocalPreview } = require(scriptPath);
  const app = await startLocalPreview({ port: 0 });
  t.after(() => app.close());
  const saved = await request(app.origin, '/__dual-preview/drafts', 'POST', payload());
  const id = saved.json.data.id;
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    request(app.origin, '/__dual-preview/drafts/' + id, 'PUT', { work_detail: { ['extra_' + i]: '로컬 ' + i } })));
  assert.ok(results.every(r => r.status === 200), results.map(r => r.text).join('\n'));
  const after = await request(app.origin, '/__dual-preview/drafts/' + id);
  for (let i = 0; i < 12; i++) assert.equal(after.json.data.work_detail['extra_' + i], '로컬 ' + i);
  assert.deepEqual(after.json.data.work_detail.dualChannelProduct, payload().work_detail.dualChannelProduct);
  await app.close();
  const fresh = await startLocalPreview({ port: 0 });
  t.after(() => fresh.close());
  assert.equal((await request(fresh.origin, '/__dual-preview/drafts/' + id)).status, 404);
  assert.equal((await fresh.store.db.query('SELECT COUNT(*)::integer AS n FROM recruit_campaigns')).rows[0].n, 0);
});

test('보호 판정을 없앤 메모리 사본은 같은 실제 SQL 저장 검사에서 실패한다', async t => {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = path.resolve(__dirname, '../scripts/lib/dual-channel-draft-store.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = createRequire(filename);
  const variants = [
    ['정규화', 'const p = normalizeDualChannelProduct(wd.dualChannelProduct);',
      'const p = wd.dualChannelProduct;', async store => {
        const body = payload(); body.work_detail.dualChannelProduct.base.pay = 1;
        await assert.rejects(store.save(body), error => error.code === 'invalid_dual_channel');
        assert.equal((await store.db.query('SELECT COUNT(*)::integer AS n FROM recruit_campaigns')).rows[0].n, 0);
      }],
    ['전체 트랜잭션', 'return db.transaction(async tx => {',
      'return (async fn => fn(db))(async tx => {', async store => {
        const row = await store.save(payload());
        const wrap = query => async (sql, params) => {
          const result = await query(sql, params);
          if (/^\s*UPDATE\b/i.test(sql)) await query('SELECT * FROM local_preview_deliberately_missing_table');
          return result;
        };
        const transaction = store.db.transaction.bind(store.db);
        store.db.transaction = fn => transaction(tx => fn({ query: wrap(tx.query.bind(tx)) }));
        store.db.query = wrap(store.db.query.bind(store.db));
        await assert.rejects(store.save({ title: '첫 SQL 성공 뒤 실패' }, row.id), /local_preview_deliberately_missing_table/);
        assert.deepEqual(await store.read(row.id), row, '실패 전 성공한 SQL까지 반드시 되돌려야 한다');
      }],
  ];
  for (const [name, from, to, contract] of variants) await t.test(name, async () => {
    assert.equal(source.split(from).length, 2, '정확히 한 보호 경계만 바꾼다');
    for (const isMutant of [false, true]) {
      const mod = { exports: {} };
      const text = isMutant ? source.replace(from, to) : source;
      vm.runInThisContext('(function(require,module,exports){\n' + text + '\n})', { filename })(localRequire, mod, mod.exports);
      const store = await mod.exports.createDraftStore();
      try {
        if (isMutant) await assert.rejects(contract(store), error => error.code === 'ERR_ASSERTION',
          '문법·import 오류가 아니라 대응 행동 검사의 단언이 실패해야 한다');
        else await contract(store);
      } finally { await store.close(); }
    }
  });
});
