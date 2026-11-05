/**
 * 블랙리스트 해제 ↔ 공고별 참여 불가 · 리뷰어 삭제 사유 (2026-10-01 이미정 건)
 *
 * ① 블랙리스트를 풀면 남은 공고별 차단 개수를 알리고, 확인 후 함께 푼다('block' 만 · 소프트 해제).
 * ② 계좌 변경 기록이 리뷰어를 붙잡아 삭제가 막히면 "서버오류" 대신 사유를 409 로 말한다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = p => path.join(__dirname, '..', 'src', p);
let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

function stubPool(handler) {
  const calls = [];
  const stub = {
    query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params) || { rows: [], rowCount: 0 }; },
    connect: async () => ({ query: stub.query, release() {} }),
  };
  return { stub, calls };
}
async function withModule(rel, handler, run) {
  const poolPath = require.resolve(SRC('db/pool'));
  const modPath = require.resolve(SRC(rel));
  const { stub, calls } = stubPool(handler);
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  delete require.cache[modPath];
  try { return await run(require(modPath), calls); }
  finally {
    delete require.cache[modPath];
    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
  }
}

(async function main() {
  console.log('\n§1 공고별 차단 — 세기·풀기');
  await ta('1a 남은 차단과 그중 모집 중 개수를 센다', async () => {
    await withModule('services/reviewerGate.service', (sql) => {
      if (/FROM campaign_reviewer_gates g/.test(sql)) return { rows: [{ total: 39, live: 7 }] };
    }, async (svc, calls) => {
      const r = await svc.countCampaignBlocks('010-3765-3335');
      assert.deepStrictEqual(r, { total: 39, live: 7 });
      assert.deepStrictEqual(calls[0].params, ['37653335'], '뒤 8자리로 찾는다');
      assert.ok(/g\.mode = 'block'/.test(calls[0].sql) && /released_at IS NULL/.test(calls[0].sql));
    });
  });
  await ta('1b ★ 풀기는 block 만 · 소프트 해제(이력 보존) · 허용 예외(allow)는 건드리지 않는다', async () => {
    await withModule('services/reviewerGate.service', (sql) => {
      if (/UPDATE campaign_reviewer_gates/.test(sql)) return { rows: [], rowCount: 39 };
    }, async (svc, calls) => {
      const r = await svc.releaseCampaignBlocks('01037653335', '박세희');
      assert.deepStrictEqual(r, { released: 39 });
      const sql = calls[0].sql;
      assert.ok(/SET released_at = NOW\(\), released_by = \$2/.test(sql));
      assert.ok(/mode = 'block'/.test(sql) && !/DELETE/i.test(sql));
      assert.deepStrictEqual(calls[0].params, ['37653335', '박세희']);
    });
  });
  await ta('1c 번호가 짧으면 세지 않고(null) 풀지도 않는다', async () => {
    await withModule('services/reviewerGate.service', () => null, async (svc, calls) => {
      assert.strictEqual(await svc.countCampaignBlocks('123'), null);
      await assert.rejects(() => svc.releaseCampaignBlocks('123', 'x'));
      assert.strictEqual(calls.length, 0);
    });
  });

  console.log('\n§2 라우트 실행');
  const getRoute = (router, p) => {
    const l = router.stack.find(x => x.route && x.route.path === p && x.route.methods.post);
    if (!l) throw new Error(p + ' 없음');
    return l.route.stack;
  };
  const fakeRes = () => { const o = { code: 200 }; o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; }; return o; };

  await ta('2a ★ 삭제가 계좌 변경 기록에 막히면 409 + 사유(서버오류 아님) + 재가입 불필요 안내', async () => {
    await withModule('routes/trackB.routes', (sql) => {
      if (/SELECT id, name, phone, phone8 FROM reviewers/.test(sql)) return { rows: [{ id: 'x', name: '이미정', phone: '01037653335', phone8: '37653335' }] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
      if (/DELETE FROM reviewers/.test(sql)) {
        const e = new Error('update or delete on table "reviewers" violates RESTRICT setting of foreign key constraint "reviewer_account_change_audit_reviewer_id_fkey" on table "reviewer_account_change_audit"');
        e.code = '23001'; throw e;
      }
    }, async (router) => {
      const h = getRoute(router, '/reviewers/delete');
      const res = fakeRes(); let nextErr = null;
      await h[h.length - 1].handle({ body: { id: '2ac5dad5-e004-4a84-a4bb-5cb79ed56c25', force: true }, admin: { name: 't' } }, res, e => { nextErr = e; });
      assert.strictEqual(nextErr, null, '서버오류로 넘기지 않는다');
      assert.strictEqual(res.code, 409);
      assert.strictEqual(res.body.code, 'delete_blocked_by_history');
      assert.ok(/계좌 변경 기록/.test(res.body.error) && /다시 가입할 필요/.test(res.body.error));
    });
  });

  await ta('2b ★ 블랙리스트 해제 = 공고별 차단도 같은 트랜잭션에서 함께 푼다(묻지 않는다)', async () => {
    await withModule('services/reviewerGate.service', (sql) => {
      if (/UPDATE campaign_reviewer_gates/.test(sql)) return { rows: [], rowCount: 20 };
    }, async (svc, calls) => {
      const r = await svc.setGlobalBlacklist({ phone: '010-5767-1782', on: false, by: '박세희' });
      assert.deepStrictEqual(r, { on: false, campaignBlocksReleased: 20 });
      const seq = calls.map(c => c.sql.trim().split(/\s+/).slice(0, 2).join(' '));
      assert.deepStrictEqual(seq, ['BEGIN', 'DELETE FROM', 'UPDATE campaign_reviewer_gates', 'COMMIT']);
    });
  });

  await ta('2c 풀다가 실패하면 블랙리스트 해제도 되돌린다(반쪽 상태 금지)', async () => {
    await withModule('services/reviewerGate.service', (sql) => {
      if (/UPDATE campaign_reviewer_gates/.test(sql)) throw new Error('boom');
    }, async (svc, calls) => {
      await assert.rejects(() => svc.setGlobalBlacklist({ phone: '01057671782', on: false, by: 'x' }));
      assert.ok(calls.some(c => /ROLLBACK/.test(c.sql)) && !calls.some(c => /COMMIT/.test(c.sql)));
    });
  });

  /* ★ 결정 050 개정(사용자 확정 2026-11-05 「b」) — 종전 2d(「등록은 공고별 차단을 건드리지 않는다」)를 뒤집는다.
     등록 = 같은 트랜잭션에서 보관 안 된 공고 전부에 「참여 불가」를 **더하기만** 한다(기존 행 UPDATE·DELETE 0 · 허용 예외 무접촉). */
  await ta('2d 블랙리스트 등록(on) = 같은 트랜잭션에서 보관 안 된 공고에 차단을 더한다(기존 행은 건드리지 않는다)', async () => {
    await withModule('services/reviewerGate.service', (sql) => {
      if (/INSERT INTO blacklist/.test(sql)) return { rows: [{ name: '김가짜' }] };
      if (/INSERT INTO campaign_reviewer_gates/.test(sql)) return { rows: [], rowCount: 17 };
    }, async (svc, calls) => {
      const r = await svc.setGlobalBlacklist({ phone: '01057671782', on: true, reason: 'r', by: '박세희' });
      assert.deepStrictEqual(r, { on: true, campaignBlocksAdded: 17 });
      const kinds = calls.map(c => /^BEGIN|^COMMIT/.test(c.sql) ? c.sql : /INSERT INTO blacklist/.test(c.sql) ? 'blacklist' : /INSERT INTO campaign_reviewer_gates/.test(c.sql) ? 'gates' : '?');
      assert.deepStrictEqual(kinds, ['BEGIN', 'blacklist', 'gates', 'COMMIT'], '한 트랜잭션');
      const gate = calls.find(c => /INSERT INTO campaign_reviewer_gates/.test(c.sql));
      assert.ok(/c\.archived_at IS NULL/.test(gate.sql), '보관된 공고는 대상 아님');
      assert.ok(/NOT EXISTS[\s\S]*released_at IS NULL/.test(gate.sql), '활성 행(허용·이미 차단)이 있으면 건드리지 않는다');
      assert.ok(/'block', 'closed'/.test(gate.sql), '「마감」으로 보인다');
      assert.ok(/ON CONFLICT DO NOTHING/.test(gate.sql));
      assert.deepStrictEqual(gate.params, ['57671782', '김가짜', '박세희 · 블랙리스트 자동']);
      assert.ok(!calls.some(c => /UPDATE campaign_reviewer_gates|DELETE FROM campaign_reviewer_gates/.test(c.sql)));
    });
  });
  await ta('2e 공고 차단을 넣다 실패하면 블랙리스트 등록도 되돌린다(반쪽 등록 금지)', async () => {
    await withModule('services/reviewerGate.service', (sql) => {
      if (/INSERT INTO campaign_reviewer_gates/.test(sql)) throw new Error('db down');
    }, async (svc, calls) => {
      await assert.rejects(() => svc.setGlobalBlacklist({ phone: '01057671782', on: true, reason: 'r', by: 'x' }));
      assert.ok(calls.some(c => /ROLLBACK/.test(c.sql)) && !calls.some(c => /COMMIT/.test(c.sql)));
    });
  });
  await ta('2f 새 공고 = 블랙리스트 전원을 그 공고에 차단(뒤 8자리 · 활성 행 있으면 무접촉)', async () => {
    await withModule('services/reviewerGate.service', (sql) => {
      if (/INSERT INTO campaign_reviewer_gates/.test(sql)) return { rows: [], rowCount: 50 };
    }, async (svc, calls) => {
      assert.deepStrictEqual(await svc.blockBlacklistOnCampaign('camp_x', '김담당'), { added: 50 });
      assert.deepStrictEqual(calls[0].params, ['camp_x', '김담당 · 블랙리스트 자동']);
      assert.ok(/FROM blacklist/.test(calls[0].sql) && /RIGHT\(REGEXP_REPLACE\(phone/.test(calls[0].sql));
      assert.ok(/NOT EXISTS[\s\S]*released_at IS NULL/.test(calls[0].sql) && /ON CONFLICT DO NOTHING/.test(calls[0].sql));
      assert.deepStrictEqual(await svc.blockBlacklistOnCampaign('', 'x'), { added: 0 });
      assert.strictEqual(calls.length, 1);
    });
  });

  console.log('\n§3 배선');
  const rt = fs.readFileSync(SRC('routes/trackB.routes.js'), 'utf8');
  const dg = fs.readFileSync(SRC('routes/diag.routes.js'), 'utf8');
  const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  t('3a 관리자 대시보드 옛 해제 경로도 같은 함수를 쓴다(어디서 풀든 같은 결과)', () =>
    assert.ok((() => { const i = dg.indexOf("case 'remove'"), j = dg.indexOf("case 'check'", i); return i >= 0 && j > i && /setGlobalBlacklist\(\{ phone: cleanPhone, on: false/.test(dg.slice(i, j)); })()));
  t('3a3 ★ 옛 등록 경로도 공고별 차단을 같은 함수로 넣는다(결정 050 개정)', () =>
    assert.ok((() => { const i = dg.indexOf("case 'add'"), j = dg.indexOf("case 'remove'", i); return i >= 0 && j > i && /blockOnOpenCampaigns\(\{ phone8: cleanPhone/.test(dg.slice(i, j)); })()));
  t('3a4 ★ 새 공고 생성은 저장 직후 블랙리스트 전원을 차단한다(fail-soft)', () => {
    const cr = fs.readFileSync(SRC('routes/campaign.routes.js'), 'utf8');
    const ins = cr.indexOf('INSERT INTO recruit_campaigns'), call = cr.indexOf('.blockBlacklistOnCampaign(rows[0].id', ins);
    assert.ok(ins > 0 && call > ins, '공고 INSERT 뒤에 부른다');
    assert.ok(/try \{ await require\('\.\.\/services\/reviewerGate\.service'\)\.blockBlacklistOnCampaign[\s\S]{0,200}catch \(e\) \{ blacklistWarning/.test(cr), '실패해도 공고 생성은 유지');
  });
  t('3a2 ★ 옛 해제 경로는 관리자·마스터만(일괄 해제 권한 확대 금지)', () =>
    assert.ok(/case 'remove'[\s\S]{0,500}role !== 'admin' && role !== 'master'[\s\S]{0,200}status\(403\)[\s\S]{0,400}setGlobalBlacklist/.test(dg)));
  t('3b 새 서버에는 따로 푸는 창구가 없고 화면 확인창도 없다 · 옛 서버 응답일 때만 옛 창구로 대신 푼다', () => {
    assert.ok(!/campaign-blocks\/release/.test(rt));
    assert.ok(/campaignBlocksReleased===undefined && resp\.campaignBlocks && resp\.campaignBlocks\.total>0/.test(wd));
    const i = wd.indexOf('async function _rvBlkToggle('), body = wd.slice(i, wd.indexOf('\n}\n', i));
    assert.ok(!/confirm\(/.test(body));
    assert.ok(/campaignBlocksReleased/.test(body), '함께 푼 개수를 말한다');
  });

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
