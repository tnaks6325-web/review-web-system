/**
 * 업체(광고주) 병합 — 같은 업체가 둘로 갈려 있을 때 하나로 합친다.
 *
 * 2026-09-28 실사고: 인트라넷에서 사업자등록증 정정으로 사업자명의 법인격 표기만 바뀌었는데
 *   (`주식회사 올곧은무역` → `(주)올곧은무역`), 리뷰웹 옛 업체에 원본 ID 가 없어 다음 작업오더 접수가
 *   **같은 업체를 하나 더** 만들었다. 업체용 뷰어를 두 개 봐야 하고 관리도 두 벌이 됐다(어니스트캄도 동일).
 *
 * 규율(사용자 확정 2026-09-28):
 *   - ★★ **사람이 두 업체를 지목해야만** 돈다(자동 병합 금지 — 결정 004). 미리보기(confirm 없음)는 쓰기 0.
 *   - ★★ 남는 쪽(target)만 존재하고 옛 업체(source)는 **완전히 지운다** — 딸린 것을 전부 옮긴 뒤에만.
 *   - ★★ 옛 접속 링크는 **계속 열리게** 한다(169 별칭) — 업체가 이미 그 주소를 쓰고 있을 수 있다.
 *     같은 이름의 브랜드는 하나로 합치고 옛 브랜드 링크도 별칭으로 살린다.
 *   - ★ 두 업체가 **서로 다른 인트라넷 광고주**에 연결돼 있으면 거부(원본이 다르면 다른 회사다).
 *   - ★ 겹치는 값은 **남는 쪽이 이긴다**, 빈 칸만 옛 업체 값으로 채운다(blank-only).
 *   - ★ 한 트랜잭션 — 중간 실패로 반쯤 옮겨진 상태를 남기지 않는다.
 *   - ★ 업체 id 를 품은 표는 전부 여기서 처리해야 한다 — 회귀가드가 마이그레이션의 `advertiser_id`
 *     칼럼을 가진 표 목록과 MERGE_TABLES 를 대조한다(표가 늘면 가드가 빨개진다).
 */
const defaultPool = require('../db/pool');
const { logger } = require('../utils/logger');

// 업체 id 를 품은 표 — 회귀가드가 마이그레이션과 대조한다.
const MERGE_TABLES = [
  'advertiser_campaigns', 'advertiser_users', 'portal_works', 'portal_comments', 'work_orders',
  'trackb_advertiser_links', 'trackb_advertiser_prefs', 'trackb_brands', 'trackb_brand_tab_map',
  'trackb_share_links', 'trackb_tab_brand_managers',
];
const MERGE_LOG_KEY = 'advertiser_merge_log';

class MergeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function _t(v, n) { return String(v == null ? '' : v).trim().slice(0, n || 200); }
function _brandKey(name) { return String(name || '').replace(/\s+/g, '').toLowerCase(); }

async function _count(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0] ? Number(rows[0].n) || 0 : 0;
}

/** 미리보기 재료 — 옮겨질 것들의 건수(두 업체 각각). */
async function _inventory(client, id) {
  const q = (sql) => _count(client, sql, [id]);
  return {
    campaigns: await q(`SELECT COUNT(*) n FROM advertiser_campaigns WHERE advertiser_id=$1 AND deleted_at IS NULL`),
    users: await q(`SELECT COUNT(*) n FROM advertiser_users WHERE advertiser_id=$1`),
    portalWorks: await q(`SELECT COUNT(*) n FROM portal_works WHERE advertiser_id=$1`),
    workOrders: await q(`SELECT COUNT(*) n FROM work_orders WHERE advertiser_id=$1`),
    brands: await q(`SELECT COUNT(*) n FROM trackb_brands WHERE advertiser_id=$1 AND deleted_at IS NULL`),
    brandTabs: await q(`SELECT COUNT(*) n FROM trackb_brand_tab_map WHERE advertiser_id=$1`),
    brandManagers: await q(`SELECT COUNT(*) n FROM trackb_tab_brand_managers WHERE advertiser_id=$1`),
    link: await q(`SELECT COUNT(*) n FROM trackb_advertiser_links WHERE advertiser_id=$1`),
    // 미리보기가 "옛 링크는 계속 열린다"고 말하려면 **살아 있는** 링크인지 알아야 한다(폐기된 링크는 별칭으로 살리지 않는다).
    linkActive: await q(`SELECT COUNT(*) n FROM trackb_advertiser_links WHERE advertiser_id=$1 AND active = TRUE`),
  };
}

/**
 * @param {{sourceId:string, targetId:string, confirm?:boolean, by?:string}} args
 *   sourceId = 없어질 옛 업체 / targetId = 남을 업체
 */
