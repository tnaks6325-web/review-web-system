/**
 * 회귀가드(진짜 PG): 업체 합치기 + 옛 링크 별칭 + 등록 시 인트라넷 원본 ID 저장.
 *
 * 2026-09-28 실사고(주식회사 올곧은무역 ↔ (주)올곧은무역 · 어니스트캄 ↔ 주식회사 어니스트캄):
 *   인트라넷에서 사업자명 법인 표기만 정정됐는데 리뷰웹 옛 업체에 원본 ID 가 없어 같은 업체가 둘이 됐다.
 * 스텁으로는 못 잡는 것(UNIQUE·FK CASCADE·jsonb 연산자·실제 로그인 교환)을 진짜 PG 로 실행한다.
 *
 * 실행: PGTEST_URL=postgres://... node tests/advertiserMergePg.test.js  (없으면 건너뜀)
 */
if (!process.env.PGTEST_URL) { console.log('advertiserMergePg: PGTEST_URL 없음 — 건너뜀'); process.exit(0); }
process.env.DATABASE_URL = process.env.PGTEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const pool = require('../src/db/pool');
const { mergeAdvertisers } = require('../src/services/advertiserMerge.service');
const auth = require('../src/services/auth.service');
const trackB = require('../src/services/trackB.service');

let failed = 0;
function ok(msg, cond) { if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } }
const q = (sql, p) => pool.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];
const n = async (sql, p) => Number((await one(sql, p)).n);

const S = 'adv_t_src', T = 'adv_t_tgt', X = 'adv_t_other';

async function seed() {
  await q(`DELETE FROM trackb_link_aliases WHERE merged_from LIKE 'adv_t_%' OR merged_from LIKE 'brd_t_%'`);
  for (const t of ['advertiser_campaigns', 'trackb_brand_tab_map', 'trackb_brands', 'trackb_tab_brand_managers', 'trackb_advertiser_prefs'])
    await q(`DELETE FROM ${t} WHERE advertiser_id LIKE 'adv_t_%'`);
  await q(`DELETE FROM trackb_workdesk_advertiser_order WHERE owner_key LIKE 'tester%' OR owner_key LIKE '어니스트캄%' OR owner_key LIKE '주식회사 어니스트캄%'`);
  await q(`DELETE FROM trackb_workdesk_favorites WHERE owner_key IN ('어니스트캄','주식회사 어니스트캄')`);
  await q(`DELETE FROM trackb_thread_seen WHERE user_key LIKE 'adv:adv_t_%'`);
  await q(`DELETE FROM advertisers WHERE id LIKE 'adv_t_%'`);

  await q(`INSERT INTO advertisers (id, name, status, inad_pm, contact, memo, sort_order) VALUES ($1,'어니스트캄','active','이만수','010','옛메모',0)`, [S]);
  await q(`INSERT INTO advertisers (id, name, status, inad_pm, intranet_advertiser_id, intranet_business_number, sort_order)
           VALUES ($1,'주식회사 어니스트캄','active','','iadv-honest','123-45-67890',0)`, [T]);
  await q(`INSERT INTO advertisers (id, name, status, intranet_advertiser_id, sort_order) VALUES ($1,'다른회사','active','iadv-other',0)`, [X]);
  // 작업 소유: S 3건(그중 g2 는 T 도 가짐) · T 1건 + 해제된 g3
  await q(`INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid) VALUES ($1,'sh','g1'),($1,'sh','g2'),($1,'sh','g3')`, [S]);
  await q(`INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid) VALUES ($1,'sh','g2')`, [T]);
  await q(`INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid, deleted_at) VALUES ($1,'sh','g3',NOW())`, [T]);
  // 링크 둘 다 사용 중
  await q(`INSERT INTO trackb_advertiser_links (advertiser_id, token, active) VALUES ($1,'tok_old_S',TRUE),($2,'tok_new_T',TRUE)`, [S, T]);
  // 브랜드: 같은 이름 '웰스앤헬스' 양쪽 · S 만 '체크오'
  await q(`INSERT INTO trackb_brands (id, advertiser_id, name, link_token) VALUES
           ('brd_t_sW',$1,'웰스앤헬스','btok_sW'),('brd_t_sC',$1,'체크오','btok_sC'),('brd_t_tW',$2,'웰스 앤헬스','btok_tW')`, [S, T]);
  await q(`INSERT INTO trackb_brand_tab_map (brand_id, advertiser_id, sheet_id, tab_name) VALUES
           ('brd_t_sW',$1,'sh','탭A'),('brd_t_sC',$1,'sh','탭B'),('brd_t_sW',$1,'sh','탭C'),('brd_t_tW',$2,'sh','탭C')`, [S, T]);
  await q(`INSERT INTO trackb_tab_brand_managers (advertiser_id, sheet_id, tab_name, managers) VALUES
           ($1,'sh','탭A','["김"]'::jsonb),($1,'sh','탭C','["박"]'::jsonb),($2,'sh','탭C','["이"]'::jsonb)`, [S, T]);
  await q(`INSERT INTO trackb_advertiser_prefs (advertiser_id, settlement_visible) VALUES ($1, FALSE)`, [S]);
  await q(`INSERT INTO trackb_thread_seen (user_key, sheet_id, tab_name) VALUES ('adv:${S}','sh','탭A')`);
  await q(`INSERT INTO trackb_workdesk_favorites (owner_key, favorites) VALUES ('어니스트캄','["x"]'::jsonb)`);
  await q(`INSERT INTO trackb_workdesk_advertiser_order (owner_key, advertiser_keys) VALUES ('tester1','["어니스트캄","가","주식회사 어니스트캄"]'::jsonb)`);
}

