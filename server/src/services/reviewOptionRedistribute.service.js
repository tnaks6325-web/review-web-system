/**
 * reviewOptionRedistribute — 리뷰타입·인원이 바뀐 연결 작업의 작업표 빈 줄 「리뷰옵션」 다시 나누기(결정 274 7단계-④ ④).
 *
 * 사용자 확정 2026-10-21:
 *   1.가 사람이 손으로 고친 리뷰옵션 줄(participant_edits col:리뷰옵션)은 그대로 — 채운 줄처럼 건너뛴다.
 *   2.가 새 비율의 유형별 수량이 이미 정해진 줄(채운 줄 + 손으로 고친 줄)의 그 유형 수보다 적으면 막는다(쓰기 0).
 *   3.가 인원만 바뀐 저장도 빈 줄을 비율대로 다시 채운다 — 인원을 늘려 새로 생긴 빈 줄이 빈 칸으로 남아 구매 캡처를 "일반 리뷰" 로 검사하던 틈.
 * ★ 채운 줄(산 사람이 있는 줄)은 절대 안 바꾼다. 무시트 작업표만 · 다른 살아 있는 공고와 같이 쓰는 탭은 건드리지 않는다.
 * ★ 표기 = 그 작업표가 이미 쓰는 표기(옛 판 「포토리뷰」 / 새 판 「포토」) — 빈 줄 고르기가 글자 그대로 비교한다.
 * ★ 섞어 쓰지 않는 작업: 새 판은 모든 빈 줄에 그 유형, 옛 판은 빈 칸(옛 판은 단일 유형이면 칸을 비워 두는 규칙 · 빈 칸 = 공고 유형).
 * ★ 섞어 쓰는 작업: 모든 살아 있는 옵션에 옵션별 수량이 있고 빈 줄마다 옵션 표식이 있으면 옵션별로, 아니면 작업 전체 수량으로 나눈다.
 *   빈 줄 순서(번호) 따라 유형을 고르게 섞는다(가중 차례 · 같은 날에 한 유형만 몰리지 않게).
 * 호출자가 같은 트랜잭션·공고 행 잠금 안에서 부른다. 장부(review_index) 다시 만들기는 커밋 뒤 호출자가.
 */
'use strict';

const { logger } = require('../utils/logger');
const { normalizeReviewType, isReviewOptionHeader, REVIEW_TYPE_SHEET_LABELS, reviewTypeLabel } = require('../utils/reviewType');
const { normalizeReviewTypeMix } = require('../utils/reviewTypeMix');

const _mixOf = (v) => {
  let raw = v;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw || '[]'); } catch (_) { raw = []; } }
  const st = normalizeReviewTypeMix(Array.isArray(raw) ? raw : []);
  const out = new Map();
  for (const e of st.mix || []) if (Number(e.quantity) > 0) out.set(e.type, (out.get(e.type) || 0) + Math.floor(Number(e.quantity)));
  return out;
};

/** 가중 차례 — 유형별 수(counts)를 n 칸에 고르게 섞은 순서. 합보다 칸이 많으면 남는 칸은 '' . */
function interleave(counts, n) {
  const types = [...counts.entries()].filter(([, c]) => c > 0);
  const total = types.reduce((a, [, c]) => a + c, 0);
  const out = [];
  const cur = new Map(types.map(([t]) => [t, 0]));
  const left = new Map(types);
  for (let i = 0; i < Math.min(n, total); i++) {
    let best = null;
    for (const [t, c] of types) {
      if (!left.get(t)) continue;
      cur.set(t, cur.get(t) + c);
      if (best === null || cur.get(t) > cur.get(best)) best = t;
    }
    cur.set(best, cur.get(best) - total);
    left.set(best, left.get(best) - 1);
    out.push(best);
  }
  while (out.length < n) out.push('');
  return out;
}

