'use strict';

/**
 * 회귀가드: 인당 구매수량 단계 ③-가 — 공고 쪽 단계 표·참여 게이트·옵션 바꾸기 (결정 289, 2026-10-15).
 * 고정: (1) 발행 복사 짝짓기 — 옵션별 단계는 공고 옵션과 하나로 맞아야 하고, 못 맞추면 공고를 만들지 않는다
 *       (2) 단계 없는 공고 = 조회 1번 뒤 종전 그대로 (3) 개수 미선택·없는 개수·마감을 사유별로 막는다(사람 수 기준)
 *       (4) 공통 단계는 상품 안 모든 옵션이 함께 센다 (5) 배선 — 잠금 안 게이트·INSERT 뒤 UPDATE·이름 바꾸기·합치기·주문 전파·필수 스키마
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/campaignQtyTiers.service');

const ROOT = path.join(__dirname, '..');
const routes = fs.readFileSync(path.join(ROOT, 'src/routes/campaign.routes.js'), 'utf8');
const hold = fs.readFileSync(path.join(ROOT, 'src/services/campaignHold.service.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'migrations/202_campaign_qty_tiers.sql'), 'utf8');

const wo = (tiers, extra = {}) => JSON.stringify([{ name: '가습기', product_mode: 'opt', options: [{ label: '블랙' }, { label: '화이트' }], qty_tiers: tiers, ...extra }]);

test('발행 복사 — 공통 단계는 상품명, 옵션별 단계는 공고 옵션 이름(상품명 붙은 이름도)으로 짝짓는다', () => {
  const common = svc.planTierCopy(wo({ mode: 'common', buy_method: 'option', rows: [{ option: null, qty: 2, people: 40, amount: 20000 }, { option: null, qty: 1, people: 60, amount: 13000 }] }),
    [{ optKey: '블랙', productName: '가습기' }, { optKey: '화이트', productName: '가습기' }]);
  assert.deepEqual(common.map(r => [r.product_name, r.opt_key, r.qty, r.people, r.pay_amount, r.buy_method]),
    [['가습기', null, 2, 40, 20000, 'option'], ['가습기', null, 1, 60, 13000, 'option']]);
  const byOpt = svc.planTierCopy(wo({ mode: 'by_option', rows: [{ option: '블랙', qty: 1, people: 60, amount: 13000 }, { option: '화이트', qty: 1, people: 40, amount: 15000 }] }),
    [{ optKey: '가습기 블랙', productName: '가습기' }, { optKey: '화이트', productName: '가습기' }]);
  assert.deepEqual(byOpt.map(r => r.opt_key), ['가습기 블랙', '화이트']);
  assert.deepEqual(svc.planTierCopy(wo(undefined), []), [], '단계 없는 오더는 복사할 것이 없다');
  assert.deepEqual(svc.planTierCopy('not json', []), []);
});

test('발행 복사 — 짝지을 수 없으면 QtyTierError(공고를 만들지 않는다)', () => {
  assert.throws(() => svc.planTierCopy(wo({ mode: 'by_option', rows: [{ option: '레드', qty: 1, people: 1, amount: 1 }] }), [{ optKey: '블랙', productName: '가습기' }]),
    err => err instanceof svc.QtyTierError && /가습기 · 레드/.test(err.message));
  assert.throws(() => svc.planTierCopy(wo({ mode: 'common', rows: [{ qty: 1, people: 1, amount: 1 }] }), [{ optKey: '다른 상품', productName: '다른 상품' }]),
    err => err instanceof svc.QtyTierError);
  // 옵션 없는 공고(단일 상품)의 공통 단계는 그대로 복사
  assert.equal(svc.planTierCopy(wo({ mode: 'common', rows: [{ qty: 1, people: 1, amount: 1 }] }), []).length, 1);
});

/** 가짜 DB — 단계 표·옵션 표·참여 기록 셈 질의에만 답한다. */
function fakeDb({ tiers = [], options = [], usage = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(String(sql).replace(/\s+/g, ' ').trim());
      if (/FROM campaign_qty_tiers/.test(sql)) return { rows: tiers };
      if (/FROM campaign_options/.test(sql)) return { rows: options };
      if (/FROM campaign_applications/.test(sql)) {
        const exclude = params[1];
        return { rows: usage.filter(u => exclude == null || u.id !== exclude) };
      }
      return { rows: [] };
    },
  };
}
const T = (opt_key, qty, people, pay_amount, product_name = '가습기') => ({ product_name, opt_key, qty, people, pay_amount, buy_method: 'qty' });

test('단계 없는 공고 = 조회 1번 뒤 null(종전 동작)', async () => {
  const db = fakeDb();
  assert.equal(await svc.judge(db, 'c1', '블랙', undefined), null);
  assert.equal(db.calls.length, 1);
  process.env.CAMPAIGN_QTY_TIERS = '0';
  const off = fakeDb({ tiers: [T(null, 1, 1, 1)] });
  assert.equal(await svc.judge(off, 'c1', null, 1), null, '스위치 꺼짐 = 조회도 안 한다');
  assert.equal(off.calls.length, 0);
  delete process.env.CAMPAIGN_QTY_TIERS;
});

