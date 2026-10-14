// ═══════════════════════════════════════════════════════════════════════════
// 모집공고 보관(폐기) — 끝난 공고를 리뷰어 목록·관리자 카드에서 내린다. (migration 130)
//
// ★★ 왜 삭제가 아니라 보관인가
//   `DELETE /api/campaign/admin/:id` 는 행을 **하드 삭제**하고 FK CASCADE 로
//   campaign_applications(참여 이력) · campaign_options · campaign_fee_schedules(참여 시점
//   리뷰비 스냅샷) · campaign_rounds · campaign_daily_plans · campaign_reviewer_gates 가
//   함께 사라진다(payment_batch_items 는 SET NULL = 입금 회차의 공고 연결이 끊긴다).
//   → 끝난 공고를 치우는 수단으로 쓸 수 없다. 보관은 **데이터를 한 줄도 지우지 않고**
//     노출만 끄며, 되돌리기가 언제나 가능하다.
//
// ★★ 자동 보관은 하지 않는다(사용자 확정 2026-08-19). 시스템은 **제안까지만** 하고
//   실행은 사람이 누른다 — 조용히 사라지는 공고를 만들지 않는다.
//   제안 조건 = **작업보드 표(campaign_participants)의 모든 줄이 채워진 경우**
//   ("투입 총량을 모집해 모든 행을 채웠다" = 그 작업의 모집이 끝났다는 뜻).
// ═══════════════════════════════════════════════════════════════════════════
const { logger } = require('../utils/logger');
const { filledSql } = require('../utils/rowNumbering');

/** 탭 키 — 복합키 구분자는 **이스케이프 표기**로 쓴다(소스에 리터럴 NUL·탭 금지: git 이
 *  파일을 바이너리로 취급해 grep·회귀가드가 그 파일에서 통째로 무력화된다 — 실측 규율). */
const _TKEY = (sheetId, tabName) => `${sheetId}\u0000${tabName}`;

/** 보관을 막는 사유(fail-closed) — 살아 있는 참여가 있으면 보관하지 않는다.
 *  보관하면 공개 목록에서 빠지고 apply 도 막히므로, 결제 중(홀드)인 리뷰어가
 *  **제출 화면을 못 찾는다**(그 참여가 통째로 소각된다). */