(async () => {
  console.log('advertiserMergePg');
  await seed();

  // 1) 미리보기 = 쓰기 0
  const pv = await mergeAdvertisers({ sourceId: S, targetId: T, by: 'tester' });
  ok('미리보기는 건수만 보여 주고 아무것도 바꾸지 않는다',
    pv.ok && pv.dryRun && pv.preview.source.campaigns === 3 && pv.preview.target.brands === 1
    && (await n(`SELECT COUNT(*) n FROM advertisers WHERE id=$1`, [S])) === 1);

  ok('미리보기가 옛 링크가 살아 있는지 알려 준다(폐기 링크를 "계속 열림"으로 말하지 않게)', pv.preview.source.link === 1 && pv.preview.source.linkActive === 1);
  // 2) 다른 인트라넷 광고주끼리는 거부(쓰기 0)
  const diff = await mergeAdvertisers({ sourceId: X, targetId: T, confirm: true, by: 'tester' });
  ok('서로 다른 인트라넷 광고주에 연결된 업체는 합치지 않는다',
    !diff.ok && diff.reason === 'different_intranet' && (await n(`SELECT COUNT(*) n FROM advertisers WHERE id=$1`, [X])) === 1);

  // 3) 실제 합치기
  const r = await mergeAdvertisers({ sourceId: S, targetId: T, confirm: true, by: 'tester' });
  ok('합치기 성공', r.ok && !r.dryRun);
  ok('옛 업체는 완전히 사라진다', (await n(`SELECT COUNT(*) n FROM advertisers WHERE id=$1`, [S])) === 0);
  ok('작업 소유가 전부 남는 업체로 온다(겹친 g2 는 하나 · 해제돼 있던 g3 는 살아난다)',
    (await n(`SELECT COUNT(*) n FROM advertiser_campaigns WHERE advertiser_id=$1 AND deleted_at IS NULL`, [T])) === 3
    && (await n(`SELECT COUNT(*) n FROM advertiser_campaigns WHERE advertiser_id=$1`, [S])) === 0);
  const tRow = await one(`SELECT * FROM advertisers WHERE id=$1`, [T]);
  ok('남는 업체의 빈 칸만 옛 값으로 채운다(담당AE·메모) · 원본 ID·이름은 그대로',
    tRow.inad_pm === '이만수' && tRow.memo === '옛메모' && tRow.intranet_advertiser_id === 'iadv-honest' && tRow.name === '주식회사 어니스트캄');
  ok('같은 이름 브랜드는 하나로 합치고 다른 브랜드는 옮긴다',
    (await n(`SELECT COUNT(*) n FROM trackb_brands WHERE advertiser_id=$1 AND deleted_at IS NULL`, [T])) === 2
    && (await n(`SELECT COUNT(*) n FROM trackb_brands WHERE id='brd_t_sW'`)) === 0);
  const map = (await q(`SELECT tab_name, brand_id FROM trackb_brand_tab_map WHERE advertiser_id=$1 ORDER BY tab_name`, [T])).rows;
  ok('브랜드 배정: 옛 웰스앤헬스 작업은 남는 웰스앤헬스로, 겹친 작업은 남는 쪽 배정이 이긴다',
    JSON.stringify(map) === JSON.stringify([
      { tab_name: '탭A', brand_id: 'brd_t_tW' }, { tab_name: '탭B', brand_id: 'brd_t_sC' }, { tab_name: '탭C', brand_id: 'brd_t_tW' }]));
  const mgr = await one(`SELECT managers FROM trackb_tab_brand_managers WHERE advertiser_id=$1 AND tab_name='탭C'`, [T]);
  ok('브랜드 담당자는 겹치면 남는 쪽 값이 이긴다', JSON.stringify(mgr.managers) === '["이"]'
    && (await n(`SELECT COUNT(*) n FROM trackb_tab_brand_managers WHERE advertiser_id=$1`, [T])) === 2);
  ok('정산 노출 설정이 옮겨진다', (await one(`SELECT settlement_visible FROM trackb_advertiser_prefs WHERE advertiser_id=$1`, [T])).settlement_visible === false);
  ok('코멘트 읽음 표시·업체 세션 즐겨찾기가 따라온다',
    (await n(`SELECT COUNT(*) n FROM trackb_thread_seen WHERE user_key='adv:${T}'`)) === 1
    && (await n(`SELECT COUNT(*) n FROM trackb_workdesk_favorites WHERE owner_key='주식회사 어니스트캄'`)) === 1);
  const ord = await one(`SELECT advertiser_keys FROM trackb_workdesk_advertiser_order WHERE owner_key='tester1'`);
  ok('작업보드 업체 배치 순서에서 옛 이름이 남는 이름으로 바뀌고 중복은 접힌다',
    JSON.stringify(ord.advertiser_keys) === '["주식회사 어니스트캄","가"]');

  // 4) 옛 링크가 계속 열린다 — 합쳐진 업체로
  const oldIn = await auth.loginByLinkToken('tok_old_S');
  ok('옛 업체 접속 링크로 들어오면 합쳐진 업체로 열린다', oldIn.success && oldIn.advertiserId === T);
  const newIn = await auth.loginByLinkToken('tok_new_T');
  ok('남는 업체 링크도 그대로 열린다', newIn.success && newIn.advertiserId === T);
  const bIn = await auth.loginByLinkToken('btok_sW');
  ok('합쳐진 옛 브랜드 링크는 남는 브랜드로 열린다', bIn.success && bIn.brandId === 'brd_t_tW');
  const bMoved = await auth.loginByLinkToken('btok_sC');
  ok('옮겨진 브랜드 링크는 그대로 열린다', bMoved.success && bMoved.brandId === 'brd_t_sC' && bMoved.advertiserId === T);

  // 5) 유출 대응이 약해지지 않는다 — 폐기하면 옛 주소도 막히고, 회전하면 옛 주소가 지워진다
  await trackB.setAdvertiserLinkActive({ advertiserId: T, active: false, by: 'tester' });
  ok('남는 업체 링크를 폐기하면 옛 주소도 열리지 않는다', !(await auth.loginByLinkToken('tok_old_S')).success);
  await trackB.setAdvertiserLinkActive({ advertiserId: T, active: true, by: 'tester' });
  ok('다시 켜면 옛 주소도 다시 열린다', (await auth.loginByLinkToken('tok_old_S')).success);
  await trackB.generateAdvertiserLink({ advertiserId: T, by: 'tester' });
  ok('링크를 회전하면 옛 주소는 더 이상 열리지 않는다',
    !(await auth.loginByLinkToken('tok_old_S')).success
    && (await n(`SELECT COUNT(*) n FROM trackb_link_aliases WHERE kind='advertiser' AND target_id=$1`, [T])) === 0);

  // 6) 기록이 남는다
  const log = await one(`SELECT value FROM app_settings WHERE key='advertiser_merge_log'`);
  ok('합치기 기록(누가·무엇을)이 남는다', !!log && JSON.parse(log.value)[0].source.id === S);

  // 7) 근본 원인 수정: 업체관리 등록이 인트라넷 원본 ID 를 저장하고, 표기만 다른 업체는 새로 만들지 않는다
  await q(`DELETE FROM advertisers WHERE id LIKE 'adv_%' AND name IN ('새로운무역','(주)새로운무역')`);
  const verify = async () => ({ ok: true, registered: true, matches: [{ intranetId: 'iadv-new', bizNo: '999-99-99999', name: '새로운무역' }] });
  const c1 = await trackB.createAdvertiserScoped({ name: '새로운무역', role: 'admin', inadPm: 'x', _verify: verify });
  ok('등록하면 인트라넷 원본 ID·사업자번호가 함께 저장된다',
    c1.ok && c1.intranetLinked && (await one(`SELECT intranet_advertiser_id i, intranet_business_number b FROM advertisers WHERE id=$1`, [c1.data.id])).i === 'iadv-new');
  const verify2 = async () => ({ ok: true, registered: true, matches: [{ intranetId: 'iadv-new', bizNo: '', name: '(주)새로운무역' }] });
  const c2 = await trackB.createAdvertiserScoped({ name: '(주)새로운무역', role: 'admin', inadPm: 'x', _verify: verify2 });
  ok('법인 표기만 다른 같은 업체는 새로 만들지 않고 기존 업체를 알려 준다',
    !c2.ok && c2.code === 409 && c2.existingId === c1.data.id);
  const verify3 = async () => ({ ok: true, registered: true, matches: [{ intranetId: 'a1', name: '동명' }, { intranetId: 'a2', name: '동명' }] });
  await q(`DELETE FROM advertisers WHERE name='동명'`);
  const c3 = await trackB.createAdvertiserScoped({ name: '동명', role: 'admin', inadPm: 'x', _verify: verify3 });
  ok('인트라넷에 같은 이름이 둘이면 원본 ID 를 추측하지 않는다',
    c3.ok && !c3.intranetLinked && (await one(`SELECT intranet_advertiser_id i FROM advertisers WHERE id=$1`, [c3.data.id])).i === '');

  // 8) 접수: 원본 ID 로 이름이 따라갈 때 옛 업체가 그 이름을 쓰고 있어도 접수가 죽지 않는다
  const { projectIntranetAdvertiser } = require('../src/services/advertiserProjection.service');
  await q(`DELETE FROM work_orders WHERE id='wo_t_1'`).catch(() => {});
  await q(`INSERT INTO advertisers (id, name, status, sort_order) VALUES ('adv_t_old2','(주)이름쓰는중','active',0)`);
  await q(`INSERT INTO advertisers (id, name, status, intranet_advertiser_id, sort_order) VALUES ('adv_t_linked2','이름쓰는중','active','iadv-busy',0)`);
  let projErr = null;
  try {
    await projectIntranetAdvertiser({ id: 'wo_t_1', intranet_advertiser_id: 'iadv-busy', intranet_advertiser_name: '(주)이름쓰는중' }, {}, { pool });
  } catch (e) { projErr = e; }
  ok('원본 ID 로 찾은 업체의 새 이름을 다른 업체가 쓰고 있으면 이름은 두고 접수는 계속된다',
    !projErr && (await one(`SELECT name FROM advertisers WHERE id='adv_t_linked2'`)).name === '이름쓰는중');

  await pool.end();
  console.log(failed ? `advertiserMergePg: FAILED (${failed})` : 'advertiserMergePg: passed');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch (_) {} process.exit(1); });
