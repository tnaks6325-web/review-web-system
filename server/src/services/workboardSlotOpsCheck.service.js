'use strict';
/**
 * 「오늘 확인할 것」 — 작업표 빈 줄이 없어 구매양식이 작업표에 들어가지 못한 주문 (결정 324 · 사용자 확정 A안 2026-11-03)
 *
 * 무슨 일: 무시트 작업표의 줄이 다 차 있으면(예: 200/200) 리뷰어 구매양식은 접수됐는데 작업표 줄이 안 생긴다.
 *   종전에는 매시간 재시도가 영원히 실패했고 직원은 몰랐다. 이제
 *   ① 큐 행은 「빈 줄 없음」 문장으로 failed 에 남고(매시 재시도 제외 — utils/workboardNoSlot)
 *   ② 그 주문을 홈 「오늘 확인할 것」에 띄워 직원이 정한다:
 *      [작업보드로 가기](화면에서 링크) · [다시 넣기](줄을 늘린 뒤 — 기존 수동 재시도 syncQueue.retryItem) · [확인함](닫기)
 *
 * ★ 새 쓰기 경로를 만들지 않는다 — 다시 넣기는 기존 retryItem(+즉시 펌프)이고, 실제 줄 고르기·기록은 언제나
 *   큐 실행부 → writeOrderToWorktable 이다. 줄을 자동으로 늘리지 않는다(사용자 확정).
 * ★ 행을 지우지 않는다(결정 271·274). 확인함은 이 확인 항목만 닫는다(큐 행·주문은 그대로).
 * ★ AI 를 부르지 않는다. 화면 문장은 고정 문장 + 시스템 사실. 리뷰어는 이름 + 연락처 끝 4자리만(주소·계좌·전체 번호 없음).
 * ★ 은행 목록(LIMIT 50)·담당자 질문과 섞지 않는다 — 홈 전용 별도 목록(결정 311 과 같은 이유).
 */
const { NO_SLOT_QUEUE_ERRORS, openSlotExistsSql } = require('../utils/workboardNoSlot');

const KIND = 'workboard_no_slot';
const LIST_LIMIT = 50;
const KST_MS = 9 * 3600 * 1000;

