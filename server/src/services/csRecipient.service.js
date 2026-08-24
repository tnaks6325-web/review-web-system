/**
 * csRecipient.service.js — 작업표 줄 → **그 참여의 로그인 본계정(phone8)** 판정의 단일 출처.
 *
 * 왜 필요한가
 *  · 작업보드에서 우클릭으로 리뷰어에게 메시지를 보낼 때, 표의 `참여자`·`연락처` 칸은
 *    **명의**(타계정일 수 있다)이지 로그인 계정이 아니다.
 *  · 리뷰어 문의함은 `reviewer.routes.js` 의 `WHERE reviewer_phone8 = $1` — **로그인 phone8 하나**로만
 *    조회한다(타계정 번호는 스코프에 없다). 그래서 명의 번호로 방을 만들면 리뷰어 화면에
 *    **영영 안 보이는 유령 방**이 되고 관리자는 보냈다고 믿는다.
 *  → 그래서 이 판정은 "있으면 좋은 편의"가 아니라 **그 기능의 동작 조건**이다.
 *
 * ★★ 완화 금지 4종
 *   ① **이름만으로 소유자를 추측하지 않는다** — 동명이인 한 번이면 남의 채팅방에 그 사람의
 *      작업·주문 얘기가 들어간다(입금 계좌 오송금과 같은 계열의 사고).
 *   ② **모호하면 보내지 않는다**(후보 2명 이상·근거 0 = 거부, 쓰기 0건). 사유를 문장으로 돌려준다.
 *   ③ **등록 리뷰어가 아니면 보내지 않는다** — 로그인할 수 없는 번호의 방은 아무도 못 읽는다.
 *   ④ 판정 결과(받는 사람·근거·명의와 다른지)를 **보내기 전에 화면이 말한다**(조용한 전송 금지).
 *
 * ★ 미리보기와 전송이 **같은 함수**를 쓴다 — 사본을 두면 "미리보기엔 A인데 실제로는 B에게 갔다".
 * ★ 이 파일은 **읽기 전용**(SELECT 만) — 쓰기는 `csBridge.postAdminNotice` 한 곳이다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { normName } = require('./identity.service');

/** 근거 코드 → 사람이 읽는 한 줄(화면·로그 공용). */
const VIA_LABEL = {
  owner_order: '참여 원장(타계정 소유자)',
  owner_link: '제출 신원 링크(로그인 계정)',
  self: '본인 명의(등록 리뷰어)',
  owner_sub: '타계정 등록(소유자 역조회)',
};

