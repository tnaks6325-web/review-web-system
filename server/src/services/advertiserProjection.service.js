/**
 * 인트라넷 광고주 → 리뷰웹 업체(advertisers) / 포털 작업(portal_works) 원본 연결.
 * (order.routes 의 `_upsertIntranetAdvertiserAndPortalWork` 를 이관 — 접수 라우트가 유일 소비처)
 *
 * ★★ 자동 병합의 근거는 `intranet_advertiser_id` 하나뿐이다(migration 103).
 *   이름은 표시값이라, 같은 이름이라는 이유로 붙이면 그 업체의 작업 소유·정산 계약·
 *   광고주 접속 링크(로그인 없이 열리는 URL)가 남에게 통째로 열린다.
 *
 * ★★ 그래서 "같은 이름인데 원본 ID 가 없는 업체"는 자동으로 병합하지 않되, **막다른 길로
 *   두지도 않는다** — 후보를 사유와 함께 돌려주고(`advertiser_name_conflict`), 사람이
 *   "같은 업체입니다"라고 확인해 `linkAdvertiserId` 로 다시 접수하면 그때 원본 ID 를
 *   **비어 있을 때만** 채운다(blank-only 백필). 종전에는 이 확인 창구가 없어, 업체관리에서
 *   먼저 만들어 둔 업체(= `intranet_advertiser_id` 가 빈 값)와 이름이 겹치는 순간
 *   접수가 영구히 409 로 막혔다(2026-08-19 실사고).
 */
const crypto = require('crypto');
const defaultPool = require('../db/pool');

const ADVERTISER_NAME_CONFLICT = 'advertiser_name_conflict';

class AdvertiserLinkError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'AdvertiserLinkError';
    this.code = code || '';
    this.detail = detail || null;
  }
}

