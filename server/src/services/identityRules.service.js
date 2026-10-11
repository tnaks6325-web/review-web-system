/*
 * 명의 규칙 — 신원 기준 재정립 3-1 (결정 221 기준 · 결정 222).
 * 타계정(명의) 목록이 지켜야 할 규칙을 **한 곳**에 둔다. 지금은 관찰 모드 — 아무것도 막지 않고
 * "켰다면 막았을 저장"만 identity_rule_observations 에 남긴다. 차단은 운영 관찰로 오탐 0 을 확인한 뒤 켠다.
 *
 * 규칙(사용자 확정 2026-10-11):
 *   ① 이름은 띄어쓰기를 무시하고 비교한다.
 *   ② 본인과 이름·번호가 같은 타계정은 두지 않는다(same_as_self).
 *   ③ 한 사람 안에서 이름·번호가 같은 칸은 하나만(duplicate_in_list). 번호가 같아도 이름이 다르면 다른 명의 — 허용.
 *      ("가족" 같은 전제는 두지 않는다 — 이름이 다르면 그냥 다른 명의다.)
 *   ④ 다른 리뷰어의 본인 번호를 타계정으로 두지 않는다(other_owner_self_phone).
 *   ⑤ 다른 리뷰어의 타계정에 이미 있는 번호를 내 타계정으로 두지 않는다 — 명의 돌려쓰기 금지(other_owner_sub_phone).
 *   ⑥ 타계정은 10개까지(limit). ⑦ 이름·번호가 비면 안 된다(missing_name_or_phone).
 * ★ 이미 저장돼 있던 칸은 문제 삼지 않는다(기존 데이터는 담당자가 정리 — 사용자 확정 "가"). 이번 저장으로 **새로 생긴** 위반만 센다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const MAX_SUBS = 10;
const MODE_KEY = 'identity_rules_mode';
const MODES = new Set(['off', 'observe']);   // 'enforce' 는 3-1b 에서 추가(관찰 결과 확인 뒤)

function nameKey(v) { return String(v == null ? '' : v).replace(/\s+/g, ''); }
function phone8Of(v) { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : ''; }
function asSubs(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return asSubs(JSON.parse(v)); } catch (_) { return []; } }
  return [];
}
function sig(name, phone) { const n = nameKey(name), p = phone8Of(phone); return n && p ? `${n}|${p}` : ''; }

let _modeCache = { at: 0, value: 'observe' };
/** 지금 모드. 비상 스위치(환경변수 IDENTITY_RULES_MODE=off)가 이긴다. 설정 조회 실패 = 관찰(막지 않는다). */
async function getMode(db = pool) {
  const forced = String(process.env.IDENTITY_RULES_MODE || '').trim();
  if (MODES.has(forced)) return forced;
  if (Date.now() - _modeCache.at < 30000) return _modeCache.value;
  let value = 'observe';
  try {
    const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [MODE_KEY]);
    const v = rows[0] ? String(rows[0].value || '').replace(/"/g, '').trim() : '';
    if (MODES.has(v)) value = v;
  } catch (_) { value = 'observe'; }
  _modeCache = { at: Date.now(), value };
  return value;
}
function _resetModeCacheForTest() { _modeCache = { at: 0, value: 'observe' }; }

/**
 * 이번 저장으로 새로 생긴 규칙 위반(순수 판정 + 다른 소유자 번호 조회 1회).
 * @param owner {id, name, phone} · prev/next = 저장 전·후 타계정 목록
 * @returns [{code, index, otherOwnerId?}]
 */
