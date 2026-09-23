/**
 * csBridge.service.js — 리뷰이미지 교체요청 ↔ C/S 문의창구 연결의 **단일 출처**.
 *
 * 왜 필요한가
 *  · 지금까지 교체요청의 승인·반려 결과는 리뷰어에게 **전혀 통지되지 않았다**
 *    (SSE 는 관리자 위젯 갱신용 브로드캐스트뿐 — 리뷰어는 '내 요청함'을 다시 열어야 알았다).
 *  · 그래서 요청/처리 사건을 그 리뷰어의 C/S 스레드에 흘려보낸다.
 *    관리자는 C/S 한 곳만 보면 되고, 리뷰어는 늘 쓰던 채팅에서 결과를 받는다.
 *
 * ★★ 불변식 — **여기서 무슨 일이 나도 교체요청 처리 자체를 깨뜨리지 않는다.**
 *    승인은 Drive 파일 이동·이름변경·review_index 갱신까지 끝난 뒤의 후처리라,
 *    통지 실패로 예외가 올라가면 "파일은 바뀌었는데 요청은 pending" 인 어긋난 상태가 된다.
 *    → 모든 진입점이 try/catch 로 감싸 **절대 throw 하지 않는다**(실패는 warn 로그만).
 *
 * ★ 호출 위치는 라우트가 아니라 **서비스 레벨**이다 — 기존 관리자페이지(리뷰관리 탭)에서
 *   눌러도, 리뷰웹시스템[3버전] C/S·전용 탭에서 눌러도 똑같이 통지된다(사용자 확정).
 *
 * ★★ 리뷰어에게 나가는 값의 규율(코드리뷰로 잡힌 것):
 *    ① meta 는 `/api/reviewer/cs/messages` 응답에 **그대로 실린다** — adminNickname.maskMessages 는
 *       senderName 만 치환한다. 그러니 관리자 실명 같은 값을 meta 에 넣으면 안 된다(화면에서만
 *       감추는 건 devtools 에 그대로 보이는 보안연극).
 *    ② SSE 푸시도 페이로드로 새므로 리뷰어용 이름으로 치환해 보낸다.
 *    ③ 기존 스레드의 campaign_label 을 덮어쓰지 않는다 — 그 값 출처에 **시트 제목**이 섞이는데,
 *       시트 제목은 리뷰어 응답에 넣지 않는다는 규칙이 reviewer.routes 에 있다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { emitCsInquiry, emitCsReplyToReviewer, broadcast } = require('../utils/sse');
const adminNickname = require('./adminNickname.service');

/** C/S 스레드 키 — 리뷰어 UI(`index.html`)·`/api/reviewer/cs/campaigns` 와 **같은 규칙**이어야
 *  이미 열려 있는 문의방에 이어 붙는다(다르면 같은 탭에 방이 두 개 생긴다). */
function campaignKeyOf(sheetId, tabName) {
  return `${String(sheetId || '')}||${String(tabName || '')}`;
}

function _clip(s, n) { return String(s == null ? '' : s).slice(0, n); }

/**
 * 교체요청 접수 → 그 리뷰어의 C/S 스레드에 **카드 메시지** 1장.
 * 스레드가 없으면 만든다(사용자 확정: 항상 자동 생성).
 * @param {object} r     review_edit_requests 행(스네이크 케이스)
 * @param {object} opts  { silent } — 처리 도중 뒤늦게 만들 때는 "새 문의 도착" 알림을 내지 않는다
 */