function refKeyOf(orderSubmissionId) { return `${KIND}:${orderSubmissionId}`; }
function _kst(at) {
  const d = new Date(new Date(at).getTime() + KST_MS);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function _phone4(phone) { const s = String(phone || '').replace(/\D/g, ''); return s.length >= 4 ? s.slice(-4) : ''; }

/** 빈 줄 없음으로 막힌 주문(주문마다 가장 최근 큐 행) — 주문이 살아 있고 아직 작업표에 안 들어간 것만. */
const blockedSql = `
  SELECT DISTINCT ON (os.id)
         sq.id AS queue_id, sq.processed_at, os.id::text AS os_id, os.sheet_id, os.tab_name,
         COALESCE(NULLIF(os.tab_gid, ''), NULLIF(os.gid, ''), tc.tab_gid, '') AS tab_gid,
         COALESCE(NULLIF(btrim(tc.display_name), ''), os.tab_name) AS title,
         COALESCE(NULLIF(btrim(os.orderer), ''), NULLIF(btrim(os.recipient), ''), '') AS who,
         os.phone, os.submitted_at,
         (SELECT COUNT(*)::int FROM campaign_participants cp
           WHERE cp.sheet_id = os.sheet_id AND cp.tab_name = os.tab_name
             AND cp.deleted_at IS NULL AND cp.active = TRUE) AS row_count
    FROM sync_queue sq
    JOIN order_submissions os ON os.id::text = (sq.payload->>'orderSubmissionId')
    LEFT JOIN tab_configs tc ON tc.sheet_id = os.sheet_id AND tc.tab_name = os.tab_name
   WHERE sq.type = 'workboard_apply' AND sq.status = 'failed'
     AND COALESCE(sq.error_msg, '') = ANY($1::text[])
     AND os.deleted_at IS NULL
     AND COALESCE(os.mirror_status, '') NOT IN ('written', 'canceled')
   ORDER BY os.id, sq.id DESC`;

function factsOf(r) {
  return {
    orderSubmissionId: r.os_id, queueId: Number(r.queue_id),
    sheetId: r.sheet_id, tabName: r.tab_name, tabGid: String(r.tab_gid || ''),
    title: r.title || r.tab_name,
    orderedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    who: String(r.who || '').slice(0, 40), phone4: _phone4(r.phone),
    rowCount: Number(r.row_count) || 0,
  };
}
function linesOf(f) {
  const full = f.rowCount > 0 ? `작업표가 꽉 차서(줄 ${f.rowCount}개 모두 참) ` : '작업표에 빈 줄이 없어 ';
  const who = [f.orderedAt ? `${_kst(f.orderedAt)} 주문` : '', f.who, f.phone4 ? `연락처 끝 ${f.phone4}` : ''].filter(Boolean).join(' · ');
  return [
    { key: 'no_slot', text: `${full}구매양식 1건이 작업표에 들어가지 못했습니다.` },
    { key: 'who', text: who },
    { key: 'how', text: '작업보드에서 줄을 추가한 뒤 [다시 넣기]를 누르면 들어갑니다(줄이 생기면 매시 정각에도 다시 넣습니다). 중복·잘못 들어온 주문이면 리뷰어 로그에서 [취소 처리]해 주세요.' },
  ];
}

/**
 * 목록을 사실에 맞춘다 — 막힌 주문은 열고(이미 「확인함」으로 닫은 것은 다시 열지 않는다),
 * 열린 항목 중 주문이 들어갔거나·취소됐거나·더 이상 빈 줄 문제가 아닌 것은 닫는다.
 * 다시 넣는 중(같은 주문의 workboard_apply 가 pending/processing)이면 열어 둔다.
 *
 * ★★ 닫기는 **한 문장(= 한 시점의 스냅숏)** 에서 「막힘·다시 넣는 중·들어감·취소」를 함께 본다(Codex P2 2026-11-03).
 *   종전에는 막힌 목록을 먼저 읽고 열린 항목을 나중에 읽어, 그 사이 재시도가 다시 빈 줄 없음으로 끝나면
 *   「막힘」에도 「다시 넣는 중」에도 없어 항목을 닫았고 — 위 upsert 가 열린 항목만 고쳐서 — 영영 닫혀 있었다.
 *   큐 행은 processing → failed 를 한 문장으로 바꾸므로 한 스냅숏에서는 둘 중 하나로 반드시 보인다.
 * ★ 시스템이 닫았는데(확인함 아님) 여전히 막힌 주문은 upsert 가 다시 연다 — 「확인함」(answers.ack)으로 닫은 것은 그대로.
 */
async function refresh(db) {
  const { rows } = await db.query(blockedSql, [[...NO_SLOT_QUEUE_ERRORS]]);
  const hash = f => require('./opsCheck.service').factsHash(f);
  for (const r of rows) {
    const f = factsOf(r);
    await db.query(
      `INSERT INTO ops_checks (kind, ref_key, facts, facts_hash, lines)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)
       ON CONFLICT (ref_key) DO UPDATE SET facts = EXCLUDED.facts, facts_hash = EXCLUDED.facts_hash,
              lines = EXCLUDED.lines, status = 'open', done_at = NULL, done_by = '', updated_at = NOW()
        WHERE (ops_checks.status = 'open' AND ops_checks.facts_hash <> EXCLUDED.facts_hash)
           OR (ops_checks.status <> 'open' AND NOT (COALESCE(ops_checks.answers, '{}'::jsonb) ? 'ack'))`,
      [KIND, refKeyOf(f.orderSubmissionId), JSON.stringify(f), hash(f), JSON.stringify(linesOf(f))]);
  }
  await db.query(
    `UPDATE ops_checks c
        SET status = 'done', done_at = NOW(), updated_at = NOW(),
            done_by = CASE WHEN s.written THEN '작업표에 들어감' WHEN s.gone THEN '주문 취소됨'
                           ELSE '빈 줄 문제 아님(다른 사유는 자동 재시도)' END
       FROM (SELECT c2.id,
                    os.id IS NULL OR os.deleted_at IS NOT NULL OR os.mirror_status = 'canceled' AS gone,
                    COALESCE(os.mirror_status, '') = 'written' AS written,
                    EXISTS (SELECT 1 FROM sync_queue sq WHERE sq.type = 'workboard_apply'
                             AND sq.status = 'failed' AND COALESCE(sq.error_msg, '') = ANY($2::text[])
                             AND (sq.payload->>'orderSubmissionId') = c2.facts->>'orderSubmissionId') AS blocked,
                    EXISTS (SELECT 1 FROM sync_queue sq WHERE sq.type = 'workboard_apply'
                             AND sq.status IN ('pending', 'processing')
                             AND (sq.payload->>'orderSubmissionId') = c2.facts->>'orderSubmissionId') AS retrying
               FROM ops_checks c2
               LEFT JOIN order_submissions os ON os.id::text = c2.facts->>'orderSubmissionId'
              WHERE c2.kind = $1 AND c2.status = 'open') s
      WHERE c.id = s.id AND c.status = 'open'
        AND (s.written OR s.gone OR NOT (s.blocked OR s.retrying))`, [KIND, [...NO_SLOT_QUEUE_ERRORS]]);
}

async function _view(db, row, allowed) {
  const item = require('./opsCheck.service').viewCheck(row);
  const osId = (item.facts || {}).orderSubmissionId;
  const { rows } = await db.query(
    `SELECT 1 FROM sync_queue WHERE type = 'workboard_apply' AND status IN ('pending', 'processing')
        AND (payload->>'orderSubmissionId') = $1 LIMIT 1`, [String(osId || '')]);
  return { ...item, queueState: rows.length ? 'retrying' : 'blocked', canAnswer: !!allowed && item.status === 'open' };
}

/** 홈 전용 목록 — 열린 것만, 오래된 것부터 50개씩. after = 앞 쪽의 마지막 id(담당자 질문과 같은 커서 · Codex P2 — 50건 넘으면 「더 보기」). */
async function list({ db, allowed = false, after = 0 }) {
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new (require('./opsCheck.service').OpsCheckError)('bad_cursor', '목록을 새로고침해 주세요.');
  }
  const { rows } = await db.query(
    `SELECT * FROM ops_checks WHERE kind = $1 AND status = 'open' AND id > $2 ORDER BY id LIMIT ${LIST_LIMIT + 1}`, [KIND, after]);
  const page = rows.slice(0, LIST_LIMIT);
  const items = [];
  for (const r of page) items.push(await _view(db, r, allowed));
  return { items, hasMore: rows.length > LIST_LIMIT, nextAfter: page.length ? Number(page[page.length - 1].id) : after };
}