function _p8(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

/**
 * 작업표 줄들 → 받는 사람(본계정) 판정.
 *
 * @param {object} p
 * @param {string} p.sheetId
 * @param {string} p.tabName
 * @param {string[]} p.participantIds  campaign_participants.id 목록(최대 200)
 * @returns {Promise<Array>} 요청한 id 마다 1건 —
 *   { participantId, seq, rowName, rowPhone8, ok, phone8, name, via, viaLabel, isSub, nameMismatch, reason }
 */
async function resolveRecipients({ sheetId, tabName, participantIds } = {}) {
  const ids = [...new Set((participantIds || []).map(v => String(v || '').trim()).filter(Boolean))].slice(0, 200);
  if (!sheetId || !tabName || !ids.length) return [];

  // ── 0) 대상 줄 — 표에 실제로 보이는 줄과 **같은 조건**(숨김·분리·삭제 줄은 대상이 아니다)
  const { rows: cps } = await pool.query(
    `SELECT id, seq, reviewer_name AS "rowName", phone8 AS "rowPhone8",
            order_submission_id AS "orderId"
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND id = ANY($3::uuid[])
        AND deleted_at IS NULL AND active = TRUE AND held_at IS NULL`,
    [sheetId, tabName, ids]);
  const byId = new Map(cps.map(r => [String(r.id), r]));

  const orderIds = [...new Set(cps.map(r => r.orderId).filter(Boolean).map(String))];
  const seqs = [...new Set(cps.map(r => r.seq).filter(v => Number.isInteger(v)))];
  const rowP8s = [...new Set(cps.map(r => _p8(r.rowPhone8)).filter(Boolean))];

  // ── ① 참여 원장 — 주문 id 로 그 줄에 결속된 홀드의 소유자.
  //    ★ 홀드 생성 시 서버가 명의 검증을 거쳐 기록한 값이라 가장 강한 근거다.
  //    ★ 같은 주문에 소유자가 둘로 보이면(데이터 오염) 채택하지 않는다.
  const ownerByOrder = new Map();
  if (orderIds.length) {
    const { rows } = await pool.query(
      `SELECT order_submission_id AS "orderId",
              COUNT(DISTINCT owner_phone8)::int AS n,
              MIN(owner_phone8) AS "ownerPhone8"
         FROM campaign_applications
        WHERE order_submission_id = ANY($1::uuid[]) AND COALESCE(owner_phone8,'') <> ''
        GROUP BY order_submission_id`,
      [orderIds]).catch(e => { logger.warn(`[csRecipient] 참여 원장 조회 실패: ${e.message}`); return { rows: [] }; });
    for (const r of rows) if (r.n === 1) ownerByOrder.set(String(r.orderId), r.ownerPhone8);
  }

  // ── ② 제출 신원 링크 — 그 줄을 제출한 **로그인 phone8**(시트/작업표 기록 성공 후에만 남는다).
  const linkBySeq = new Map();
  if (seqs.length) {
    const { rows } = await pool.query(
      `SELECT row_index AS "seq", phone8, name
         FROM participation_links
        WHERE sheet_id=$1 AND tab_name=$2 AND row_index = ANY($3::int[]) AND COALESCE(phone8,'') <> ''`,
      [sheetId, tabName, seqs]).catch(e => { logger.warn(`[csRecipient] 신원 링크 조회 실패: ${e.message}`); return { rows: [] }; });
    for (const r of rows) linkBySeq.set(Number(r.seq), r);
  }

  // ── ④ 그 명의 번호가 **누구의 타계정으로 등록돼 있는가**(번호 일치만 — 이름 추측 금지).
  const subOwners = new Map();   // 명의 phone8 → [소유자 phone8]
  if (rowP8s.length) {
    const { rows } = await pool.query(
      `SELECT DISTINCT r.phone8 AS "ownerPhone8",
              RIGHT(regexp_replace(COALESCE(s->>'phone',''), '[^0-9]', '', 'g'), 8) AS "subPhone8"
         FROM reviewers r,
              jsonb_array_elements(CASE WHEN jsonb_typeof(r.sub_accounts)='array' THEN r.sub_accounts ELSE '[]'::jsonb END) s
        WHERE RIGHT(regexp_replace(COALESCE(s->>'phone',''), '[^0-9]', '', 'g'), 8) = ANY($1::text[])
          AND COALESCE(r.phone8,'') <> ''`,
      [rowP8s]).catch(e => { logger.warn(`[csRecipient] 타계정 역조회 실패: ${e.message}`); return { rows: [] }; });
    for (const r of rows) {
      const k = r.subPhone8;
      if (!subOwners.has(k)) subOwners.set(k, []);
      if (!subOwners.get(k).includes(r.ownerPhone8)) subOwners.get(k).push(r.ownerPhone8);
    }
  }

  // ── 후보 번호들의 등록 리뷰어(표시 이름 + 등록 여부 + 타계정 목록) 한 번에
  const cand = [...new Set([
    ...ownerByOrder.values(),
    ...[...linkBySeq.values()].map(v => _p8(v.phone8)),
    ...rowP8s,
    ...[...subOwners.values()].flat(),
  ].map(_p8).filter(Boolean))];
  const revByP8 = new Map();
  if (cand.length) {
    const { rows } = await pool.query(
      `SELECT phone8, COALESCE(name,'') AS name, COALESCE(phone,'') AS phone,
              CASE WHEN jsonb_typeof(sub_accounts)='array' THEN sub_accounts ELSE '[]'::jsonb END AS "subAccounts"
         FROM reviewers WHERE phone8 = ANY($1::text[])`,
      [cand]).catch(e => { logger.warn(`[csRecipient] 리뷰어 조회 실패: ${e.message}`); return { rows: [] }; });
    for (const r of rows) {
      if (!revByP8.has(r.phone8)) revByP8.set(r.phone8, []);
      revByP8.get(r.phone8).push(r);
    }
  }
  const registered = p8 => (revByP8.get(p8) || []).length > 0;
  /** 그 소유자의 타계정 목록에 이 줄(번호 또는 이름)이 등록돼 있는가 — ② 의 stale 링크 방어. */
  const ownsRow = (ownerP8, row) => {
    const list = revByP8.get(ownerP8) || [];
    const rn = normName(row.rowName), rp = _p8(row.rowPhone8);
    for (const rev of list) {
      if (rn && normName(rev.name) === rn) return true;                 // 본인 명의 참여
      const arr = Array.isArray(rev.subAccounts) ? rev.subAccounts : [];
      for (const s of arr) {
        if (!s) continue;
        if (rp && _p8(s.phone) === rp) return true;                     // 타계정 번호 일치
        if (rn && normName(s.name) === rn) return true;                 // 타계정 이름 일치(그 소유자 안에서만)
      }
    }
    return false;
  };
  const displayName = p8 => {
    const list = revByP8.get(p8) || [];
    const names = [...new Set(list.map(r => String(r.name || '').trim()).filter(Boolean))];
    return names.length === 1 ? names[0] : (names[0] || '');
  };
  /* 받는 사람의 **전체 연락처**(사용자 확정 2026-08-21 — 뒤 4자리로는 누구인지 확인이 안 된다).
     ★ 등록 원장의 `phone` 을 그대로 준다 — `phone8`(뒤 8자리)로 앞자리를 `010` 이라 **추측하지 않는다**.
     ★ 같은 phone8 을 쓰는 행이 둘이면 값이 하나로 모일 때만 쓴다(모호하면 빈 값 → 화면이 뒤 4자리로 접는다). */
  const displayPhone = p8 => {
    const list = revByP8.get(p8) || [];
    const ph = [...new Set(list.map(r => String(r.phone || '').trim()).filter(Boolean))];
    return ph.length === 1 ? ph[0] : '';
  };

  return ids.map(id => {
    const row = byId.get(String(id));
    const base = { participantId: String(id) };
    if (!row) return { ...base, ok: false, reason: '표에 없는 줄입니다(삭제·분리되었을 수 있습니다).' };
    const out = { ...base, seq: row.seq, rowName: row.rowName || '', rowPhone8: _p8(row.rowPhone8) };

    let phone8 = '', via = '';
    const o1 = row.orderId ? ownerByOrder.get(String(row.orderId)) : null;
    if (o1 && registered(_p8(o1))) { phone8 = _p8(o1); via = 'owner_order'; }

    if (!phone8) {
      const l = linkBySeq.get(Number(row.seq));
      const lp = l ? _p8(l.phone8) : '';
      // ★ 이름 대조 필수 — 재배정된 줄의 stale 링크가 엉뚱한 사람의 방을 열지 못하게 한다.
      if (lp && registered(lp) && ownsRow(lp, row)) { phone8 = lp; via = 'owner_link'; }
    }
    if (!phone8 && out.rowPhone8 && registered(out.rowPhone8)) { phone8 = out.rowPhone8; via = 'self'; }
    if (!phone8 && out.rowPhone8) {
      const owners = (subOwners.get(out.rowPhone8) || []).map(_p8).filter(registered);
      const uniq = [...new Set(owners)];
      if (uniq.length === 1) { phone8 = uniq[0]; via = 'owner_sub'; }
      else if (uniq.length > 1) {
        return { ...out, ok: false, reason: `이 번호가 ${uniq.length}명의 타계정으로 등록돼 있어 로그인 계정을 특정할 수 없습니다.` };
      }
    }

    if (!phone8) {
      // ★ 사유를 구분해 말한다 — 담당자가 무엇을 고쳐야 하는지 알아야 한다.
      const why = !out.rowPhone8
        ? '이 줄의 연락처가 비어 있습니다'
        : '이 연락처로 등록된 리뷰어를 찾지 못했습니다(등록리뷰어DB에서 등록해 주세요)';
      return { ...out, ok: false, reason: `로그인 계정을 찾지 못했습니다 — ${why}.` };
    }

    const name = displayName(phone8);
    const isSub = !!(out.rowPhone8 && out.rowPhone8 !== phone8);
    // 명의 이름과 본계정 이름이 다르면 **막지 않고 밝힌다**(타계정 참여의 정상 모습이기도 하다).
    const nameMismatch = !isSub && !!(out.rowName && name && normName(out.rowName) !== normName(name));
    return { ...out, ok: true, phone8, phoneFull: displayPhone(phone8), name, via,
      viaLabel: VIA_LABEL[via] || via, isSub, nameMismatch };
  });
}

module.exports = { resolveRecipients, VIA_LABEL };
