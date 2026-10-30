/**
 * bidirSwitch — 양방향 동기화 스위치 읽기(결정 275). 아직 부르는 곳이 없다(2단계 = 기반만).
 *
 *   ① 환경변수 `BIDIR_HARD_OFF=1` — 최우선. 켜져 있으면 표 값과 무관하게 전부 꺼짐(배포 없이 못 끄는 상황 대비가 아니라,
 *      배포로 확실히 끄는 비상 스위치).
 *   ② `app_settings` 키 `bidir_sync` = `{"in2rw":"off|observe|apply","push":"off|on","campaign_edit":"off|on","publish_reconcile":"off|on"}`
 *      — 재배포 없이 끄고 켠다. 10초 캐시. publish_reconcile = 발행 때 값이 다르면 오더를 공고 값으로 자동 맞추기(결정 313).
 *   ③ 오더별 `work_orders.bidir_state` — 이 모듈 밖(적용 단계)에서 본다.
 *
 * ★★ fail-closed — 값이 없거나·깨졌거나·모르는 값이거나·읽다가 실패하면 **전부 꺼짐**으로 접는다.
 *    "모르면 켠다" 로 접으면 설정 한 줄 실수로 두 운영 시스템이 서로 덮어쓰기 시작한다.
 */
'use strict';

const SETTING_KEY = 'bidir_sync';
const CACHE_MS = 10_000;
const OFF = Object.freeze({ in2rw: 'off', push: 'off', campaign_edit: 'off', publish_reconcile: 'off', hardOff: false });
const ALLOWED = { in2rw: ['off', 'observe', 'apply'], push: ['off', 'on'], campaign_edit: ['off', 'on'], publish_reconcile: ['off', 'on'] };

let _cache = null;   // { at, value }

/** 설정 글자 → 스위치. 모르는 칸·값은 off. */
function parseBidirSetting(raw) {
  let v;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return { ...OFF }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...OFF };
  const out = { ...OFF };
  for (const [k, allowed] of Object.entries(ALLOWED)) {
    const s = String(v[k] == null ? '' : v[k]).trim();
    out[k] = allowed.includes(s) ? s : 'off';
  }
  return out;
}

/**
 * @param {{ query: Function }} db
 * @param {{ now?: number, env?: object }} [opts] 시험용
 */
async function readBidirSwitch(db, { now = Date.now(), env = process.env } = {}) {
  if (String(env.BIDIR_HARD_OFF || '').trim() === '1') return { ...OFF, hardOff: true };
  if (_cache && now - _cache.at < CACHE_MS) return _cache.value;
  let value = { ...OFF };
  try {
    const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [SETTING_KEY]);
    value = rows.length ? parseBidirSetting(rows[0].value) : { ...OFF };
  } catch (_) {
    value = { ...OFF };   // 읽기 실패 = 꺼짐(캐시하지 않아 다음 호출이 다시 읽는다)
    return value;
  }
  _cache = { at: now, value };
  return value;
}

function _resetBidirSwitchCacheForTest() { _cache = null; }

module.exports = { SETTING_KEY, parseBidirSetting, readBidirSwitch, _resetBidirSwitchCacheForTest };