async function postReviewEditRequest(r, opts) {
  opts = opts || {};
  try {
    if (!r || !r.id || !r.phone8) return null;
    const campaignKey = campaignKeyOf(r.sheet_id, r.tab_name);
    const label = _clip(r.campaign_label || r.tab_name || '문의', 200);
    const name = _clip(r.reviewer_name || '리뷰어', 100);
    const preview = '🖼 리뷰이미지 교체요청';

    // 리뷰어가 보낸 것과 동일한 upsert — admin_unread_count 를 올려 관리자 뱃지에 잡히게 한다
    //   (요청 자체가 "확인이 필요한 도착물"이라 미확인으로 세는 게 맞다).
    // ★★ 기존 스레드의 campaign_label·reviewer_name 은 **덮어쓰지 않는다** —
    //   라벨 출처(tab_configs.campaign_name)에 시트 제목이 섞일 수 있고, 그 값은
    //   `/api/reviewer/cs/threads` 로 리뷰어 문의방 이름에 그대로 나간다.
    const { rows: tRows } = await pool.query(`
      INSERT INTO cs_threads
        (reviewer_phone8, reviewer_name, campaign_key, campaign_label, campaign_source,
         status, last_message_at, last_message_preview, admin_unread_count)
      VALUES ($1,$2,$3,$4,'review_index','open',NOW(),$5,1)
      ON CONFLICT (reviewer_phone8, campaign_key) DO UPDATE SET
        status = 'open',
        last_message_at = NOW(),
        last_message_preview = EXCLUDED.last_message_preview,
        admin_unread_count = cs_threads.admin_unread_count + 1,
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS "isNew"
    `, [r.phone8, name, campaignKey, label, preview]);
    const threadId = tRows[0].id;

    // 카드 1장 — 승인/반려는 이 카드를 **제자리에서** 갱신한다(카드가 여러 장 쌓이지 않게).
    //   ON CONFLICT DO NOTHING = uq_cs_msg_review_edit(부분 유니크)와 짝. 재호출해도 안전.
    //   ★ meta 에는 리뷰어가 봐도 되는 값만 담는다(관리자 실명 금지 — 위 규율 ①).
    const meta = {
      requestId: r.id, status: 'pending',
      slotKey: r.slot_key || 'review', rowIndex: r.row_index,
      sheetId: r.sheet_id, tabName: r.tab_name,
      oldFileId: r.old_file_id || '', newFileId: r.new_file_id || '',
      reason: _clip(r.reason, 500),
    };
    await pool.query(
      `INSERT INTO cs_messages (thread_id, sender_role, sender_name, content, msg_type, meta)
       VALUES ($1,'reviewer',$2,$3,'review_edit',$4::jsonb)
       ON CONFLICT DO NOTHING`,
      [threadId, name, '리뷰이미지 교체를 요청했습니다.', JSON.stringify(meta)]
    );

    // ★ 승인/반려 도중 뒤늦게 만드는 경우(silent)에는 알림을 내지 않는다 —
    //   관리자가 방금 처리를 눌렀는데 "새 문의 도착"이 뜨면 새 문의로 오인한다.
    if (!opts.silent) {
      try {
        emitCsInquiry({
          isNew: tRows[0].isNew, threadId, reviewerName: name, reviewerPhone8: r.phone8,
          campaignLabel: label, preview,
        });
      } catch (_) {}
    }
    return { threadId };
  } catch (err) {
    logger.warn(`[csBridge] 교체요청 카드 기록 실패(${r && r.id}): ${err.message}`);
    return null;
  }
}

/**
 * 승인/반려 → ① 카드 상태 제자리 갱신 ② 리뷰어 채팅에 **자동 통지 메시지**.
 * 관리자가 따로 타이핑할 필요가 없게 하는 것이 이 함수의 목적.
 * @param {object} r     처리된 review_edit_requests 행
 * @param {'approved'|'rejected'} decision
 * @param {string} note  반려 사유(반려는 필수 — 라우트에서 강제) / 승인 시 선택 메모
 * @param {string} by    처리한 관리자 로그인명(DB 에만 남고 리뷰어에겐 치환해 나간다)
 * @param {number} _depth 내부용 — 재귀 1회 제한
 */
