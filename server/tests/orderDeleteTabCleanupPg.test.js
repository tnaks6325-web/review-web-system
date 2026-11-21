'use strict';
/**
 * orderDeleteTabCleanupPg.test.js — 결정 254 「손대지 않은 빈 작업」 판정의 **공고 범위**를 실제 SQL 로 지킨다(심판 §8 PR 4 「RW-A0」).
 *
 * 왜 이 가드가 따로 있나
 *   기존 `orderDeleteTabCleanup.test.js`(28) 는 스텁 pool 이 SQL 글자(`/AS live,/`)만 보고 숫자를 돌려준다 —
 *   공고 범위(WHERE)를 「이 탭 + 보관 안 된 공고」로 좁혀도 **그대로 통과한다**(블루 실험 guard254.js).
 *   범위가 좁아지면 오더 삭제 자동 정리가 **같은 작업보드의 다른(보관된) 공고에 신청이 있는데도** 작업과 공고를 지운다(되돌릴 수 없음).
 *   그래서 여기서는 PGlite 에 저장소 migrations 를 전부 깔고 판정·삭제를 **실제로 실행**한다.
 *
 *   [1] 범위 경계 — 보관된 다른 공고의 신청(만료 포함) · 탭 이름이 빈 공고(빈 글자·NULL) · 다른 탭·다른 시트 · 공고 경유 주문 · 임시저장 공고 예외(결정 332)
 *       · 지운 줄 흔적도 채운 줄
 *   [2] 판정(_untouchedReasons)과 숫자(campaignUseCounts)가 같은 범위 — 모든 고정구에서 「숫자 > 0 ⇔ 사유 있음」
 *   [3] 판정 범위 = 삭제 범위 — deleteTask(onlyIfUntouched) 를 실제로 돌려 지워지는 공고·남는 공고를 본다
 *   [4] 사본 0 — 범위 식(COALESCE(NULLIF(linked_tab_name,''),$n)=$n)이 CAMPAIGN_TAB_SCOPE 밖 어디에도 없다
 *   [5] 변이 자가검사 — 서비스 소스를 메모리에서 바꿔(범위 좁히기·넓히기·사본) 같은 검사를 돌리면 **실패해야** 한다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const SERVER = path.join(__dirname, '..');
const SVC_PATH = path.join(SERVER, 'src/services/workTabDelete.service.js');
const SVC_SRC = fs.readFileSync(SVC_PATH, 'utf8');

let passed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; } };

(async () => {
  const db = new PGlite();
  for (const f of fs.readdirSync(path.join(SERVER, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8')); } catch (_) { /* pg_trgm·pgcrypto 등 확장 — 아래에서 표만 채운다 */ }
  }
  const query = async (sql, params) => { const r = await db.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; };
  const pool = { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
  const poolPath = require.resolve(path.join(SERVER, 'src/db/pool'));
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (t, p) => pool.query(t, p);

  const svc = require('../src/services/workTabDelete.service');
  for (const t of [...svc.DELETE_TABLES, ...svc.MONEY_TABLES.map(m => m.table)]) {
    await q(`CREATE TABLE IF NOT EXISTS ${t} (id serial, sheet_id text, tab_name text)`);
  }

  // ── 고정구(실행마다 새 시트 id — 변이 실행이 서로 섞이지 않게) ─────────────────
  const T = '11/20(네이버)가상상품 10건';
  const mkTab = async (s, t = T, { empty = 2 } = {}) => {
    await q(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless) VALUES ($1,$2,true)`, [s, t]);
    for (let i = 1; i <= empty; i++) await q(`INSERT INTO campaign_participants (sheet_id, tab_name, seq) VALUES ($1,$2,$3)`, [s, t, i]);
  };
  const mkCampaign = async ({ id, sheet, tab, status = 'active', published = true, archived = false }) => {
    await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, published_at, archived_at)
             VALUES ($1,$1,$2,TRUE,$3,$4, ${published ? 'NOW()' : 'NULL'}, ${archived ? 'NOW()' : 'NULL'})`, [id, status, sheet, tab]);
  };
  let phoneSeq = 0;
  const apply = async (campaignId, status) => { const p8 = String(10000000 + (++phoneSeq)); return q(
    `INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, status, submitted_at) VALUES ($1,'가상신청자',$2,$3,$4::text, CASE WHEN $4::text='submitted' THEN NOW() END)`,
    [campaignId, '010' + p8, p8, status]); };
  const campaignOrder = async campaignId => q(
    `INSERT INTO order_submissions (sheet_id, tab_name) VALUES ($1,'')`, ['campaign:' + campaignId]);

  /** 고정구 한 벌을 깔고 「이름 → {s,t}」를 돌려준다. */
  async function seed(p) {
    const F = {};
    const S = k => `${p}_${k}`;
    // A · 보관된 옛 공고에 만료 신청 1 + 보관된 새 공고(신청 0) — 「이 공고 신청 0」이어도 작업보드 단위로 막힌다
    F.A = { s: S('A'), t: T }; await mkTab(F.A.s);
    await mkCampaign({ id: S('A_old'), sheet: F.A.s, tab: T, status: 'closed', archived: true }); await apply(S('A_old'), 'expired');
    await mkCampaign({ id: S('A_new'), sheet: F.A.s, tab: T, status: 'closed', archived: true });
    // B · 탭 이름이 빈 글자인 공고(같은 시트 · 보관) 에 신청 1 — 어느 작업 것인지 몰라 막고, 숫자에도 들어간다
    F.B = { s: S('B'), t: T }; await mkTab(F.B.s);
    await mkCampaign({ id: S('B_blank'), sheet: F.B.s, tab: '', status: 'closed', archived: true }); await apply(S('B_blank'), 'cancelled');
    // B2 · 탭 이름이 NULL 인 공고(보관) 에 공고 경유 주문 1
    F.B2 = { s: S('B2'), t: T }; await mkTab(F.B2.s);
    await mkCampaign({ id: S('B2_null'), sheet: F.B2.s, tab: null, status: 'closed', archived: true }); await campaignOrder(S('B2_null'));
    // C · 같은 시트 다른 탭 · 다른 시트 같은 탭 이름의 공고(게시 중 · 신청 3) — 이 작업과 무관
    F.C = { s: S('C'), t: T }; await mkTab(F.C.s);
    await mkCampaign({ id: S('C_other_tab'), sheet: F.C.s, tab: T + ' 2차' }); for (let i = 0; i < 3; i++) await apply(S('C_other_tab'), 'applied');
    await mkCampaign({ id: S('C_other_sheet'), sheet: S('C_x'), tab: T }); await apply(S('C_other_sheet'), 'submitted');
    // D · 보관된 공고에 신청은 0, 공고 경유 주문만 1
    F.D = { s: S('D'), t: T }; await mkTab(F.D.s);
    await mkCampaign({ id: S('D_camp'), sheet: F.D.s, tab: T, status: 'closed', archived: true }); await campaignOrder(S('D_camp'));
    // E1 · 게시한 적 없는 임시저장 공고만(보관 안 됨) — 종류 변경(allowDraft)에서만 「살아 있는 공고」가 아니다
    F.E1 = { s: S('E1'), t: T }; await mkTab(F.E1.s);
    await mkCampaign({ id: S('E1_draft'), sheet: F.E1.s, tab: T, status: 'draft', published: false });
    // E2 · 임시저장 + 게시했다가 보관한 공고 — 종류 변경도 막는다(결정 332 · Codex PR #1758)
    F.E2 = { s: S('E2'), t: T }; await mkTab(F.E2.s);
    await mkCampaign({ id: S('E2_draft'), sheet: F.E2.s, tab: T, status: 'draft', published: false });
    await mkCampaign({ id: S('E2_pub_arch'), sheet: F.E2.s, tab: T, status: 'closed', published: true, archived: true });
    // G · 지운 줄(deleted_at)에 이름이 남은 흔적 — 254 는 지운 줄도 「손댄 줄」로 친다(더 엄격)
    F.G = { s: S('G'), t: T }; await mkTab(F.G.s);
    await q(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, reviewer_name, deleted_at) VALUES ($1,$2,9,'가상리뷰어',NOW())`, [F.G.s, T]);
    // F · 손대지 않은 빈 작업: 보관된 빈 공고(같은 탭) + 같은 시트 다른 탭의 게시 공고 → 정리되면 앞엣것만 함께 지워진다
    F.F = { s: S('F'), t: T }; await mkTab(F.F.s);
    await mkCampaign({ id: S('F_arch_empty'), sheet: F.F.s, tab: T, status: 'closed', archived: true });
    await mkCampaign({ id: S('F_other_tab'), sheet: F.F.s, tab: T + ' 2차' }); await apply(S('F_other_tab'), 'applied');
    return F;
  }

  const has = (arr, x) => arr.includes(x);
  /**
   * 같은 검사를 원본·변이 모두에 돌린다. 실패한 검사 이름 목록을 돌려준다(원본 = 빈 목록이어야 한다).
   * @param mod workTabDelete.service 모듈(원본 또는 변이)
   */
  async function checks(mod, prefix) {
    const F = await seed(prefix);
    const fails = [];
    const check = async (name, fn) => { try { await fn(); } catch (e) { fails.push(name + ' — ' + e.message); } };
    const reasons = (f, opts = {}) => opts.kind
      ? mod.kindChangeReasons(q, { sheetId: f.s, tabName: f.t, selfOrderId: '' })
      : mod.untouchedReasons(pool, f.s, f.t);
    const counts = f => mod.campaignUseCounts(q, f.s, f.t);

    await check('A 보관된 옛 공고의 만료 신청 → campaign_used · 신청 1', async () => {
      const r = await reasons(F.A);
      assert.ok(has(r, 'campaign_used'), JSON.stringify(r));
      assert.ok(!has(r, 'live_campaign'), '보관 공고뿐 — 살아 있는 공고 아님');
      assert.deepStrictEqual(await counts(F.A), { applications: 1, campaignOrders: 0, filledRows: 0 });
    });
    await check('B 탭 이름 빈 공고 → ambiguous_campaign + campaign_used · 신청 1(취소 포함)', async () => {
      const r = await reasons(F.B);
      assert.ok(has(r, 'ambiguous_campaign') && has(r, 'campaign_used'), JSON.stringify(r));
      assert.deepStrictEqual(await counts(F.B), { applications: 1, campaignOrders: 0, filledRows: 0 });
    });
    await check('B2 탭 이름 NULL 공고의 공고 주문 → campaign_used · 공고 주문 1', async () => {
      const r = await reasons(F.B2);
      assert.ok(has(r, 'ambiguous_campaign') && has(r, 'campaign_used'), JSON.stringify(r));
      assert.deepStrictEqual(await counts(F.B2), { applications: 0, campaignOrders: 1, filledRows: 0 });
    });
    await check('C 다른 탭·다른 시트 공고의 신청은 세지 않는다', async () => {
      const r = await reasons(F.C);
      assert.ok(!has(r, 'campaign_used') && !has(r, 'live_campaign') && !has(r, 'ambiguous_campaign'), JSON.stringify(r));
      assert.deepStrictEqual(await counts(F.C), { applications: 0, campaignOrders: 0, filledRows: 0 });
    });
    await check('D 신청 0 · 공고 경유 주문 1 → campaign_used', async () => {
      const r = await reasons(F.D);
      assert.ok(has(r, 'campaign_used'), JSON.stringify(r));
      assert.deepStrictEqual(await counts(F.D), { applications: 0, campaignOrders: 1, filledRows: 0 });
    });
    await check('E1 임시저장 공고 — 정리 판정은 살아 있는 공고 · 종류 변경은 예외', async () => {
      assert.ok(has(await reasons(F.E1), 'live_campaign'));
      assert.ok(!has(await reasons(F.E1, { kind: true }), 'live_campaign'));
      assert.deepStrictEqual(await counts(F.E1), { applications: 0, campaignOrders: 0, filledRows: 0 });
    });
    await check('E2 임시저장 + 게시했다 보관한 공고 — 종류 변경도 막음', async () => {
      assert.ok(has(await reasons(F.E2), 'live_campaign'), '임시저장(보관 안 됨)이 있어 정리 판정은 live');
      assert.ok(has(await reasons(F.E2, { kind: true }), 'live_campaign'), '게시했던 공고는 보관돼도 종류 변경을 막는다');
    });
    await check('G 지운 줄에 남은 이름 → filled_rows · 채운 줄 1', async () => {
      assert.ok(has(await reasons(F.G), 'filled_rows'));
      assert.deepStrictEqual(await counts(F.G), { applications: 0, campaignOrders: 0, filledRows: 1 });
    });
    await check('판정 ⇔ 숫자 — 모든 고정구에서 같은 범위(숫자 > 0 이면 사유, 0 이면 사유 없음)', async () => {
      for (const [k, f] of Object.entries(F)) {
        const r = await reasons(f); const c = await counts(f);
        assert.strictEqual(c.applications + c.campaignOrders > 0, has(r, 'campaign_used'), `${k} 공고 사용`);
        assert.strictEqual(c.filledRows > 0, has(r, 'filled_rows'), `${k} 채운 줄`);
      }
    });
    await check('A 실제 자동 정리 → 쓰기 0(not_untouched · campaign_used) · 작업·공고 남음', async () => {
      const out = await mod.deleteTask({ sheetId: F.A.s, tabName: F.A.t, confirm: true, onlyIfUntouched: true, notifyIntranet: false, by: 't', pool });
      assert.strictEqual(out.ok, false); assert.ok(has(out.reasons, 'campaign_used'), JSON.stringify(out));
      assert.strictEqual((await q(`SELECT 1 FROM tab_configs WHERE sheet_id=$1`, [F.A.s])).rows.length, 1);
      assert.strictEqual((await q(`SELECT 1 FROM recruit_campaigns WHERE linked_sheet_id=$1`, [F.A.s])).rows.length, 2);
    });
    await check('F 실제 자동 정리 → 같은 탭 보관 공고는 함께 지움 · 다른 탭 공고는 남김(판정 범위 = 삭제 범위)', async () => {
      assert.deepStrictEqual(await reasons(F.F), []);
      const out = await mod.deleteTask({ sheetId: F.F.s, tabName: F.F.t, confirm: true, onlyIfUntouched: true, notifyIntranet: false, by: 't', pool });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      const left = (await q(`SELECT id FROM recruit_campaigns WHERE linked_sheet_id=$1 ORDER BY id`, [F.F.s])).rows.map(r => r.id);
      assert.deepStrictEqual(left, [prefix + '_F_other_tab']);
      assert.strictEqual((await q(`SELECT 1 FROM campaign_applications WHERE campaign_id=$1`, [prefix + '_F_other_tab'])).rows.length, 1);
      assert.strictEqual((await q(`SELECT 1 FROM tab_configs WHERE sheet_id=$1`, [F.F.s])).rows.length, 0);
    });
    return fails;
  }

  console.log('\n[결정 254 · 판정 공고 범위 단일 출처 · 실 SQL(PGlite)]');
  console.log('[1~3] 범위 경계 · 판정 ⇔ 숫자 · 판정 범위 = 삭제 범위');
  const baseFails = await checks(svc, 'base');
  await ok(`원본 서비스 — 경계 검사 11개 전부 통과`, async () => assert.deepStrictEqual(baseFails, []));

  console.log('[4] 범위 식 사본 0');
  await ok('CAMPAIGN_TAB_SCOPE — 별칭·매개변수 그대로 · 결정 254 판정 쿼리와 글자 같은 조각', async () => {
    assert.strictEqual(svc.CAMPAIGN_TAB_SCOPE('rc'), `rc.linked_sheet_id=$1 AND COALESCE(NULLIF(rc.linked_tab_name,''), $2)=$2`);
    assert.strictEqual(svc.CAMPAIGN_TAB_SCOPE(), `linked_sheet_id=$1 AND COALESCE(NULLIF(linked_tab_name,''), $2)=$2`);
    assert.strictEqual(svc.CAMPAIGN_TAB_SCOPE('', '$3', '$4'), `linked_sheet_id=$3 AND COALESCE(NULLIF(linked_tab_name,''), $4)=$4`);
    for (const bad of [['rc;--'], ['rc', '1'], ['rc', '$1', "$2'"], ['r c']]) assert.throws(() => svc.CAMPAIGN_TAB_SCOPE(...bad), /CAMPAIGN_TAB_SCOPE/);
  });
  await ok('src 어디에도 범위 식을 손으로 쓴 사본이 없다 · 결정 254 판정 쿼리는 조각을 쓴다', async () => {
    const SCOPE_COPY = /COALESCE\(\s*NULLIF\(\s*(?:\w+\.)?linked_tab_name\s*,\s*''\s*\)\s*,\s*\$\d+\s*\)\s*=\s*\$\d+/;
    const hits = [];
    const walk = d => { for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p); else if (n.name.endsWith('.js') && SCOPE_COPY.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(SERVER, p));
    } };
    walk(path.join(SERVER, 'src'));
    assert.deepStrictEqual(hits, [], '범위 식은 workTabDelete.CAMPAIGN_TAB_SCOPE 하나만');
    assert.ok(/AS used\s+FROM recruit_campaigns rc\s+WHERE \$\{CAMPAIGN_TAB_SCOPE\('rc'\)\}`/.test(SVC_SRC), '254 판정 쿼리 WHERE = 조각');
    assert.ok((SVC_SRC.match(/\$\{CAMPAIGN_TAB_SCOPE\(/g) || []).length >= 7, '판정·숫자·삭제·미리보기 범위 모두 조각');
    const routes = fs.readFileSync(path.join(SERVER, 'src/routes/order.routes.js'), 'utf8');
    assert.ok(/CAMPAIGN_TAB_SCOPE\('', '\$3', '\$4'\)/.test(routes), '종류 변경 「다른 곳에 묶인 공고」도 같은 조각(결정 332)');
  });

  console.log('[5] 변이 자가검사 — 범위를 바꾼 사본은 위 검사에 걸려야 한다');
  const mutant = (src) => {
    const m = new Module(SVC_PATH, null);
    m.filename = SVC_PATH; m.paths = Module._nodeModulePaths(path.dirname(SVC_PATH));
    m._compile(src, SVC_PATH);
    return m.exports;
  };
  const MUTANTS = [
    { name: 'M1 조각을 「보관 안 된 공고」로 좁힘', expect: /^A /,
      from: "return `${p}linked_sheet_id=${sheet} AND COALESCE(NULLIF(${p}linked_tab_name,''), ${tab})=${tab}`;",
      to: "return `${p}linked_sheet_id=${sheet} AND COALESCE(NULLIF(${p}linked_tab_name,''), ${tab})=${tab} AND ${p}archived_at IS NULL`;" },
    { name: 'M2 조각에서 빈 탭 이름 포함(COALESCE·NULLIF)을 뺌', expect: /^B /,
      from: "return `${p}linked_sheet_id=${sheet} AND COALESCE(NULLIF(${p}linked_tab_name,''), ${tab})=${tab}`;",
      to: "return `${p}linked_sheet_id=${sheet} AND ${p}linked_tab_name=${tab}`;" },
    { name: 'M3 조각을 시트 단위로 넓힘(탭 무시)', expect: /^C |^F /,
      from: "return `${p}linked_sheet_id=${sheet} AND COALESCE(NULLIF(${p}linked_tab_name,''), ${tab})=${tab}`;",
      to: "return `${p}linked_sheet_id=${sheet} AND ${tab}::text IS NOT NULL`;" },
    { name: 'M4 254 판정 쿼리만 손으로 쓴 좁은 사본(이 탭 + 보관 안 됨)', expect: /^A |^B |^판정 ⇔ 숫자/,
      from: "AS used\n       FROM recruit_campaigns rc\n      WHERE ${CAMPAIGN_TAB_SCOPE('rc')}`",
      to: "AS used\n       FROM recruit_campaigns rc\n      WHERE rc.linked_sheet_id=$1 AND rc.linked_tab_name=$2 AND rc.archived_at IS NULL`" },
    { name: 'M5 숫자가 살아 있는 신청만 셈(취소·만료 빠짐)', expect: /^A |^B /,
      from: 'WHERE ${CAMPAIGN_TAB_SCOPE(\'rc\')})::int AS applications',
      to: "WHERE ${CAMPAIGN_TAB_SCOPE('rc')} AND a.status IN ('applied','submitted'))::int AS applications" },
    { name: 'M6 숫자가 공고 경유 주문을 안 셈', expect: /^B2 |^D /,
      from: 'WHERE ${CAMPAIGN_TAB_SCOPE(\'rc\')})::int AS campaign_orders',
      to: "WHERE ${CAMPAIGN_TAB_SCOPE('rc')} AND FALSE)::int AS campaign_orders" },
    { name: 'M7 숫자가 지운 줄 흔적을 안 셈(254 보다 느슨)', expect: /^G /,
      from: "cp.tab_name=$2 AND ${_filledRowSql('cp')})::int AS filled_rows",
      to: "cp.tab_name=$2 AND cp.deleted_at IS NULL AND ${_filledRowSql('cp')})::int AS filled_rows" },
    { name: 'M8 삭제 범위를 시트 단위로 넓힘(판정과 다른 범위로 공고 삭제)', expect: /^F /,
      from: "`DELETE FROM recruit_campaigns\n        WHERE ${CAMPAIGN_TAB_SCOPE()}",
      to: "`DELETE FROM recruit_campaigns\n        WHERE linked_sheet_id=$1 AND $2::text IS NOT NULL" },
  ];
  let mi = 0;
  for (const mu of MUTANTS) {
    await ok(`${mu.name} → 걸림`, async () => {
      assert.ok(SVC_SRC.includes(mu.from), `변이 대상 글자가 서비스에 있어야 한다(리팩터했으면 변이도 함께 고칠 것): ${mu.from}`);
      const fails = await checks(mutant(SVC_SRC.split(mu.from).join(mu.to)), 'mu' + (++mi));
      assert.ok(fails.length > 0, '변이가 아무 검사에도 안 걸렸다 — 가드가 범위를 못 본다');
      assert.ok(fails.some(f => mu.expect.test(f)), `기대한 검사가 잡아야 한다: ${mu.expect} / 실제: ${fails.join(' | ')}`);
    });
  }

  console.log(`\n✅ orderDeleteTabCleanupPg: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