test('참여 판정 — 개수 미선택 · 없는 개수 · 단계 마감 · 전부 마감 · 통과', async () => {
  const tiers = [T(null, 3, 1, 30000), T(null, 1, 2, 13000)];
  const options = [{ opt_key: '블랙', product_name: '가습기' }, { opt_key: '화이트', product_name: '가습기' }];
  // 공통 단계: 블랙 3개 1명이 이미 있음 → 화이트에서 3개를 고르면 마감(상품 안 옵션이 함께 센다)
  const usage = [{ id: 7, option_key: '블랙', purchase_qty: 3, n: 1 }];
  const db = () => fakeDb({ tiers, options, usage });
  assert.equal((await svc.judge(db(), 'c1', '화이트', undefined)).reason, 'tier_required');
  assert.equal((await svc.judge(db(), 'c1', '화이트', 2)).reason, 'tier_invalid');
  const sold = await svc.judge(db(), 'c1', '화이트', 3);
  assert.equal(sold.reason, 'tier_soldout');
  assert.equal(sold.status, 409);
  const okv = await svc.judge(db(), 'c1', '화이트', 1);
  assert.deepEqual([okv.ok, okv.qty, okv.amount], [true, 1, 13000]);
  // 옵션 바꾸기: 내 기록(id 7)은 빼고 보면 3개 자리가 다시 남는다
  assert.equal((await svc.judge(db(), 'c1', '블랙', 3, { excludeAppId: 7 })).ok, true);
  // 단계가 전부 찼으면 상품 마감으로 말한다(옵션은 열렸는데 고를 개수가 없는 막다른 길을 사유로 드러냄)
  const full = fakeDb({ tiers: [T(null, 1, 1, 13000)], options, usage: [{ id: 1, option_key: '블랙', purchase_qty: 1, n: 1 }] });
  assert.equal((await svc.judge(full, 'c1', '화이트', 1)).reason, 'option_soldout');
});

test('옵션별 단계는 그 옵션만 센다 · 옵션 없는 공고는 공통 단계 하나', async () => {
  const tiers = [T('블랙', 1, 1, 13000), T('화이트', 1, 1, 15000)];
  const db = fakeDb({ tiers, options: [], usage: [{ id: 1, option_key: '블랙', purchase_qty: 1, n: 1 }] });
  assert.equal((await svc.judge(db, 'c1', '화이트', 1)).amount, 15000);
  const single = fakeDb({ tiers: [T(null, 2, 5, 20000, '텀블러')], options: [], usage: [] });
  assert.equal((await svc.judge(single, 'c1', null, 2)).ok, true);
  assert.equal(svc.scopeFor({ tiers: [T(null, 1, 1, 1, 'A'), T(null, 1, 1, 1, 'B')], optProduct: new Map() }, null), null,
    '옵션 없는 공고에 상품이 둘이면 어느 단계인지 모른다 → 걸지 않는다');
});

