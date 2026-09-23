/**
 * shareLink.service.js — 작업보드·업체 공유 링크 (migration 131)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 하는 일 = **"그 작업보드로 바로 가는 짧은 주소"를 만들고 되찾아 준다.**
 *   인수인계(택배·문의) 때 상대가 검색 탭에서 매번 찾아 들어가던 것을,
 *   `.../workdesk#w=<code>` 한 줄을 메신저로 던지는 것으로 바꾼다.
 *
 * ★★ **링크는 권한이 아니다(완화 금지)** — code 는 "어디로 갈지"만 말한다.
 *   ① 여는 사람은 평소와 똑같이 로그인해야 하고(비로그인 진입 없음)
 *   ② 작업 링크는 되찾을 때 `canAccessTab` 을 그대로 통과해야 한다.
 *   그래서 링크가 카톡방에서 굴러다녀도 담당 범위 밖 사람에게는 열리지 않는다.
 *   광고주 전용 접속 링크(058)와 정반대의 물건이다 — 그쪽은 로그인을 대신하는 열쇠,
 *   이쪽은 로그인한 사람에게 길만 알려 주는 이정표다.
 *
 * ★ **대상마다 코드 1개**(부분 유니크) — 언제 눌러도 같은 주소가 나온다. 이미 공유해 둔
 *   링크가 다음에 눌렀다고 죽으면 "고유 링크"라는 말이 성립하지 않는다.
 * ★ 쓰기 표면 = `trackb_share_links` 한 곳(운영 테이블 무접촉).
 */
const crypto = require('crypto');
const { logger } = require('../utils/logger');

let _pool = null;
function getPool() { if (!_pool) _pool = require('../db/pool'); return _pool; }

const CODE_BYTES = 9;          // base64url 12자 — 카톡에서 한 줄에 들어가고 추측은 불가
const MAX_TRIES = 5;

function _newCode() { return crypto.randomBytes(CODE_BYTES).toString('base64url'); }
function _s(v) { return String(v == null ? '' : v).trim(); }

// 131 미적용(42P01) — 088 규율: 조용한 500 대신 무엇이 없는지 말한다.
function notReady(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

/**
 * 작업(탭) 공유 링크 확보 — 있으면 그대로, 없으면 발급.
 * ★ tab_gid 는 **blank-only 보정**(이미 있는 값은 안 덮는다 — 리네임 교정은 다른 경로의 일).
 */
async function ensureTabShareLink({ sheetId, tabName, tabGid, by } = {}) {
  const sid = _s(sheetId), tab = _s(tabName);
  if (!sid || !tab) throw Object.assign(new Error('sheetId, tabName 필수'), { status: 400 });
  const db = getPool();
  for (let i = 0; i < MAX_TRIES; i++) {
    const { rows } = await db.query(
      `SELECT code FROM trackb_share_links WHERE kind='tab' AND sheet_id=$1 AND tab_name=$2`, [sid, tab]);
    if (rows[0]) {
      if (_s(tabGid)) await db.query(
        `UPDATE trackb_share_links SET tab_gid=$2 WHERE code=$1 AND kind='tab' AND COALESCE(tab_gid,'')=''`,
        [rows[0].code, _s(tabGid)]).catch(() => {});
      return { code: rows[0].code, created: false };
    }
    try {
      const code = _newCode();
      const ins = await db.query(
        `INSERT INTO trackb_share_links (code, kind, sheet_id, tab_name, tab_gid, created_by)
         VALUES ($1,'tab',$2,$3,$4,$5)
         ON CONFLICT DO NOTHING RETURNING code`,
        [code, sid, tab, _s(tabGid), _s(by).slice(0, 100)]);
      if (ins.rows[0]) return { code: ins.rows[0].code, created: true };
      // ON CONFLICT DO NOTHING = 같은 대상(경합) 또는 code 충돌 → 위 SELECT 로 되돌아가 재확인
    } catch (e) { if (i === MAX_TRIES - 1) throw e; }
  }
  throw new Error('공유 링크를 만들지 못했습니다.');
}

/** 업체 공유 링크 확보 — 있으면 그대로, 없으면 발급. */
async function ensureAdvertiserShareLink({ advertiserId, by } = {}) {
  const aid = _s(advertiserId);
  if (!aid) throw Object.assign(new Error('advertiserId 필수'), { status: 400 });
  const db = getPool();
  for (let i = 0; i < MAX_TRIES; i++) {
    const { rows } = await db.query(
      `SELECT code FROM trackb_share_links WHERE kind='advertiser' AND advertiser_id=$1`, [aid]);
    if (rows[0]) return { code: rows[0].code, created: false };
    try {
      const ins = await db.query(
        `INSERT INTO trackb_share_links (code, kind, advertiser_id, created_by)
         VALUES ($1,'advertiser',$2,$3) ON CONFLICT DO NOTHING RETURNING code`,
        [_newCode(), aid, _s(by).slice(0, 100)]);
      if (ins.rows[0]) return { code: ins.rows[0].code, created: true };
    } catch (e) { if (i === MAX_TRIES - 1) throw e; }
  }
  throw new Error('공유 링크를 만들지 못했습니다.');
}

/**
 * 코드 → 대상. 못 찾으면 null(스코프 판정은 호출부 라우트가 한다).
 * ★ 업체 이름은 여기서 조인해 함께 돌려준다 — 화면이 "무엇을 여는 링크인지" 말할 수 있어야 한다.
 */
async function resolveShareLink(code) {
  const c = _s(code);
  if (!c || c.length > 64) return null;
  const { rows } = await getPool().query(
    `SELECT s.code, s.kind, s.sheet_id AS "sheetId", s.tab_name AS "tabName", s.tab_gid AS "tabGid",
            s.advertiser_id AS "advertiserId", a.name AS "advertiserName", a.status AS "advertiserStatus"
       FROM trackb_share_links s
       LEFT JOIN advertisers a ON a.id = s.advertiser_id
      WHERE s.code = $1`, [c]);
  return rows[0] || null;
}

/** 열람 기록 — 실패해도 이동을 막지 않는다(fail-soft). */
async function touchShareLink(code) {
  try { await getPool().query(`UPDATE trackb_share_links SET last_used_at=NOW() WHERE code=$1`, [_s(code)]); }
  catch (e) { logger.warn('[shareLink] touch 실패', { code: _s(code), err: e && e.message }); }
}

module.exports = { ensureTabShareLink, ensureAdvertiserShareLink, resolveShareLink, touchShareLink, notReady };
