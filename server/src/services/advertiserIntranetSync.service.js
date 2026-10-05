/**
 * 업체 ↔ 인트라넷 광고주 연결 점검·동기화.
 *
 * 2026-09-28 실사고: 업체관리에서 등록한 업체가 인트라넷 원본 ID 없이 이름으로만 저장돼 있어,
 *   인트라넷에서 사업자명을 정정하자 같은 업체가 둘이 됐다(올곧은무역·어니스트캄). 등록 경로는 이제
 *   원본 ID 를 함께 저장하지만(근본 원인 수정), **이미 ID 없이 등록된 업체**와 **ID 가 있어도 이름이
 *   예전 값에 멈춘 업체**가 남는다. 이 서비스가 그 둘을 찾고 안전한 것만 고친다.
 *
 * 분류(plan):
 *   link      — ID 없음 + 인트라넷에 **이름이 정확히 같은** 광고주가 **하나**, 그 ID 를 쓰는 업체 없음 → ID 채움
 *   rename    — ID 있음 + 인트라넷 사업자명이 바뀜 → 이름을 따라감(다른 업체가 그 이름을 쓰면 rename_blocked)
 *   bizno     — ID 있음 + 사업자번호 칸이 비어 있음 → 채움
 *   suggest   — ID 없음 + 법인 표기만 다른 인트라넷 광고주 하나 → **사람 확인 후에만**(ids 로 지목) 연결
 *   dismissed — 사람이 "다른 회사입니다"라고 답한 suggest(다시 묻지 않는다 · DISMISS_KEY)
 *   duplicate — 그 인트라넷 광고주가 이미 다른 업체에 연결됨 → **업체 합치기 대상**(mergeWith 동봉)
 *   name_taken — 새 이름을 **다른 인트라넷 광고주에 연결된** 업체가 쓰고 있음(합치기 대상 아님 — 이름 구분 필요)
 *   ambiguous / not_found / orphan — 사람이 본다(자동 조치 없음)
 *
 * ★★ 자동 병합은 하지 않는다(결정 004). 자동으로 고치는 것은 link·rename·bizno 셋뿐이고,
 *    link 는 등록 게이트와 같은 근거(인트라넷 사업자명 **정확일치** + 유일)다.
 * ★ 인트라넷 도달 불가면 아무것도 쓰지 않는다(fail-closed — 모르는 채로 고치지 않는다).
 */
const defaultPool = require('../db/pool');
const { logger } = require('../utils/logger');
const { sameAdvertiser } = require('../utils/advertiserIdentity');

const AUTO_KINDS = ['link', 'rename', 'bizno'];
// 사람이 "다른 회사입니다"라고 답한 suggest 조합 — 다시 묻지 않는다(매시간 점검이 같은 안내를 되살리지 않게).
const DISMISS_KEY = 'advertiser_sync_dismissed';
const DISMISS_CAP = 500;
const _dkey = (advertiserId, intranetId) => String(advertiserId) + '|' + String(intranetId);

function _trim(v) { return String(v == null ? '' : v).trim(); }

/** 순수 판정 — advs: [{id,name,intranetId,businessNumber}], intra: [{intranetId,name,bizNo}]
 *  opts.dismissed: Set('업체id|인트라넷id') — 사람이 "다른 회사"라고 답한 suggest 는 dismissed 로 내린다. */