test('배선 — 잠금 안 게이트 · INSERT 뒤 UPDATE · 옵션 바꾸기 · 이름 바꾸기 · 합치기 · 주문 전파 · 필수 스키마 · 금액 비공개', () => {
  const gate = routes.indexOf("campaignQtyTiers.judge(client, id, chosenOpt ? chosenOpt.opt_key : null, req.body.purchaseQty)");
  assert.ok(gate > routes.indexOf("const { rows: allOpts } = await client.query("), '참여 게이트는 옵션 게이트 뒤(같은 잠금 안)');
  assert.ok(gate < routes.indexOf('INSERT INTO campaign_applications'), '참여 게이트는 INSERT 전');
  assert.match(routes, /if \(qtyTierPick\) \{[^\n]*\n\s*await client\.query\(\n\s*`UPDATE campaign_applications SET purchase_qty = \$2, qty_tier_amount = \$3 WHERE id = \$1`/);
  assert.match(routes, /campaignQtyTiers\.judge\(client, id, newKey, wantQty !== null \? wantQty : app\.purchase_qty, \{ excludeAppId: app\.id \}\)/);
  assert.match(routes, /UPDATE campaign_applications SET purchase_qty=\$4, qty_tier_amount=\$5\n\s*WHERE id=\$1 AND campaign_id=\$2 AND hold_token=\$3 AND status='applied' AND expires_at > NOW\(\)/, '개수 변경도 만료 미연장 조건부 UPDATE');
  // 이름 바꾸기는 단일 출처(campaignOptionRename)로 옮겨졌다 — 두 단계(임시 이름 → 새 이름)가 같은 step() 을 탄다
  const rename = require('fs').readFileSync(require('path').join(__dirname, '../src/services/campaignOptionRename.service.js'), 'utf8');
  const step = rename.slice(rename.indexOf('const step = async (from, to) => {'), rename.indexOf('for (let i = 0; i < plan.length; i++) await step(plan[i].from, tmp[i]);'));
  assert.equal((step.match(/UPDATE campaign_qty_tiers SET opt_key=\$3/g) || []).length, 1, '이름 바꾸기 step 이 단계 표도 옮긴다');
  assert.match(rename, /await step\(plan\[i\]\.from, tmp\[i\]\);\n\s*for \(let i = 0; i < plan\.length; i\+\+\) await step\(tmp\[i\], plan\[i\]\.to\);/, '두 단계 모두 step');
  assert.match(routes, /return require\('\.\.\/services\/campaignOptionRename\.service'\)\.applyOptionRenames\(client, campaignId, options\);/, '공고 창도 같은 단일 출처');
  assert.match(routes, /code: 'qty_tiers_present'/);
  assert.match(routes, /campaignQtyTiers\.insertTiers\(_insClient, rows\[0\]\.id, _qtyTierRows\)[^\n]*\n\s*if \(_insClient\) await _insClient\.query\('COMMIT'\)/, '복사는 공고 INSERT 와 같은 트랜잭션');
  assert.match(routes, /workKindForStore\(work_kind\) !== 'blog'/, '블로그 체험단은 복사하지 않는다');
  assert.match(routes, /function _publicTierView\(v\) \{\n\s*return \{ qty: v\.qty, status: v\.status, remaining: v\.remaining, buyMethod: v\.buyMethod \};/, '참여 전 응답에 금액을 싣지 않는다(결정 041)');
  assert.match(hold, /purchase_qty = COALESCE\(os\.purchase_qty, ca\.purchase_qty\)/);
  assert.match(hold, /qty_tier_amount = COALESCE\(os\.qty_tier_amount, ca\.qty_tier_amount\)/);
  for (const [t, c] of [['campaign_applications', 'purchase_qty'], ['campaign_applications', 'qty_tier_amount'], ['order_submissions', 'purchase_qty'], ['order_submissions', 'qty_tier_amount']]) {
    assert.ok(index.includes(`['${t}', '${c}']`), `필수 스키마: ${t}.${c}`);
  }
  assert.match(index, /'campaign_qty_tiers',/);
  assert.ok(!/\bDROP\b|^\s*UPDATE\b|^\s*DELETE\b|^\s*INSERT\b/m.test(migration.replace(/^--.*$/gm, '')), '마이그레이션은 추가만(백필·삭제 없음)');
  assert.equal((migration.match(/IF NOT EXISTS/g) || []).length, 6, '여러 번 돌려도 안전');
});

// ★ 결정 289 「가」(사용자 확정 2026-10-26) — 공고가 나간 뒤 단계·상품 이름은 못 바꾼다(바꾸면 공고 단계와 참여 기록이 어긋나거나 단계가 조용히 빠진다)
test('「가」 — 접수 뒤 단계 수정·단계 상품 이름 바꾸기·공고 창 상품 이름 바꾸기는 막는다', () => {
  const sp = fs.readFileSync(path.join(ROOT, 'src/services/sharedPatch.service.js'), 'utf8');
  // ① 공유 저장: 단계 칸이 막힌 칸이면 "아직" 이 아니라 영구 금지 문구 · 일반 막힘보다 먼저
  const tb = sp.indexOf("const tierBlocked = blocked.filter(w => w.meta && w.meta.kind === 'leaf' && w.meta.key === 'qty_tiers');");
  assert.ok(tb > 0, '단계 칸 막힘을 따로 본다');
  assert.ok(tb < sp.indexOf("code: 'field_not_editable'"), '일반 「아직 못 바꿈」보다 먼저');
  assert.match(sp.slice(tb, tb + 800), /code: 'quantity_tiers_locked'[\s\S]*새 리뷰오더로 접수해 주세요/);
  // 단계 칸 자체는 계속 쓸 수 없는 칸(writablePath 의 leaf 목록에 qty_tiers 가 없다 = false)
  const wp = sp.slice(sp.indexOf('function writablePath(row, origin) {'), sp.indexOf('const _truthy = v =>'));
  assert.ok(!/qty_tiers/.test(wp), '단계 칸을 쓸 수 있는 칸으로 열지 않는다');
  // ② 단계 상품 이름 바꾸기(인트라넷발 구조 저장)
  assert.match(sp, /for \(const r of structure\.renamedProducts \|\| \[\]\) \{\n\s*if \(_tiersOn\(list\.find\(y => String\(y && y\.name \|\| ''\)\.trim\(\) === String\(r\.to \|\| ''\)\.trim\(\)\)\)\) \{\n\s*return \{ code: 'quantity_tiers_locked'/);
  // ③ 공고 창 저장: 단계 공고의 상품 이름 바꾸기는 통째로 되돌린다(이름 바꾸기 뒤 · 쓰기 전)
  const fn = routes.slice(routes.indexOf('async function _saveCampaignOptions('), routes.indexOf('INSERT INTO campaign_options (campaign_id, opt_key, option_url'));
  assert.match(fn, /await _applyOptionRenames\(client, campaignId, options, keep\);[\s\S]*SELECT 1 FROM campaign_qty_tiers WHERE campaign_id=\$1 LIMIT 1[\s\S]*throw Object\.assign\(new Error\(`구매수량 단계가 있는 공고라 상품 이름/);
});
