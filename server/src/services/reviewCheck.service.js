/**
 * reviewCheck.service.js — 제출한 리뷰 캡처의 검수 결과를 **리뷰어에게** 보여준다.
 *
 * 사용자 확정 2026-09-26
 *   ① 반려는 시스템이 바로 정한다(담당자 확인을 기다리지 않는다)
 *   ② 제출 직후에는 `확인 중` — 검사가 끝나면 `제출완료` 또는 `제출 반려`
 *   ③ 반려 사실은 리뷰 내역과 **1:1 문의방 양쪽**에 남는다
 *   ④ 자동 반려 대상은 **중복 리뷰 이미지 하나만**(나머지는 분석 정확도가 올라간 뒤)
 *
 * ★★ 이 파일이 "무엇을 반려로 볼지"의 **단일 출처**다. 화면·라우트에 판정을 다시 세우면
 *    "카드는 반려인데 문의방엔 안내가 없다" 같은 어긋남이 생긴다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

/* ═══════════════════════════════════════════════════════════════
   ① 반려 판정 — 사용자 확정: 중복 리뷰 이미지 하나만
   ═══════════════════════════════════════════════════════════════
   ★★ 여기를 넓히지 말 것(완화 금지의 반대 방향 = 확대 금지).
      · duplicate = SHA-256 정확 일치라 **우리가 틀릴 여지가 거의 없다**.
      · format(리뷰 화면 아님)·product(다른 상품)·channel 은 AI 추정이라
        오판 시 **정상 리뷰어가 반려를 본다** — 그건 불량 1건을 놓치는 것보다 큰 사고다
        (리뷰 자동검수 규율: 우리 오류로 리뷰어를 막지 않는다).
      · 넓히려면 사용자 확정을 다시 받는다. */
const AUTO_REJECT_CHECKS = ['duplicate'];

/** 유형 → 리뷰어 화면에 적는 짧은 말(카드 배지 아래 한 줄) */
const REJECT_SHORT = { duplicate: '중복 리뷰 이미지' };

/** 유형 → 1:1 문의 안내문의 설정 키(utils/inspectMessages 의 유형 key 와 같은 이름) */
const REJECT_MSG_KEY = { duplicate: 'duplicate' };

/**
 * 검수 결과(checks)가 자동 반려 대상인가.
 * @returns {string|null} 반려 사유 유형 키('duplicate') | null(반려 아님)
 *
 * ★ `duplicate.verdict` 가 'fail' 일 때만이다. 같은 리뷰어가 다른 작업에 낸 같은 캡처는
 *   `classifyDuplicateContext` 가 이미 'pass'(한 화면에 여러 리뷰) 또는 'warn' 으로
 *   완화해 두므로 여기 걸리지 않는다. 같은 (시트·탭·행·리뷰어) 재업로드도 애초에
 *   중복으로 세지 않는다(findDuplicate 쿼리에서 제외) — 정상 재제출은 반려되지 않는다.
 */