async function postReviewEditDecision(r, decision, note, by, _depth) {
  try {
    if (!r || !r.id || !r.phone8) return null;
    if (decision !== 'approved' && decision !== 'rejected') return null;
    const campaignKey = campaignKeyOf(r.sheet_id, r.tab_name);

    const { rows: tRows } = await pool.query(
      `SELECT id FROM cs_threads WHERE reviewer_phone8=$1 AND campaign_key=$2`,
      [r.phone8, campaignKey]
    );
    if (!tRows.length) {
      // 스레드가 없으면 통지할 곳이 없으므로 요청 카드를 뒤늦게 만든다(멱등).
      //   ★ 깊이 1회 제한 — 키가 어긋나 SELECT 가 계속 0행이면 무한 재귀가 된다.
      if (_depth) { logger.warn(`[csBridge] 스레드 생성 후에도 못 찾음(${r.id}) — 통지 생략`); return null; }
      const made = await postReviewEditRequest(r, { silent: true });
      if (!made) return null;
      return postReviewEditDecision(r, decision, note, by, 1);
    }
    const threadId = tRows[0].id;

    // ① 카드 상태 갱신 — meta 병합(다른 키 보존)
    //   ★ 반려는 새 파일이 곧 휴지통으로 가므로 newFileId 를 비운다 — 안 그러면 반려 카드의
    //     "변경 요청" 썸네일이 깨진 이미지로 남는다.
    await pool.query(
      `UPDATE cs_messages
          SET meta = meta || $2::jsonb
        WHERE msg_type='review_edit' AND meta->>'requestId' = $1`,
      [String(r.id), JSON.stringify({
        status: decision, adminNote: _clip(note, 500),
        newFileId: decision === 'rejected' ? '' : (r.new_file_id || ''),
      })]
    );

    // ② 자동 통지 — 관리자 발신 텍스트 메시지(리뷰어 채팅에 알림으로 뜬다)
    //   sender_name 은 로그인명으로 저장하고(책임추적), 읽는 시점에 adminNickname 이 역할별로 치환한다.
    const text = decision === 'approved'
      ? '리뷰이미지 수정요청이 승인되었습니다.'
      : `리뷰이미지 수정요청이 반려되었습니다.\n사유: ${_clip(note, 300)}`;
    const senderName = _clip(by || '관리자', 100);
    const { rows: mRows } = await pool.query(
      `INSERT INTO cs_messages (thread_id, sender_role, sender_name, content)
       VALUES ($1,'admin',$2,$3) RETURNING id, created_at AS "createdAt"`,
      [threadId, senderName, text]
    );
    await pool.query(
      `UPDATE cs_threads
          SET reviewer_unread_count = reviewer_unread_count + 1,
              last_message_at = NOW(), last_message_preview = $2, updated_at = NOW()
        WHERE id = $1`,
      [threadId, _clip(text.replace(/\n/g, ' '), 120)]
    );

    // ③ 실시간 — 리뷰어 연결에만 타깃 + 관리자 화면 갱신
    //   ★★ 리뷰어에게 가는 푸시는 **반드시 리뷰어용 이름으로**(cs.routes 답장과 같은 규칙).
    //     화면이 senderName 을 안 그리더라도 페이로드로는 새므로 여기서 막아야 한다.
    try {
      const nickMap = await adminNickname.getNicknameMap().catch(() => null);
      emitCsReplyToReviewer(r.phone8, {
        id: mRows[0].id, threadId, senderRole: 'admin',
        senderName: adminNickname.toReviewerName(senderName, nickMap),
        content: text, imageUrls: [], createdAt: mRows[0].createdAt,
        campaignLabel: r.campaign_label || r.tab_name || '문의',
      });
    } catch (_) {}
    try { broadcast('cs_message', { threadId, senderRole: 'admin', reviewerPhone8: r.phone8 }); } catch (_) {}
    return { threadId, messageId: mRows[0].id };
  } catch (err) {
    logger.warn(`[csBridge] 교체요청 처리 통지 실패(${r && r.id}/${decision}): ${err.message}`);
    return null;
  }
}

/**
 * 리뷰어가 요청을 취소 → 카드만 `cancelled` 로 내린다(통지 메시지는 없음 — 본인이 누른 일이다).
 * ★ 이게 없으면 카드가 계속 `pending` 이라 관리자 화면에 **[승인]/[반려] 버튼이 살아 있고**,
 *   같은 행에 재요청까지 하면 "처리 대기" 카드가 두 장 보인다(부분 유니크는 pending 만 막는다).
 */
async function markReviewEditCancelled(r) {
  try {
    if (!r || !r.id) return null;
    const { rowCount } = await pool.query(
      `UPDATE cs_messages
          SET meta = meta || '{"status":"cancelled","newFileId":""}'::jsonb
        WHERE msg_type='review_edit' AND meta->>'requestId' = $1`,
      [String(r.id)]
    );
    return { updated: rowCount };
  } catch (err) {
    logger.warn(`[csBridge] 교체요청 취소 카드 갱신 실패(${r && r.id}): ${err.message}`);
    return null;
  }
}

/**
 * 리뷰검수 [✕ 불량 맞음] → 리뷰어 채팅에 **반려 사유 자동 통지**(교체요청 반려 통지와 같은 규율).
 * ★ 절대 throw 하지 않는다 — 통지 실패가 불량 확인(원장 기록)을 되돌리면 안 된다.
 * ★ 스레드가 없으면 만든다 — 단 관리자 발신이므로 admin_unread 는 올리지 않는다
 *   (교체요청 카드 upsert 와 달리 "관리자가 확인할 도착물"이 아니다).
 * ★ SSE 페이로드의 발신자 이름은 반드시 리뷰어용으로 치환(닉네임 fail-closed 규율).
 */
