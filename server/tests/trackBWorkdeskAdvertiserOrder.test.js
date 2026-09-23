// 업체목록 드래그 배치 원장: 순서 보존·계정 격리·입력 방어 회귀가드.
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function pool(row, opts = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ q, params });
      if (opts.missing && /INSERT INTO trackb_workdesk_advertiser_order/.test(q)) {
        const e = new Error('relation does not exist'); e.code = '42P01'; throw e;
      }
      if (/SELECT advertiser_keys AS/.test(q)) return { rows: row === undefined ? [] : [{ advertiserKeys: row }] };
      return { rows: [] };
    },
  };
}

(async () => {
  let db = pool(['업체B', '업체A']); svc.__setPoolForTest(db);
  assert.deepEqual(await svc.getWorkdeskAdvertiserOrder('kim'), { ok: true, advertiserKeys: ['업체B', '업체A'] });
  assert.equal(db.calls[0].params[0], 'kim', '조회는 로그인 사용자 키만 사용');

  db = pool(); svc.__setPoolForTest(db);
  const saved = await svc.setWorkdeskAdvertiserOrder('kim', ['업체B', '업체A', '업체B', '', 9, 'x'.repeat(301)]);
  assert.deepEqual(saved, { ok: true, count: 2 });
  const write = db.calls.find(x => /INSERT INTO trackb_workdesk_advertiser_order/.test(x.q));
  assert.ok(write && /ON CONFLICT \(owner_key\) DO UPDATE/.test(write.q), '계정별 upsert가 필요');
  assert.deepEqual(JSON.parse(write.params[1]), ['업체B', '업체A'], '드래그 순서를 그대로 저장하고 중복/오염만 제거');

  db = pool(); svc.__setPoolForTest(db);
  const noOwner = await svc.setWorkdeskAdvertiserOrder(' ', ['업체A']);
  assert.equal(noOwner.error, 'no_owner'); assert.equal(db.calls.length, 0, '빈 계정은 DB에 쓰지 않음');

  svc.__setPoolForTest(pool(undefined, { missing: true }));
  const unavailable = await svc.setWorkdeskAdvertiserOrder('kim', ['업체A']);
  assert.equal(unavailable.code, 'not_ready', '마이그레이션 누락은 조용히 저장 성공으로 꾸미지 않음');
  svc.__setPoolForTest(null);
  console.log('TRACKB WORKDESK ADVERTISER ORDER TESTS PASSED');
})().catch(err => { console.error(err); process.exit(1); });
