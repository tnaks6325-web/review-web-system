/**
 * advertiserWorkLink.service.js — 업체 작업 링크의 단축 주소 (migration 229 · 결정 419)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 왜: 작업보드 [🏢 광고주링크]가 복사하던 주소는 `#a=<열쇠>&work=<작업 좌표 JSON>` 이라
 *   작업 이름(한글·괄호)이 그대로 퍼센트 인코딩돼 200자를 넘었고, 카카오톡은 주소 속 `)` 에서
 *   링크를 끊어 버렸다(2026-11-25 직원 신고 — 「337)10/20(쿠팡)…」 작업에서 링크가 반쯤 잘림).
 *   → `.../workdesk#k=<12자>` 짧은 주소를 주고, 받은 화면이 서버에서 원래 주소로 되돌린다.
 *
 * ★★ 단축 주소는 권한을 새로 만들지 않는다(완화 금지) — 코드는 **그때의 접속 열쇠(token) + 작업 좌표**만
 *   가리킨다. 실제 입장은 언제나 기존 교환(`/advertiser-link-login` → loginByLinkToken)이 판정한다.
 *   그래서 업체관리에서 링크를 **폐기**하면 단축 주소도 막히고, **회전**하면 옛 열쇠를 가리키는
 *   단축 주소는 죽는다(긴 주소와 똑같이). 업체를 합치면 옛 열쇠 별칭(169)을 따라 그대로 열린다.
 * ★ 같은 (열쇠, 작업) 이면 언제 눌러도 같은 코드 — 이미 보낸 주소가 다음 복사로 죽지 않는다.
 * ★ 쓰기 표면 = `trackb_advertiser_work_links` 한 곳.
 */
const crypto = require('crypto');

let _pool = null;
function getPool() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p; }

const CODE_BYTES = 9;          // base64url 12자(72비트) — 공개 되찾기는 IP당 분당 30회로 묶인다
const CODE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_TRIES = 5;

function _newCode() { return crypto.randomBytes(CODE_BYTES).toString('base64url'); }
function _s(v) { return String(v == null ? '' : v).trim(); }

// 229 미적용(42P01) — 부르는 쪽이 긴 주소로 되돌아가게 알려 준다.
function notReady(err) { return !!(err && (err.code === '42P01' || err.code === '42703')); }

/** (열쇠, 작업) 단축 코드 확보 — 있으면 그대로, 없으면 발급. */
async function ensureWorkLink({ token, sheetId, tabName, by } = {}) {
  const tok = _s(token), sid = _s(sheetId), tab = _s(tabName);
  if (!tok || !sid || !tab) throw Object.assign(new Error('token, sheetId, tabName 필수'), { status: 400 });
  const db = getPool();
  for (let i = 0; i < MAX_TRIES; i++) {
    const { rows } = await db.query(
      `SELECT code FROM trackb_advertiser_work_links WHERE token=$1 AND sheet_id=$2 AND tab_name=$3`, [tok, sid, tab]);
    if (rows[0]) return { code: rows[0].code, created: false };
    try {
      const ins = await db.query(
        `INSERT INTO trackb_advertiser_work_links (code, token, sheet_id, tab_name, created_by)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING code`,
        [_newCode(), tok, sid, tab, _s(by).slice(0, 100)]);
      if (ins.rows[0]) return { code: ins.rows[0].code, created: true };
      // ON CONFLICT DO NOTHING = 같은 대상 경합 또는 코드 충돌 → 위 SELECT 로 되돌아가 재확인
    } catch (e) { if (notReady(e) || i === MAX_TRIES - 1) throw e; }
  }
  throw new Error('단축 주소를 만들지 못했습니다.');
}

/** 코드 → { token, sheetId, tabName } (없으면 null). 입장 판정은 하지 않는다 — 부르는 쪽이 기존 교환을 탄다. */
async function resolveWorkLink(code) {
  const c = _s(code);
  if (!CODE_RE.test(c)) return null;
  const db = getPool();
  const { rows } = await db.query(
    `SELECT token, sheet_id, tab_name FROM trackb_advertiser_work_links WHERE code=$1`, [c]);
  if (!rows[0]) return null;
  db.query(`UPDATE trackb_advertiser_work_links SET last_used_at=NOW() WHERE code=$1`, [c]).catch(() => {});
  return { token: rows[0].token, sheetId: rows[0].sheet_id, tabName: rows[0].tab_name };
}

module.exports = { ensureWorkLink, resolveWorkLink, notReady, CODE_RE, __setPoolForTest };
