'use strict';
/**
 * 결정 289 ④ — 인당 구매수량 단계 관리자·업체 표시 (사용자 확정 2026-10-26 ①가 ②가)
 *   1) 작업표 「구매수량」 가상 칸 — 공고 참여 주문의 purchase_qty · 개수가 실린 줄이 있을 때만 선언 · 내부·업체 모두(①가)
 *   2) 판매 개수(counts.soldUnits) = 채워진 줄의 구매수량 합(고르지 않은 줄 = 1개)
 *   3) 작업 조건 카드 단계 요약(campaignQtyTiers.summaryForCampaign) — Σ(단계 1인 금액 × 인원) · Σ(개수 × 인원) · 단계 없는 옵션 = 1개 × 모집인원
 *   4) 입금관리 단독 금액 경고 — 고른 개수의 금액(qty_tier_amount)과 같으면 경고하지 않는다(②가 · 줄이는 쪽만)
 *   5) 배선(화면) — 서버 값을 그리기만 한다(카드에서 새 곱셈 없음)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const S = 'SHEET_Q';
const TQ = '10/27(쿠팡)구매수량 6건';
const TP = '10/27(쿠팡)단계없음 3건';

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const readFront = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', rel), 'utf8');

function stubDb(routes) {
  return { query: async (sql, params) => {
    if (/\b(UPDATE|INSERT|DELETE)\b/i.test(sql)) throw new Error('쓰기 금지');
    for (const [re, rows] of routes) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(sql, params) : rows };
    return { rows: [] };
  } };
}

(async () => {
  // ── 3. 단계 요약(순수 · 스텁 DB) ──
  const qt = require('../src/services/campaignQtyTiers.service');
  const TIERS = [
    { product_name: '가습기', opt_key: null, qty: 3, people: 2, pay_amount: 30000, buy_method: 'qty', sort_order: 0 },
    { product_name: '가습기', opt_key: null, qty: 2, people: 3, pay_amount: 20000, buy_method: 'qty', sort_order: 1 },
    { product_name: '가습기', opt_key: null, qty: 1, people: 5, pay_amount: 10000, buy_method: 'qty', sort_order: 2 },
  ];
  const OPTS = [
    { opt_key: '화이트', product_name: '가습기', pay_amount: 10000, recruit_total: 6 },
    { opt_key: '블랙', product_name: '가습기', pay_amount: 10000, recruit_total: 4 },
    { opt_key: '필터', product_name: '필터', pay_amount: 19000, recruit_total: 5 },
  ];
  const db3 = (tiers = TIERS, opts = OPTS) => stubDb([[/FROM campaign_qty_tiers/, tiers], [/FROM campaign_options/, opts]]);
  await t('★ 단계 요약 — 공통 단계(가습기) Σ(금액×인원) + 단계 없는 필터 1개 × 모집인원', async () => {
    const s = await qt.summaryForCampaign(db3(), 'c1');
    assert.strictEqual(s.groups.length, 1, '같은 상품 공통 단계는 한 묶음');
    assert.strictEqual(s.groups[0].label, '가습기');
    assert.deepStrictEqual(s.groups[0].rows.map(r => [r.qty, r.people, r.amount]), [[3, 2, 30000], [2, 3, 20000], [1, 5, 10000]]);
    assert.strictEqual(s.totalAmount, 30000 * 2 + 20000 * 3 + 10000 * 5 + 19000 * 5);
    assert.strictEqual(s.totalUnits, 3 * 2 + 2 * 3 + 1 * 5 + 5);
    assert.strictEqual(s.totalPeople, 10 + 5);
  });
  await t('단계 없음 → null(카드는 종전 계산) · 스위치 끔 → null · 공고 없음 → null', async () => {
    assert.strictEqual(await qt.summaryForCampaign(db3([]), 'c1'), null);
    assert.strictEqual(await qt.summaryForCampaign(db3(), null), null);
    const old = process.env.CAMPAIGN_QTY_TIERS; process.env.CAMPAIGN_QTY_TIERS = '0';
    try { assert.strictEqual(await qt.summaryForCampaign(db3(), 'c1'), null); }
    finally { if (old === undefined) delete process.env.CAMPAIGN_QTY_TIERS; else process.env.CAMPAIGN_QTY_TIERS = old; }
  });
  await t('단계 없는 옵션 금액·인원을 모르면 총결제금액은 지어내지 않는다(null) · 판매 목표는 센다', async () => {
    const s = await qt.summaryForCampaign(db3(TIERS, OPTS.map(o => o.opt_key === '필터' ? { ...o, pay_amount: 0 } : o)), 'c1');
    assert.strictEqual(s.totalAmount, null);
    assert.strictEqual(s.totalUnits, 17 + 5);
  });
  await t('옵션 전용 단계는 옵션 이름으로 묶는다 · 옵션 없는 공고는 공통 단계 하나', async () => {
    const byOpt = [{ ...TIERS[0], opt_key: '화이트' }, { ...TIERS[2], opt_key: '화이트', people: 4 }];
    const s = await qt.summaryForCampaign(db3(byOpt, OPTS.slice(0, 2)), 'c1');
    assert.deepStrictEqual(s.groups.map(g => g.label), ['화이트']);
    assert.strictEqual(s.totalAmount, 30000 * 2 + 10000 * 4 + 10000 * 4, '블랙(단계 없음)은 1개 × 4명');
    const none = await qt.summaryForCampaign(db3(TIERS, []), 'c1');
    assert.strictEqual(none.groups[0].label, '가습기');
    assert.strictEqual(none.totalAmount, 170000);
  });

  // ── 4. 입금관리 단독 금액 경고 ──
  const { flagPriceOutliers } = require('../src/services/payment.service');
  await t('★ 입금관리 — 1개 10,000원 사이의 3개 30,000원: 고른 개수 금액이면 경고 없음 · 아니면 종전대로 경고', async () => {
    const mk = (price, tier) => ({ sheetId: S, tabName: TQ, productPrice: price, qtyTierAmount: tier, warnings: [] });
    const items = [mk(10000, 10000), mk(10000, 10000), mk(10000, 10000), mk(10000, 10000), mk(30000, 30000)];
    flagPriceOutliers(items);
    assert.ok(!items[4].priceOutlier, '고른 개수 금액 = 정상');
    const old = [mk(10000, null), mk(10000, null), mk(10000, null), mk(10000, null), mk(30000, null)];
    flagPriceOutliers(old);
    assert.ok(old[4].priceOutlier && old[4].warnings.includes('price_outlier'), '단계 정보 없는 줄은 종전 경고(대조군)');
    const wrong = [mk(10000, 10000), mk(10000, 10000), mk(10000, 10000), mk(10000, 10000), mk(30000, 20000)];
    flagPriceOutliers(wrong);
    assert.ok(wrong[4].priceOutlier, '고른 개수 금액과 다르면 종전대로 경고(새 경고를 만들지는 않는다)');
  });

  // ── 1·2. 작업표(PGlite 실DB로 서비스 그대로) ──
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'statusCountUnify.schema.sql'), 'utf8'));
  const q = async (sql, params) => db.query(sql, params);
  const pool = require('../src/db/pool');
  pool.query = q; pool.connect = async () => ({ query: q, release() {} });
  const svc = require('../src/services/trackB.service');
  await db.exec(`
    INSERT INTO raw_sheet_tabs (sheet_id, spreadsheet_title, tab_gid, tab_name, row_count, is_system_tab, detected_headers, mirrored_at) VALUES
     ('${S}','가짜 시트','201','${TQ}',6,FALSE,'["번호","수취인","결제금액","리뷰제출","입금"]'::jsonb, NOW()),
     ('${S}','가짜 시트','202','${TP}',3,FALSE,'["번호","수취인","결제금액","리뷰제출","입금"]'::jsonb, NOW());
    INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheetless, is_closed, manager) VALUES
     ('${S}','${TQ}','201',TRUE,FALSE,'망고'), ('${S}','${TP}','202',TRUE,FALSE,'망고');
    -- TQ: 주문 4건(3개·2개·1개·개수 없음) + 빈 슬롯 2줄
    INSERT INTO order_submissions (id, sheet_id, tab_name, orderer, recipient, phone, price, purchase_qty, qty_tier_amount)
    VALUES ('00000000-0000-0000-0000-000000000001','${S}','${TQ}','가','가','01070000001','30000',3,30000),
           ('00000000-0000-0000-0000-000000000002','${S}','${TQ}','나','나','01070000002','20000',2,20000),
           ('00000000-0000-0000-0000-000000000003','${S}','${TQ}','다','다','01070000003','10000',1,10000),
           ('00000000-0000-0000-0000-000000000004','${S}','${TQ}','라','라','01070000004','10000',NULL,NULL),
           ('00000000-0000-0000-0000-000000000005','${S}','${TP}','마','마','01070000005','10000',NULL,NULL);
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, is_submitted, source, submit_col, row_json, active, order_submission_id)
    SELECT '${S}','201','${TQ}', g+1, '사람'||g, '수취'||g, '7000000'||g, FALSE, 'worktable', '리뷰제출',
           jsonb_build_object('번호', g::text, '결제금액', (ARRAY['30000','20000','10000','10000'])[g]), TRUE,
           ('00000000-0000-0000-0000-00000000000'||g)::uuid FROM generate_series(1,4) g;
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, source, row_json, active)
    SELECT '${S}','201','${TQ}', g+1, 'worktable', jsonb_build_object('번호', g::text), TRUE FROM generate_series(5,6) g;
    INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, source, row_json, active, order_submission_id)
    VALUES ('${S}','202','${TP}', 2, '사람5', '수취5', '70000005', 'worktable', '{"번호":"1","결제금액":"10000"}'::jsonb, TRUE, '00000000-0000-0000-0000-000000000005');
  `);
  const board = await svc.workdeskTab({ sheetId: S, tabName: TQ, role: 'master' });
  await t('★★ 작업표 — 「구매수량」 가상 칸 선언 · 줄마다 고른 개수(없으면 값 없음 — 화면이 1개로 그린다)', async () => {
    assert.deepStrictEqual(board.purchaseQtyColumn, { key: '__purchaseQty', label: '구매수량' });
    const people = board.roster.filter(r => r.filled).sort((a, b) => a.seq - b.seq);
    assert.deepStrictEqual(people.map(r => r.purchaseQty == null ? null : r.purchaseQty), [3, 2, 1, null]);
    assert.ok(!(board.headers || []).includes('구매수량'), '시트 칸으로 섞이지 않는다(가상 칸)');
  });
  await t('★★ 판매 개수 = 채워진 줄 구매수량 합(고르지 않은 줄 1개 · 빈 슬롯 0) = 3+2+1+1', async () => {
    assert.strictEqual(board.counts.soldUnits, 7);
    assert.strictEqual(board.counts.filled, 4, '사람 수 셈은 그대로');
  });
  await t('개수가 실린 줄이 없는 작업 — 칸·판매 개수 모두 없음(종전 표 그대로)', async () => {
    const plain = await svc.workdeskTab({ sheetId: S, tabName: TP, role: 'master' });
    assert.strictEqual(plain.purchaseQtyColumn, undefined);
    assert.strictEqual(plain.counts.soldUnits, undefined);
  });

  // ── 5. 배선 ──
  await t('배선(서버) — roster 가 같은 조인에서 purchase_qty 를 읽고 보관본은 NULL · 업체 렌즈에 단계 요약(①가)', async () => {
    const src = read('src/services/trackB.service.js');
    assert.ok(/purpose_order\.purchase_qty AS "purchaseQty"/.test(src));
    assert.ok(/NULL::int AS "purchaseQty"/.test(src), '보관본 쿼리도 같은 칸 모양');
    assert.ok(/if \(_hasQty\) res\.purchaseQtyColumn = \{ key: '__purchaseQty', label: '구매수량' \};/.test(src));
    const lens = src.slice(src.indexOf('function _condAdvertiserLens'), src.indexOf('function _tpAdvertiserLens'));
    assert.ok(/qtyTiers: cd\.qtyTiers \|\| null,/.test(lens), '업체 렌즈에 단계 요약');
    assert.ok(/summaryForCampaign\(db, c\.id\)\.catch\(/.test(src), '단계 요약 실패는 카드 전체를 죽이지 않는다');
  });
  await t('배선(화면) — 가상 칸 · 카드 · 진행 현황 · 카드에 새 곱셈 없음', async () => {
    const f = readFront('workdesk.html');
    assert.ok(/const _PURCHASE_QTY_COL='__purchaseQty';/.test(f));
    assert.ok(/\.\.\._gridSheetCols\(wd,H\)/.test(f) && /\.\.\._gridSheetCols\(wd,wd&&wd\.headers\|\|\[\]\)/.test(f), '그리드·열 목록 둘 다 같은 함수');
    assert.ok(/else if\(c\.kind==='purchaseQty'\)\{[\s\S]{0,200}gstatuslock/.test(f), '읽기 전용 칸');
    assert.ok(/if\(h===_PURCHASE_QTY_COL\) return _purchaseQtyDisplay\(r\);/.test(f), '필터·정렬·복사 표시값');
    const card = f.slice(f.indexOf('function _condCardHtml'), f.indexOf('/* 메인URL(사용자 확정 2026-08-23)'));
    const qtBlock = card.slice(card.indexOf('const qt=cd.qtyTiers'), card.indexOf('/* 메인URL') > 0 ? card.indexOf('/* 메인URL') : card.length);
    assert.ok(qtBlock.length > 50 && !/\*\s*Number|\w\*\w/.test(qtBlock.replace(/\/\*[\s\S]*?\*\//g, '')), '단계 블록은 서버 값을 그리기만(곱셈 없음)');
    assert.ok(/c\.soldUnits!=null\?/.test(f) && /판매 개수/.test(f));
  });

  console.log(`\n✅ qtyTiersDisplay: ${passed} 통과`);
})().catch(e => { console.error(e); process.exitCode = 1; });
