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

// ★ 코드리뷰(PR #1690) P1·P2
test('P1 — 옵션 이름이 다른 상품 이름과 같아도 그 옵션 상품의 단계만 본다', async () => {
  // 상품 「블랙」(옵션 라지 · 2개 200원) · 상품 「램프」(옵션 「블랙」 · 2개 900원)
  const tiers = [T(null, 2, 1, 200, '블랙'), T(null, 2, 1, 900, '램프')];
  const options = [{ opt_key: '라지', product_name: '블랙' }, { opt_key: '블랙', product_name: '램프' }];
  const v = await svc.judge(fakeDb({ tiers, options, usage: [] }), 'c1', '블랙', 2);
  assert.ok(v.ok && v.amount === 900, '램프의 블랙 = 램프 단계(900원) ' + JSON.stringify(v));
  const ctx = { tiers, optProduct: new Map(options.map(o => [o.opt_key, o.product_name])) };
  assert.equal(svc.scopeFor(ctx, '블랙').key, 'prod:램프');
  assert.equal(svc.scopeFor(ctx, '블랙').tiers.length, 1, '두 상품 단계를 섞지 않는다');
});

test('P2 — 단계는 있는데 범위를 못 정하면 통과로 접지 않는다(발행 직후 옵션 미저장 · 옵션 저장 실패)', async () => {
  const optTiers = [T('블랙', 2, 1, 20000)];
  // 옵션 줄이 아직 없다(발행 tx 커밋 뒤 · 옵션 저장 전) — 옵션 없이 온 참여
  const a = await svc.judge(fakeDb({ tiers: optTiers, options: [], usage: [] }), 'c1', null, undefined);
  assert.equal(a && a.reason, 'tier_unavailable');
  // 고른 옵션 줄이 공고에 없다
  const b = await svc.judge(fakeDb({ tiers: optTiers, options: [], usage: [] }), 'c1', '블랙', 2);
  assert.ok(b.ok === true || b.reason === 'tier_unavailable', '옵션 전용 단계는 opt_key 로 바로 잡힌다(줄 없어도 단계 자체는 맞다)');
  const c = await svc.judge(fakeDb({ tiers: [T(null, 2, 1, 1, '가습기')], options: [], usage: [] }), 'c1', '화이트', 2);
  assert.equal(c && c.reason, 'tier_unavailable', '옵션 줄이 없으면 어느 상품 단계인지 모른다');
  // 옵션 없이 왔는데 공통 단계가 상품 둘 → 모른다 → 막음
  const d = await svc.judge(fakeDb({ tiers: [T(null, 1, 1, 1, 'A'), T(null, 1, 1, 1, 'B')], options: [], usage: [] }), 'c1', null, 1);
  assert.equal(d && d.reason, 'tier_unavailable');
  // 단계 없는 상품의 옵션(줄은 있다) = 종전대로 통과
  const e = await svc.judge(fakeDb({ tiers: optTiers, options: [{ opt_key: '블랙', product_name: '가습기' }, { opt_key: '컵', product_name: '컵' }], usage: [] }), 'c1', '컵', undefined);
  assert.equal(e, null, '단계 없는 상품은 종전 그대로');
});

