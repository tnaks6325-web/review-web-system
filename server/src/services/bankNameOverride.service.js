'use strict';
/**
 * bankNameOverride.service.js — 은행 정식명·자동인식 표기를 **화면에서** 고치는 저장 계층.
 *
 * 배경: 계좌 보완 팝업의 `은행명을 인식하지 못했습니다` 를 담당자가 그 자리에서 못 고쳤다
 *   (`utils/bankCodes.js` 의 표가 코드에 박혀 있어 표기 하나 추가에 배포가 필요했다).
 *
 * ★★ **판정 단일 출처는 여전히 `utils/bankCodes.resolveBank`** — 이 서비스는 그 표에
 *   "무엇이 들어 있는가"만 바꿔 넣는다(`setBankOverrides`). 규칙(정확일치·모르면 null)은 불변.
 * ★★ 저장은 `app_settings.bank_name_overrides` JSON **한 키**(신규 테이블 0) — 레포 관용구.
 * ★★ **조회 실패는 기본 표 유지**(fail-open) — 이 화면이 죽었다고 이체 판정이 멈추면 안 된다.
 *   반대로 **저장은 fail-closed**: 겹침(같은 표기가 두 은행)이면 저장 자체를 막는다.
 * ★ 금액·통장표시·계좌는 회차 생성 시점 값이 `payment_batch_items` 에 박제된다. 다만 **서식의
 *   은행 칸은 박제된 이름이 아니라 `bank_code` 로 다운로드 시점에 다시 계산**하므로(`buildWorkbook`
 *   → `bankFormLabel`), 여기서 이름을 고치면 **과거 회차를 다시 받아도 새 이름**으로 나간다.
 * ★★ 단, 케이뱅크가 이름을 인식 못 하는 기관(`FORM_CODE_ONLY` — 031 대구은행)은 여기서 무엇을
 *   고쳐도 **코드**로 나간다(화면이 `formCodeOnly` 로 그 사실을 말한다).
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const BC = require('../utils/bankCodes');

const SETTING_KEY = 'bank_name_overrides';
const LOG_CAP = 200;          // 이력 보관 건수(오래된 것부터 밀어낸다)
const TTL_MS = 60 * 1000;     // 오버레이 캐시

let _lastRaw = null;          // 마지막으로 적용한 저장값
let _lastAt = 0;
let _meta = { updatedAt: null };
let _inflight = null;

async function _read() {
  const { rows } = await pool.query(
    'SELECT value, updated_at FROM app_settings WHERE key = $1 LIMIT 1', [SETTING_KEY]);
  if (!rows[0]) return { data: {}, updatedAt: null };
  let data = {};
  try { data = JSON.parse(rows[0].value) || {}; } catch (_) { data = {}; }
  return { data, updatedAt: rows[0].updated_at || null };
}

/**
 * 저장값을 읽어 판정 표에 적용한다. 소비처(입금대상 조회·서식 생성·계좌 보완 검증)가
 * 자기 진입점에서 부른다 — **절대 throw 하지 않는다**(실패 = 직전 표 유지 = 기본 동작).
 */