async function archiveBlockers(db, id) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'applied' AND expires_at > NOW()) AS holds,
            COUNT(*) FILTER (WHERE status = 'blog_pending')                   AS blog_pending
       FROM campaign_applications WHERE campaign_id = $1`, [id]);
  const holds = Number(rows[0] && rows[0].holds) || 0;
  const pend = Number(rows[0] && rows[0].blog_pending) || 0;
  const out = [];
  if (holds > 0) out.push({ code: 'active_holds', count: holds, message: `진행 중인 참여 ${holds}건이 있습니다 — 제출이 끝나거나 자리가 만료된 뒤에 보관하세요.` });
  if (pend > 0) out.push({ code: 'blog_pending', count: pend, message: `승인 대기 중인 블로그 신청 ${pend}건이 있습니다 — 로그에서 승인/반려한 뒤에 보관하세요.` });
  return out;
}

/** 보관. 이미 보관된 공고면 그대로 성공(멱등).
 *  ★ 쓰기 표면 = `recruit_campaigns.archived_at/archived_by` 두 칸뿐(다른 테이블 무접촉). */
async function archiveCampaign(db, id, by) {
  const { rows: cur } = await db.query('SELECT id, title, archived_at FROM recruit_campaigns WHERE id = $1', [id]);
  if (!cur.length) return { ok: false, code: 'not_found', error: '캠페인을 찾을 수 없습니다.' };
  if (cur[0].archived_at) return { ok: true, already: true, archivedAt: cur[0].archived_at };

  const blockers = await archiveBlockers(db, id);
  if (blockers.length) return { ok: false, code: 'blocked', blockers, error: blockers.map(b => b.message).join(' ') };

  const { rows } = await db.query(
    `UPDATE recruit_campaigns SET archived_at = NOW(), archived_by = $2, updated_at = NOW()
      WHERE id = $1 AND archived_at IS NULL RETURNING archived_at`, [id, by || null]);
  // 0행 = 그 사이 다른 담당자가 먼저 보관함(경합) — 성공으로 수렴(결과가 같다)
  return { ok: true, archivedAt: (rows[0] && rows[0].archived_at) || null };
}

/** 보관 해제 — 비상구라 게이트는 하나뿐: ★ 결정 246 같은 작업오더에 살아 있는 다른 공고가 있으면 거절.
 *  (보관 → 같은 오더로 새 공고 → 옛 공고 해제 = 살아 있는 공고 두 장 — 생성 쪽 검사를 우회하는 길, Codex PR #1632.)
 *  생성과 같은 잠금·같은 짝짓기(linkedRecruitQuota 단일 출처)로 확인 → 해제한다. 오더 없는 공고는 종전 그대로.
 *  0행은 "되돌렸습니다"로 꾸미지 않는다. */
async function unarchiveCampaign(db, id) {
  const client = typeof db.connect === 'function' ? await db.connect() : null;
  const q = client || db;
  try {
    if (client) await client.query('BEGIN');
    const lrq = require('./linkedRecruitQuota.service');
    // 행 잠금 — 확인과 해제 사이에 다른 담당자가 보관·해제를 끼워 넣지 못하게.
    const { rows: cur } = await q.query('SELECT archived_at FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.length || !cur[0].archived_at) {
      // ★ 이미 해제됨(재시도)·없음은 여기서 끝낸다 — 계속 가면 그 사이 보관+새 공고가 생겼을 때
      //   검사·잠금 없이 해제 UPDATE 가 맞아떨어진다(Codex PR #1632).
      if (client) await client.query('ROLLBACK');
      return cur.length ? { ok: true, already: true } : { ok: false, code: 'not_found', error: '캠페인을 찾을 수 없습니다.' };
    }
    const woIds = await lrq.workOrderIdsForCampaign(q, id);
    if (woIds.length) {
      await lrq.lockWorkOrderCampaigns(q, woIds);
      const live = await lrq.liveCampaignForWorkOrders(q, woIds, id);
      if (live) {
        if (client) await client.query('ROLLBACK');
        return { ok: false, code: 'work_order_campaign_exists', campaignId: live.id,
          error: `같은 작업오더로 살아 있는 모집공고가 이미 있습니다 — 「${live.title || live.id}」. 그 공고를 보관하거나 삭제한 뒤에 보관을 해제하세요.` };
      }
    }
    const { rows } = await q.query(
      `UPDATE recruit_campaigns SET archived_at = NULL,
         published_at = CASE WHEN status = 'active' THEN NOW() ELSE published_at END,   -- 174: 보관 해제 = 오늘 다시 게시(보관 중은 리뷰어에게 안 보였다)
         updated_at = NOW()
        WHERE id = $1 AND archived_at IS NOT NULL RETURNING id`, [id]);
    // ★ archived_by 는 지우지 않는다 — 이력 테이블이 없어 "누가 언제 보관했나"의 유일한 기록이다.
    let out = { ok: true };
    if (!rows.length) {
      const { rows: exist } = await q.query('SELECT archived_at FROM recruit_campaigns WHERE id = $1', [id]);
      out = exist.length ? { ok: true, already: true }   // 이미 보관 해제 상태
        : { ok: false, code: 'not_found', error: '캠페인을 찾을 수 없습니다.' };
    }
    if (client) await client.query('COMMIT');
    return out;
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (client) client.release();
  }
}

/**
 * 보관 **제안** 판정 — 연결 작업표의 모든 줄이 채워졌는가.
 *
 * ★ 재료는 작업보드 표 그 자체(`campaign_participants`): 총 줄 수 vs 이름/연락처가 채워진 줄 수.
 *   "투입 총량을 모집해 모든 행을 채운 경우"라는 사용자 확정 조건을 그대로 옮긴 것이다.
 * ★ 소프트삭제(deleted_at)·비활성(active=FALSE) 줄은 표에서 이미 빠졌으므로 세지 않는다.
 * ★ **못 세면 제안하지 않는다**(fail-soft `null`) — 0/0 을 "다 찼다"로 읽으면 아직 시작도 안 한
 *   작업의 공고에 보관 제안이 붙는다(모르는 것을 단정하지 않는다).
 *
 * @returns {Promise<Map<string,{total:number,filled:number,full:boolean}>|null>} 공고 id → 판정
 */
async function archiveSuggestions(db, campaigns) {
  const list = (campaigns || []).filter(c => c && c.linked_sheet_id && c.linked_tab_name && !c.archived_at);
  if (!list.length) return new Map();
  try {
    const sheets = list.map(c => c.linked_sheet_id);
    const tabs = list.map(c => c.linked_tab_name);
    // ★★ "채워진 줄" 판정 = utils/rowNumbering.filledSql 단일 출처 합류(2026-08-20 명시적 의미 변경).
    //   종전 2칸(phone8/reviewer_name)은 작업보드 게이지·번호 정리의 4칸 판정
    //   (order_submission_id·reviewer_name·recipient_name·phone8)과 갈라져 "게이지는 169인데
    //   보관 제안 filled 는 다른 수"가 됐다. 이 값은 관리자 카드 누적 표기(1단계)의 재료도 겸하므로
    //   두 화면이 같은 숫자를 봐야 한다. 넓어지는 방향(주문 링크만·수취인만 있는 줄도 채워짐)이고,
    //   보관은 제안 전용 + 실행 게이트(유효 홀드·blog_pending 거부)가 따로 있어 안전하다.
    const { rows } = await db.query(
      `SELECT p.sheet_id, p.tab_name,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE ${filledSql('p')}) AS filled
         FROM campaign_participants p
        WHERE p.deleted_at IS NULL AND p.active
          AND (p.sheet_id, p.tab_name) IN (SELECT * FROM UNNEST($1::text[], $2::text[]))
        GROUP BY p.sheet_id, p.tab_name`, [sheets, tabs]);
    const byTab = new Map();
    for (const r of rows) {
      byTab.set(_TKEY(r.sheet_id, r.tab_name), {
        total: Number(r.total) || 0,
        filled: Number(r.filled) || 0,
      });
    }
    const out = new Map();
    for (const c of list) {
      const t = byTab.get(_TKEY(c.linked_sheet_id, c.linked_tab_name));
      if (!t || t.total <= 0) continue;              // 표가 없거나 빈 표 = 판정 불가(제안 없음)
      out.set(c.id, { total: t.total, filled: t.filled, full: t.filled >= t.total });
    }
    return out;
  } catch (err) {
    // ★ 제안은 편의 기능이다 — 실패해도 목록은 그대로 떠야 한다(조회 실패 = 제안 없음).
    logger.warn(`[campaignArchive] 보관 제안 판정 실패(제안 없이 계속): ${err.message}`);
    return null;
  }
}

module.exports = { archiveCampaign, unarchiveCampaign, archiveBlockers, archiveSuggestions };
