/**
 * 작업표 줄 ↔ 주문 링크 교정 (일회성 복구 도구) — 2026-08-19
 *
 * ★★ 왜 필요한가: 투영이 링크를 `phone8` 하나로 정하던 시절, **한 연락처를 여러 명의가
 *    공유하면**(타계정 참여) 그 한 주문이 링크가 빈 줄마다 붙었다. 그 오염은 두 방향으로 사고를 냈다 —
 *      ㉮ 중복 정리가 "같은 주문을 여러 줄이 쓴다"로 읽어 **멀쩡한 주문을 취소**(실측: 유재휘 건,
 *         canceled_by='dedupe:…')
 *      ㉯ 관제 대조가 그 줄을 "확정 안 잡힘"으로 표시
 *    2026-08-19 에 "링크는 표 주문번호가 정한다"로 **앞으로 채울 때의 규칙**은 고쳤지만, 그 규칙은
 *    blank-only 라 **이미 박힌 값은 그대로 남는다**. 이 서비스가 그 잔존분을 사람이 지목해 고치는 창구다.
 *
 * ★★ 완화 금지 규율
 *   - **자동 스캔·일괄 적용 없음**: 호출자가 줄(seq)과 **지금 값(expect)** 을 명시해야 한다.
 *     그 사이 다른 세션이 바꿨으면 거부한다(낙관적 동시성 — 모르는 상태에 쓰지 않는다).
 *   - **표 주문번호가 링크를 정한다**(투영의 현행 규칙과 같은 근거). 번호가 원장에 없거나
 *     둘 이상이면 **채우지 않고 거부**한다 — 모르는 것을 추측해 채우는 쪽이 빈 링크보다 나쁘다.
 *   - **줄 번호가 일치할 때만 재링크**(`order.sheet_row === seq`). 엉뚱한 줄에 남의 주문을 붙이는
 *     사고를 구조적으로 막는다.
 *   - **한 주문은 한 줄**: 다른 살아있는 줄이 이미 그 주문을 가리키면 거부(오염을 새로 만들지 않는다).
 *   - **전부 아니면 전무**: 한 건이라도 조건을 못 지키면 트랜잭션을 통째로 되돌린다.
 *   - **쓰기 표면 2곳뿐** — `campaign_participants.order_submission_id` ·
 *     (취소 되돌리기 시) `order_submissions.deleted_at/canceled_by/mirror_status`.
 *     시트·장부·정원·홀드는 건드리지 않는다.
 *   - **취소 되돌리기는 중복 정리가 취소한 건에만**(`deleted_at` 있고 `mirror_status='canceled'`).
 *     사람이 [주문취소]한 건을 되살리면 정원·시트가 어긋난다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const MAX_FIXES = 50;

class LinkRepairError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const sameId = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);

/**
 * @param {object} p
 * @param {string} p.sheetId
 * @param {string} p.tabName
 * @param {Array<{seq:number, action:'relink'|'unlink', expectOrderSubmissionId:?string, orderNum?:string}>} p.fixes
 * @param {boolean} p.dryRun  기본 true — 같은 코드 경로를 돌린 뒤 ROLLBACK 한다(미리보기 ≡ 실행).
 * @param {boolean} p.confirm dryRun 이 아닐 때 필수.
 * @param {string}  p.by
 */