/**
 * @param {object} client 트랜잭션 클라이언트
 * @param {object} camp 공고 행(linked_sheet_id·linked_tab_name·id)
 * @param {object} order 저장 뒤 오더 상태(review_type · review_type_mix · product_options_json)
 * @param {string} [opts.prevReviewType] 저장 전 오더 리뷰타입 — 채운 줄의 빈 칸을 그 유형으로 센다(아래 fixedType)
 * @returns {Promise<{applied:boolean, changed?:number, reason?:string, reject?:{code:string,error:string}, worktable?:object}>}
 */
async function redistributeReviewOptionsInTx(client, camp, order, { by = 'bidir-review-type', prevReviewType = '' } = {}) {
  if (!camp || !camp.linked_sheet_id || !camp.linked_tab_name) return { applied: false, reason: 'no_worktable_link' };
  const { isSheetless } = require('../utils/sheetlessScope');
  if (!await isSheetless(client, camp.linked_sheet_id, camp.linked_tab_name)) return { applied: false, reason: 'not_sheetless' };
  const { rows: shared } = await client.query(
    `SELECT id FROM recruit_campaigns WHERE participation_mode AND status = 'active' AND archived_at IS NULL AND linked_sheet_id = $1 AND linked_tab_name = $2 AND id <> $3 LIMIT 1`,
    [camp.linked_sheet_id, camp.linked_tab_name, camp.id]);
  if (shared.length) return { applied: false, reason: 'shared_worktable' };

  const { rows } = await client.query(
    `SELECT id, seq, option_text, row_json,
            (NULLIF(btrim(COALESCE(reviewer_name,'')),'') IS NOT NULL OR NULLIF(btrim(COALESCE(recipient_name,'')),'') IS NOT NULL
              OR NULLIF(btrim(COALESCE(phone8,'')),'') IS NOT NULL OR order_submission_id IS NOT NULL) AS filled
       FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE
      ORDER BY seq FOR UPDATE`, [camp.linked_sheet_id, camp.linked_tab_name]);
  if (!rows.length) return { applied: false, reason: 'no_rows' };
  let header = '';
  for (const r of rows) { const k = Object.keys(r.row_json || {}).find(h => isReviewOptionHeader(h)); if (k) { header = k; break; } }
  const type = normalizeReviewType(order.review_type) || '';
  const mixed = type === 'mixed';
  // 칸이 없는 작업표(옛 판 한 종류 = 칸 자체가 없을 수 있다) — 한 종류면 아래 「사라지는 유형」 검사만 하고 쓰지 않는다
  const noColumn = !header;
  if (noColumn) header = '리뷰옵션';

  // 사람이 손으로 고친 빈 줄(1.가) — 최신 손 글씨가 살아 있는 줄
  const manual = new Map();
  await client.query('SAVEPOINT ro_manual');
  try {
    const { rows: ov } = await client.query(
      `SELECT DISTINCT ON (anchor_value) anchor_value, value_text FROM participant_edits
        WHERE sheet_id = $1 AND tab_name = $2 AND anchor_type = 'manual' AND field = $3 AND reverted_at IS NULL AND anchor_value = ANY($4::text[])
        ORDER BY anchor_value, created_at DESC, id DESC`,
      [camp.linked_sheet_id, camp.linked_tab_name, 'col:' + header, rows.map(r => String(r.id))]);
    await client.query('RELEASE SAVEPOINT ro_manual');
    for (const o of ov) manual.set(String(o.anchor_value), String(o.value_text == null ? '' : o.value_text).trim());
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT ro_manual').catch(() => {});
    // 손 글씨를 모르면 덮을 수도 있다 — 막는다(fail-closed)
    return { applied: false, reason: 'manual_unknown', reject: { code: 'review_option_unknown', error: '작업표에서 손으로 고친 리뷰옵션을 확인하지 못해 저장하지 않았습니다. 잠시 뒤 다시 저장해 주세요.' } };
  }
  const valOf = r => String(((r.row_json || {})[header]) == null ? '' : (r.row_json || {})[header]).trim();
  // 표기 — 작업표 판을 따른다(옛 판 「포토리뷰」 / 새 판 「포토」). 판은 탭 설정이 단일 출처(장부 sheetlessLedger 와 같은 칸) —
  //   오더 상태에는 판 번호가 없다(검토 2026-10-21: 칸 값으로만 짐작하면 「포토」 가 아직 없는 새 판을 옛 판으로 오판).
  const { rows: tc } = await client.query('SELECT workboard_schema_version FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
    [camp.linked_sheet_id, camp.linked_tab_name]);
  const v1 = Number(tc[0] && tc[0].workboard_schema_version) !== 2;
  const labelOf = t => (v1 ? (REVIEW_TYPE_SHEET_LABELS[t] || '') : (reviewTypeLabel(t) || ''));
  const fixed = r => r.filled || manual.has(String(r.id));
  // ★ 채운 줄의 빈 칸 = 저장 전 단일 유형(옛 판은 단일 유형이면 칸을 비워 둔다 · 빈 칸 = 공고 유형). 안 세면 산 분이 어느 유형에도
  //   안 잡혀 비율이 틀어지고 줄이기 거부도 빠진다(검토 2026-10-21 🔴). 저장 전이 섞어 쓰기·자율이면 모른다 — 세지 않는다.
  const prevSingle = (() => { const t = normalizeReviewType(prevReviewType) || ''; return t && t !== 'mixed' ? t : ''; })();
  const fixedType = r => {
    if (manual.has(String(r.id))) return normalizeReviewType(manual.get(String(r.id))) || '';
    const v = valOf(r);
    return (v ? normalizeReviewType(v) : '') || (r.filled && !v ? prevSingle : '') || '';
  };
  const open = rows.filter(r => !fixed(r));

  const want = new Map();   // row id → 적을 값
  if (!mixed) {
    // 2.가 — 한 종류로 바꿀 때도 이미 정해진 줄(채운 줄 + 손으로 고친 줄)이 쓰는 유형이 사라지면 거부(사용자 확정 2026-10-21 「가」:
    //   산 분에게 다른 유형 기준이 적용되는 일을 막는다). 유형이 그대로인 저장(인원만 바뀜)·자율(빈 유형)은 검사하지 않는다.
    const prevType = normalizeReviewType(prevReviewType) || '';
    if (type && type !== prevType) {
      const gone = new Map();
      for (const r of rows.filter(fixed)) { const t = fixedType(r); if (t && t !== 'mixed' && t !== type) gone.set(t, (gone.get(t) || 0) + 1); }
      if (gone.size) {
        const [t, used] = [...gone.entries()][0];
        const name = reviewTypeLabel(t) || t;
        return { applied: false, reject: { code: 'review_type_below_used',
          error: `「${name}」은 이미 ${used}줄이 정해져 있어(참여했거나 작업표에서 직접 정한 줄) 리뷰타입을 「${reviewTypeLabel(type) || type}」 하나로 바꿀 수 없습니다. 혼합으로 바꿔 ${name}을 ${used}줄 이상 남기거나, 새 리뷰오더로 접수해 주세요.` } };
      }
    }
    if (noColumn) return { applied: false, reason: 'no_column' };
    const label = v1 ? '' : (type ? labelOf(type) : '');
    for (const r of open) want.set(String(r.id), label);
  } else {
    // 옵션별 수량을 쓸 수 있나 — 살아 있는 옵션 줄마다 수량이 있고 빈 줄마다 그 옵션 표식이 있을 때
    const pre = require('./sharedPatch.service')._prefillOf(order);   // 프리필은 한 경로로(혼합 수량 글자 풀기 포함)
    const optMix = new Map();
    for (const o of pre.options || []) {
      const key = o.unitKind === 'product' ? String(o.productName || '').trim() : String(o.optKey || '').trim();
      if (key) optMix.set(key, _mixOf(o.reviewTypeMix));
    }
    const byOption = optMix.size > 0 && [...optMix.values()].every(m => m.size > 0)
      && open.every(r => optMix.has(String(r.option_text || '').trim()));
    const groups = byOption
      ? [...optMix.entries()].map(([key, m]) => ({ key, target: m, rows: rows.filter(r => String(r.option_text || '').trim() === key) }))
      : [{ key: '', target: _mixOf(order.review_type_mix), rows }];
    for (const g of groups) {
      const remain = new Map(g.target);
      for (const r of g.rows.filter(fixed)) {
        const t = fixedType(r);
        if (!t || t === 'mixed') continue;
        remain.set(t, (remain.get(t) || 0) - 1);
      }
      for (const [t, n] of remain) {
        if (n < 0) {
          const used = g.rows.filter(fixed).filter(r => fixedType(r) === t).length;
          const name = reviewTypeLabel(t) || t;
          return { applied: false, reject: { code: 'review_type_below_used',
            error: `「${name}」은 이미 ${used}줄이 정해져 있어(참여했거나 작업표에서 직접 정한 줄${g.key ? ` · ${g.key}` : ''}) ${g.target.get(t) || 0}로 줄일 수 없습니다. ${name} 수량을 ${used} 이상으로 맞춰 주세요.` } };
        }
      }
      // 이미 정해진 줄에 새 비율에 없는 유형이 있으면(예: 구매확정을 뺐는데 구매확정 줄이 있음) 그것도 막는다
      for (const r of g.rows.filter(fixed)) {
        const t = fixedType(r);
        if (t && t !== 'mixed' && !g.target.has(t)) {
          const used = g.rows.filter(fixed).filter(x => fixedType(x) === t).length;
          const name = reviewTypeLabel(t) || t;
          return { applied: false, reject: { code: 'review_type_below_used',
            error: `「${name}」은 이미 ${used}줄이 정해져 있어(참여했거나 작업표에서 직접 정한 줄) 리뷰타입에서 뺄 수 없습니다. ${name} 수량을 ${used} 이상으로 남겨 주세요.` } };
        }
      }
      const list = g.rows.filter(r => !fixed(r));
      const seqTypes = interleave(remain, list.length);
      list.forEach((r, i) => want.set(String(r.id), seqTypes[i] ? labelOf(seqTypes[i]) : ''));
    }
  }

  let changed = 0;
  for (const r of rows) {
    if (!want.has(String(r.id))) continue;
    const v = want.get(String(r.id));
    const hasKey = Object.prototype.hasOwnProperty.call(r.row_json || {}, header);
    if (valOf(r) === v && (hasKey || !mixed)) continue;
    const rj = { ...(r.row_json || {}), [header]: v };
    await client.query(`UPDATE campaign_participants SET row_json = $2::jsonb, updated_by = $3, updated_at = NOW() WHERE id = $1`,
      [r.id, JSON.stringify(rj), String(by).slice(0, 100)]);
    changed += 1;
  }
  // 섞어 쓰는데 칸이 없던 줄(채운 줄 포함) — 칸만 만든다(값은 그대로 · 장부 머리글이 줄 키에서 나온다)
  if (mixed) {
    for (const r of rows) {
      if (want.has(String(r.id)) || Object.prototype.hasOwnProperty.call(r.row_json || {}, header)) continue;
      await client.query(`UPDATE campaign_participants SET row_json = row_json || jsonb_build_object($2::text, ''), updated_at = NOW() WHERE id = $1`, [r.id, header]);
    }
  }
  if (changed) logger.info(`[review-option] ${camp.id} 빈 줄 리뷰옵션 다시 나눔 ${changed}줄 (${mixed ? '섞어 쓰기' : (type || '자율')} · 손으로 고친 줄 ${manual.size} 건너뜀)`);
  return { applied: changed > 0, changed, worktable: { synced: true, sheetId: camp.linked_sheet_id, tabName: camp.linked_tab_name } };
}

module.exports = { redistributeReviewOptionsInTx, interleave };