function autoRejectKind(checks) {
  if (!checks || typeof checks !== 'object') return null;
  for (const k of AUTO_REJECT_CHECKS) {
    const c = checks[k];
    if (c && typeof c === 'object' && c.verdict === 'fail') return k;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════
   ② 소급 금지 기준선 — 이 시각 이전 제출분은 종전대로 '제출완료'로만 보인다
   ═══════════════════════════════════════════════════════════════ */
const VISIBLE_FROM_KEY = 'review_check_visible_from';
const _CACHE_MS = 5 * 60 * 1000;
let _vfCache = { at: 0, v: undefined };

/**
 * @returns {Promise<Date|null>} 기준선 | null(모름)
 * ★★ 모르면 null 을 돌려주고, 호출부는 그때 **아무것도 새로 보여주지 않는다**(fail-closed).
 *    기준선을 모르는 채로 상태를 그리면 과거 제출 건이 통째로 '확인 중'으로 뒤집힌다.
 */
async function visibleFrom() {
  if (_vfCache.v !== undefined && Date.now() - _vfCache.at < _CACHE_MS) return _vfCache.v;
  try {
    const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [VISIBLE_FROM_KEY]);
    const raw = rows[0] && rows[0].value;
    const d = raw ? new Date(raw) : null;
    const v = (d && !isNaN(d.getTime())) ? d : null;
    _vfCache = { at: Date.now(), v };
    return v;
  } catch (e) {
    logger.warn(`[reviewCheck] 기준선 조회 실패(표시 생략): ${e.message}`);
    _vfCache = { at: Date.now(), v: null };
    return null;
  }
}

/** 테스트·설정 변경 직후용 */
function _resetVisibleFromCache() { _vfCache = { at: 0, v: undefined }; }

/* ═══════════════════════════════════════════════════════════════
   ③ 리뷰어 화면 재료 — 그 행의 검수 상태를 한 번에
   ═══════════════════════════════════════════════════════════════ */
const KEY_SEP = '\u0000';
const rowKey = (sheetId, tabName, rowIndex) =>
  String(sheetId || '') + KEY_SEP + String(tabName || '') + KEY_SEP + String(rowIndex ?? '');

/**
 * 여러 행의 검수 상태를 한 번에 읽는다(N+1 금지).
 * @param {Array<{sheetId,tabName,rowIndex}>} keys
 * @returns {Promise<Map<string,{state:'checking'|'rejected', kind?:string, short?:string}>>}
 *
 * 판정
 *   · 하나라도 자동 반려 대상(중복 fail) + 관리자가 '정상'으로 풀지 않음 → **rejected**
 *   · 하나라도 아직 검사가 안 끝남(pending)                              → **checking**
 *   · 그 외                                                              → 맵에 없음(= 종전 '제출완료')
 *
 * ★ 조회 실패·기준선 미상은 **빈 맵**(fail-closed) — 화면이 종전 그대로 뜬다.
 */
async function reviewCheckMap(keys) {
  const list = (keys || []).filter(k => k && k.sheetId && k.tabName && k.rowIndex != null);
  const out = new Map();
  if (!list.length) return out;

  const from = await visibleFrom();
  if (!from) return out;                    // 기준선을 모르면 아무것도 새로 보여주지 않는다

  try {
    const sheets = list.map(k => String(k.sheetId));
    const tabs   = list.map(k => String(k.tabName));
    const rows_  = list.map(k => parseInt(k.rowIndex, 10));
    const { rows } = await pool.query(
      `SELECT ri.sheet_id, ri.tab_name, ri.row_index,
              ri.status, ri.checks, ri.resolution, ri.created_at
         FROM review_inspections ri
         JOIN unnest($1::text[], $2::text[], $3::int[]) AS t(s, tb, rw)
           ON ri.sheet_id = t.s AND ri.tab_name = t.tb AND ri.row_index = t.rw
        WHERE ri.created_at >= $4
          AND COALESCE(ri.slot_key, 'review') <> 'trashed'`,
      [sheets, tabs, rows_, from]
    );

    for (const r of rows) {
      const k = rowKey(r.sheet_id, r.tab_name, r.row_index);
      const prev = out.get(k);
      if (prev && prev.state === 'rejected') continue;      // 반려가 가장 강하다

      // 관리자가 '정상'으로 확인했으면 반려가 아니다(오탐이었다는 뜻).
      const released = String(r.resolution || '') === 'ok';
      const kind = released ? null : autoRejectKind(r.checks);
      if (kind) {
        out.set(k, { state: 'rejected', kind, short: REJECT_SHORT[kind] || '' });
        continue;
      }
      if (String(r.status || '') === 'pending' && !prev) out.set(k, { state: 'checking' });
    }
    return out;
  } catch (e) {
    logger.warn(`[reviewCheck] 상태 조회 실패(표시 생략): ${e.message}`);
    return new Map();
  }
}

/* ═══════════════════════════════════════════════════════════════
   ④ 반려 안내 — 1:1 문의방에 자동으로 한 번만
   ═══════════════════════════════════════════════════════════════ */

/** 설정된 안내문구(관리자가 고쳤으면 그 값, 아니면 기본 문구) */
async function _rejectMessage(kind) {
  const IM = require('../utils/inspectMessages');
  const key = REJECT_MSG_KEY[kind] || kind;
  let saved = {};
  try {
    const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [IM.SETTING_KEY]);
    if (rows[0] && rows[0].value) saved = JSON.parse(rows[0].value) || {};
  } catch (_) { /* 미설정·파싱 실패 = 기본 문구 */ }
  const merged = IM.merge(saved);
  return IM.render(merged[key] || IM.DEFAULTS[key] || '', {
    reason: REJECT_SHORT[kind] || '',
  });
}