/**
 * 직원 답 — choice: 'retry'(다시 넣기) | 'ack'(확인함).
 *   retry: 그 작업표에 빈 줄이 있어야 한다(없으면 no_room · 아무것도 안 바꾼다). 이미 다시 넣는 중이면 그대로 둔다.
 *          기존 수동 재시도(syncQueue.retryItem — failed 인 작업보드 반영 행만 pending 으로) + 즉시 펌프.
 *          확인 항목은 열어 둔다 — 들어가면 다음 갱신에서 「작업표에 들어감」으로 닫힌다.
 *   ack:   이 확인 항목만 닫는다(큐 행·주문은 그대로 · 다시 열지 않는다).
 */
async function answer({ db, id, choice, admin, by }) {
  const { OpsCheckError } = require('./opsCheck.service');
  if (!['master', 'admin'].includes(admin && admin.role) || !await require('../utils/workdeskEditors').canEdit(admin)) {
    throw new OpsCheckError('forbidden', '작업보드를 수정할 수 있는 관리자만 처리할 수 있습니다.');
  }
  if (!['retry', 'ack'].includes(choice)) throw new OpsCheckError('bad_choice', '다시 넣기 또는 확인함을 골라 주세요.');
  const cur = (await db.query('SELECT * FROM ops_checks WHERE id = $1', [id])).rows[0];
  if (!cur || cur.kind !== KIND) throw new OpsCheckError('not_found', '확인할 것을 찾을 수 없습니다. 새로고침해 주세요.');
  const f = cur.facts || {};
  const who = String(by || '').slice(0, 100);
  if (choice === 'ack') {
    await db.query(
      `UPDATE ops_checks SET answers = $2::jsonb, status = 'done', done_at = NOW(), done_by = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'open'`,
      [id, JSON.stringify({ ack: { choice: 'ack', by: who, at: new Date().toISOString() } }), who]);
  } else {
    if (cur.status !== 'open') throw Object.assign(new OpsCheckError('stale', '이미 닫힌 항목입니다. 새로고침해 주세요.'), { status: 409 });
    const { rows: q } = await db.query(
      `SELECT id, status, COALESCE(error_msg, '') AS error_msg FROM sync_queue
        WHERE type = 'workboard_apply' AND (payload->>'orderSubmissionId') = $1 ORDER BY id DESC`,
      [String(f.orderSubmissionId || '')]);
    if (!q.some(x => x.status === 'pending' || x.status === 'processing')) {
      const failed = q.find(x => x.status === 'failed' && NO_SLOT_QUEUE_ERRORS.includes(x.error_msg));
      if (!failed) throw Object.assign(new OpsCheckError('stale', '이미 바뀐 항목입니다. 새로고침해 주세요.'), { status: 409 });
      const { rows: room } = await db.query(`SELECT ${openSlotExistsSql('$1', '$2')} AS ok`, [f.sheetId, f.tabName]);
      if (!room[0] || !room[0].ok) {
        throw Object.assign(new OpsCheckError('no_room', '작업표에 아직 빈 줄이 없습니다 — 작업보드에서 줄을 먼저 추가해 주세요.'), { status: 409 });
      }
      try {
        await require('./syncQueue.service').retryItem(failed.id);   // 기존 수동 재시도(failed → pending · 주문 queued)
      } catch (e) {
        // 그사이 다른 쪽(매시 복구 등)이 먼저 되살렸으면 그대로 둔다 — 그 밖은 오류
        const { rows: again } = await db.query(`SELECT status FROM sync_queue WHERE id = $1`, [failed.id]);
        if (!again[0] || !['pending', 'processing', 'done'].includes(again[0].status)) throw e;
      }
      try { require('../jobs/queuePump').kickQueuePump(); } catch (_) {}
    }
  }
  const row = (await db.query('SELECT * FROM ops_checks WHERE id = $1', [id])).rows[0];
  return _view(db, row, true);
}

module.exports = { KIND, refKeyOf, factsOf, linesOf, blockedSql, refresh, list, answer };