// ★ 결정 289 ③-나 — 리뷰어 개수 고르기(화면) · 보기 전용 서버 응답
test('③-나 viewsForCampaign — 옵션별·옵션 없는 공고 · 단계 없으면 null · 내 참여 빼고', async () => {
  assert.equal(await svc.viewsForCampaign(fakeDb(), 'c1', ['블랙']), null, '단계 없는 공고 = null(종전 화면)');
  const tiers = [T(null, 1, 2, 10000), T(null, 2, 1, 20000)];
  const options = [{ opt_key: '블랙', product_name: '가습기' }, { opt_key: '컵', product_name: '컵' }];
  const usage = [{ id: 9, option_key: '블랙', purchase_qty: 2, n: 1 }];
  const v = await svc.viewsForCampaign(fakeDb({ tiers, options, usage }), 'c1', ['블랙', '컵']);
  assert.deepEqual(v.byOpt['블랙'].map(x => [x.qty, x.status, x.remaining]), [[2, 'soldout', 0], [1, 'open', 2]]);
  assert.equal(v.byOpt['컵'], undefined, '단계 없는 상품의 옵션은 싣지 않는다');
  const mine = await svc.viewsForCampaign(fakeDb({ tiers, options, usage }), 'c1', ['블랙'], { excludeAppId: 9 });
  assert.ok(mine && mine.byOpt && mine.byOpt['블랙'], '내 참여 빼고 보기도 돌아간다');
});

test('③-나 배선 — 참여 전 상세(금액 없음) · 참여 후 내 개수·금액 · 화면 개수 창', () => {
  // 서버: 참여 전 상세는 _publicTierView(금액 없음)로만 · 실패해도 공고는 연다
  assert.match(routes, /o\.qtyTiers = v\.map\(_publicTierView\)/);
  assert.match(routes, /view\.qtyTiers = tv\.campaign\.map\(_publicTierView\)/);
  assert.match(routes, /logger\.warn\(`\[campaign\/detail\] 구매수량 단계 보기 실패/, '보기 실패가 상세를 죽이지 않는다');
  // 참여 후: 내 참여는 빼고 본 자리 · 금액은 참여 후에만 · 응답 qty
  assert.match(routes, /viewsForCampaign\(pool, id, app\.option_key \? \[app\.option_key\] : \[\], \{ excludeAppId: app\.id \}\)/);
  assert.match(routes, /\{ \.\.\._publicTierView\(v\), payAmount: v\.payAmount \}/);
  assert.match(routes, /\n\s+qty,\s+\/\/ ★ 결정 289 ③-나/);
  // 화면: 모든 참여 경로가 모이는 _doApply 에서 자리 잡기 전에 개수 창 · 본문에 purchaseQty · 서버 단계 사유면 개수 창 다시
  const camp = fs.readFileSync(path.join(ROOT, '../frontend/campaign.html'), 'utf8');
  const ap = camp.slice(camp.indexOf('async function _doApply(optionKey, sub, purchaseQty){'));
  const sheet = ap.indexOf("return openQtySheet({ mode:'join', optionKey, sub, views: tv })");
  assert.ok(sheet > 0 && sheet < ap.indexOf("+ '/apply', {"), '개수 창은 apply 요청 전');
  assert.ok(ap.indexOf('if(isBlogCampaign() && !_isBlogUrl(_blogUrl))') < sheet, '블로그 주소 확인 뒤(블로그는 단계 없음)');
  assert.match(ap, /if\(purchaseQty\) body\.purchaseQty = purchaseQty;/);
  assert.match(ap, /if\(_qtyRetryFromServer\(j, \{ mode:'join', optionKey, sub, views: _qtyViewsFor\(optionKey\) \}\)\) return;/);
  assert.match(camp, /function _qtyRetryFromServer\(j, p\)\{\n\s*if\(!\['tier_required','tier_invalid','tier_soldout'\]\.includes\(j && j\.reason\)\) return false;/);
  assert.match(camp, /if\(_qtyRetryFromServer\(j, \{ mode:'change_opt', optionKey: newKey, views: \[\] \}\)\) return;/, '옵션 바꾸기도 새 옵션의 개수');
  assert.match(camp, /renderJoinedOption\(j\);\n\s*renderJoinedQty\(j\);/);
  assert.match(camp, /<div class="sheet-ovl" id="qtySheet">/);
  // 개수 바꾸기도 미리보기에서는 서버를 부르지 않는다
  assert.match(camp, /async function _doChangeQty\(qty\)\{\n\s*if\(PREVIEW\) return toast/);
});