function _text(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}
function _dateOrNull(v) {
  return (v && String(v).trim()) ? v : null;
}
function _intOrZero(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
function _portalWorkId() {
  return 'pw_' + crypto.randomBytes(6).toString('hex');
}

/**
 * 충돌 후보의 표시 재료. "이 업체가 정말 그 회사인가"를 사람이 판단할 근거만 담는다
 * (사업자번호·연락처·담당AE·소유 작업 수). 관리자 전용 라우트에서만 소비된다.
 * ★ SAVEPOINT 격리 — 이 조회가 실패해도 충돌 안내 자체는 나가야 한다(트랜잭션 abort 차단).
 */
async function _candidates(client, ids) {
  if (!ids.length) return [];
  const minimal = ids.map(id => ({ id, name: '', status: '', inadPm: '', intranetAdvertiserId: '',
    businessNumber: '', contact: '', ownedTabs: null, portalWorks: null }));
  try {
    await client.query('SAVEPOINT adv_cand');
    const { rows } = await client.query(
      `SELECT a.id, a.name, a.status,
              COALESCE(a.inad_pm,'')                  AS "inadPm",
              COALESCE(a.intranet_advertiser_id,'')   AS "intranetAdvertiserId",
              COALESCE(a.intranet_business_number,'') AS "businessNumber",
              COALESCE(a.intranet_contact, a.contact, '') AS "contact",
              a.created_at                            AS "createdAt",
              (SELECT COUNT(*) FROM advertiser_campaigns ac
                WHERE ac.advertiser_id = a.id AND ac.deleted_at IS NULL)::int AS "ownedTabs",
              (SELECT COUNT(*) FROM portal_works pw
                WHERE pw.advertiser_id = a.id)::int                           AS "portalWorks"
         FROM advertisers a
        WHERE a.id = ANY($1::text[])
        ORDER BY a.created_at ASC`,
      [ids]
    );
    await client.query('RELEASE SAVEPOINT adv_cand');
    return rows;
  } catch (_) {
    try { await client.query('ROLLBACK TO SAVEPOINT adv_cand'); } catch (__) {}
    return minimal;   // 후보를 못 꾸며도 "무엇과 겹쳤는지"는 알려준다(조용한 실패 금지)
  }
}

/**
 * @param {object} order   work_orders 행
 * @param {object} context { workSheetUrl, by, linkAdvertiserId }
 *   - linkAdvertiserId: 사람이 "같은 업체"라고 확인한 기존 업체 id (없으면 자동 연결만 시도)
 * @returns {Promise<null|{advertiserId, portalWorkId, linkedExisting}>}
 */
async function projectIntranetAdvertiser(order, context, deps) {
  const pool = (deps && deps.pool) || defaultPool;
  const intranetId = _text(order.intranet_advertiser_id, 128);
  if (!intranetId) return null;

  const name = _text(order.intranet_advertiser_name, 200);
  if (!name) throw new AdvertiserLinkError('원본 광고주명이 없어 광고주를 연결할 수 없습니다.', 'no_advertiser_name');
  const contact = _text(order.intranet_advertiser_contact, 300);
  const businessNumber = _text(order.intranet_advertiser_business_number, 80);
  const linkId = _text(context && context.linkAdvertiserId, 64);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      `SELECT id, intranet_advertiser_id FROM advertisers
        WHERE intranet_advertiser_id = $1
        FOR UPDATE`,
      [intranetId]
    );

    let advertiserId = existingRows[0] && existingRows[0].id;
    let linkedExisting = false;
    if (!advertiserId) {
      const { rows: sameNameRows } = await client.query(
        `SELECT id, intranet_advertiser_id FROM advertisers WHERE name = $1 FOR UPDATE`, [name]
      );
      if (sameNameRows.length && !linkId) {
        // ★ 자동 병합 금지 — 대신 사람이 고를 후보를 함께 돌려준다.
        const candidates = await _candidates(client, sameNameRows.map(r => r.id));
        throw new AdvertiserLinkError(
          '동일 이름의 기존 광고주가 있어 자동 병합하지 않았습니다. 같은 업체인지 확인해 주세요.',
          ADVERTISER_NAME_CONFLICT,
          { name, intranetAdvertiserId: intranetId, businessNumber, contact, candidates }
        );
      }
      if (linkId) {
        // ── 사람이 확인한 기존 업체에 원본 ID 를 백필해 연결 ──
        const { rows: picked } = await client.query(
          `SELECT id, name, COALESCE(intranet_advertiser_id,'') AS cur
             FROM advertisers WHERE id = $1 FOR UPDATE`, [linkId]);
        if (!picked.length) {
          throw new AdvertiserLinkError('고른 업체를 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.', 'advertiser_not_found');
        }
        if (picked[0].cur && picked[0].cur !== intranetId) {
          // ★ 남의 원본을 빼앗지 않는다(fail-closed).
          throw new AdvertiserLinkError('그 업체는 이미 다른 인트라넷 광고주에 연결되어 있습니다.', 'advertiser_already_linked');
        }
        if (_text(picked[0].name, 200) !== name) {
          // ★ 화면이 보여준 뒤 이름이 바뀌었다면 판단 근거가 달라진 것이다 — 다시 확인시킨다.
          throw new AdvertiserLinkError('그 사이 업체명이 바뀌었습니다. 다시 접수해 확인해 주세요.', 'advertiser_name_changed');
        }
        const upd = await client.query(
          `UPDATE advertisers SET
             intranet_advertiser_id   = $2,
             intranet_contact         = COALESCE(NULLIF($3, ''), intranet_contact),
             intranet_business_number = COALESCE(NULLIF($4, ''), intranet_business_number),
             updated_at = NOW()
           WHERE id = $1 AND COALESCE(intranet_advertiser_id,'') = ''
           RETURNING id`,
          [linkId, intranetId, contact, businessNumber]
        );
        if (!upd.rows.length) {
          throw new AdvertiserLinkError('그 업체의 원본 연결이 방금 바뀌었습니다. 다시 시도해 주세요.', 'advertiser_link_race');
        }
        advertiserId = upd.rows[0].id;
        linkedExisting = true;
      } else {
        const { rows: inserted } = await client.query(
          `INSERT INTO advertisers
             (id, name, intranet_advertiser_id, intranet_contact, intranet_business_number)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (intranet_advertiser_id) WHERE intranet_advertiser_id <> ''
           DO UPDATE SET
             name = EXCLUDED.name,
             intranet_contact = COALESCE(NULLIF(EXCLUDED.intranet_contact, ''), advertisers.intranet_contact),
             intranet_business_number = COALESCE(NULLIF(EXCLUDED.intranet_business_number, ''), advertisers.intranet_business_number),
             updated_at = NOW()
           RETURNING id`,
          ['adv_' + crypto.randomBytes(6).toString('hex'), name, intranetId, contact, businessNumber]
        );
        advertiserId = inserted[0].id;
      }
    } else {
      await client.query(
        `UPDATE advertisers SET
           name = $2,
           intranet_contact = COALESCE(NULLIF($3, ''), intranet_contact),
           intranet_business_number = COALESCE(NULLIF($4, ''), intranet_business_number),
           updated_at = NOW()
         WHERE id = $1`,
        [advertiserId, name, contact, businessNumber]
      );
    }

    const { rows: workRows } = await client.query(
      `INSERT INTO portal_works
         (id, advertiser_id, work_order_id, inad_manager, work_type, product, channel,
          qty, progress_date, work_sheet_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (work_order_id) WHERE work_order_id <> ''
       DO UPDATE SET
         advertiser_id = EXCLUDED.advertiser_id,
         inad_manager = EXCLUDED.inad_manager,
         work_type = EXCLUDED.work_type,
         product = EXCLUDED.product,
         channel = EXCLUDED.channel,
         qty = EXCLUDED.qty,
         progress_date = EXCLUDED.progress_date,
         work_sheet_url = COALESCE(NULLIF(EXCLUDED.work_sheet_url, ''), portal_works.work_sheet_url),
         updated_at = NOW()
       RETURNING id`,
      [
        _portalWorkId(), advertiserId, order.id, _text(order.manager_name || order.work_manager, 100),
        order.work_kind === 'blog' ? '블로그 체험단' : '리뷰 체험단',
        _text(order.product_option || order.title, 1000), _text(order.inflow_type, 100),
        _intOrZero(order.recruit_count), _dateOrNull(order.start_date),
        _text(context && context.workSheetUrl, 1000), _text(context && context.by, 100),
      ]
    );
    await client.query(`UPDATE work_orders SET advertiser_id = $2, updated_at = NOW() WHERE id = $1`, [order.id, advertiserId]);
    await client.query('COMMIT');
    return { advertiserId, portalWorkId: workRows[0].id, linkedExisting };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  projectIntranetAdvertiser,
  AdvertiserLinkError,
  ADVERTISER_NAME_CONFLICT,
};