async function postInspectionReject({ sheetId, tabName, rowIndex, reviewerName, phone8, message, by, card } = {}) {
  try {
    if (!phone8 || !String(message || '').trim()) return null;
    const campaignKey = campaignKeyOf(sheetId, tabName);
    const name = _clip(reviewerName || '리뷰어', 100);
    const text = _clip(String(message).trim(), 1000);
    const preview = _clip(text.replace(/\n/g, ' '), 120);

    let threadId;
    const { rows: tRows } = await pool.query(
      `SELECT id FROM cs_threads WHERE reviewer_phone8=$1 AND campaign_key=$2`,
      [phone8, campaignKey]
    );
    if (tRows.length) threadId = tRows[0].id;
    else {
      // ★ 기존 스레드의 campaign_label·reviewer_name 은 덮어쓰지 않는다(위 규율 그대로) —
      //   신규 생성 시 라벨은 탭 표시명(시트 제목 미노출 원칙).
      const { rows } = await pool.query(`
        INSERT INTO cs_threads
          (reviewer_phone8, reviewer_name, campaign_key, campaign_label, campaign_source,
           status, last_message_at, last_message_preview, admin_unread_count)
        VALUES ($1,$2,$3,$4,'review_index','open',NOW(),$5,0)
        ON CONFLICT (reviewer_phone8, campaign_key) DO UPDATE SET updated_at = NOW()
        RETURNING id
      `, [phone8, name, campaignKey, _clip(tabName || '문의', 200), preview]);
      threadId = rows[0].id;
    }

    const senderName = _clip(by || '관리자', 100);   // DB 엔 로그인명(책임추적) — 표시 치환은 읽는 시점
    /* ★ 사진 카드(선택) — 교체요청 카드와 같은 구조(meta + 파일ID, 프론트가 신뢰 베이스로 URL 재구성).
       ★★ meta 는 리뷰어 응답에 **그대로 실린다** — 관리자 실명·시트 제목을 넣지 않는다(080 규율).
       ★ 파일ID 형식이 아닌 값은 버린다(잘못된 값이 <img> 로 나가지 않게). */
    const _fid = (v) => { const s = String(v || '').replace(/[^-\w]/g, ''); return s.length >= 10 ? s : ''; };
    const meta = card ? {
      kind: _clip(card.kind, 40),
      fileId: _fid(card.fileId),
      matchFileId: _fid(card.matchFileId),
      work: _clip(card.work || tabName || '', 120),
      product: _clip(card.product, 120),
      ordinal: Number(card.ordinal) || 0,
      submittedAt: card.submittedAt || null,
      matchProduct: _clip(card.matchProduct, 120),
      matchOrdinal: Number(card.matchOrdinal) || 0,
      matchAt: card.matchAt || null,
      to: _clip(card.to, 40),
    } : null;
    const { rows: mRows } = await pool.query(
      `INSERT INTO cs_messages (thread_id, sender_role, sender_name, content, msg_type, meta)
       VALUES ($1,'admin',$2,$3,$4,$5::jsonb) RETURNING id, created_at AS "createdAt"`,
      [threadId, senderName, text, meta ? 'inspect_result' : 'text', meta ? JSON.stringify(meta) : null]
    );
    await pool.query(
      `UPDATE cs_threads
          SET reviewer_unread_count = reviewer_unread_count + 1,
              status = 'open', last_message_at = NOW(), last_message_preview = $2, updated_at = NOW()
        WHERE id = $1`,
      [threadId, preview]
    );
    try {
      const nickMap = await adminNickname.getNicknameMap().catch(() => null);
      emitCsReplyToReviewer(phone8, {
        id: mRows[0].id, threadId, senderRole: 'admin',
        senderName: adminNickname.toReviewerName(senderName, nickMap),
        content: text, imageUrls: [], createdAt: mRows[0].createdAt,
        campaignLabel: tabName || '문의',
        msgType: meta ? 'inspect_result' : 'text', meta: meta || null,   // 실시간 푸시에도 카드가 그려지게
      });
    } catch (_) {}
    try { broadcast('cs_message', { threadId, senderRole: 'admin', reviewerPhone8: phone8 }); } catch (_) {}
    return { threadId, messageId: mRows[0].id };
  } catch (err) {
    logger.warn(`[csBridge] 검수 반려 통지 실패(${sheetId}/${tabName}/${rowIndex}): ${err.message}`);
    return null;
  }
}

/* ★ 관리자 → 리뷰어 단문 안내는 위 함수가 하는 일 그대로다(스레드 없으면 생성 · admin_unread 0 ·
     닉네임 치환 · SSE 푸시 · 절대 throw 안 함). 사본을 만들면 그 방어가 한쪽에서만 풀리므로
     **이름만 하나 더 열어** 다른 용도(입금 실패 안내 등)가 같은 실행부를 쓰게 한다. */
const postAdminNotice = postInspectionReject;

module.exports = { campaignKeyOf, postReviewEditRequest, postReviewEditDecision, markReviewEditCancelled, postInspectionReject, postAdminNotice };