function planIntranetSync(advs, intra, opts) {
  const dismissed = (opts && opts.dismissed) || new Set();
  const byId = new Map(intra.filter(r => r.intranetId).map(r => [r.intranetId, r]));
  const advByIid = new Map(advs.filter(a => a.intranetId).map(a => [a.intranetId, a]));
  const advNames = new Map(advs.map(a => [_trim(a.name), a]));
  const items = [];
  for (const a of advs) {
    const name = _trim(a.name);
    if (a.intranetId) {
      const ir = byId.get(a.intranetId);
      if (!ir) { items.push({ kind: 'orphan', id: a.id, name }); continue; }
      const iname = _trim(ir.name);
      if (iname && iname !== name) {
        const holder = advNames.get(iname);
        // ★ 그 이름을 쥔 업체가 **다른 인트라넷 광고주에 연결돼 있으면** 같은 업체가 아니다(합치기 대상 아님 —
        //   서버 합치기도 different_intranet 으로 거부한다). 사람이 한쪽 이름을 구분되게 바꿔야 하는 name_taken 으로 둔다.
        if (holder && holder.id !== a.id) {
          // ★ 사람이 그 업체와 이 인트라넷 광고주를 "다른 회사"라고 답했다면 합칠 짝이 아니다(이름만 겹친 다른 회사).
          const saidDifferent = !holder.intranetId && dismissed.has(_dkey(holder.id, a.intranetId));
          if ((holder.intranetId && holder.intranetId !== a.intranetId) || saidDifferent) items.push({ kind: 'name_taken', id: a.id, name, to: iname, takenBy: { id: holder.id, name: holder.name } });
          else items.push({ kind: 'rename_blocked', id: a.id, name, to: iname, blockedBy: { id: holder.id, name: holder.name, intranetLinked: !!holder.intranetId } });
        }
        else items.push({ kind: 'rename', id: a.id, name, to: iname, intranetId: a.intranetId });
      }
      if (!_trim(a.businessNumber) && _trim(ir.bizNo)) items.push({ kind: 'bizno', id: a.id, name, bizNo: _trim(ir.bizNo), intranetId: a.intranetId });
      continue;
    }
    const exact = intra.filter(r => _trim(r.name) === name && r.intranetId);
    const allPool = exact.length ? exact
      : intra.filter(r => r.intranetId && sameAdvertiser({ name: r.name, businessNumber: r.bizNo }, { name, businessNumber: a.businessNumber }));
    if (!allPool.length) { items.push({ kind: 'not_found', id: a.id, name }); continue; }
    // ★★ "다른 회사" 답은 **모든 분류보다 먼저** 적용한다(Codex 리뷰) — 뒤에서만 보면 그 인트라넷 광고주가 나중에
    //   다른 업체에 연결되는 순간 duplicate(합치기 권유)로, 이름이 같아지면 link(자동 연결)로 되살아난다.
    const pool = allPool.filter(r => !dismissed.has(_dkey(a.id, r.intranetId)));
    if (!pool.length) {
      items.push({ kind: 'dismissed', id: a.id, name, intranetId: allPool[0].intranetId, intranetName: allPool[0].name, bizNo: _trim(allPool[0].bizNo) });
      continue;
    }
    if (pool.length > 1) { items.push({ kind: 'ambiguous', id: a.id, name, options: pool.map(r => r.name) }); continue; }
    const ir = pool[0];
    const holder = advByIid.get(ir.intranetId);
    if (holder && holder.id !== a.id) {
      items.push({ kind: 'duplicate', id: a.id, name, intranetName: ir.name, mergeWith: { id: holder.id, name: holder.name } });
      continue;
    }
    const kind = exact.length ? 'link' : 'suggest';
    items.push({ kind, id: a.id, name, intranetId: ir.intranetId, intranetName: ir.name, bizNo: _trim(ir.bizNo) });
  }
  const counts = {};
  for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
  return { items, counts };
}

async function _load(db, deps) {
  const trackB = (deps && deps.trackB) || require('./trackB.service');
  const idx = await trackB.intranetAdvertiserIndex();
  if (!idx || !idx.ok) return { ok: false, error: '인트라넷 광고주DB를 확인할 수 없어 점검하지 않았습니다. 잠시 후 다시 시도하세요.' };
  const { rows } = await db.query(
    `SELECT id, name, COALESCE(intranet_advertiser_id,'') AS "intranetId",
            COALESCE(intranet_business_number,'') AS "businessNumber"
       FROM advertisers WHERE COALESCE(status,'') <> 'ended' ORDER BY name`);
  return { ok: true, advs: rows, intra: idx.rows || [], dismissed: await _loadDismissed(db) };
}

// 조회 실패는 빈 목록(= 다시 묻는다) — 모르는 채로 안내를 숨기지 않는다.
async function _loadDismissed(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [DISMISS_KEY]);
    const arr = JSON.parse((rows[0] && rows[0].value) || '[]');
    return new Set((Array.isArray(arr) ? arr : []).map(x => _dkey(x.advertiserId, x.intranetId)));
  } catch (_) { return new Set(); }
}

/**
 * "다른 회사입니다" — 그 업체와 그 인트라넷 광고주 조합을 다시 묻지 않는다.
 * ★ 지금 점검 결과에 실제로 있는 suggest 조합만 받는다(fail-closed — 낡은 화면·임의 값 거부).
 */
async function dismissSuggest({ advertiserId, intranetId, by = '' } = {}, deps) {
  const db = (deps && deps.pool) || defaultPool;
  const aid = _trim(advertiserId), iid = _trim(intranetId);
  if (!aid || !iid) return { ok: false, code: 400, error: '업체와 인트라넷 광고주를 지정하세요.' };
  const L = await _load(db, deps);
  if (!L.ok) return { ok: false, code: 503, error: L.error };
  if (L.dismissed.has(_dkey(aid, iid))) return { ok: true, already: true };
  const plan = planIntranetSync(L.advs, L.intra, { dismissed: L.dismissed });
  const it = plan.items.find(x => x.id === aid && x.intranetId === iid && x.kind === 'suggest');
  if (!it) return { ok: false, code: 409, error: '그 사이 점검 결과가 바뀌었습니다. 새로고침한 뒤 다시 확인하세요.' };
  // ★ 관리자 둘이 동시에 눌러도 서로의 기록을 지우지 않게 — 읽기·쓰기를 한 트랜잭션 + 잠금으로 직렬화(Codex 리뷰).
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [DISMISS_KEY]);
    const { rows } = await client.query(`SELECT value FROM app_settings WHERE key = $1`, [DISMISS_KEY]);
    let arr = []; try { arr = JSON.parse((rows[0] && rows[0].value) || '[]'); } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    if (!arr.some(x => _dkey(x.advertiserId, x.intranetId) === _dkey(aid, iid))) {
      arr.unshift({ advertiserId: aid, intranetId: iid, name: it.name, intranetName: it.intranetName, by: _trim(by).slice(0, 100), at: new Date().toISOString() });
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [DISMISS_KEY, JSON.stringify(arr.slice(0, DISMISS_CAP))]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
  logger.info(`[advSync] 연결 제안 거절: ${it.name} ↔ ${it.intranetName} by ${by}`);
  return { ok: true };
}