async function ensureBankOverrides(force) {
  if (!force && _lastRaw !== null && Date.now() - _lastAt < TTL_MS) return _lastRaw;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const { data, updatedAt } = await _read();
      BC.setBankOverrides(data);
      _lastRaw = data;
      _meta = { updatedAt };
      _lastAt = Date.now();
      return data;
    } catch (err) {
      // ★ 실패 시 기존 오버레이를 **비우지 않는다** — 비우면 방금까지 인식되던 표기가
      //   조용히 '인식불가'로 바뀌어 멀쩡한 건이 보류된다. 다음 호출에서 다시 시도한다.
      logger.warn('[bankNames] 오버레이 조회 실패 — 직전 표 유지', { err: err && err.message });
      return _lastRaw;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** 화면용 현재 상태(목록 + 마지막 저장 정보 + 이력). */
async function bankNamesView() {
  await ensureBankOverrides();
  const raw = _lastRaw || {};
  return {
    ok: true,
    banks: BC.bankTable(),
    rev: _meta.updatedAt ? new Date(_meta.updatedAt).toISOString() : null,
    updatedBy: String(raw.updatedBy || ''),
    log: Array.isArray(raw.log) ? raw.log.slice(0, 50) : [],
  };
}

/** 저장 전/후를 비교해 "누가 언제 무엇을 바꿨나"를 문장으로 남긴다. */
function _diffLog(prev, next, by) {
  const at = new Date().toISOString();
  const out = [];
  const pb = (prev && prev.banks) || {};
  const nb = (next && next.banks) || {};
  const nameOf = (code) => {
    const row = BC.BANKS.find(x => x[0] === code);
    const ex = ((next && next.extra) || []).find(x => x.code === code);
    return (nb[code] && nb[code].name) || (row && row[1]) || (ex && ex.name) || code;
  };
  const arr = (o, k) => (o && Array.isArray(o[k]) ? o[k] : []);
  const codes = new Set([...Object.keys(pb), ...Object.keys(nb)]);
  for (const c of codes) {
    const p = pb[c] || {}, n = nb[c] || {};
    if ((p.name || '') !== (n.name || '')) {
      out.push({ at, by, act: 'rename', code: c, val: n.name || '(기본 명칭으로 되돌림)' });
    }
    for (const a of arr(n, 'add')) if (!arr(p, 'add').includes(a)) out.push({ at, by, act: 'alias_add', code: c, val: a, name: nameOf(c) });
    for (const a of arr(p, 'add')) if (!arr(n, 'add').includes(a)) out.push({ at, by, act: 'alias_remove', code: c, val: a, name: nameOf(c) });
    for (const a of arr(n, 'del')) if (!arr(p, 'del').includes(a)) out.push({ at, by, act: 'base_off', code: c, val: a, name: nameOf(c) });
    for (const a of arr(p, 'del')) if (!arr(n, 'del').includes(a)) out.push({ at, by, act: 'base_on', code: c, val: a, name: nameOf(c) });
  }
  const pe = new Map(((prev && prev.extra) || []).map(x => [x.code, x.name]));
  const ne = new Map(((next && next.extra) || []).map(x => [x.code, x.name]));
  for (const [c, nm] of ne) if (!pe.has(c)) out.push({ at, by, act: 'bank_add', code: c, val: nm });
  for (const [c, nm] of pe) if (!ne.has(c)) out.push({ at, by, act: 'bank_remove', code: c, val: nm });
  return out;
}

/**
 * 저장. `rev`(마지막 조회 시각)가 지금 값과 다르면 거부 — 다른 담당자가 방금 넣은
 * 표기를 조용히 덮지 않는다(화면은 전체 상태를 보내므로 이 검사가 없으면 통째로 밀린다).
 */
async function saveBankOverrides({ payload, by, rev }) {
  const v = BC.validateBankOverrides(payload || {});
  if (!v.ok) return { ok: false, code: v.code, error: v.error, conflicts: v.conflicts || [] };

  const cur = await _read();
  const curRev = cur.updatedAt ? new Date(cur.updatedAt).getTime() : 0;
  const gotRev = rev ? new Date(rev).getTime() : 0;
  if (curRev && gotRev && curRev !== gotRev) {
    return { ok: false, code: 'stale', error: '다른 사람이 먼저 저장했습니다. 새로고침 후 다시 시도해 주세요.' };
  }

  const prevLog = Array.isArray(cur.data.log) ? cur.data.log : [];
  const added = _diffLog(cur.data, v.clean, String(by || ''));
  const next = {
    banks: v.clean.banks,
    extra: v.clean.extra,
    updatedBy: String(by || ''),
    log: added.concat(prevLog).slice(0, LOG_CAP),
  };

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [SETTING_KEY, JSON.stringify(next)]
  );
  await ensureBankOverrides(true);           // 저장 즉시 판정 표에 반영(다음 조회까지 기다리지 않는다)
  const view = await bankNamesView();
  return { ok: true, changed: added.length, ...view };
}

module.exports = {
  SETTING_KEY, ensureBankOverrides, bankNamesView, saveBankOverrides,
  _diffLog,   // 회귀가드용
};