async function evaluateSubAccountsChange(db, { owner, prev, next }) {
  const out = [];
  const prevList = asSubs(prev), nextList = asSubs(next);
  const prevCount = new Map();
  prevList.forEach((s) => { const k = sig(s && s.name, s && s.phone); if (k) prevCount.set(k, (prevCount.get(k) || 0) + 1); });
  // 빈 칸(이름·번호 중 하나라도 없음)은 칸 순번이 아니라 **값**으로 센다 — 순서만 바뀐 저장을 새 위반으로 세지 않는다(Codex P2).
  const blankKey = (s) => `${nameKey(s && s.name)}|${String(s && s.phone == null ? '' : s.phone).replace(/\D/g, '')}`;
  const prevBlank = new Map();
  prevList.forEach((s) => { if (!sig(s && s.name, s && s.phone)) { const b = blankKey(s); prevBlank.set(b, (prevBlank.get(b) || 0) + 1); } });
  const selfSig = sig(owner && owner.name, owner && owner.phone);

  if (nextList.length > MAX_SUBS && nextList.length > prevList.length) out.push({ code: 'limit', index: null });
  const seen = new Map();
  const newPhones = [];
  nextList.forEach((s, index) => {
    const k = sig(s && s.name, s && s.phone);
    if (!k) {
      const b = blankKey(s);
      const left = prevBlank.get(b) || 0;
      if (left > 0) prevBlank.set(b, left - 1);
      else out.push({ code: 'missing_name_or_phone', index });
      return;
    }
    const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    const isNew = n > (prevCount.get(k) || 0);
    if (!isNew) return;   // 이미 있던 칸 — 담당자 정리 대상(기존 데이터는 문제 삼지 않는다)
    if (k === selfSig) out.push({ code: 'same_as_self', index });
    else if (n > 1) out.push({ code: 'duplicate_in_list', index });
    // 새로 생긴 명의(이름+번호)는 번호가 내 목록에 이미 있었어도 다른 리뷰어와 겹치는지 본다(Codex P2).
    // 기존 칸 이름만 바꾼 저장도 새 명의로 세어진다 — 차단(3-1b) 때 다룰지 관찰 결과로 정한다.
    newPhones.push({ p8: phone8Of(s.phone), index });
  });
  if (newPhones.length && owner && owner.id) {
    const phones = [...new Set(newPhones.map((x) => x.p8))];
    const { rows } = await db.query(
      `SELECT r.id::text AS owner_id, r.phone8 AS p8, 'self' AS kind FROM reviewers r
        WHERE r.id <> $1::uuid AND r.phone8 = ANY($2::text[])
       UNION ALL
       SELECT r.id::text, RIGHT(regexp_replace(COALESCE(s->>'phone', ''), '[^0-9]', '', 'g'), 8), 'sub'
         FROM reviewers r
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.sub_accounts) = 'array' THEN r.sub_accounts ELSE '[]'::jsonb END) s
        WHERE r.id <> $1::uuid
          AND RIGHT(regexp_replace(COALESCE(s->>'phone', ''), '[^0-9]', '', 'g'), 8) = ANY($2::text[])`,
      [owner.id, phones]);
    for (const { p8, index } of newPhones) {
      const selfHit = rows.find((r) => r.p8 === p8 && r.kind === 'self');
      const subHit = rows.find((r) => r.p8 === p8 && r.kind === 'sub');
      if (selfHit) out.push({ code: 'other_owner_self_phone', index, otherOwnerId: selfHit.owner_id });
      else if (subHit) out.push({ code: 'other_owner_sub_phone', index, otherOwnerId: subHit.owner_id });
    }
  }
  return out;
}

/**
 * 관찰 — 저장이 확정된 **뒤에** 부른다. 어떤 실패도 밖으로 내보내지 않는다(저장에 영향 0).
 * 반환 Promise 는 테스트용 — 호출부는 기다리지 않는다.
 */
function observeSubAccountsWrite({ owner, prev, next, source = '' }, db = pool) {
  return (async () => {
    try {
      const mode = await getMode(db);
      if (mode === 'off') return [];
      const violations = await evaluateSubAccountsChange(db, { owner, prev, next });
      for (const v of violations) {
        await db.query(
          `INSERT INTO identity_rule_observations (source, owner_reviewer_id, rule_code, sub_index, other_owner_reviewer_id, mode)
           VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6)`,
          [String(source || ''), owner && owner.id ? String(owner.id) : null, v.code,
           v.index == null ? null : v.index, v.otherOwnerId || null, mode]);
      }
      if (violations.length) logger.info(`[identity-rules] 관찰(막지 않음) source=${source} owner=${owner && owner.id} ${violations.map((v) => v.code).join(',')}`);
      return violations;
    } catch (err) {
      logger.warn(`[identity-rules] 관찰 실패(저장 무영향): ${err.code || ''} ${err.message}`);
      return [];
    }
  })();
}

module.exports = { MAX_SUBS, MODE_KEY, getMode, evaluateSubAccountsChange, observeSubAccountsWrite,
  _test: { nameKey, phone8Of, sig, _resetModeCacheForTest } };