async function mergeAdvertisers({ sourceId, targetId, confirm = false, by = '' } = {}, deps) {
  const pool = (deps && deps.pool) || defaultPool;
  const src = _t(sourceId, 64), tgt = _t(targetId, 64);
  if (!src || !tgt) return { ok: false, code: 400, error: '합칠 두 업체를 모두 지정하세요.' };
  if (src === tgt) return { ok: false, code: 400, error: '같은 업체끼리는 합칠 수 없습니다.' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: advs } = await client.query(
      `SELECT id, name, status, COALESCE(inad_pm,'') AS inad_pm, COALESCE(contact,'') AS contact,
              COALESCE(memo,'') AS memo, COALESCE(intranet_advertiser_id,'') AS iid,
              COALESCE(intranet_business_number,'') AS biz, COALESCE(intranet_contact,'') AS icontact
         FROM advertisers WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [[src, tgt]]);
    const S = advs.find(a => a.id === src), T = advs.find(a => a.id === tgt);
    if (!S || !T) throw new MergeError('업체를 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도하세요.', 'not_found');
    if (String(T.status || '') === 'ended') throw new MergeError('남길 업체가 종료된 거래처입니다. 진행 중인 업체를 남기세요.', 'target_ended');
    if (S.iid && T.iid && S.iid !== T.iid) {
      throw new MergeError('두 업체가 서로 다른 인트라넷 광고주에 연결돼 있어 합칠 수 없습니다(다른 회사입니다).', 'different_intranet');
    }

    const preview = {
      source: { id: S.id, name: S.name, intranetLinked: !!S.iid, ...(await _inventory(client, src)) },
      target: { id: T.id, name: T.name, intranetLinked: !!T.iid, ...(await _inventory(client, tgt)) },
    };
    if (confirm !== true) {
      await client.query('ROLLBACK');
      return { ok: true, dryRun: true, preview };
    }

    const out = { campaignsMoved: 0, campaignsFolded: 0, linkAliased: false, linkMoved: false,
      brandsMoved: 0, brandsFolded: 0, brandAliases: 0 };

    // 1) 작업 소유 — 같은 작업을 둘 다 갖고 있으면 남는 쪽 행을 살리고 옛 행을 지운다.
    await client.query(
      `UPDATE advertiser_campaigns t SET deleted_at = NULL
         FROM advertiser_campaigns s
        WHERE s.advertiser_id = $1 AND t.advertiser_id = $2
          AND s.sheet_id = t.sheet_id AND COALESCE(s.tab_gid,'') = COALESCE(t.tab_gid,'')
          AND s.deleted_at IS NULL AND t.deleted_at IS NOT NULL`, [src, tgt]);
    const folded = await client.query(
      `DELETE FROM advertiser_campaigns s USING advertiser_campaigns t
        WHERE s.advertiser_id = $1 AND t.advertiser_id = $2
          AND s.sheet_id = t.sheet_id AND COALESCE(s.tab_gid,'') = COALESCE(t.tab_gid,'')`, [src, tgt]);
    out.campaignsFolded = folded.rowCount || 0;
    const moved = await client.query(`UPDATE advertiser_campaigns SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);
    out.campaignsMoved = moved.rowCount || 0;

    // 2) 계정·포털·작업오더 — 단순 이동.
    await client.query(`UPDATE advertiser_users SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);
    await client.query(`UPDATE portal_works SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);
    await client.query(`UPDATE portal_comments SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);
    await client.query(`UPDATE work_orders SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);

    // 3) 접속 링크 — 남는 쪽에 없으면 옮기고, 있으면 옛 주소를 별칭으로 살린다(폐기된 링크는 되살리지 않는다).
    const { rows: [sLink] } = await client.query(`SELECT token, active FROM trackb_advertiser_links WHERE advertiser_id = $1`, [src]);
    const { rows: [tLink] } = await client.query(`SELECT token FROM trackb_advertiser_links WHERE advertiser_id = $1`, [tgt]);
    if (sLink) {
      if (!tLink) {
        await client.query(`UPDATE trackb_advertiser_links SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);
        out.linkMoved = true;
      } else {
        if (sLink.active) {
          await client.query(
            `INSERT INTO trackb_link_aliases (token, kind, target_id, merged_from, created_by)
             VALUES ($1, 'advertiser', $2, $3, $4) ON CONFLICT (token) DO NOTHING`,
            [sLink.token, tgt, src, _t(by, 100)]);
          out.linkAliased = true;
        }
        await client.query(`DELETE FROM trackb_advertiser_links WHERE advertiser_id = $1`, [src]);
      }
    }
    await client.query(`UPDATE trackb_link_aliases SET target_id = $2 WHERE kind = 'advertiser' AND target_id = $1`, [src, tgt]);

    // 4) 정산 노출 설정 — 남는 쪽 값이 이긴다.
    await client.query(
      `UPDATE trackb_advertiser_prefs SET advertiser_id = $2 WHERE advertiser_id = $1
          AND NOT EXISTS (SELECT 1 FROM trackb_advertiser_prefs x WHERE x.advertiser_id = $2)`, [src, tgt]);
    await client.query(`DELETE FROM trackb_advertiser_prefs WHERE advertiser_id = $1`, [src]);

    // 5) 브랜드 — 같은 이름의 살아 있는 브랜드는 하나로 합치고(옛 브랜드 링크는 별칭), 나머지는 옮긴다.
    const { rows: tBrands } = await client.query(
      `SELECT id, name FROM trackb_brands WHERE advertiser_id = $1 AND deleted_at IS NULL`, [tgt]);
    const tByName = new Map(tBrands.map(b => [_brandKey(b.name), b.id]));
    const { rows: sBrands } = await client.query(
      `SELECT id, name, link_token, link_active, deleted_at FROM trackb_brands WHERE advertiser_id = $1`, [src]);
    for (const b of sBrands) {
      const into = !b.deleted_at ? tByName.get(_brandKey(b.name)) : null;
      if (into) {
        await client.query(`UPDATE trackb_brand_tab_map SET brand_id = $2 WHERE brand_id = $1`, [b.id, into]);
        if (b.link_token && b.link_active) {
          await client.query(
            `INSERT INTO trackb_link_aliases (token, kind, target_id, merged_from, created_by)
             VALUES ($1, 'brand', $2, $3, $4) ON CONFLICT (token) DO NOTHING`,
            [b.link_token, into, b.id, _t(by, 100)]);
          out.brandAliases++;
        }
        await client.query(`UPDATE trackb_link_aliases SET target_id = $2 WHERE kind = 'brand' AND target_id = $1`, [b.id, into]);
        await client.query(`DELETE FROM trackb_brands WHERE id = $1`, [b.id]);
        out.brandsFolded++;
      } else {
        await client.query(`UPDATE trackb_brands SET advertiser_id = $2 WHERE id = $1`, [b.id, tgt]);
        if (!b.deleted_at) out.brandsMoved++;
      }
    }
    // 작업↔브랜드 배정: 같은 작업이 양쪽에 배정돼 있으면 남는 쪽 배정이 이긴다.
    await client.query(
      `DELETE FROM trackb_brand_tab_map s USING trackb_brand_tab_map t
        WHERE s.advertiser_id = $1 AND t.advertiser_id = $2
          AND s.sheet_id = t.sheet_id AND s.tab_name = t.tab_name`, [src, tgt]);
    await client.query(`UPDATE trackb_brand_tab_map SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);

    // 6) 브랜드 담당자(136) — 같은 작업이면 남는 쪽 값이 이긴다.
    await client.query(
      `DELETE FROM trackb_tab_brand_managers s USING trackb_tab_brand_managers t
        WHERE s.advertiser_id = $1 AND t.advertiser_id = $2
          AND s.sheet_id = t.sheet_id AND s.tab_name = t.tab_name`, [src, tgt]);
    await client.query(`UPDATE trackb_tab_brand_managers SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);

    // 7) 업체 공유 링크(131, 내부용) — 남는 쪽에 있으면 옛 코드는 지운다(직원은 새로 복사하면 된다).
    await client.query(
      `DELETE FROM trackb_share_links WHERE kind = 'advertiser' AND advertiser_id = $1
          AND EXISTS (SELECT 1 FROM trackb_share_links x WHERE x.kind = 'advertiser' AND x.advertiser_id = $2)`, [src, tgt]);
    await client.query(`UPDATE trackb_share_links SET advertiser_id = $2 WHERE advertiser_id = $1`, [src, tgt]);

    // 8) 화면 개인 설정 — 코멘트 읽음 표시(adv:<id>) · 업체 세션의 즐겨찾기 등(owner_key=업체명) ·
    //    작업보드 업체 배치 순서(업체명 배열). 남는 쪽에 이미 있으면 옛 값은 버린다.
    await client.query(
      `UPDATE trackb_thread_seen SET user_key = $2 WHERE user_key = $1
          AND NOT EXISTS (SELECT 1 FROM trackb_thread_seen x WHERE x.user_key = $2
                           AND x.sheet_id = trackb_thread_seen.sheet_id AND x.tab_name = trackb_thread_seen.tab_name)`,
      ['adv:' + src, 'adv:' + tgt]);
    await client.query(`DELETE FROM trackb_thread_seen WHERE user_key = $1`, ['adv:' + src]);
    for (const tbl of ['trackb_workdesk_favorites', 'trackb_workdesk_worktabs', 'trackb_workdesk_advertiser_order']) {
      await client.query(
        `UPDATE ${tbl} SET owner_key = $2 WHERE owner_key = $1
            AND NOT EXISTS (SELECT 1 FROM ${tbl} x WHERE x.owner_key = $2)`, [S.name, T.name]);
      await client.query(`DELETE FROM ${tbl} WHERE owner_key = $1`, [S.name]);
    }
    const { rows: orderRows } = await client.query(
      `SELECT owner_key, advertiser_keys FROM trackb_workdesk_advertiser_order WHERE advertiser_keys ? $1`, [S.name]);
    for (const r of orderRows) {
      const arr = Array.isArray(r.advertiser_keys) ? r.advertiser_keys : [];
      const next = [];
      for (const k of arr) { const v = k === S.name ? T.name : k; if (!next.includes(v)) next.push(v); }
      await client.query(`UPDATE trackb_workdesk_advertiser_order SET advertiser_keys = $2::jsonb, updated_at = NOW() WHERE owner_key = $1`,
        [r.owner_key, JSON.stringify(next)]);
    }

    // 9) 남는 업체의 빈 칸만 옛 값으로 채운다. 원본 ID 는 UNIQUE 라 옛 업체에서 먼저 뗀다.
    if (S.iid && !T.iid) await client.query(`UPDATE advertisers SET intranet_advertiser_id = '' WHERE id = $1`, [src]);
    await client.query(
      `UPDATE advertisers SET
         inad_pm = CASE WHEN COALESCE(inad_pm,'') = '' THEN $2 ELSE inad_pm END,
         contact = CASE WHEN COALESCE(contact,'') = '' THEN $3 ELSE contact END,
         memo    = CASE WHEN COALESCE(memo,'') = '' THEN $4 ELSE memo END,
         intranet_advertiser_id   = CASE WHEN COALESCE(intranet_advertiser_id,'') = '' THEN $5 ELSE intranet_advertiser_id END,
         intranet_business_number = CASE WHEN COALESCE(intranet_business_number,'') = '' THEN $6 ELSE intranet_business_number END,
         intranet_contact         = CASE WHEN COALESCE(intranet_contact,'') = '' THEN $7 ELSE intranet_contact END,
         updated_at = NOW()
       WHERE id = $1`, [tgt, S.inad_pm, S.contact, S.memo, S.iid, S.biz, S.icontact]);

    // 10) 옛 업체 삭제 — 딸린 것을 다 옮긴 뒤라 CASCADE 로 사라지는 것이 없어야 한다(아래에서 확인).
    const left = await _inventory(client, src);
    const remaining = Object.entries(left).filter(([, n]) => n > 0).map(([k]) => k);
    if (remaining.length) {
      throw new MergeError(`옛 업체에 옮기지 못한 정보가 남아 합치기를 취소했습니다(${remaining.join(', ')}).`, 'leftover');
    }
    await client.query(`DELETE FROM advertisers WHERE id = $1`, [src]);

    // 11) 기록 — 누가 언제 무엇을 합쳤는지(되돌리기 판단 재료). 실패해도 병합은 유지.
    const entry = { at: new Date().toISOString(), by: _t(by, 100), source: { id: S.id, name: S.name },
      target: { id: T.id, name: T.name }, result: out };
    try {
      await client.query('SAVEPOINT merge_log');
      const { rows: [cur] } = await client.query(`SELECT value FROM app_settings WHERE key = $1`, [MERGE_LOG_KEY]);
      let arr = [];
      try { arr = JSON.parse((cur && cur.value) || '[]'); } catch (_) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      arr.unshift(entry);
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [MERGE_LOG_KEY, JSON.stringify(arr.slice(0, 100))]);
      await client.query('RELEASE SAVEPOINT merge_log');
    } catch (e) {
      try { await client.query('ROLLBACK TO SAVEPOINT merge_log'); } catch (_) {}
      logger.warn(`[advMerge] 기록 실패(병합은 유지): ${e.message}`);
    }

    await client.query('COMMIT');
    logger.info(`[advMerge] ${S.name}(${S.id}) → ${T.name}(${T.id}) by ${by}: ${JSON.stringify(out)}`);
    return { ok: true, dryRun: false, preview, result: out, kept: { id: T.id, name: T.name } };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err instanceof MergeError) return { ok: false, code: err.code === 'not_found' ? 404 : 409, reason: err.code, error: err.message };
    if (err && err.code === '42P01') return { ok: false, code: 503, reason: 'not_ready', error: '업체 합치기가 아직 준비되지 않았습니다(migration 169 미적용).' };
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { mergeAdvertisers, MERGE_TABLES, MERGE_LOG_KEY };