/**
 * 그 파일의 반려를 문의방에 **한 번만** 알린다.
 * ★ 실행부는 관리자 [✕ 불량]과 **같은 함수**(`notifyInspectionReject`) — 사본 0.
 *   리뷰어 연락처 해석(4갈래 폴백)·카드·닉네임 가림이 그대로 상속된다.
 * ★ 절대 throw 하지 않는다 — 검수는 이미 끝났고, 안내 실패가 그걸 되돌리면 안 된다.
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
async function notifyRejectionOnce({ fileId, kind, matchFileId }) {
  if (!fileId || !kind) return { sent: false, reason: 'no_target' };
  let claimed = false;
  try {
    // ★ 선점 — 동시에 두 번 불려도 한 번만 나간다(전송 실패 시 아래에서 되돌린다).
    const { rows } = await pool.query(
      `UPDATE review_inspections
          SET reviewer_notified_at = NOW()
        WHERE file_id = $1 AND reviewer_notified_at IS NULL
        RETURNING file_id`,
      [fileId]
    );
    if (!rows.length) return { sent: false, reason: 'already_notified' };
    claimed = true;

    const message = await _rejectMessage(kind);
    if (!message) { await _releaseClaim(fileId); return { sent: false, reason: 'no_message' }; }

    const out = await require('./reviewInspect.service').notifyInspectionReject({
      fileId, message, by: 'system:auto',
      // 반려된 사진과 이미 제출된 사진을 나란히 보여준다(카드 렌더러가 두 장을 그린다)
      card: matchFileId ? { kind: 'duplicate', matchFileId } : { kind: 'reject' },
    });
    if (!out || !out.sent) {
      await _releaseClaim(fileId);
      return { sent: false, reason: (out && out.error) || 'send_failed' };
    }
    return { sent: true };
  } catch (e) {
    if (claimed) await _releaseClaim(fileId);
    logger.warn(`[reviewCheck] 반려 안내 실패(무시): ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

/** 전송이 실패했으면 선점을 되돌린다 — 다음 기회에 다시 보낼 수 있게. */
async function _releaseClaim(fileId) {
  try {
    await pool.query('UPDATE review_inspections SET reviewer_notified_at = NULL WHERE file_id = $1', [fileId]);
  } catch (_) { /* 되돌리기 실패 = 다음 안내가 생략될 뿐 */ }
}

/**
 * 검수 결과를 받아 반려면 안내까지 보낸다(제출 직후 뒤에서 · 스윕 뒤에서 공용).
 * @param {{fileId:string, inspection:{status:string, checks:object}|null}} p
 * @returns {Promise<{rejected:boolean, kind?:string, notify?:object}>}
 */
async function applyInspectionOutcome({ fileId, inspection }) {
  try {
    const kind = autoRejectKind(inspection && inspection.checks);
    if (!kind) return { rejected: false };
    const dup = (inspection.checks && inspection.checks.duplicate) || {};
    const notify = await notifyRejectionOnce({ fileId, kind, matchFileId: dup.matchFileId || '' });
    return { rejected: true, kind, notify };
  } catch (e) {
    logger.warn(`[reviewCheck] 반려 처리 실패(무시): ${e.message}`);
    return { rejected: false };
  }
}

/**
 * 한 행의 검수 상태 + 리뷰어에게 보일 안내문(참여상품 정보 팝업용).
 * ★ 판정은 `reviewCheckMap` 그대로 — 화면마다 다른 기준이 생기지 않게 한다.
 * ★ 실패·해당 없음은 **null**(팝업이 아무것도 그리지 않는다).
 */
async function reviewCheckDetail({ sheetId, tabName, rowIndex }) {
  try {
    const map = await reviewCheckMap([{ sheetId, tabName, rowIndex }]);
    const v = map.get(rowKey(sheetId, tabName, rowIndex));
    if (!v) return null;
    if (v.state !== 'rejected') return { state: v.state };
    return {
      state: 'rejected',
      kind: v.kind || '',
      short: v.short || '',
      message: await _rejectMessage(v.kind),   // 문의방에 간 것과 **같은 문장**
    };
  } catch (e) {
    logger.warn(`[reviewCheck] 상세 조회 실패(표시 생략): ${e.message}`);
    return null;
  }
}

module.exports = {
  AUTO_REJECT_CHECKS, REJECT_SHORT, REJECT_MSG_KEY,
  autoRejectKind,
  visibleFrom, _resetVisibleFromCache, VISIBLE_FROM_KEY,
  rowKey, reviewCheckMap, reviewCheckDetail,
  notifyRejectionOnce, applyInspectionOutcome,
};
