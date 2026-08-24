/**
 * campaignUnitGuide.test.js — 복합 작업(옵션 있는 상품 + 옵션 없는 상품)의 선택 단위 + 선택지별 유입가이드
 *   migration 134 · campaign.routes(_normalizeOptionsInput/_saveCampaignOptions/뷰 3종)
 *   · campaignState.computeOptionView · submit.routes(시트 옵션 칸) · manualOrder(수동 제출)
 *
 * 고정하는 불변식
 *   ① 마이그레이션은 **컬럼 추가만**(백필·CHECK·FK 0) + 기본값이 종전 동작 = 배포 즉시 동작 불변
 *   ② 옵션 저장 INSERT 의 **컬럼 수 ≡ 자리표시자 수 ≡ 파라미터 수**(컬럼 추가 때 가장 흔히 깨지는 자리)
 *   ③ 선택지별 유입가이드는 **공개 뷰에 절대 실리지 않는다**(홀드 게이트 뒤에서만)
 *   ④ 모르는 unit_kind 는 'product' 로 승격되지 않는다(종전 동작)
 *   ⑤ 옵션 없는 상품 단위의 키(=상품명)는 **시트 옵션 칸에 쓰지 않는다**(8/3 상품명 오기입 사고 규율)
 *      — 단 홀드 대조값(expectedOptKey)은 원래 키 그대로(정상 건마다 warn 이 뜨면 관제 신호가 죽는다)
 *   ⑥ REQUIRED_SCHEMA 등록(없으면 옵션 저장이 전면 42703 인데 부팅은 통과하는 무신호 장애)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');
// campaign.routes.js 는 복합키 구분자로 **의도된 NUL** 을 담고 있다(제거 금지) — 읽을 때만 걷어낸다.
const routes = rd('server/src/routes/campaign.routes.js').split(String.fromCharCode(0)).join('');
const submit = rd('server/src/routes/submit.routes.js');
const manual = rd('server/src/services/manualOrder.service.js');
const stateSrc = rd('server/src/services/campaignState.service.js');
const indexSrc = rd('server/index.js');
const migration = rd('server/migrations/137_campaign_option_unit_guide.sql');

const { computeOptionView } = require('../src/services/campaignState.service');
const { sanitizeGuideHtml, sanitizeGuideImages } = require('../src/utils/sanitizeGuideHtml');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name); };

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} 함수가 있어야 한다`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 본문이 끝나지 않는다`);
}

// ── ① 마이그레이션 모양 ─────────────────────────────────────────────
t('134: 4개 컬럼을 ADD COLUMN IF NOT EXISTS 로만 추가', () => {
  for (const col of ['product_name', 'unit_kind', 'inflow_guide_html', 'inflow_guide_images']) {
    assert.ok(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`).test(migration), `${col} 추가`);
  }
});

t('134: 백필(UPDATE/INSERT)·CHECK·FK 0 — 배포 즉시 동작 불변', () => {
  const sql = migration.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\bUPDATE\b/i.test(sql), '백필 UPDATE 금지');
  assert.ok(!/\bINSERT\b/i.test(sql), '백필 INSERT 금지');
  assert.ok(!/\bCHECK\s*\(/i.test(sql), 'DB CHECK 금지(어휘 확장 때마다 저장이 실패한다)');
  assert.ok(!/\bREFERENCES\b/i.test(sql), 'FK 금지(082 의 42804 규율)');
});

t("134: 기본값이 종전 동작 — unit_kind='option' · 가이드는 빈 값", () => {
  assert.match(migration, /unit_kind\s+TEXT\s+NOT NULL DEFAULT 'option'/);
  assert.match(migration, /product_name\s+TEXT\s+NOT NULL DEFAULT ''/);
  assert.match(migration, /inflow_guide_html\s+TEXT\s+NOT NULL DEFAULT ''/);
  assert.match(migration, /inflow_guide_images\s+JSONB\s+NOT NULL DEFAULT '\[\]'::jsonb/);
});

// ── ⑥ 부팅 프리플라이트 ────────────────────────────────────────────
t('REQUIRED_SCHEMA 에 4개 컬럼 등록(없으면 옵션 저장 전면 42703인데 부팅은 통과)', () => {
  for (const col of ['product_name', 'unit_kind', 'inflow_guide_html', 'inflow_guide_images']) {
    assert.ok(
      new RegExp(`\\['campaign_options',\\s*'${col}'\\]`).test(indexSrc),
      `campaign_options.${col} 등록`);
  }
});

// ── ② INSERT 계수 정합 ─────────────────────────────────────────────
t('옵션 저장 INSERT: 컬럼 수 ≡ VALUES 자리 수 ≡ 파라미터 수', () => {
  const i = routes.indexOf('INSERT INTO campaign_options (campaign_id, opt_key');
  assert.notEqual(i, -1, '옵션 저장 INSERT 가 있어야 한다');
  const stmt = routes.slice(i, routes.indexOf('ON CONFLICT', i));
  // ★ 괄호·따옴표 안의 쉼표(`COALESCE($9,'active')`)를 항목 구분으로 세면 안 된다.
  const splitTop = (s) => {
    const out = []; let depth = 0, quote = false, cur = '';
    for (const ch of s) {
      if (ch === "'") quote = !quote;
      if (!quote && ch === '(') depth += 1;
      if (!quote && ch === ')') depth -= 1;
      if (!quote && depth === 0 && ch === ',') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(x => x.trim()).filter(Boolean);
  };
  const cols = splitTop(stmt.slice(stmt.indexOf('(') + 1, stmt.indexOf(')')));
  const valuesPart = stmt.slice(stmt.indexOf('VALUES'));
  const values = splitTop(valuesPart.slice(valuesPart.indexOf('(') + 1, valuesPart.lastIndexOf(')')));
  assert.equal(cols.length, values.length, `컬럼 ${cols.length} ≠ 자리 ${values.length}`);
  // 새 컬럼 4종이 실제로 문장 안에 있고, UPDATE 절에서도 갱신된다
  const upd = routes.slice(routes.indexOf('ON CONFLICT', i), routes.indexOf('updated_at=NOW()', i) + 20);
  for (const col of ['product_name', 'unit_kind', 'inflow_guide_html', 'inflow_guide_images']) {
    assert.ok(cols.includes(col), `INSERT 컬럼에 ${col}`);
    assert.ok(upd.includes(`${col}=EXCLUDED.${col}`), `UPDATE 절에 ${col}`);
  }
  // 최대 자리표시자 번호 = 파라미터 배열 길이
  const maxPh = Math.max(...(stmt.match(/\$(\d+)/g) || []).map(s => Number(s.slice(1))));
  const argsStart = routes.indexOf('[campaignId, o.optKey, o.optionUrl', i);
  const args = routes.slice(argsStart, routes.indexOf(']);', argsStart));
  const argCount = args.split('\n').join(' ').split(',').filter(s => s.trim()).length;
  assert.equal(maxPh, argCount, `자리표시자 최대 $${maxPh} ≠ 파라미터 ${argCount}개`);
});

// ── ③④ 정규화·공개 뷰 ─────────────────────────────────────────────
const sandbox = {
  URL,
  normalizeReviewTypeMix: require('../src/utils/reviewTypeMix').normalizeReviewTypeMix,
  sanitizeGuideHtml, sanitizeGuideImages,
};
vm.createContext(sandbox);
for (const fn of ['_normOptKey', '_optNum', '_normalizeOptionUrl', '_normalizeOptionsInput', '_publicOptionView']) {
  vm.runInContext(functionSource(routes, fn), sandbox);
}

t('④ 모르는 unit_kind 는 option(종전 동작) — 상품 단위로 승격 금지', () => {
  const rows = sandbox._normalizeOptionsInput([
    { optKey: 'A' },
    { optKey: 'B', unitKind: 'PRODUCT' },   // 대문자 = 모르는 값
    { optKey: 'C', unitKind: 'product' },
  ]);
  assert.equal(rows[0].unitKind, 'option');
  assert.equal(rows[1].unitKind, 'option');
  assert.equal(rows[2].unitKind, 'product');
});

t('③ 공개 뷰(_publicOptionView)에 유입가이드가 실리지 않는다', () => {
  const view = computeOptionView({
    opt_key: '옵션A', product_name: '상품A', unit_kind: 'option',
    recruit_total: 10, daily_limit: 5, status: 'active',
    inflow_guide_html: '<p>검색해서 들어오세요</p>',
    inflow_guide_images: ['https://x.example/api/order/guide-image/aaaaaaaaaaaaaaaaaaaaa'],
  }, null, { state: 'open' });
  assert.equal(view.inflowGuideHtml, '<p>검색해서 들어오세요</p>', '홀드 게이트 뷰에는 가이드가 있다');
  const pub = sandbox._publicOptionView(view);
  assert.ok(!('inflowGuideHtml' in pub), '공개 뷰에 inflowGuideHtml 금지');
  assert.ok(!('inflowGuideImages' in pub), '공개 뷰에 inflowGuideImages 금지');
  assert.ok(!('payAmount' in pub), '금액은 종전대로 참여 후 공개');
  assert.equal(pub.productName, '상품A', '묶음 머리에 쓸 상품명은 공개');
  assert.equal(pub.unitKind, 'option');
});

t('computeOptionView: 컬럼 없는 구버전 행이면 종전 값으로 접는다', () => {
  const v = computeOptionView({ opt_key: 'X', recruit_total: 0, daily_limit: 0, status: 'active' }, null, null);
  assert.equal(v.productName, '');
  assert.equal(v.unitKind, 'option');
  assert.equal(v.inflowGuideHtml, '');
  assert.deepEqual(v.inflowGuideImages, []);
});

// ── ⑤ 시트 옵션 칸 ─────────────────────────────────────────────────
t('⑤ 리뷰어 제출: product 단위는 시트 옵션 칸에 쓰지 않는다(sheetOptKey)', () => {
  assert.match(submit, /const sheetOptKey = \(holdCtx && holdCtx\.unitKind === 'product'\) \? '' : effectiveOptKey;/);
  assert.match(submit, /selectedOptKey: sheetOptKey,/);
  assert.ok(!/selectedOptKey: effectiveOptKey/.test(submit),
    '원장·시트로 나가는 값은 sheetOptKey 하나만 쓴다(옛 경로 부활 금지)');
});

t('⑤ 홀드 대조값(expectedOptKey)은 원래 단위 키 그대로 — 정상 건 warn 도배 금지', () => {
  assert.match(submit, /expectedOptKey: effectiveOptKey/);
});

t('⑤ unitKind 는 홀드 조회 같은 왕복에서 읽는다(쿼리 순증 0)', () => {
  const i = submit.indexOf('async function _authoritativeHold');
  const body = submit.slice(i, submit.indexOf('\n}', i));
  assert.match(body, /LEFT JOIN campaign_options co/);
  assert.match(body, /co\.unit_kind AS unit_kind/);
  assert.match(body, /ctx\.unitKind = String\(rows\[0\]\.unit_kind \|\| ''\) === 'product' \? 'product' : 'option';/);
});

t('⑤ 외부모집 수동제출도 같은 규율(product 단위면 옵션 칸 미기입·fail-open)', () => {
  assert.match(manual, /SELECT unit_kind FROM campaign_options WHERE campaign_id = \$1 AND opt_key = \$2/);
  assert.match(manual, /if \(u\.length && String\(u\[0\]\.unit_kind \|\| ''\) === 'product'\) resolvedOptKey = '';/);
  const i = manual.indexOf('SELECT unit_kind FROM campaign_options');
  const around = manual.slice(i - 400, i + 500);
  assert.match(around, /catch \(_\) \{ \/\* fail-open/, '조회 실패는 종전 동작');
});

// ── 읽기 경로 정화·컬럼 ───────────────────────────────────────────
t('읽기 경로 SELECT 에 새 컬럼 합류(뷰·프리필)', () => {
  assert.match(routes, /product_name, unit_kind, inflow_guide_html, inflow_guide_images\n\s*FROM campaign_options WHERE campaign_id=\$1/);
  assert.match(routes, /product_name AS "productName", unit_kind AS "unitKind"/);
  assert.match(routes, /inflow_guide_html AS "inflowGuideHtml", inflow_guide_images AS "inflowGuideImages"/);
});

t('가이드는 저장·응답 양쪽에서 정화된다(§03-E 이중 적용)', () => {
  const norm = functionSource(routes, '_normalizeOptionsInput');
  assert.match(norm, /inflowGuideHtml: sanitizeGuideHtml\(/, '저장 시 1차 정화');
  assert.match(norm, /inflowGuideImages: sanitizeGuideImages\(/);
  const views = functionSource(routes, '_loadOptionViews');
  assert.match(views, /v\.inflowGuideHtml = sanitizeGuideHtml\(v\.inflowGuideHtml\);/, '응답 직전 재정화');
  assert.match(views, /v\.inflowGuideImages = sanitizeGuideImages\(v\.inflowGuideImages\);/);
  const raw = functionSource(routes, '_loadOptionsRaw');
  assert.match(raw, /sanitizeGuideHtml\(r\.inflowGuideHtml\)/, '관리 프리필도 재정화');
});

t('공개 목록 배치 조회에도 상품명·단위 종류가 실린다(카드 묶음 표기)', () => {
  const fn = functionSource(routes, '_fetchOptionsForCampaigns');
  assert.match(fn, /status, product_name, unit_kind/);
  assert.ok(!/inflow_guide/.test(fn), '공개 배치 조회는 가이드를 읽지 않는다');
});

// ── 진짜 PG16(선택) ────────────────────────────────────────────────
//   ★ 스텁 DB 는 SQL 을 해석하지 않는다 — 컬럼/자리표시자 정합·기본값·업서트는 실제로 돌려야 잡힌다.
//   PGTEST_URL=postgres://... node tests/campaignUnitGuide.test.js
async function pgChecks(url) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  const schema = 'unitguide_' + Date.now().toString(36);
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await c.query(`CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT)`);
    await c.query(`CREATE TABLE campaign_options (
      id BIGSERIAL PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
      opt_key TEXT NOT NULL, option_url TEXT NOT NULL DEFAULT '',
      pay_amount INTEGER NOT NULL DEFAULT 0, recruit_total INTEGER NOT NULL DEFAULT 0,
      daily_limit INTEGER NOT NULL DEFAULT 0, review_type_mix JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (campaign_id, opt_key))`);
    await c.query(`INSERT INTO recruit_campaigns VALUES ('c1','복합')`);
    await c.query(`INSERT INTO campaign_options (campaign_id, opt_key) VALUES ('c1','옛옵션')`);

    // 134 적용 — 그리고 재실행해도 안전(idempotent)
    await c.query(migration);
    await c.query(migration);
    const before = await c.query(`SELECT product_name, unit_kind, inflow_guide_html, inflow_guide_images
                                    FROM campaign_options WHERE opt_key='옛옵션'`);
    assert.deepEqual(before.rows[0],
      { product_name: '', unit_kind: 'option', inflow_guide_html: '', inflow_guide_images: [] },
      '기존 행은 종전 동작 그대로(백필 0)');
    t('PG: 134 멱등 + 기존 행 기본값이 종전 동작', () => {});

    // 코드에 박힌 INSERT 를 그대로 꺼내 실행 — 자리표시자·타입 정합을 DB 가 판정한다
    const i = routes.indexOf('`INSERT INTO campaign_options (campaign_id, opt_key');
    const sql = routes.slice(i + 1, routes.indexOf('`', i + 1));
    const run = o => c.query(sql, ['c1', o.k, '', 0, 0, 0, '[]', o.s, o.status || 'active',
      o.p || '', o.u || 'option', o.g || '', '[]']);
    await run({ k: '옵션A', s: 0, p: '상품A', u: 'option', g: '<p>A</p>' });
    await run({ k: '옵션B', s: 1, p: '상품A', u: 'option', g: '<p>B</p>' });
    await run({ k: '상품B', s: 2, p: '상품B', u: 'product', g: '<p>P</p>' });
    const units = await c.query(`SELECT opt_key, product_name, unit_kind FROM campaign_options
                                  WHERE campaign_id='c1' AND opt_key <> '옛옵션' ORDER BY sort_order`);
    assert.equal(units.rows.length, 3, '리뷰어 선택지 3가지(A옵션1·A옵션2·상품B)');
    assert.equal(units.rows[2].unit_kind, 'product');
    t('PG: 옵션 저장 INSERT 실행 — 혼합 작업의 선택 단위 3개 생성', () => {});

    // 업서트가 새 컬럼을 갱신하고 status 는 미지정 시 보존(COALESCE $9)
    await c.query(`UPDATE campaign_options SET status='closed' WHERE opt_key='상품B'`);
    await c.query(sql, ['c1', '상품B', '', 0, 0, 0, '[]', 2, null, '상품B', 'product', '<p>수정</p>', '[]']);
    const up = await c.query(`SELECT status, inflow_guide_html FROM campaign_options WHERE opt_key='상품B'`);
    assert.equal(up.rows[0].status, 'closed', 'status 미지정은 기존 상태 보존(조용한 재오픈 금지)');
    assert.equal(up.rows[0].inflow_guide_html, '<p>수정</p>', '가이드는 갱신');
    t('PG: 업서트 — 가이드는 갱신 / status 미지정은 보존', () => {});
  } finally {
    try { await c.query(`DROP SCHEMA ${schema} CASCADE`); } catch (_) { /* noop */ }
    await c.end();
  }
}

(async () => {
  if (process.env.PGTEST_URL) await pgChecks(process.env.PGTEST_URL);
  else console.log('  · (PGTEST_URL 없음 — 진짜 PG 검증 생략)');
  console.log(`\n✅ campaignUnitGuide: ${n}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