async function repairWorktableLinks({ sheetId, tabName, fixes, dryRun = true, confirm = false, by = 'repair' } = {}) {
  if (!sheetId || !tabName) throw new LinkRepairError('bad_request', 'sheetId, tabName 이 필요합니다.');
  const list = Array.isArray(fixes) ? fixes : [];
  if (!list.length) throw new LinkRepairError('empty', '고칠 줄을 지정하세요.');
  if (list.length > MAX_FIXES) throw new LinkRepairError('too_many', `한 번에 ${MAX_FIXES}건까지만 처리합니다.`);
  if (!dryRun && confirm !== true) {
    throw new LinkRepairError('confirm_required', "되돌리기 어려운 변경입니다 — confirm:true 가 필요합니다.");
  }

  const client = await pool.connect();
  const results = [];
  let failed = null;
  try {
    await client.query('BEGIN');
    for (const f of list) {
      const seq = parseInt(f && f.seq, 10);
      const action = String((f && f.action) || '');
      const r = { seq, action, ok: false };
      results.push(r);
      if (!Number.isFinite(seq) || !['relink', 'unlink'].includes(action)) {
        r.code = 'bad_fix'; r.error = 'seq 와 action(relink|unlink) 이 필요합니다.'; failed = r; break;
      }

      // ── 줄 잠금 + 현재 값 확인(낙관적 동시성) ──
      const { rows: pr } = await client.query(
        `SELECT id, seq, reviewer_name, phone8, order_submission_id
           FROM campaign_participants
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL
          FOR UPDATE`,
        [sheetId, tabName, seq]);
      if (!pr.length) { r.code = 'row_not_found'; r.error = '그 줄을 찾지 못했습니다(삭제됐거나 번호가 다릅니다).'; failed = r; break; }
      const row = pr[0];
      r.name = row.reviewer_name || '';
      r.before = { orderSubmissionId: row.order_submission_id || null };
      if (!sameId(row.order_submission_id, f.expectOrderSubmissionId)) {
        r.code = 'changed';
        r.error = '그 사이 링크가 바뀌었습니다 — 다시 조회한 뒤 실행하세요.';
        failed = r; break;
      }

      if (action === 'unlink') {
        await client.query(
          `UPDATE campaign_participants SET order_submission_id = NULL, updated_at = NOW(), updated_by = $2
            WHERE id = $1`, [row.id, String(by).slice(0, 100)]);
        r.after = { orderSubmissionId: null };
        r.ok = true;
        continue;
      }

      // ── relink: 표 주문번호가 링크를 정한다 ──
      const num = digits(f.orderNum);
      if (num.length < 6) { r.code = 'bad_order_num'; r.error = '표 주문번호(6자리 이상)가 필요합니다.'; failed = r; break; }
      const { rows: os } = await client.query(
        `SELECT id, sheet_row, mirror_status, deleted_at, canceled_by
           FROM order_submissions
          WHERE sheet_id = $1 AND tab_name = $2
            AND regexp_replace(COALESCE(order_num, ''), '\\D', '', 'g') = $3
          FOR UPDATE`,
        [sheetId, tabName, num]);
      if (!os.length) { r.code = 'order_not_found'; r.error = '그 주문번호가 원장에 없습니다 — 링크를 채우지 않습니다.'; failed = r; break; }
      if (os.length > 1) { r.code = 'order_ambiguous'; r.error = `같은 주문번호가 ${os.length}건입니다 — 사람이 골라야 합니다.`; failed = r; break; }
      const ord = os[0];
      if (Number(ord.sheet_row) !== seq) {
        r.code = 'row_mismatch';
        r.error = `그 주문이 가리키는 줄(${ord.sheet_row})과 지정한 줄(${seq})이 다릅니다.`;
        failed = r; break;
      }
      const { rows: dup } = await client.query(
        `SELECT seq FROM campaign_participants
          WHERE sheet_id = $1 AND tab_name = $2 AND order_submission_id = $3::uuid
            AND deleted_at IS NULL AND id <> $4`,
        [sheetId, tabName, ord.id, row.id]);
      if (dup.length) {
        r.code = 'already_linked';
        r.error = `그 주문은 이미 ${dup.map(d => d.seq + '행').join(', ')} 이 가리키고 있습니다.`;
        failed = r; break;
      }

      await client.query(
        `UPDATE campaign_participants SET order_submission_id = $2::uuid, updated_at = NOW(), updated_by = $3
          WHERE id = $1`, [row.id, ord.id, String(by).slice(0, 100)]);
      r.after = { orderSubmissionId: ord.id };

      /* 중복 정리가 취소한 주문이면 되살린다 — 링크 오염이 원인이고 취소는 그 결과였다.
         ★ 사람이 [주문취소] 한 건(canceled_by 가 dedupe 계열이 아님)은 되살리지 않는다. */
      if (ord.deleted_at && ord.mirror_status === 'canceled' && /^dedupe/i.test(String(ord.canceled_by || ''))) {
        await client.query(
          `UPDATE order_submissions
              SET deleted_at = NULL, canceled_by = NULL, mirror_status = 'written', updated_at = NOW()
            WHERE id = $1`, [ord.id]);
        r.restoredOrder = { id: ord.id, wasCanceledBy: ord.canceled_by };
      } else if (ord.deleted_at) {
        r.orderStillCanceled = { canceledBy: ord.canceled_by || null };
      }
      r.ok = true;
    }

    const allOk = !failed && results.every(x => x.ok);
    if (dryRun || !allOk) {
      await client.query('ROLLBACK');
      return {
        ok: allOk, dryRun: true, applied: false,
        code: failed ? failed.code : undefined,
        error: failed ? `${failed.seq}행: ${failed.error}` : undefined,
        results,
      };
    }
    await client.query('COMMIT');
    logger.warn(`[worktable/repair-link] ${sheetId}/${tabName} ${results.length}건 적용 by ${by}`);
    return { ok: true, dryRun: false, applied: true, results };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { repairWorktableLinks, LinkRepairError, MAX_FIXES };