async function previewIntranetSync(deps) {
  const db = (deps && deps.pool) || defaultPool;
  const L = await _load(db, deps);
  if (!L.ok) return { ok: false, code: 503, error: L.error };
  // dismissSupported = 이 서버가 [다른 회사] 창구를 갖고 있다는 표식(화면이 먼저 배포돼도 죽은 버튼을 그리지 않게).
  return { ok: true, dismissSupported: true, ...planIntranetSync(L.advs, L.intra, { dismissed: L.dismissed }) };
}

/**
 * @param {{kinds?:string[], ids?:string[], by?:string}} opts
 *   kinds — 자동으로 고칠 종류(기본 link·rename·bizno). 'suggest' 는 ids 로 지목한 업체만.
 */
async function applyIntranetSync({ kinds = AUTO_KINDS, ids = [], expect = null, by = '' } = {}, deps) {
  const db = (deps && deps.pool) || defaultPool;
  const L = await _load(db, deps);
  if (!L.ok) return { ok: false, code: 503, error: L.error };
  const plan = planIntranetSync(L.advs, L.intra, { dismissed: L.dismissed });
  const want = new Set((Array.isArray(kinds) ? kinds : AUTO_KINDS).filter(k => AUTO_KINDS.includes(k)));
  const pick = new Set((Array.isArray(ids) ? ids : []).map(String));
  const done = [], failed = [];
  for (const it of plan.items) {
    const suggestPicked = it.kind === 'suggest' && pick.has(it.id);
    if (!(want.has(it.kind) || suggestPicked)) continue;
    // ★ 사람이 화면에서 본 인트라넷 광고주와 지금 판정이 다르면 연결하지 않는다(낡은 화면 방어).
    if (suggestPicked && expect && typeof expect === 'object' && expect[it.id] && expect[it.id] !== it.intranetId) {
      failed.push({ kind: it.kind, id: it.id, name: it.name, reason: '그 사이 점검 결과가 바뀌었습니다 — 새로고침 후 다시 확인하세요' });
      continue;
    }
    try {
      let r;
      if (it.kind === 'link' || it.kind === 'suggest') {
        // 원본 ID 를 비어 있을 때만 채운다(blank-only). suggest 는 이름도 원본 표기로 맞춘다(다른 업체가 쓰면 그대로).
        r = await db.query(
          `UPDATE advertisers SET intranet_advertiser_id = $2,
                  intranet_business_number = CASE WHEN COALESCE(intranet_business_number,'') = '' THEN $3 ELSE intranet_business_number END,
                  name = CASE WHEN $5 AND NOT EXISTS (SELECT 1 FROM advertisers o WHERE o.name = $4 AND o.id <> $1)
                              THEN $4 ELSE name END,
                  updated_at = NOW()
            WHERE id = $1 AND COALESCE(intranet_advertiser_id,'') = ''
              AND NOT EXISTS (SELECT 1 FROM advertisers o WHERE o.intranet_advertiser_id = $2 AND o.id <> $1)`,
          [it.id, it.intranetId, it.bizNo || '', _trim(it.intranetName), it.kind === 'suggest']);
      } else if (it.kind === 'rename') {
        // 원본 ID 가 그대로이고, 다른 업체가 새 이름을 쓰지 않을 때만(UNIQUE 충돌로 죽지 않게).
        r = await db.query(
          `UPDATE advertisers SET name = $2, updated_at = NOW()
            WHERE id = $1 AND intranet_advertiser_id = $3 AND name = $4
              AND NOT EXISTS (SELECT 1 FROM advertisers o WHERE o.name = $2 AND o.id <> $1)`,
          [it.id, it.to, it.intranetId, it.name]);
      } else if (it.kind === 'bizno') {
        r = await db.query(
          `UPDATE advertisers SET intranet_business_number = $2, updated_at = NOW()
            WHERE id = $1 AND intranet_advertiser_id = $3 AND COALESCE(intranet_business_number,'') = ''`,
          [it.id, it.bizNo, it.intranetId]);
      }
      if (r && r.rowCount) done.push({ kind: it.kind, id: it.id, name: it.name, to: it.to || it.intranetName || undefined });
      else failed.push({ kind: it.kind, id: it.id, name: it.name, reason: '그 사이 값이 바뀌어 건너뜀' });
    } catch (e) {
      failed.push({ kind: it.kind, id: it.id, name: it.name, reason: e.message });
    }
  }
  if (done.length) logger.info(`[advSync] 인트라넷 연결 동기화 ${done.length}건 by ${by}: ${done.map(d => d.kind + ':' + d.name).join(', ')}`);
  return { ok: true, done, failed, remaining: plan.counts };
}

module.exports = { planIntranetSync, previewIntranetSync, applyIntranetSync, dismissSuggest, AUTO_KINDS, DISMISS_KEY };
